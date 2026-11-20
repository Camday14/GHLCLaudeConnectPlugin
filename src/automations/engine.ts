import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { GhlClient } from "../core/client.js";
import { GhlData } from "../core/ghl.js";
import { DEFAULT_RULES, scoreContact } from "../core/tools/leads.js";
import { blockReason } from "../core/tools/messaging.js";
import { compactContact, renderTemplate, sha256, toMs } from "../core/util.js";
import type { ConnectionStore } from "../remote/connections.js";
import type { Db, Queryable } from "../remote/db.js";
import {
  automationDefinitionSchema,
  settingsSchema,
  waitMs,
  type Action,
  type AutomationDefinition,
  type Conditions,
  type StopCondition,
  type StoredAutomation,
  type Trigger,
} from "./schema.js";

export type EventType =
  | "contact_created"
  | "tag_added"
  | "tag_removed"
  | "opportunity_created"
  | "opportunity_stage_changed"
  | "opportunity_status_changed"
  | "inbound_message"
  | "appointment_booked"
  | "appointment_status_changed"
  | "task_completed";

export interface NormalizedEvent {
  type: EventType;
  locationId: string;
  contactId?: string;
  opportunityId?: string;
  tag?: string;
  pipelineId?: string;
  stageId?: string;
  status?: string;
  channel?: string;
  body?: string;
  calendarId?: string;
  appointmentId?: string;
  startTime?: string;
  source?: string;
}

interface Subject {
  contactId?: string;
  opportunityId?: string;
}

interface LogEntry {
  at: string;
  step?: number;
  action?: string;
  ok: boolean;
  detail: string;
}

export const MAX_CHAIN_DEPTH = 5;
const SELF_ACTION_WINDOW_MIN = 10;

export interface EngineOptions {
  readOnly?: boolean;
  pollIntervalMs?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Runs Claude-created automations: GHL webhook/poll/schedule triggers → conditions → actions,
 * with dry-run mode, rate caps, loop protection and delayed steps.
 */
export class AutomationEngine {
  private pending = new Set<Promise<unknown>>();
  private dataCache = new Map<string, { data: GhlData; at: number }>();
  private lastPoll = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private now: () => number;
  private log: (msg: string) => void;

  constructor(
    private db: Db,
    private connections: ConnectionStore,
    private opts: EngineOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(`[automations] ${m}`));
  }

  // ======================================================================
  // GHL access
  // ======================================================================
  dataFor(locationId: string): GhlData {
    const hit = this.dataCache.get(locationId);
    if (hit && this.now() - hit.at < 5 * 60_000) return hit.data;
    const data = new GhlData(this.connections.client(locationId));
    this.dataCache.set(locationId, { data, at: this.now() });
    return data;
  }

  private client(locationId: string): GhlClient {
    return this.dataFor(locationId).client;
  }

  // ======================================================================
  // CRUD
  // ======================================================================
  /** Validate a definition and resolve stage names to IDs. Returns the resolved definition and warnings. */
  async resolve(locationId: string, input: unknown): Promise<{ definition: AutomationDefinition; warnings: string[] }> {
    const def = automationDefinitionSchema.parse(input);
    const data = this.dataFor(locationId);
    const warnings: string[] = [];
    const stages = await data.stageIndex().catch(() => ({}) as Record<string, any>);
    const resolveStage = (stage: string | undefined, pipelineId: string | undefined, where: string) => {
      if (!stage) return { stage, pipelineId };
      if ((stages as any)[stage]) return { stage, pipelineId: pipelineId ?? (stages as any)[stage].pipelineId };
      const m = Object.entries(stages).filter(([, s]: any) => s.stageName.toLowerCase() === stage.toLowerCase() && (!pipelineId || s.pipelineId === pipelineId));
      if (m.length === 1) return { stage: m[0][0], pipelineId: (m[0][1] as any).pipelineId };
      throw new Error(`${where}: stage "${stage}" ${m.length ? "exists in several pipelines; add pipeline_id" : "was not found (see list_pipelines)"}.`);
    };

    const t: any = def.trigger;
    if ((t.type === "opportunity_created" || t.type === "opportunity_stage_changed") && t.stage) Object.assign(t, mapStage(resolveStage(t.stage, t.pipeline_id, "trigger")));
    if (t.type === "schedule") {
      try {
        new Cron(t.cron, { timezone: t.timezone, paused: true });
      } catch (e) {
        throw new Error(`trigger.cron is invalid: ${(e as Error).message}`);
      }
      if (t.target.kind === "opportunities" && t.target.stage) Object.assign(t.target, mapStage(resolveStage(t.target.stage, t.target.pipeline_id, "schedule target")));
    }
    if (def.conditions?.opportunity?.stage) Object.assign(def.conditions.opportunity, mapStage(resolveStage(def.conditions.opportunity.stage, def.conditions.opportunity.pipeline_id, "conditions.opportunity")));
    if (def.conditions?.business_hours) checkTimezone(def.conditions.business_hours.timezone);
    if (t.type === "schedule") checkTimezone(t.timezone);

    const users = await data.users().catch(() => undefined);
    const workflows = await data.workflows().catch(() => undefined);
    def.actions.forEach((a: any, i) => {
      const where = `actions[${i}] (${a.type})`;
      if (a.type === "create_opportunity" || a.type === "move_opportunity") Object.assign(a, mapStage(resolveStage(a.stage, a.pipeline_id, where)));
      if (a.type === "assign_user" && users) {
        for (const u of a.user_ids) if (!users.some((x: any) => x.id === u)) warnings.push(`${where}: user ID ${u} not found (see list_users).`);
      }
      if (a.type === "create_task" && a.assign_to !== "contact_owner" && users && !users.some((x: any) => x.id === a.assign_to)) warnings.push(`${where}: user ID ${a.assign_to} not found.`);
      if ((a.type === "add_to_workflow" || a.type === "remove_from_workflow") && workflows) {
        const wf = workflows.find((w: any) => w.id === a.workflow_id);
        if (!wf) warnings.push(`${where}: workflow ${a.workflow_id} not found (see list_workflows).`);
        else if (wf.status && wf.status !== "published") warnings.push(`${where}: workflow "${wf.name}" is ${wf.status}, not published.`);
      }
    });
    if (def.actions.some((a) => a.type === "send_sms" || a.type === "send_email") && !def.conditions?.business_hours) {
      warnings.push("Messages will send at any hour. Consider conditions.business_hours.");
    }
    const needsContact = def.actions.some((a) => !["wait", "webhook", "stop_if", "move_opportunity", "set_opportunity_status"].includes(a.type));
    if (needsContact && t.type === "schedule" && t.target.kind === "opportunities") warnings.push("Contact actions use each deal's contact.");
    return { definition: def, warnings };
  }

  /**
   * Record which contacts currently have a tag, so a later "tag added" event for a contact we've never seen
   * can be trusted. Runs when a tag-triggered automation is created, updated or re-enabled.
   */
  async prepareTrigger(locationId: string, definition: AutomationDefinition) {
    const t = definition.trigger;
    if (t.type !== "tag_added" && t.type !== "tag_removed") return;
    const tag = t.tag.toLowerCase();
    const seeded = ((await this.getSetting(locationId, "seeded_tags")) as string[] | undefined) ?? [];
    if (seeded.includes(tag)) return;
    const res = await this.dataFor(locationId).searchContacts({ tags_any: [t.tag] }, 10_000);
    for (const c of res.items) {
      await this.db.query(
        `INSERT INTO contact_snapshots (location_id, contact_id, tags) VALUES ($1,$2,$3) ON CONFLICT (location_id, contact_id) DO NOTHING`,
        [locationId, c.id, JSON.stringify(c.tags ?? [])],
      );
    }
    await this.setSetting(locationId, "seeded_tags", [...seeded, tag]);
  }

  async create(locationId: string, definition: AutomationDefinition): Promise<StoredAutomation> {
    await this.prepareTrigger(locationId, definition);
    const id = `auto_${randomUUID().slice(0, 8)}`;
    await this.db.query(
      `INSERT INTO automations (id, location_id, name, definition, enabled, mode, created_at, updated_at) VALUES ($1,$2,$3,$4,true,'dry_run',$5,$5)`,
      [id, locationId, definition.name, JSON.stringify(definition), new Date(this.now())],
    );
    return (await this.get(locationId, id))!;
  }

  async update(locationId: string, id: string, definition: AutomationDefinition) {
    await this.prepareTrigger(locationId, definition);
    await this.db.query(`UPDATE automations SET definition=$3, name=$4, updated_at=now() WHERE id=$1 AND location_id=$2`, [id, locationId, JSON.stringify(definition), definition.name]);
    return this.get(locationId, id);
  }

  async get(locationId: string, id: string): Promise<StoredAutomation | undefined> {
    const { rows } = await this.db.query(`SELECT * FROM automations WHERE id=$1 AND location_id=$2`, [id, locationId]);
    return rows[0];
  }

  async list(locationId: string): Promise<StoredAutomation[]> {
    const { rows } = await this.db.query(`SELECT * FROM automations WHERE location_id=$1 ORDER BY created_at`, [locationId]);
    return rows;
  }

  async setState(locationId: string, id: string, state: { enabled?: boolean; mode?: "dry_run" | "live" }) {
    await this.db.query(
      `UPDATE automations SET enabled=COALESCE($3, enabled), mode=COALESCE($4, mode), updated_at=now() WHERE id=$1 AND location_id=$2`,
      [id, locationId, state.enabled ?? null, state.mode ?? null],
    );
    if (state.enabled === false) await this.cancelWaiting(locationId, id);
    return this.get(locationId, id);
  }

  async remove(locationId: string, id: string) {
    await this.cancelWaiting(locationId, id);
    await this.db.query(`DELETE FROM automations WHERE id=$1 AND location_id=$2`, [id, locationId]);
  }

  async pauseAll(locationId: string): Promise<number> {
    const { rows } = await this.db.query(`UPDATE automations SET enabled=false, updated_at=now() WHERE location_id=$1 AND enabled=true RETURNING id`, [locationId]);
    for (const r of rows) await this.cancelWaiting(locationId, r.id);
    return rows.length;
  }

  private async cancelWaiting(locationId: string, automationId: string) {
    await this.db.query(
      `UPDATE jobs SET status='cancelled' WHERE status='pending' AND run_id IN (SELECT id FROM automation_runs WHERE automation_id=$1 AND location_id=$2)`,
      [automationId, locationId],
    );
    await this.db.query(`UPDATE automation_runs SET status='cancelled', updated_at=now() WHERE automation_id=$1 AND location_id=$2 AND status IN ('waiting','running')`, [
      automationId,
      locationId,
    ]);
  }

  async history(locationId: string, opts: { automationId?: string; status?: string; limit?: number }) {
    const { rows } = await this.db.query(
      `SELECT r.*, a.name AS automation_name FROM automation_runs r LEFT JOIN automations a ON a.id=r.automation_id
       WHERE r.location_id=$1 AND ($2::text IS NULL OR r.automation_id=$2) AND ($3::text IS NULL OR r.status=$3)
       ORDER BY r.started_at DESC LIMIT $4`,
      [locationId, opts.automationId ?? null, opts.status ?? null, opts.limit ?? 50],
    );
    return rows;
  }

  async stats(automationId: string) {
    const { rows } = await this.db.query(
      `SELECT status, count(*)::int AS n FROM automation_runs WHERE automation_id=$1 AND started_at > now() - interval '7 days' GROUP BY status`,
      [automationId],
    );
    return Object.fromEntries(rows.map((r: any) => [r.status, r.n]));
  }

  // ======================================================================
  // Webhooks → events
  // ======================================================================
  /** Entry point for GHL webhooks. Returns quickly; processing continues in the background. */
  acceptWebhook(payload: any, rawBody: string): Promise<{ accepted: boolean; reason?: string }> {
    const p = this.handleWebhook(payload, rawBody).catch((e) => {
      this.log(`webhook processing failed: ${(e as Error).message}`);
      return { accepted: false, reason: (e as Error).message };
    });
    this.track(p);
    return p;
  }

  async handleWebhook(payload: any, rawBody: string): Promise<{ accepted: boolean; reason?: string }> {
    const locationId: string | undefined = payload?.locationId ?? payload?.location_id;
    if (!locationId || !payload?.type) return { accepted: false, reason: "missing locationId/type" };
    const conn = await this.connections.get(locationId);
    if (!conn || conn.status !== "active") return { accepted: false, reason: "location not connected" };
    const key = `wh:${payload.webhookId ?? sha256(rawBody)}`;
    const ins = await this.db.query(`INSERT INTO processed_events (event_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_key`, [key]);
    if (!ins.rows.length) return { accepted: false, reason: "duplicate" };
    await this.setSetting(locationId, "last_webhook_at", this.now());
    const events = await this.normalize(locationId, payload);
    for (const e of events) await this.dispatch(e);
    return { accepted: true };
  }

  async normalize(locationId: string, p: any): Promise<NormalizedEvent[]> {
    const base = { locationId };
    switch (p.type) {
      case "ContactCreate": {
        const tags: string[] = p.tags ?? [];
        await this.saveTags(locationId, p.id, tags);
        return [
          { ...base, type: "contact_created", contactId: p.id, source: p.source },
          ...tags.map((tag) => ({ ...base, type: "tag_added" as const, contactId: p.id, tag })),
        ];
      }
      case "ContactTagUpdate":
      case "ContactUpdate": {
        if (!Array.isArray(p.tags)) return [];
        return this.tagDiff(locationId, p.id, p.tags);
      }
      case "OpportunityCreate":
        await this.saveOpp(locationId, p.id, p.pipelineStageId, p.status);
        return [{ ...base, type: "opportunity_created", opportunityId: p.id, contactId: p.contactId, pipelineId: p.pipelineId, stageId: p.pipelineStageId, status: p.status }];
      case "OpportunityStageUpdate": {
        const prev = await this.getOpp(locationId, p.id);
        await this.saveOpp(locationId, p.id, p.pipelineStageId, p.status);
        if (prev && prev.stage_id === p.pipelineStageId) return [];
        return [{ ...base, type: "opportunity_stage_changed", opportunityId: p.id, contactId: p.contactId, pipelineId: p.pipelineId, stageId: p.pipelineStageId, status: p.status }];
      }
      case "OpportunityStatusUpdate": {
        const prev = await this.getOpp(locationId, p.id);
        await this.saveOpp(locationId, p.id, p.pipelineStageId, p.status);
        if (prev && prev.status === p.status) return [];
        return [{ ...base, type: "opportunity_status_changed", opportunityId: p.id, contactId: p.contactId, pipelineId: p.pipelineId, stageId: p.pipelineStageId, status: p.status }];
      }
      case "InboundMessage":
        return [{ ...base, type: "inbound_message", contactId: p.contactId, channel: normChannel(p.messageType), body: p.body ?? "" }];
      case "AppointmentCreate":
      case "AppointmentUpdate": {
        const a = p.appointment ?? p;
        const ev: NormalizedEvent = {
          ...base,
          type: p.type === "AppointmentCreate" ? "appointment_booked" : "appointment_status_changed",
          contactId: a.contactId,
          calendarId: a.calendarId,
          appointmentId: a.id,
          status: a.appointmentStatus ?? a.status,
          startTime: a.startTime,
        };
        return [ev];
      }
      case "TaskComplete":
        return [{ ...base, type: "task_completed", contactId: p.contactId }];
      default:
        return [];
    }
  }

  private async tagDiff(locationId: string, contactId: string, tags: string[]): Promise<NormalizedEvent[]> {
    const { rows } = await this.db.query(`SELECT tags FROM contact_snapshots WHERE location_id=$1 AND contact_id=$2`, [locationId, contactId]);
    let prev: string[] = rows[0]?.tags ?? [];
    if (!rows.length) {
      // First time we see this contact. For tags we've "seeded" (recorded every contact that had them when the
      // automation was created), absence of a snapshot means the contact didn't have the tag, so it was just added.
      // For any other tag we can't tell, so assume it was already there; this never fires on old tags.
      const seeded = new Set(((await this.getSetting(locationId, "seeded_tags")) as string[] | undefined) ?? []);
      prev = tags.filter((t) => !seeded.has(t.toLowerCase()));
    }
    await this.saveTags(locationId, contactId, tags);
    const lower = (a: string[]) => new Set(a.map((t) => t.toLowerCase()));
    const prevSet = lower(prev);
    const curSet = lower(tags);
    const added = tags.filter((t) => !prevSet.has(t.toLowerCase()));
    const removed = rows.length ? prev.filter((t) => !curSet.has(t.toLowerCase())) : [];
    return [
      ...added.map((tag) => ({ locationId, type: "tag_added" as const, contactId, tag })),
      ...removed.map((tag) => ({ locationId, type: "tag_removed" as const, contactId, tag })),
    ];
  }

  private async saveTags(locationId: string, contactId: string, tags: string[]) {
    await this.db.query(
      `INSERT INTO contact_snapshots (location_id, contact_id, tags, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (location_id, contact_id) DO UPDATE SET tags=$3, updated_at=now()`,
      [locationId, contactId, JSON.stringify(tags ?? [])],
    );
  }

  private async getOpp(locationId: string, id: string) {
    const { rows } = await this.db.query(`SELECT * FROM opportunity_snapshots WHERE location_id=$1 AND opportunity_id=$2`, [locationId, id]);
    return rows[0] as { stage_id: string; status: string } | undefined;
  }

  private async saveOpp(locationId: string, id: string, stageId?: string, status?: string) {
    await this.db.query(
      `INSERT INTO opportunity_snapshots (location_id, opportunity_id, stage_id, status, updated_at) VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (location_id, opportunity_id) DO UPDATE SET stage_id=COALESCE($3, opportunity_snapshots.stage_id), status=COALESCE($4, opportunity_snapshots.status), updated_at=now()`,
      [locationId, id, stageId ?? null, status ?? null],
    );
  }

  /** Match an event against enabled automations and start runs. */
  async dispatch(e: NormalizedEvent): Promise<string[]> {
    let origin: { automation_id: string; depth: number } | undefined;
    if (e.contactId) {
      const { rows } = await this.db.query(
        `SELECT automation_id, depth FROM self_actions WHERE location_id=$1 AND contact_id=$2 AND action_key=$3 AND at > $4 ORDER BY at DESC LIMIT 1`,
        [e.locationId, e.contactId, eventKey(e), new Date(this.now() - SELF_ACTION_WINDOW_MIN * 60_000)],
      );
      origin = rows[0];
      if (origin && origin.depth + 1 >= MAX_CHAIN_DEPTH) {
        this.log(`dropping ${e.type} for ${e.contactId}: automation chain depth limit reached`);
        return [];
      }
    }
    const { rows } = await this.db.query(
      `SELECT * FROM automations WHERE location_id=$1 AND enabled=true AND definition->'trigger'->>'type' = $2`,
      [e.locationId, e.type],
    );
    const started: string[] = [];
    for (const a of rows as StoredAutomation[]) {
      if (origin?.automation_id === a.id) continue; // an automation never re-triggers itself
      if (!triggerMatches(a.definition.trigger, e)) continue;
      const runId = await this.startRun(a, { contactId: e.contactId, opportunityId: e.opportunityId }, e, origin ? origin.depth + 1 : 0);
      if (runId) started.push(runId);
    }
    return started;
  }

  // ======================================================================
  // Runs
  // ======================================================================
  private settingsFor(a: StoredAutomation) {
    const s = settingsSchema.parse(a.definition.settings ?? {});
    if (a.definition.trigger.type === "schedule" && a.definition.settings?.once_per_contact === undefined) s.once_per_contact = false;
    return s;
  }

  async startRun(a: StoredAutomation, subject: Subject, event: unknown, depth = 0, opts: { manual?: boolean } = {}): Promise<string | undefined> {
    const settings = this.settingsFor(a);
    if (settings.once_per_contact && subject.contactId && !opts.manual) {
      const { rows } = await this.db.query(`SELECT 1 FROM automation_runs WHERE automation_id=$1 AND contact_id=$2 AND status <> 'skipped' LIMIT 1`, [a.id, subject.contactId]);
      if (rows.length) return undefined;
    }
    const data = this.dataFor(a.location_id);
    let contact: any;
    let opp: any;
    try {
      if (subject.opportunityId) opp = (await data.client.get(`/opportunities/${subject.opportunityId}`)).opportunity;
      const contactId = subject.contactId ?? opp?.contactId ?? opp?.contact?.id;
      if (contactId) contact = await data.getContact(contactId);
      subject = { contactId, opportunityId: subject.opportunityId };
    } catch (err) {
      return this.insertRun(a, subject, event, depth, "failed", `Couldn't load the contact/deal: ${(err as Error).message}`);
    }
    const reason = await this.checkConditions(data, a.definition.conditions, contact, opp);
    if (reason) return this.insertRun(a, subject, event, depth, "skipped", reason);
    const runId = await this.insertRun(a, subject, event, depth, "running");
    await this.executeRun(runId);
    return runId;
  }

  private async insertRun(a: StoredAutomation, subject: Subject, event: unknown, depth: number, status: string, error?: string) {
    const id = `run_${randomUUID().slice(0, 12)}`;
    await this.db.query(
      `INSERT INTO automation_runs (id, automation_id, location_id, contact_id, opportunity_id, mode, status, trigger_event, depth, error, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [id, a.id, a.location_id, subject.contactId ?? null, subject.opportunityId ?? null, a.mode, status, JSON.stringify(event ?? null), depth, error ?? null, new Date(this.now())],
    );
    return id;
  }

  async checkConditions(data: GhlData, c: Conditions | undefined, contact: any, opp: any): Promise<string | undefined> {
    if (!c) return undefined;
    if (c.contact_filter) {
      if (!contact) return "no contact to check the contact filter against";
      if (!data.matchesFilter(contact, c.contact_filter)) return "contact did not match the contact filter";
    }
    if (c.min_score !== undefined) {
      if (!contact) return "no contact to score";
      const rules = (c.score_rules?.length ? c.score_rules : DEFAULT_RULES) as any[];
      const oppsByContact = new Map<string, any[]>();
      if (rules.some((r) => String(r.type).includes("opportunit"))) {
        oppsByContact.set(contact.id, (await data.searchOpportunities({ contact_id: contact.id, status: "open" }, 50)).items);
      }
      const { score } = scoreContact(contact, rules, oppsByContact, await data.customFieldKeyMap(), this.now());
      if (score < c.min_score) return `lead score ${score} is below ${c.min_score}`;
    }
    if (c.opportunity) {
      const o = c.opportunity;
      let candidates: any[] = opp ? [opp] : [];
      if (!opp && contact) candidates = (await data.searchOpportunities({ contact_id: contact.id, status: o.status ?? "open" }, 50)).items;
      const ok = candidates.some(
        (x) =>
          (!o.pipeline_id || x.pipelineId === o.pipeline_id) &&
          (!o.stage || x.pipelineStageId === o.stage) &&
          (!o.status || x.status === o.status) &&
          (o.min_value === undefined || Number(x.monetaryValue ?? 0) >= o.min_value),
      );
      if (!ok) return "no deal matched the deal conditions";
    }
    return undefined;
  }

  private async loadRun(runId: string) {
    const { rows } = await this.db.query(`SELECT * FROM automation_runs WHERE id=$1`, [runId]);
    return rows[0];
  }

  private async saveRun(runId: string, fields: Record<string, unknown>) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k}=$${i + 2}`).join(", ");
    const vals = keys.map((k) => (k === "log" || k === "vars" ? JSON.stringify(fields[k]) : fields[k]));
    await this.db.query(`UPDATE automation_runs SET ${sets}, updated_at=now() WHERE id=$1`, [runId, ...vals]);
  }

  /** Execute (or continue) a run from its current step until it finishes, waits, or fails. */
  async executeRun(runId: string): Promise<void> {
    const run = await this.loadRun(runId);
    if (!run || !["running", "waiting"].includes(run.status)) return;
    const a = (await this.db.query(`SELECT * FROM automations WHERE id=$1`, [run.automation_id])).rows[0] as StoredAutomation | undefined;
    const log: LogEntry[] = run.log ?? [];
    const stamp = () => new Date(this.now()).toISOString();
    if (!a || !a.enabled) {
      await this.saveRun(runId, { status: "cancelled", log: [...log, { at: stamp(), ok: false, detail: "Automation was disabled or deleted." }] });
      return;
    }
    const mode: "dry_run" | "live" = run.mode === "live" && !this.opts.readOnly ? "live" : "dry_run";
    const data = this.dataFor(a.location_id);
    const env: RunEnv = {
      data,
      client: data.client,
      automation: a,
      run,
      mode,
      contact: undefined,
      opp: undefined,
      cf: {},
    };
    try {
      if (run.opportunity_id) env.opp = (await data.client.get(`/opportunities/${run.opportunity_id}`)).opportunity;
      if (run.contact_id) env.contact = await data.getContact(run.contact_id);
      env.cf = await data.customFieldKeyMap();
    } catch (err) {
      await this.saveRun(runId, { status: "failed", error: `Couldn't load the contact/deal: ${(err as Error).message}`, log });
      return;
    }
    const settings = this.settingsFor(a);
    const actions = a.definition.actions;
    for (let step = run.step; step < actions.length; step++) {
      const action = actions[step];
      if (action.type === "wait") {
        const ms = waitMs(action);
        if (mode === "dry_run") {
          log.push({ at: stamp(), step, action: "wait", ok: true, detail: `[dry run] would wait ${fmtDuration(ms)} here` });
          continue;
        }
        const runAt = new Date(this.now() + ms);
        await this.db.query(`INSERT INTO jobs (run_id, run_at) VALUES ($1,$2)`, [runId, runAt]);
        log.push({ at: stamp(), step, action: "wait", ok: true, detail: `waiting until ${runAt.toISOString()}` });
        await this.saveRun(runId, { status: "waiting", step: step + 1, log, opportunity_id: env.run.opportunity_id ?? null });
        return;
      }
      if (action.type === "stop_if") {
        const why = await this.stopReason(env, action.condition);
        log.push({ at: stamp(), step, action: "stop_if", ok: true, detail: why ? `stopped: ${why}` : "continue (condition not met)" });
        if (why) {
          await this.saveRun(runId, { status: "stopped", step: step + 1, log });
          return;
        }
        continue;
      }
      const bh = a.definition.conditions?.business_hours;
      if (bh && (action.type === "send_sms" || action.type === "send_email")) {
        const next = nextBusinessTime(this.now(), bh);
        if (next > this.now()) {
          if (mode === "dry_run") {
            log.push({ at: stamp(), step, action: "wait", ok: true, detail: `[dry run] would wait for business hours (until ${new Date(next).toISOString()})` });
          } else {
            await this.db.query(`INSERT INTO jobs (run_id, run_at) VALUES ($1,$2)`, [runId, new Date(next)]);
            log.push({ at: stamp(), step, action: "wait", ok: true, detail: `outside business hours; waiting until ${new Date(next).toISOString()}` });
            await this.saveRun(runId, { status: "waiting", step, log });
            return;
          }
        }
      }
      if (mode === "live") {
        const { rows } = await this.db.query(`SELECT count(*)::int AS n FROM automation_actions WHERE automation_id=$1 AND at > $2`, [a.id, new Date(this.now() - 3_600_000)]);
        if (rows[0].n >= settings.max_actions_per_hour) {
          log.push({ at: stamp(), step, action: action.type, ok: false, detail: `rate limit reached (${settings.max_actions_per_hour} actions/hour); run stopped` });
          await this.saveRun(runId, { status: "rate_limited", step, log, error: "rate limit reached" });
          return;
        }
      }
      try {
        const detail = await this.perform(action, env);
        log.push({ at: stamp(), step, action: action.type, ok: true, detail: (mode === "dry_run" ? "[dry run] would " : "") + detail });
        if (mode === "live") {
          await this.db.query(`INSERT INTO automation_actions (automation_id, at) VALUES ($1,$2)`, [a.id, new Date(this.now())]);
          await this.recordSelfAction(env, action);
        }
      } catch (err) {
        log.push({ at: stamp(), step, action: action.type, ok: false, detail: (err as Error).message });
        await this.saveRun(runId, { status: "failed", step, log, error: (err as Error).message, opportunity_id: env.run.opportunity_id ?? null });
        return;
      }
      await this.saveRun(runId, { step: step + 1, log, opportunity_id: env.run.opportunity_id ?? null });
    }
    await this.saveRun(runId, { status: "completed", step: actions.length, log, opportunity_id: env.run.opportunity_id ?? null });
  }

  /** Dry-run an automation definition against a contact/deal without saving anything. */
  async simulate(locationId: string, def: AutomationDefinition, subject: Subject, event?: NormalizedEvent) {
    const data = this.dataFor(locationId);
    let opp: any;
    let contact: any;
    if (subject.opportunityId) opp = (await data.client.get(`/opportunities/${subject.opportunityId}`)).opportunity;
    const contactId = subject.contactId ?? opp?.contactId;
    if (contactId) contact = await data.getContact(contactId);
    const trace: string[] = [];
    if (event) trace.push(triggerMatches(def.trigger, event) ? "Trigger: matches the sample event" : "Trigger: would NOT fire for the sample event");
    const reason = await this.checkConditions(data, def.conditions, contact, opp);
    if (reason) return { would_run: false, reason, contact: compactContact(contact) };
    const a: StoredAutomation = { id: "simulation", location_id: locationId, name: def.name, definition: def, enabled: true, mode: "dry_run" };
    const env: RunEnv = {
      data,
      client: data.client,
      automation: a,
      run: { id: "simulation", started_at: new Date(this.now()), contact_id: contactId, opportunity_id: subject.opportunityId, trigger_event: event },
      mode: "dry_run",
      contact,
      opp,
      cf: await data.customFieldKeyMap(),
    };
    for (const [i, action] of def.actions.entries()) {
      if (action.type === "wait") {
        trace.push(`${i + 1}. wait ${fmtDuration(waitMs(action))}`);
        continue;
      }
      if (action.type === "stop_if") {
        const why = await this.stopReason(env, action.condition);
        trace.push(`${i + 1}. stop_if → ${why ? `would stop now (${why})` : "continue"}`);
        if (why) break;
        continue;
      }
      try {
        trace.push(`${i + 1}. would ${await this.perform(action, env)}`);
      } catch (e) {
        trace.push(`${i + 1}. ERROR: ${(e as Error).message}`);
        break;
      }
    }
    return { would_run: true, contact: compactContact(contact), opportunity: opp ? { id: opp.id, name: opp.name, stage: opp.pipelineStageId, status: opp.status } : undefined, steps: trace };
  }

  private async stopReason(env: RunEnv, c: StopCondition): Promise<string | undefined> {
    const tags = new Set<string>((env.contact?.tags ?? []).map((t: string) => t.toLowerCase()));
    if (c.has_tag && tags.has(c.has_tag.toLowerCase())) return `contact has tag "${c.has_tag}"`;
    if (c.missing_tag && !tags.has(c.missing_tag.toLowerCase())) return `contact lacks tag "${c.missing_tag}"`;
    if (c.opportunity_status_in?.length && env.opp && c.opportunity_status_in.includes(env.opp.status)) return `deal is ${env.opp.status}`;
    if (c.contact_filter && env.contact && env.data.matchesFilter(env.contact, c.contact_filter)) return "contact matches the stop filter";
    if (c.replied && env.contact) {
      const since = new Date(env.run.started_at).getTime();
      const scan = await env.data.scanMessages({ start: since, end: this.now(), contactId: env.contact.id, maxConversations: 5 });
      if (scan.messages.some((m) => m.direction === "inbound")) return "the contact replied";
    }
    return undefined;
  }

  private templateVars(env: RunEnv, names: Record<string, string> = {}): Record<string, unknown> {
    const ev: any = env.run.trigger_event ?? {};
    const o = env.opp;
    return {
      "automation.name": env.automation.name,
      "opportunity.name": o?.name,
      "opportunity.value": o?.monetaryValue,
      "opportunity.status": o?.status,
      "message.body": ev.body,
      "appointment.start_time": ev.startTime,
      "owner.name": env.contact?.assignedTo ? names[env.contact.assignedTo] : undefined,
    };
  }

  /** Perform one action (live) or describe it (dry run). Returns a human-readable detail string. */
  private async perform(action: Action, env: RunEnv): Promise<string> {
    const { client, contact, mode } = env;
    const live = mode === "live";
    const needContact = () => {
      if (!contact) throw new Error(`${action.type} needs a contact, but this run has none.`);
      return contact;
    };
    const names = action.type === "send_sms" || action.type === "send_email" ? await env.data.userNames() : {};
    const render = (s: string) => renderTemplate(s, contact ?? {}, env.cf, this.templateVars(env, names));
    const loc = env.automation.location_id;

    switch (action.type) {
      case "send_sms": {
        const c = needContact();
        const blocked = blockReason(c, "SMS");
        if (blocked) return `skip SMS (${blocked})`;
        const message = render(action.message);
        if (live) await client.post("/conversations/messages", { type: "SMS", contactId: c.id, message });
        return `send SMS to ${c.phone}: "${message}"`;
      }
      case "send_email": {
        const c = needContact();
        const blocked = blockReason(c, "Email");
        if (blocked) return `skip email (${blocked})`;
        const body: Record<string, unknown> = { type: "Email", contactId: c.id, subject: render(action.subject) };
        if (action.html) body.html = render(action.html);
        else body.message = render(action.message ?? "");
        if (action.email_from) body.emailFrom = action.email_from;
        if (live) await client.post("/conversations/messages", body);
        return `send email to ${c.email}: "${body.subject}"`;
      }
      case "add_tags": {
        const c = needContact();
        if (live) await client.post(`/contacts/${c.id}/tags`, { tags: action.tags });
        return `add tags ${action.tags.join(", ")}`;
      }
      case "remove_tags": {
        const c = needContact();
        if (live) await client.delete(`/contacts/${c.id}/tags`, { tags: action.tags });
        return `remove tags ${action.tags.join(", ")}`;
      }
      case "assign_user": {
        const c = needContact();
        let userId = action.user_ids[0];
        if (action.mode === "round_robin" && action.user_ids.length > 1) {
          const key = `rr:${env.automation.id}`;
          const idx = Number((await this.getSetting(loc, key)) ?? 0);
          userId = action.user_ids[idx % action.user_ids.length];
          if (live) await this.setSetting(loc, key, idx + 1);
        }
        if (live) {
          await client.put(`/contacts/${c.id}`, { assignedTo: userId });
          if (action.also_assign_opportunities) {
            const opps = await env.data.searchOpportunities({ contact_id: c.id, status: "open" }, 50);
            for (const o of opps.items) await client.put(`/opportunities/${o.id}`, { assignedTo: userId });
          }
        }
        const names2 = await env.data.userNames();
        return `assign contact to ${names2[userId] ?? userId}`;
      }
      case "create_opportunity": {
        const c = needContact();
        if (action.skip_if_open) {
          const open = await env.data.searchOpportunities({ contact_id: c.id, pipeline_id: action.pipeline_id, status: "open" }, 5);
          if (open.items.length) return `skip creating a deal (contact already has open deal "${open.items[0].name}")`;
        }
        const name = render(action.name ?? "{{contact.name}}") || c.email || c.phone || "New deal";
        if (live) {
          const res = await client.post("/opportunities/", {
            locationId: loc,
            pipelineId: action.pipeline_id,
            pipelineStageId: action.stage,
            contactId: c.id,
            name,
            status: "open",
            monetaryValue: action.monetary_value,
            assignedTo: c.assignedTo,
          });
          const opp = res.opportunity ?? res;
          if (opp?.id) {
            env.opp = opp;
            env.run.opportunity_id = opp.id;
          }
        }
        return `create deal "${name}" in stage ${await this.stageName(env, action.stage)}`;
      }
      case "move_opportunity": {
        const o = await this.targetOpp(env, action.pipeline_id);
        if (live) await client.put(`/opportunities/${o.id}`, { pipelineId: action.pipeline_id ?? o.pipelineId, pipelineStageId: action.stage });
        return `move deal "${o.name}" to stage ${await this.stageName(env, action.stage)}`;
      }
      case "set_opportunity_status": {
        const o = await this.targetOpp(env);
        if (live) await client.put(`/opportunities/${o.id}/status`, { status: action.status });
        return `mark deal "${o.name}" as ${action.status}`;
      }
      case "create_task": {
        const c = needContact();
        const assignedTo = action.assign_to === "contact_owner" ? c.assignedTo : action.assign_to;
        const due = new Date(this.now() + action.due_in_hours * 3_600_000).toISOString();
        if (live)
          await client.post(`/contacts/${c.id}/tasks`, {
            title: render(action.title),
            body: action.body ? render(action.body) : undefined,
            dueDate: due,
            completed: false,
            assignedTo,
          });
        return `create task "${render(action.title)}" due ${due}`;
      }
      case "add_note": {
        const c = needContact();
        if (live) await client.post(`/contacts/${c.id}/notes`, { body: render(action.body) });
        return `add note "${render(action.body).slice(0, 80)}"`;
      }
      case "add_to_workflow": {
        const c = needContact();
        if (live) await client.post(`/contacts/${c.id}/workflow/${action.workflow_id}`, {});
        return `enroll contact in workflow ${action.workflow_id}`;
      }
      case "remove_from_workflow": {
        const c = needContact();
        if (live) await client.delete(`/contacts/${c.id}/workflow/${action.workflow_id}`);
        return `remove contact from workflow ${action.workflow_id}`;
      }
      case "webhook": {
        const payload = {
          automation: { id: env.automation.id, name: env.automation.name },
          contact: compactContact(contact),
          opportunity: env.opp ? { id: env.opp.id, name: env.opp.name, value: env.opp.monetaryValue, stageId: env.opp.pipelineStageId, status: env.opp.status } : undefined,
          event: env.run.trigger_event,
          data: Object.fromEntries(Object.entries(action.payload ?? {}).map(([k, v]) => [k, typeof v === "string" ? render(v) : v])),
        };
        if (live) {
          const res = await (this.opts.fetchImpl ?? fetch)(action.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) throw new Error(`webhook ${action.url} returned ${res.status}`);
        }
        return `POST to ${action.url}`;
      }
      default:
        throw new Error(`Unsupported action ${(action as any).type}`);
    }
  }

  private async stageName(env: RunEnv, stageId: string) {
    const idx = await env.data.stageIndex().catch(() => ({}) as Record<string, any>);
    return idx[stageId] ? `"${idx[stageId].stageName}"` : stageId;
  }

  private async targetOpp(env: RunEnv, pipelineId?: string) {
    if (env.opp) return env.opp;
    if (!env.contact) throw new Error("No deal for this run (no contact either).");
    const open = await env.data.searchOpportunities({ contact_id: env.contact.id, pipeline_id: pipelineId, status: "open" }, 10);
    if (!open.items.length) throw new Error("The contact has no open deal to update.");
    const newest = [...open.items].sort((x, y) => (toMs(y.updatedAt ?? y.createdAt) ?? 0) - (toMs(x.updatedAt ?? x.createdAt) ?? 0))[0];
    env.opp = newest;
    env.run.opportunity_id = newest.id;
    return newest;
  }

  private async recordSelfAction(env: RunEnv, action: Action) {
    const contactId = env.contact?.id;
    if (!contactId) return;
    const keys: string[] = [];
    if (action.type === "add_tags") keys.push(...action.tags.map((t) => `tag_added:${t.toLowerCase()}`));
    if (action.type === "remove_tags") keys.push(...action.tags.map((t) => `tag_removed:${t.toLowerCase()}`));
    if (action.type === "create_opportunity") keys.push(`opportunity_created:${action.stage}`);
    if (action.type === "move_opportunity") keys.push(`opportunity_stage_changed:${action.stage}`);
    if (action.type === "set_opportunity_status") keys.push(`opportunity_status_changed:${action.status}`);
    for (const k of keys) {
      await this.db.query(`INSERT INTO self_actions (location_id, contact_id, action_key, automation_id, depth, at) VALUES ($1,$2,$3,$4,$5,$6)`, [
        env.automation.location_id,
        contactId,
        k,
        env.automation.id,
        env.run.depth ?? 0,
        new Date(this.now()),
      ]);
    }
  }

  // ======================================================================
  // Manual runs
  // ======================================================================
  async runManually(a: StoredAutomation, subjects: Subject[]): Promise<string[]> {
    const ids: string[] = [];
    for (const s of subjects) {
      const id = await this.startRun(a, s, { type: "manual" }, 0, { manual: true });
      if (id) ids.push(id);
    }
    return ids;
  }

  // ======================================================================
  // Worker: delayed steps, schedules, polling, cleanup
  // ======================================================================
  start(intervalMs = 15_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.log(`tick failed: ${(e as Error).message}`)), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runDueJobs();
      await this.runSchedules();
      await this.pollAll();
      await this.cleanup();
    } finally {
      this.ticking = false;
    }
  }

  async runDueJobs() {
    const jobs = await this.db.tx(async (q: Queryable) => {
      const { rows } = await q.query(
        `SELECT id, run_id FROM jobs WHERE status='pending' AND run_at <= $1 ORDER BY run_at LIMIT 25 FOR UPDATE SKIP LOCKED`,
        [new Date(this.now())],
      );
      if (rows.length) await q.query(`UPDATE jobs SET status='running', attempts=attempts+1 WHERE id = ANY($1::bigint[])`, [rows.map((r: any) => r.id)]);
      return rows as Array<{ id: number; run_id: string }>;
    });
    for (const j of jobs) {
      try {
        await this.executeRun(j.run_id);
        await this.db.query(`UPDATE jobs SET status='done' WHERE id=$1`, [j.id]);
      } catch (e) {
        this.log(`job ${j.id} failed: ${(e as Error).message}`);
        await this.db.query(`UPDATE jobs SET status='failed' WHERE id=$1`, [j.id]);
        await this.saveRun(j.run_id, { status: "failed", error: (e as Error).message });
      }
    }
  }

  async runSchedules() {
    const { rows } = await this.db.query(
      `SELECT a.* FROM automations a JOIN connections c ON c.location_id=a.location_id
       WHERE a.enabled=true AND c.status='active' AND a.definition->'trigger'->>'type'='schedule'`,
    );
    for (const a of rows as StoredAutomation[]) {
      const t = a.definition.trigger as Extract<Trigger, { type: "schedule" }>;
      const from = new Date(a.last_scheduled_at ?? a.created_at ?? this.now());
      let next: Date | null;
      try {
        next = new Cron(t.cron, { timezone: t.timezone, paused: true }).nextRun(from);
      } catch {
        continue;
      }
      if (!next || next.getTime() > this.now()) continue;
      await this.db.query(`UPDATE automations SET last_scheduled_at=$2 WHERE id=$1`, [a.id, new Date(this.now())]);
      try {
        const subjects = await this.scheduleTargets(a.location_id, t);
        for (const s of subjects) await this.startRun(a, s, { type: "schedule", at: new Date(this.now()).toISOString() });
      } catch (e) {
        this.log(`schedule ${a.id} failed: ${(e as Error).message}`);
      }
    }
  }

  async scheduleTargets(locationId: string, t: Extract<Trigger, { type: "schedule" }>): Promise<Subject[]> {
    const data = this.dataFor(locationId);
    if (t.target.kind === "contacts") {
      const res = await data.searchContacts(t.target.filter ?? {}, t.max_per_run);
      return res.items.map((c) => ({ contactId: c.id }));
    }
    const tg = t.target;
    const res = await data.searchOpportunities({ pipeline_id: tg.pipeline_id, stage_id: tg.stage, status: tg.status }, Math.max(t.max_per_run * 3, 300));
    let items = res.items;
    if (tg.stale_days) {
      const cutoff = this.now() - tg.stale_days * 86_400_000;
      items = items.filter((o) => (toMs(o.lastStageChangeAt ?? o.updatedAt ?? o.createdAt) ?? 0) < cutoff);
    }
    return items.slice(0, t.max_per_run).map((o) => ({ opportunityId: o.id, contactId: o.contactId ?? o.contact?.id }));
  }

  /**
   * Polling fallback for locations that don't receive webhooks (Private Integration Token logins,
   * or a Marketplace app without webhooks configured).
   */
  async pollAll() {
    const interval = this.opts.pollIntervalMs ?? 5 * 60_000;
    const { rows } = await this.db.query(
      `SELECT DISTINCT a.location_id FROM automations a JOIN connections c ON c.location_id=a.location_id
       WHERE a.enabled=true AND c.status='active' AND a.definition->'trigger'->>'type' NOT IN ('schedule','manual')`,
    );
    for (const { location_id } of rows) {
      if (this.now() - (this.lastPoll.get(location_id) ?? 0) < interval) continue;
      const lastWebhook = Number((await this.getSetting(location_id, "last_webhook_at")) ?? 0);
      if (this.now() - lastWebhook < 24 * 3_600_000) continue; // webhooks are flowing; no need to poll
      this.lastPoll.set(location_id, this.now());
      try {
        await this.pollLocation(location_id);
      } catch (e) {
        this.log(`poll ${location_id} failed: ${(e as Error).message}`);
      }
    }
  }

  async pollLocation(locationId: string) {
    const data = this.dataFor(locationId);
    const { rows } = await this.db.query(`SELECT last_poll_at FROM poll_state WHERE location_id=$1`, [locationId]);
    const first = !rows.length;
    const since = first ? this.now() - 60 * 60_000 : new Date(rows[0].last_poll_at).getTime();
    const startedAt = this.now();
    const events: NormalizedEvent[] = [];

    // Contacts: new contacts and tag changes
    const contacts = await data.searchContacts({ updated_after: new Date(since - 60_000).toISOString() }, 1000);
    for (const c of contacts.items) {
      const created = toMs(c.dateAdded) ?? 0;
      if (first) {
        await this.saveTags(locationId, c.id, c.tags ?? []);
        continue;
      }
      if (created >= since) {
        events.push({ locationId, type: "contact_created", contactId: c.id, source: c.source });
        await this.saveTags(locationId, c.id, c.tags ?? []);
        events.push(...(c.tags ?? []).map((tag: string) => ({ locationId, type: "tag_added" as const, contactId: c.id, tag })));
      } else {
        events.push(...(await this.tagDiff(locationId, c.id, c.tags ?? [])));
      }
    }

    // Opportunities: created, stage and status changes
    const opps = await data.searchOpportunities({ status: "all" }, 2000);
    for (const o of opps.items) {
      const prev = await this.getOpp(locationId, o.id);
      await this.saveOpp(locationId, o.id, o.pipelineStageId, o.status);
      if (first) continue;
      const contactId = o.contactId ?? o.contact?.id;
      const base = { locationId, opportunityId: o.id, contactId, pipelineId: o.pipelineId, stageId: o.pipelineStageId, status: o.status };
      if (!prev) {
        if ((toMs(o.createdAt) ?? 0) >= since) events.push({ ...base, type: "opportunity_created" });
        continue;
      }
      if (prev.stage_id !== o.pipelineStageId) events.push({ ...base, type: "opportunity_stage_changed" });
      if (prev.status !== o.status) events.push({ ...base, type: "opportunity_status_changed" });
    }

    // Inbound messages
    if (!first) {
      const res = await data.client.get("/conversations/search", { locationId, limit: 100, sort: "desc", sortBy: "last_message_date" });
      for (const conv of res.conversations ?? []) {
        const at = toMs(conv.lastMessageDate) ?? 0;
        if (at < since) break;
        if (conv.lastMessageDirection === "inbound") {
          events.push({ locationId, type: "inbound_message", contactId: conv.contactId, channel: normChannel(conv.lastMessageType), body: conv.lastMessageBody ?? "" });
        }
      }
    }

    await this.db.query(
      `INSERT INTO poll_state (location_id, last_poll_at) VALUES ($1,$2) ON CONFLICT (location_id) DO UPDATE SET last_poll_at=$2`,
      [locationId, new Date(startedAt)],
    );
    for (const e of events) {
      const key = `poll:${sha256(JSON.stringify({ ...e, body: undefined }) + Math.floor(startedAt / 60_000))}`;
      const ins = await this.db.query(`INSERT INTO processed_events (event_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_key`, [key]);
      if (ins.rows.length) await this.dispatch(e);
    }
    return events.length;
  }

  async cleanup() {
    const q = (sql: string) => this.db.query(sql).catch(() => undefined);
    await q(`DELETE FROM pending_auth WHERE expires_at < now()`);
    await q(`DELETE FROM auth_codes WHERE expires_at < now() - interval '1 day'`);
    await q(`DELETE FROM confirm_tokens WHERE expires_at < now()`);
    await q(`DELETE FROM tokens WHERE expires_at < now() - interval '7 days'`);
    await q(`DELETE FROM processed_events WHERE at < now() - interval '3 days'`);
    await q(`DELETE FROM self_actions WHERE at < now() - interval '1 day'`);
    await q(`DELETE FROM automation_actions WHERE at < now() - interval '2 days'`);
    await q(`DELETE FROM automation_runs WHERE status='skipped' AND started_at < now() - interval '7 days'`);
    await q(`DELETE FROM automation_runs WHERE started_at < now() - interval '90 days' AND status NOT IN ('waiting','running')`);
    await q(`DELETE FROM jobs WHERE status IN ('done','cancelled','failed') AND run_at < now() - interval '7 days'`);
  }

  // ======================================================================
  // helpers
  // ======================================================================
  private async getSetting(locationId: string, key: string): Promise<unknown> {
    const { rows } = await this.db.query(`SELECT value FROM settings WHERE location_id=$1 AND key=$2`, [locationId, key]);
    return rows[0]?.value;
  }

  private async setSetting(locationId: string, key: string, value: unknown) {
    await this.db.query(
      `INSERT INTO settings (location_id, key, value) VALUES ($1,$2,$3) ON CONFLICT (location_id, key) DO UPDATE SET value=$3`,
      [locationId, key, JSON.stringify(value)],
    );
  }

  private track(p: Promise<unknown>) {
    this.pending.add(p);
    p.finally(() => this.pending.delete(p));
  }

  /** Wait for background webhook processing (used by tests and graceful shutdown). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }
}

interface RunEnv {
  data: GhlData;
  client: GhlClient;
  automation: StoredAutomation;
  run: any;
  mode: "dry_run" | "live";
  contact: any;
  opp: any;
  cf: Record<string, string>;
}

// ---------- pure helpers (exported for tests) ----------

function mapStage(r: { stage?: string; pipelineId?: string }) {
  return { stage: r.stage, pipeline_id: r.pipelineId };
}

function checkTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error(`Unknown time zone "${tz}" (use an IANA name like America/New_York).`);
  }
}

export function normChannel(t: unknown): string {
  const s = String(t ?? "").replace(/^TYPE_/, "").toUpperCase();
  if (s === "EMAIL") return "Email";
  if (s === "LIVE_CHAT" || s === "WEBCHAT") return "Live_Chat";
  if (s === "WHATSAPP") return "WhatsApp";
  if (s === "FACEBOOK") return "FB";
  if (s === "INSTAGRAM") return "IG";
  if (s === "CALL" || s === "PHONE") return "Call";
  return s || "";
}

export function eventKey(e: NormalizedEvent): string {
  switch (e.type) {
    case "tag_added":
    case "tag_removed":
      return `${e.type}:${(e.tag ?? "").toLowerCase()}`;
    case "opportunity_created":
    case "opportunity_stage_changed":
      return `${e.type}:${e.stageId ?? ""}`;
    case "opportunity_status_changed":
      return `${e.type}:${e.status ?? ""}`;
    default:
      return e.type;
  }
}

export function triggerMatches(t: Trigger, e: NormalizedEvent): boolean {
  if (t.type !== e.type) return false;
  switch (t.type) {
    case "contact_created":
      return !t.source || (e.source ?? "").toLowerCase() === t.source.toLowerCase();
    case "tag_added":
    case "tag_removed":
      return (e.tag ?? "").toLowerCase() === t.tag.toLowerCase();
    case "opportunity_created":
    case "opportunity_stage_changed":
      return (!t.pipeline_id || e.pipelineId === t.pipeline_id) && (!t.stage || e.stageId === t.stage);
    case "opportunity_status_changed":
      return !t.status || e.status === t.status;
    case "inbound_message": {
      if (t.channel && normChannel(e.channel) !== t.channel) return false;
      if (t.keywords?.length) {
        const body = (e.body ?? "").toLowerCase();
        return t.keywords.some((k) => new RegExp(`(^|\\W)${k.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`).test(body));
      }
      return true;
    }
    case "appointment_booked":
      return !t.calendar_id || e.calendarId === t.calendar_id;
    case "appointment_status_changed":
      return (!t.status || e.status === t.status) && (!t.calendar_id || e.calendarId === t.calendar_id);
    case "task_completed":
      return true;
    default:
      return false;
  }
}

/** Returns `now` if within business hours, else the next opening time (15-minute resolution). */
export function nextBusinessTime(now: number, bh: { timezone: string; start: string; end: string; days: number[] }): number {
  const [sh, sm] = bh.start.split(":").map(Number);
  const [eh, em] = bh.end.split(":").map(Number);
  const startMin = sh * 60 + (sm || 0);
  const endMin = eh * 60 + (em || 0);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: bh.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const isOpen = (t: number) => {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(t)).map((p) => [p.type, p.value]));
    const minutes = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
    return bh.days.includes(days.indexOf(parts.weekday)) && minutes >= startMin && minutes < endMin;
  };
  if (isOpen(now)) return now;
  const step = 15 * 60_000;
  let t = Math.ceil(now / step) * step;
  for (let i = 0; i < 4 * 24 * 8; i++, t += step) if (isOpen(t)) return t;
  return now; // misconfigured (no open slot in a week): don't block forever
}

function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.round((m / 60) * 10) / 10}h`;
  return `${Math.round((m / 1440) * 10) / 10}d`;
}
