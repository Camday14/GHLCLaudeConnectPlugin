import { z } from "zod";
import { contactFilterSchema } from "../core/schemas.js";

// ---------- triggers ----------
const tagTrigger = (type: "tag_added" | "tag_removed") => z.object({ type: z.literal(type), tag: z.string().min(1) });

export const scheduleTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("contacts"), filter: contactFilterSchema.optional() }),
  z.object({
    kind: z.literal("opportunities"),
    pipeline_id: z.string().optional(),
    stage: z.string().optional().describe("Stage ID or name"),
    status: z.enum(["open", "won", "lost", "abandoned", "all"]).default("open"),
    stale_days: z.number().int().min(1).optional().describe("Only deals with no stage change for at least this many days"),
  }),
]);

export const triggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("contact_created"), source: z.string().optional().describe("Only contacts with this lead source") }),
  tagTrigger("tag_added"),
  tagTrigger("tag_removed"),
  z.object({
    type: z.literal("opportunity_created"),
    pipeline_id: z.string().optional(),
    stage: z.string().optional().describe("Stage ID or name"),
  }),
  z.object({
    type: z.literal("opportunity_stage_changed"),
    pipeline_id: z.string().optional(),
    stage: z.string().optional().describe("Fires when a deal moves INTO this stage (ID or name). Omit for any stage change."),
  }),
  z.object({ type: z.literal("opportunity_status_changed"), status: z.enum(["open", "won", "lost", "abandoned"]).optional() }),
  z.object({
    type: z.literal("inbound_message"),
    channel: z.enum(["SMS", "Email", "WhatsApp", "FB", "IG", "Live_Chat", "GMB", "Call"]).optional(),
    keywords: z.array(z.string()).optional().describe("Only when the message contains one of these words (case-insensitive)"),
  }),
  z.object({ type: z.literal("appointment_booked"), calendar_id: z.string().optional() }),
  z.object({
    type: z.literal("appointment_status_changed"),
    status: z.enum(["confirmed", "showed", "noshow", "cancelled", "invalid", "new"]).optional(),
    calendar_id: z.string().optional(),
  }),
  z.object({ type: z.literal("task_completed") }),
  z.object({
    type: z.literal("schedule"),
    cron: z.string().describe('5-field cron, e.g. "30 8 * * 1-5" = weekdays 8:30'),
    timezone: z.string().default("America/New_York").describe("IANA time zone"),
    target: scheduleTargetSchema.describe("Which records each scheduled run acts on (one run per record)"),
    max_per_run: z.number().int().min(1).max(2000).default(200),
  }),
  z.object({ type: z.literal("manual").describe("Only runs when started with run_automation") }),
]);

// ---------- conditions ----------
const scoreRuleSchema = z.object({
  type: z.string(),
  value: z.union([z.string(), z.number()]).optional(),
  field: z.string().optional(),
  points: z.number(),
});

export const stopConditionSchema = z.object({
  has_tag: z.string().optional(),
  missing_tag: z.string().optional(),
  replied: z.boolean().optional().describe("Contact sent an inbound message since this run started"),
  opportunity_status_in: z.array(z.enum(["open", "won", "lost", "abandoned"])).optional(),
  contact_filter: contactFilterSchema.optional(),
});

export const conditionsSchema = z.object({
  contact_filter: contactFilterSchema.optional().describe("Contact must match (tags, owner, source, has_email/has_phone...)"),
  min_score: z.number().optional().describe("Lead score (from score_rules or sort_leads defaults) must be at least this"),
  score_rules: z.array(scoreRuleSchema).optional(),
  opportunity: z
    .object({
      pipeline_id: z.string().optional(),
      stage: z.string().optional(),
      status: z.enum(["open", "won", "lost", "abandoned"]).optional(),
      min_value: z.number().optional(),
    })
    .optional(),
  business_hours: z
    .object({
      timezone: z.string().default("America/New_York"),
      start: z.string().default("09:00"),
      end: z.string().default("17:00"),
      days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]).describe("0=Sun..6=Sat"),
    })
    .optional()
    .describe("Message/action steps wait until business hours"),
});

// ---------- actions ----------
export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("send_sms"), message: z.string().min(1) }),
  z.object({ type: z.literal("send_email"), subject: z.string().min(1), html: z.string().optional(), message: z.string().optional(), email_from: z.string().optional() }),
  z.object({ type: z.literal("add_tags"), tags: z.array(z.string()).min(1) }),
  z.object({ type: z.literal("remove_tags"), tags: z.array(z.string()).min(1) }),
  z.object({
    type: z.literal("assign_user"),
    user_ids: z.array(z.string()).min(1),
    mode: z.enum(["round_robin", "fixed"]).default("round_robin"),
    also_assign_opportunities: z.boolean().default(false),
  }),
  z.object({
    type: z.literal("create_opportunity"),
    stage: z.string().describe("Stage ID or name"),
    pipeline_id: z.string().optional(),
    name: z.string().optional().describe("Supports merge fields; default: contact name"),
    monetary_value: z.number().optional(),
    skip_if_open: z.boolean().default(true),
  }),
  z.object({ type: z.literal("move_opportunity"), stage: z.string(), pipeline_id: z.string().optional() }),
  z.object({ type: z.literal("set_opportunity_status"), status: z.enum(["open", "won", "lost", "abandoned"]) }),
  z.object({
    type: z.literal("create_task"),
    title: z.string(),
    body: z.string().optional(),
    due_in_hours: z.number().min(0).default(24),
    assign_to: z.string().default("contact_owner").describe('"contact_owner" or a user ID'),
  }),
  z.object({ type: z.literal("add_note"), body: z.string() }),
  z.object({ type: z.literal("add_to_workflow"), workflow_id: z.string() }),
  z.object({ type: z.literal("remove_from_workflow"), workflow_id: z.string() }),
  z.object({ type: z.literal("webhook"), url: z.string().url().startsWith("https://"), payload: z.record(z.any()).optional() }),
  z.object({
    type: z.literal("wait"),
    minutes: z.number().min(0).optional(),
    hours: z.number().min(0).optional(),
    days: z.number().min(0).optional(),
  }),
  z.object({ type: z.literal("stop_if"), condition: stopConditionSchema }),
]);

export const settingsSchema = z.object({
  once_per_contact: z.boolean().default(true).describe("Never run more than once for the same contact"),
  max_actions_per_hour: z.number().int().min(1).max(5000).default(100),
});

export const automationDefinitionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  trigger: triggerSchema,
  conditions: conditionsSchema.optional(),
  actions: z.array(actionSchema).min(1).max(50),
  settings: settingsSchema.optional(),
});

export type Trigger = z.infer<typeof triggerSchema>;
export type Action = z.infer<typeof actionSchema>;
export type Conditions = z.infer<typeof conditionsSchema>;
export type StopCondition = z.infer<typeof stopConditionSchema>;
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;

export interface StoredAutomation {
  id: string;
  location_id: string;
  name: string;
  definition: AutomationDefinition & { resolved?: Record<string, unknown> };
  enabled: boolean;
  mode: "dry_run" | "live";
  last_scheduled_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

// ---------- plain-English description ----------
const q = (s: string) => `"${s.length > 60 ? s.slice(0, 57) + "..." : s}"`;

export function describeTrigger(t: Trigger): string {
  switch (t.type) {
    case "contact_created":
      return `When a new contact is created${t.source ? ` with source ${q(t.source)}` : ""}`;
    case "tag_added":
      return `When tag ${q(t.tag)} is added to a contact`;
    case "tag_removed":
      return `When tag ${q(t.tag)} is removed from a contact`;
    case "opportunity_created":
      return `When a deal is created${t.stage ? ` in stage ${q(t.stage)}` : ""}`;
    case "opportunity_stage_changed":
      return t.stage ? `When a deal moves into stage ${q(t.stage)}` : "When a deal changes stage";
    case "opportunity_status_changed":
      return t.status ? `When a deal is marked ${t.status}` : "When a deal's status changes";
    case "inbound_message":
      return `When a contact sends ${t.channel ? `an ${t.channel}` : "a message"}${t.keywords?.length ? ` containing ${t.keywords.map(q).join(" or ")}` : ""}`;
    case "appointment_booked":
      return `When an appointment is booked${t.calendar_id ? ` on calendar ${t.calendar_id}` : ""}`;
    case "appointment_status_changed":
      return t.status ? `When an appointment is marked ${t.status}` : "When an appointment's status changes";
    case "task_completed":
      return "When a task is completed";
    case "schedule":
      return `On schedule ${q(t.cron)} (${t.timezone}), for each ${t.target.kind === "contacts" ? "matching contact" : `${t.target.status ?? "open"} deal${t.target.stale_days ? ` stuck ${t.target.stale_days}+ days` : ""}`} (max ${t.max_per_run})`;
    case "manual":
      return "When started manually";
  }
}

export function describeAction(a: Action): string {
  switch (a.type) {
    case "send_sms":
      return `Send SMS ${q(a.message)}`;
    case "send_email":
      return `Send email ${q(a.subject)}`;
    case "add_tags":
      return `Add tags ${a.tags.map(q).join(", ")}`;
    case "remove_tags":
      return `Remove tags ${a.tags.map(q).join(", ")}`;
    case "assign_user":
      return `Assign to ${a.mode === "round_robin" && a.user_ids.length > 1 ? "next of " : ""}${a.user_ids.join(", ")}${a.also_assign_opportunities ? " (and open deals)" : ""}`;
    case "create_opportunity":
      return `Create deal in stage ${q(a.stage)}${a.monetary_value ? ` worth ${a.monetary_value}` : ""}${a.skip_if_open ? " (unless one is already open)" : ""}`;
    case "move_opportunity":
      return `Move deal to stage ${q(a.stage)}`;
    case "set_opportunity_status":
      return `Mark deal ${a.status}`;
    case "create_task":
      return `Create task ${q(a.title)} due in ${a.due_in_hours}h for ${a.assign_to === "contact_owner" ? "the contact owner" : a.assign_to}`;
    case "add_note":
      return `Add note ${q(a.body)}`;
    case "add_to_workflow":
      return `Enroll in GHL workflow ${a.workflow_id}`;
    case "remove_from_workflow":
      return `Remove from GHL workflow ${a.workflow_id}`;
    case "webhook":
      return `POST to ${a.url}`;
    case "wait":
      return `Wait ${[a.days && `${a.days}d`, a.hours && `${a.hours}h`, a.minutes && `${a.minutes}m`].filter(Boolean).join(" ") || "0m"}`;
    case "stop_if": {
      const c = a.condition;
      const parts = [
        c.replied && "the contact replied",
        c.has_tag && `contact has tag ${q(c.has_tag)}`,
        c.missing_tag && `contact lacks tag ${q(c.missing_tag)}`,
        c.opportunity_status_in?.length && `deal is ${c.opportunity_status_in.join("/")}`,
        c.contact_filter && "contact matches filter",
      ].filter(Boolean);
      return `Stop if ${parts.join(" or ") || "(no condition)"}`;
    }
  }
}

export function describeAutomation(d: AutomationDefinition): string {
  const lines = [describeTrigger(d.trigger)];
  const c = d.conditions;
  if (c) {
    const conds = [
      c.contact_filter && "contact matches filter",
      c.min_score !== undefined && `lead score ≥ ${c.min_score}`,
      c.opportunity && "deal matches filter",
      c.business_hours && `actions wait for business hours (${c.business_hours.start}-${c.business_hours.end} ${c.business_hours.timezone})`,
    ].filter(Boolean);
    if (conds.length) lines.push(`Only if: ${conds.join("; ")}`);
  }
  d.actions.forEach((a, i) => lines.push(`${i + 1}. ${describeAction(a)}`));
  const s = settingsSchema.parse(d.settings ?? {});
  lines.push(`Limits: ${s.once_per_contact ? "once per contact, " : ""}max ${s.max_actions_per_hour} actions/hour`);
  return lines.join("\n");
}

export function waitMs(a: Extract<Action, { type: "wait" }>): number {
  return ((a.days ?? 0) * 1440 + (a.hours ?? 0) * 60 + (a.minutes ?? 0)) * 60_000;
}
