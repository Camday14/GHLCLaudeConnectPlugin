import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { defineTool, type ToolDef } from "../context.js";
import { dateRangeSchema } from "../schemas.js";
import { dateRange, groupCount, iso, round, toMs } from "../util.js";
import { compactOpp } from "./pipelines.js";

// ---------- pure computations (unit-tested) ----------

export function classifyCall(m: any): "answered" | "missed" | "voicemail" | "other" {
  const status = String(m.meta?.call?.status ?? m.status ?? "").toLowerCase();
  const duration = Number(m.meta?.call?.duration ?? 0);
  if (status.includes("voicemail")) return "voicemail";
  if (["completed", "answered", "in-progress"].includes(status)) return duration > 0 || m.meta?.call?.duration === undefined ? "answered" : "missed";
  if (["no-answer", "busy", "failed", "canceled", "cancelled", "missed", "no_answer"].includes(status)) return "missed";
  return "other";
}

export function summarizeCalls(calls: any[], names: Record<string, string>) {
  const byUser: Record<string, { calls: number; outbound: number; inbound: number; answered: number; missed: number; voicemail: number; talk_seconds: number }> = {};
  let talk = 0;
  const outcomes: Record<string, number> = {};
  for (const m of calls) {
    const outcome = classifyCall(m);
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    const dur = Number(m.meta?.call?.duration ?? 0) || 0;
    talk += dur;
    const user = m.userId ? names[m.userId] ?? m.userId : "(unattributed)";
    const u = (byUser[user] ??= { calls: 0, outbound: 0, inbound: 0, answered: 0, missed: 0, voicemail: 0, talk_seconds: 0 });
    u.calls++;
    if (m.direction === "outbound") u.outbound++;
    else if (m.direction === "inbound") u.inbound++;
    if (outcome === "answered") u.answered++;
    if (outcome === "missed") u.missed++;
    if (outcome === "voicemail") u.voicemail++;
    u.talk_seconds += dur;
  }
  const answered = outcomes.answered ?? 0;
  return {
    total_calls: calls.length,
    by_direction: groupCount(calls, (m) => m.direction),
    by_outcome: outcomes,
    answer_rate: calls.length ? round(answered / calls.length, 3) : 0,
    total_talk_minutes: round(talk / 60, 1),
    avg_answered_call_minutes: answered ? round(talk / 60 / answered, 2) : 0,
    by_user: Object.fromEntries(
      Object.entries(byUser)
        .sort((a, b) => b[1].calls - a[1].calls)
        .map(([k, v]) => [k, { ...v, talk_minutes: round(v.talk_seconds / 60, 1) }]),
    ),
  };
}

export function summarizePipeline(
  opps: any[],
  pipelines: any[],
  names: Record<string, string>,
  range: { start: number; end: number },
  staleDays: number,
  now = Date.now(),
) {
  const num = (v: unknown) => Number(v) || 0;
  const inRange = (t: unknown) => {
    const ms = toMs(t as any);
    return ms !== undefined && ms >= range.start && ms <= range.end;
  };
  const report = pipelines.map((p: any) => {
    const po = opps.filter((o) => o.pipelineId === p.id);
    const open = po.filter((o) => o.status === "open");
    const stages = (p.stages ?? []).map((s: any) => {
      const so = open.filter((o) => o.pipelineStageId === s.id);
      return { stage: s.name, open_deals: so.length, open_value: so.reduce((t, o) => t + num(o.monetaryValue), 0) };
    });
    const closedIn = (status: string) => po.filter((o) => o.status === status && inRange(o.lastStatusChangeAt ?? o.updatedAt));
    const won = closedIn("won");
    const lost = closedIn("lost");
    const abandoned = closedIn("abandoned");
    return {
      pipeline: p.name,
      pipeline_id: p.id,
      open_deals: open.length,
      open_value: open.reduce((t, o) => t + num(o.monetaryValue), 0),
      stages,
      in_period: {
        created: po.filter((o) => inRange(o.createdAt)).length,
        won: won.length,
        won_value: won.reduce((t, o) => t + num(o.monetaryValue), 0),
        lost: lost.length,
        lost_value: lost.reduce((t, o) => t + num(o.monetaryValue), 0),
        abandoned: abandoned.length,
        win_rate: won.length + lost.length ? round(won.length / (won.length + lost.length), 3) : null,
      },
    };
  });

  const byOwner: Record<string, { open_deals: number; open_value: number; won: number; won_value: number; lost: number }> = {};
  for (const o of opps) {
    const owner = o.assignedTo ? names[o.assignedTo] ?? o.assignedTo : "(unassigned)";
    const b = (byOwner[owner] ??= { open_deals: 0, open_value: 0, won: 0, won_value: 0, lost: 0 });
    if (o.status === "open") {
      b.open_deals++;
      b.open_value += num(o.monetaryValue);
    } else if (inRange(o.lastStatusChangeAt ?? o.updatedAt)) {
      if (o.status === "won") {
        b.won++;
        b.won_value += num(o.monetaryValue);
      } else if (o.status === "lost") b.lost++;
    }
  }

  const staleCutoff = now - staleDays * 86_400_000;
  const stale = opps
    .filter((o) => o.status === "open")
    .map((o) => ({ o, last: toMs(o.lastStageChangeAt ?? o.updatedAt ?? o.createdAt) ?? 0 }))
    .filter((x) => x.last < staleCutoff)
    .sort((a, b) => a.last - b.last);

  return { pipelines: report, by_owner: byOwner, stale_count: stale.length, stale };
}

// ---------- tools ----------

export const reportTools: ToolDef<any>[] = [
  defineTool({
    name: "pipeline_report",
    title: "Pipeline report",
    description:
      "Sales pipeline status: open deals and value per stage, deals created/won/lost and win rate in a period, per-owner breakdown, and stale deals with no stage change in N days.",
    schema: {
      pipeline_id: z.string().optional().describe("Default: all pipelines"),
      ...dateRangeSchema,
      assigned_to: z.string().optional(),
      stale_days: z.number().int().min(1).default(14),
      max_opportunities: z.number().int().min(1).max(20000).default(5000),
    },
    handler: async (a, { data }) => {
      const range = dateRange(a.start_date, a.end_date);
      const pipelines = (await data.pipelines()).filter((p: any) => !a.pipeline_id || p.id === a.pipeline_id);
      const { items, truncated } = await data.searchOpportunities({ pipeline_id: a.pipeline_id, status: "all", assigned_to: a.assigned_to }, a.max_opportunities);
      const names = await data.userNames();
      const stages = await data.stageIndex();
      const s = summarizePipeline(items, pipelines, names, range, a.stale_days);
      return {
        period: { start: iso(range.start), end: iso(range.end) },
        opportunities_analyzed: items.length,
        truncated,
        pipelines: s.pipelines,
        by_owner: s.by_owner,
        stale_deals: { count: s.stale_count, threshold_days: a.stale_days, oldest: s.stale.slice(0, 25).map((x) => compactOpp(x.o, stages, names)) },
      };
    },
  }),

  defineTool({
    name: "call_report",
    title: "Call report",
    description:
      "Summarize phone calls in a period: totals, inbound/outbound, answered/missed/voicemail, answer rate, talk time, and per-user breakdown. Built from conversation call logs (GHL has no public call-reporting API), so numbers may differ slightly from the in-app Call Reporting dashboard. Large periods scan many conversations; use max_conversations to bound it.",
    schema: {
      ...dateRangeSchema,
      user_id: z.string().optional().describe("Only calls handled by this user"),
      contact_id: z.string().optional(),
      max_conversations: z.number().int().min(1).max(5000).default(300),
      include_call_list: z.boolean().default(false).describe("Also return individual calls (up to 200)"),
    },
    handler: async (a, { data }) => {
      const range = dateRange(a.start_date, a.end_date, 7);
      const scan = await data.scanMessages({ ...range, types: ["TYPE_CALL"], maxConversations: a.max_conversations, contactId: a.contact_id });
      const calls = scan.messages.filter((m) => !a.user_id || m.userId === a.user_id);
      const names = await data.userNames();
      return {
        period: { start: iso(range.start), end: iso(range.end) },
        conversations_scanned: scan.conversationsScanned,
        incomplete: scan.truncated ? "Stopped at max_conversations; older calls in the period may be missing. Increase max_conversations for a complete count." : undefined,
        ...summarizeCalls(calls, names),
        calls: a.include_call_list
          ? calls.slice(0, 200).map((m) => ({
              message_id: m.id,
              date: m.dateAdded,
              contact: m._contactName,
              contact_id: m.contactId,
              direction: m.direction,
              outcome: classifyCall(m),
              status: m.meta?.call?.status ?? m.status,
              duration_seconds: m.meta?.call?.duration,
              user: m.userId ? names[m.userId] ?? m.userId : undefined,
            }))
          : undefined,
      };
    },
  }),

  defineTool({
    name: "get_call_details",
    title: "Get call transcript / recording",
    description: "Get the transcript of a recorded call (if transcription is enabled in GHL) and optionally save the recording audio to a local file.",
    schema: {
      message_id: z.string().describe("Call message ID (from call_report with include_call_list, or get_conversation_messages)"),
      save_recording_to: z.string().optional().describe("Absolute path to save the recording, e.g. /Users/me/Desktop/call.wav"),
    },
    handler: async (a, { client, data }) => {
      const out: Record<string, unknown> = { message_id: a.message_id };
      try {
        const t = await client.get(`/conversations/locations/${data.locationId}/messages/${a.message_id}/transcription`);
        const lines = Array.isArray(t) ? t : t.transcriptions ?? t.data ?? t;
        out.transcript = Array.isArray(lines)
          ? lines.map((l: any) => `${l.mediaChannel === 1 ? "Agent" : l.mediaChannel === 2 ? "Contact" : `Ch${l.mediaChannel ?? "?"}`}: ${l.transcript ?? l.text ?? ""}`).join("\n")
          : lines;
      } catch (e) {
        out.transcript_error = (e as Error).message;
      }
      if (a.save_recording_to) {
        try {
          const res: Response = await client.request("GET", `/conversations/messages/${a.message_id}/locations/${data.locationId}/recording`, { raw: true });
          const buf = Buffer.from(await res.arrayBuffer());
          await writeFile(a.save_recording_to, buf);
          out.recording_saved_to = a.save_recording_to;
          out.recording_bytes = buf.length;
        } catch (e) {
          out.recording_error = (e as Error).message;
        }
      }
      return out;
    },
  }),

  defineTool({
    name: "activity_summary",
    title: "Activity summary",
    description: "Snapshot of sales activity in a period: new leads (by source and owner), messages sent/received by channel, and appointments by status.",
    schema: {
      ...dateRangeSchema,
      max_contacts: z.number().int().min(1).max(20000).default(5000),
      include_messages: z.boolean().default(true),
      max_conversations: z.number().int().min(1).max(5000).default(300),
      include_appointments: z.boolean().default(true),
    },
    handler: async (a, { data, client }) => {
      const range = dateRange(a.start_date, a.end_date, 7);
      const names = await data.userNames();
      const leads = await data.searchContacts({ created_after: iso(range.start), created_before: iso(range.end) }, a.max_contacts);
      const out: Record<string, unknown> = {
        period: { start: iso(range.start), end: iso(range.end) },
        new_leads: {
          total: leads.items.length,
          truncated: leads.truncated,
          by_source: groupCount(leads.items, (c) => c.source),
          by_owner: groupCount(leads.items, (c) => (c.assignedTo ? names[c.assignedTo] ?? c.assignedTo : "(unassigned)")),
        },
      };
      if (a.include_messages) {
        const scan = await data.scanMessages({ ...range, maxConversations: a.max_conversations });
        const by: Record<string, { inbound: number; outbound: number }> = {};
        for (const m of scan.messages) {
          const type = String(m.messageType ?? m.type).replace(/^TYPE_/, "");
          const b = (by[type] ??= { inbound: 0, outbound: 0 });
          if (m.direction === "inbound") b.inbound++;
          else b.outbound++;
        }
        out.messages = { by_channel: by, conversations_scanned: scan.conversationsScanned, incomplete: scan.truncated || undefined };
      }
      if (a.include_appointments) {
        try {
          const cals = await data.calendars();
          const events: any[] = [];
          for (const cal of cals) {
            const r = await client.get("/calendars/events", { locationId: data.locationId, calendarId: cal.id, startTime: range.start, endTime: range.end });
            events.push(...(r.events ?? []).map((e: any) => ({ ...e, _calendar: cal.name })));
          }
          out.appointments = {
            total: events.length,
            by_status: groupCount(events, (e) => e.appointmentStatus ?? e.status),
            by_calendar: groupCount(events, (e) => e._calendar),
            by_user: groupCount(events, (e) => (e.assignedUserId ? names[e.assignedUserId] ?? e.assignedUserId : "(none)")),
          };
        } catch (e) {
          out.appointments_error = (e as Error).message;
        }
      }
      return out;
    },
  }),

  defineTool({
    name: "revenue_summary",
    title: "Revenue summary",
    description: "Payments collected through GHL in a period (from payment transactions): gross revenue, refunds, count, by source type, by day, and top customers.",
    schema: { ...dateRangeSchema, max_transactions: z.number().int().min(1).max(20000).default(5000) },
    handler: async (a, { client, data }) => {
      const range = dateRange(a.start_date, a.end_date);
      const tx: any[] = [];
      let offset = 0;
      let total: number | undefined;
      while (tx.length < a.max_transactions) {
        const r = await client.get("/payments/transactions", {
          altId: data.locationId,
          altType: "location",
          startAt: iso(range.start),
          endAt: iso(range.end),
          limit: 100,
          offset,
        });
        const batch: any[] = r.data ?? r.transactions ?? [];
        total = r.totalCount ?? total;
        tx.push(...batch);
        if (batch.length < 100 || (total !== undefined && tx.length >= total)) break;
        offset += 100;
      }
      const inPeriod = tx.filter((t) => {
        const ms = toMs(t.createdAt);
        return ms === undefined || (ms >= range.start && ms <= range.end);
      });
      const succeeded = inPeriod.filter((t) => ["succeeded", "paid", "completed"].includes(String(t.status).toLowerCase()));
      const refunded = inPeriod.filter((t) => String(t.status).toLowerCase().includes("refund"));
      const sum = (arr: any[], f = (t: any) => Number(t.amount) || 0) => round(arr.reduce((s, t) => s + f(t), 0));
      const byCurrency: Record<string, number> = {};
      const byDay: Record<string, number> = {};
      const byCustomer: Record<string, number> = {};
      for (const t of succeeded) {
        const cur = String(t.currency ?? "").toUpperCase() || "?";
        byCurrency[cur] = round((byCurrency[cur] ?? 0) + (Number(t.amount) || 0));
        const day = String(t.createdAt ?? "").slice(0, 10);
        byDay[day] = round((byDay[day] ?? 0) + (Number(t.amount) || 0));
        const cust = t.contactName ?? t.contactEmail ?? t.contactId ?? "(unknown)";
        byCustomer[cust] = round((byCustomer[cust] ?? 0) + (Number(t.amount) || 0));
      }
      return {
        period: { start: iso(range.start), end: iso(range.end) },
        transactions: inPeriod.length,
        successful_payments: succeeded.length,
        gross_revenue: sum(succeeded),
        gross_by_currency: byCurrency,
        refunds: { count: refunded.length, amount: sum(refunded, (t) => Number(t.amountRefunded ?? t.amount) || 0) },
        by_status: groupCount(inPeriod, (t) => t.status),
        by_source: groupCount(succeeded, (t) => t.entitySourceType ?? t.entityType),
        by_day: byDay,
        top_customers: Object.entries(byCustomer)
          .sort((x, y) => y[1] - x[1])
          .slice(0, 10)
          .map(([customer, amount]) => ({ customer, amount })),
        truncated: tx.length >= a.max_transactions || undefined,
      };
    },
  }),
];
