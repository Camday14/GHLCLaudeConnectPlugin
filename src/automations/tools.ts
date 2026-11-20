import { z } from "zod";
import { runConfirmable } from "../core/confirm.js";
import { confirmTokenArg, defineTool, type Ctx, type ToolDef } from "../core/context.js";
import { contactFilterSchema } from "../core/schemas.js";
import { compactContact } from "../core/util.js";
import type { AutomationEngine } from "./engine.js";
import { actionSchema, automationDefinitionSchema, conditionsSchema, describeAutomation, settingsSchema, triggerSchema, type StoredAutomation } from "./schema.js";

function engineOf(ctx: Ctx): AutomationEngine {
  const e = ctx.services?.automations as AutomationEngine | undefined;
  if (!e) throw new Error("Automations are only available through the hosted connector.");
  return e;
}

const loc = (ctx: Ctx) => ctx.client.locationId;

async function load(ctx: Ctx, id: string): Promise<StoredAutomation> {
  const a = await engineOf(ctx).get(loc(ctx), id);
  if (!a) throw new Error(`Automation ${id} not found (see list_automations).`);
  return a;
}

function summary(a: StoredAutomation) {
  return {
    id: a.id,
    name: a.name,
    status: !a.enabled ? "disabled" : a.mode === "live" ? "LIVE" : "dry run (logs only, takes no action)",
    summary: describeAutomation(a.definition),
  };
}

/** Sample matching: how many of the most recently updated contacts would pass the conditions right now. */
async function sampleMatch(ctx: Ctx, engine: AutomationEngine, def: z.infer<typeof automationDefinitionSchema>) {
  if (!def.conditions) return undefined;
  try {
    const recent = await ctx.data.searchContacts({}, 20);
    let pass = 0;
    for (const c of recent.items) if (!(await engine.checkConditions(ctx.data, def.conditions, c, undefined))) pass++;
    return `${pass} of the ${recent.items.length} most recently added contacts currently meet the conditions`;
  } catch {
    return undefined;
  }
}

const AUTOMATION_GUIDE = `
Automations run on the hosted server: Trigger → optional conditions → ordered actions.
Triggers: contact_created, tag_added, tag_removed, opportunity_created, opportunity_stage_changed, opportunity_status_changed, inbound_message (channel/keywords), appointment_booked, appointment_status_changed, task_completed, schedule (cron + target contacts/deals), manual.
Actions: send_sms, send_email, add_tags, remove_tags, assign_user (round robin), create_opportunity, move_opportunity, set_opportunity_status, create_task, add_note, add_to_workflow, remove_from_workflow, webhook, wait (minutes/hours/days), stop_if (replied / has_tag / missing_tag / deal status).
Messages support merge fields: {{contact.first_name|there}}, {{opportunity.name}}, {{message.body}}, {{owner.name}}, {{automation.name}}.
New automations start in DRY RUN (they log what they would do). Use test_automation on a real contact, review automation_history, then set_automation_mode live.`;

export const automationTools: ToolDef<any>[] = [
  defineTool({
    name: "create_automation",
    title: "Create automation",
    description:
      "Create an automation that the connector runs for you in GoHighLevel (GHL's own workflow builder can't be edited through the API, so these run on the connector server and act on GHL). " +
      AUTOMATION_GUIDE.trim(),
    write: true,
    schema: {
      name: z.string().min(1),
      description: z.string().optional(),
      trigger: triggerSchema,
      conditions: conditionsSchema.optional(),
      actions: z.array(actionSchema).min(1).max(50),
      settings: settingsSchema.partial().optional(),
      ...confirmTokenArg,
    },
    handler: async ({ confirm_token, ...input }, ctx) => {
      const engine = engineOf(ctx);
      const { definition, warnings } = await engine.resolve(loc(ctx), input);
      return runConfirmable(
        ctx.confirm,
        {
          tool: "create_automation",
          plan: definition,
          count: 1,
          preview: {
            action: "CREATE AUTOMATION (starts in dry-run mode: it will only log what it would do until you switch it live)",
            summary: describeAutomation(definition),
            warnings: warnings.length ? warnings : undefined,
            sample: await sampleMatch(ctx, engine, definition),
          },
          execute: async (def) => {
            const a = await engine.create(loc(ctx), def);
            return { ...summary(a), next_steps: "Run test_automation with a real contact_id, then set_automation_mode(mode='live') when it looks right." };
          },
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "list_automations",
    title: "List automations",
    description: "List automations with their status (live / dry run / disabled), a plain-English summary, and run counts for the last 7 days.",
    schema: {},
    handler: async (_a, ctx) => {
      const engine = engineOf(ctx);
      const list = await engine.list(loc(ctx));
      const out = [];
      for (const a of list) out.push({ ...summary(a), runs_last_7_days: await engine.stats(a.id) });
      return out;
    },
  }),

  defineTool({
    name: "get_automation",
    title: "Get automation",
    description: "Show an automation's full definition, summary and recent stats.",
    schema: { automation_id: z.string() },
    handler: async ({ automation_id }, ctx) => {
      const a = await load(ctx, automation_id);
      return { ...summary(a), definition: a.definition, runs_last_7_days: await engineOf(ctx).stats(a.id), created_at: a.created_at, updated_at: a.updated_at };
    },
  }),

  defineTool({
    name: "update_automation",
    title: "Update automation",
    description: "Replace parts of an automation (name, trigger, conditions, actions, settings). Runs already waiting continue with the new step list.",
    write: true,
    schema: {
      automation_id: z.string(),
      name: z.string().optional(),
      description: z.string().optional(),
      trigger: triggerSchema.optional(),
      conditions: conditionsSchema.nullable().optional().describe("null removes all conditions"),
      actions: z.array(actionSchema).min(1).max(50).optional(),
      settings: settingsSchema.partial().optional(),
      ...confirmTokenArg,
    },
    handler: async ({ automation_id, confirm_token, ...changes }, ctx) => {
      const engine = engineOf(ctx);
      const current = await load(ctx, automation_id);
      const merged: Record<string, unknown> = { ...current.definition };
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) merged[k] = v === null ? undefined : v;
      const { definition, warnings } = await engine.resolve(loc(ctx), merged);
      return runConfirmable(
        ctx.confirm,
        {
          tool: "update_automation",
          plan: { automation_id, definition },
          count: 1,
          preview: {
            action: `UPDATE AUTOMATION ${automation_id} (currently ${current.mode === "live" && current.enabled ? "LIVE" : current.enabled ? "dry run" : "disabled"})`,
            before: describeAutomation(current.definition),
            after: describeAutomation(definition),
            warnings: warnings.length ? warnings : undefined,
          },
          execute: async (p) => summary((await engine.update(loc(ctx), p.automation_id, p.definition))!),
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "set_automation_mode",
    title: "Turn automation live / dry run / off",
    description: "Switch an automation to 'live' (takes real actions), 'dry_run' (logs only) or 'disabled' (cancels waiting runs). Going live requires confirmation.",
    write: true,
    schema: { automation_id: z.string(), mode: z.enum(["live", "dry_run", "disabled"]), ...confirmTokenArg },
    handler: async ({ automation_id, mode, confirm_token }, ctx) => {
      const engine = engineOf(ctx);
      const a = await load(ctx, automation_id);
      if (mode !== "live") {
        const updated = await engine.setState(loc(ctx), automation_id, mode === "disabled" ? { enabled: false } : { enabled: true, mode: "dry_run" });
        return summary(updated!);
      }
      const recent = await engine.history(loc(ctx), { automationId: automation_id, limit: 5 });
      return runConfirmable(
        ctx.confirm,
        {
          tool: "set_automation_mode",
          plan: { automation_id, mode, definition: a.definition },
          count: 1,
          preview: {
            action: `TURN LIVE: "${a.name}" will start sending messages / changing records in GoHighLevel`,
            summary: describeAutomation(a.definition),
            recent_dry_runs: recent.map((r: any) => ({ at: r.started_at, status: r.status, contact_id: r.contact_id, steps: (r.log ?? []).map((l: any) => l.detail) })),
          },
          execute: async () => summary((await engine.setState(loc(ctx), automation_id, { enabled: true, mode: "live" }))!),
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "delete_automation",
    title: "Delete automation",
    description: "Delete an automation and cancel its waiting runs. History is kept for reference.",
    write: true,
    destructive: true,
    schema: { automation_id: z.string(), ...confirmTokenArg },
    handler: async ({ automation_id, confirm_token }, ctx) => {
      const engine = engineOf(ctx);
      const a = await load(ctx, automation_id);
      return runConfirmable(
        ctx.confirm,
        {
          tool: "delete_automation",
          plan: { automation_id },
          count: 1,
          preview: { action: `DELETE AUTOMATION "${a.name}"`, summary: describeAutomation(a.definition) },
          execute: async () => {
            await engine.remove(loc(ctx), automation_id);
            return { deleted: automation_id };
          },
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "test_automation",
    title: "Test automation (dry run)",
    description:
      "Dry-run an automation (saved, or a draft definition) against a real contact and/or deal: checks conditions and shows exactly what each step would do, with merge fields filled in. Never changes anything.",
    schema: {
      automation_id: z.string().optional(),
      draft: automationDefinitionSchema.optional().describe("Test a definition before creating it"),
      contact_id: z.string().optional(),
      opportunity_id: z.string().optional(),
      sample_event: z
        .object({ tag: z.string().optional(), stage: z.string().optional(), status: z.string().optional(), body: z.string().optional(), channel: z.string().optional() })
        .optional()
        .describe("Optional: event details to check whether the trigger would match"),
    },
    handler: async (a, ctx) => {
      const engine = engineOf(ctx);
      if (!a.contact_id && !a.opportunity_id) throw new Error("Provide contact_id and/or opportunity_id to test against.");
      let def;
      if (a.automation_id) def = (await load(ctx, a.automation_id)).definition;
      else if (a.draft) def = (await engine.resolve(loc(ctx), a.draft)).definition;
      else throw new Error("Provide automation_id or draft.");
      const event = a.sample_event
        ? ({ type: def.trigger.type, locationId: loc(ctx), contactId: a.contact_id, opportunityId: a.opportunity_id, tag: a.sample_event.tag, stageId: a.sample_event.stage, status: a.sample_event.status, body: a.sample_event.body, channel: a.sample_event.channel } as any)
        : undefined;
      return { summary: describeAutomation(def), ...(await engine.simulate(loc(ctx), def, { contactId: a.contact_id, opportunityId: a.opportunity_id }, event)) };
    },
  }),

  defineTool({
    name: "run_automation",
    title: "Run automation now",
    description: "Start an automation right now for specific contacts (or a filter), regardless of its trigger. Uses the automation's current mode (dry run or live).",
    write: true,
    schema: {
      automation_id: z.string(),
      contact_ids: z.array(z.string()).optional(),
      filter: contactFilterSchema.optional(),
      max_contacts: z.number().int().min(1).max(1000).default(50),
      ...confirmTokenArg,
    },
    handler: async (a, ctx) => {
      const engine = engineOf(ctx);
      const auto = await load(ctx, a.automation_id);
      if (!auto.enabled) throw new Error("This automation is disabled. Switch it to dry_run or live first.");
      const contacts = await ctx.data.resolveContacts(a.contact_ids, a.filter, a.max_contacts);
      const plan = { automation_id: a.automation_id, mode: auto.mode, contact_ids: contacts.map((c) => c.id).sort() };
      return runConfirmable(
        ctx.confirm,
        {
          tool: "run_automation",
          plan,
          count: plan.contact_ids.length,
          preview: {
            action: `RUN "${auto.name}" now for ${plan.contact_ids.length} contacts in ${auto.mode === "live" ? "LIVE" : "dry-run"} mode`,
            summary: describeAutomation(auto.definition),
            sample: contacts.slice(0, 10).map(compactContact),
          },
          execute: async (p) => {
            const runIds = await engine.runManually(auto, p.contact_ids.map((contactId) => ({ contactId })));
            const runs = await engine.history(loc(ctx), { automationId: auto.id, limit: Math.min(runIds.length, 20) });
            return { runs_started: runIds.length, recent: runs.map((r: any) => ({ run_id: r.id, contact_id: r.contact_id, status: r.status, error: r.error })) };
          },
        },
        a.confirm_token,
      );
    },
  }),

  defineTool({
    name: "automation_history",
    title: "Automation history",
    description: "Recent automation runs with step-by-step logs: what fired, for whom, what was done (or would be done in dry run), and any errors.",
    schema: {
      automation_id: z.string().optional(),
      status: z.enum(["running", "waiting", "completed", "stopped", "skipped", "failed", "rate_limited", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(200).default(25),
    },
    handler: async (a, ctx) => {
      const rows = await engineOf(ctx).history(loc(ctx), { automationId: a.automation_id, status: a.status, limit: a.limit });
      return rows.map((r: any) => ({
        run_id: r.id,
        automation: r.automation_name ?? r.automation_id,
        mode: r.mode,
        status: r.status,
        contact_id: r.contact_id,
        opportunity_id: r.opportunity_id,
        started_at: r.started_at,
        error: r.error ?? undefined,
        steps: (r.log ?? []).map((l: any) => `${l.ok ? "✓" : "✗"} ${l.detail}`),
      }));
    },
  }),

  defineTool({
    name: "pause_all_automations",
    title: "Pause ALL automations (kill switch)",
    description: "Immediately disable every automation for this GoHighLevel account and cancel all waiting steps. No confirmation needed.",
    schema: {},
    handler: async (_a, ctx) => {
      const n = await engineOf(ctx).pauseAll(loc(ctx));
      return { paused: n, message: n ? `Disabled ${n} automation(s). Re-enable individually with set_automation_mode.` : "No automations were running." };
    },
  }),
];

export const AUTOMATION_INSTRUCTIONS = `
- Automations: use create_automation / test_automation / set_automation_mode. ${AUTOMATION_GUIDE.trim()}`;
