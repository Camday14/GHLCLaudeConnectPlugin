import { z } from "zod";
import { runConfirmable } from "../confirm.js";
import { confirmTokenArg, defineTool, type ToolDef } from "../context.js";
import { contactFilterSchema } from "../schemas.js";
import { compactContact, normalizeEmail, normalizePhone, toMs } from "../util.js";
import { summarize } from "./contacts.js";

const ruleSchema = z.object({
  type: z.enum([
    "has_tag",
    "missing_tag",
    "source_is",
    "field_equals",
    "field_exists",
    "created_within_days",
    "created_older_than_days",
    "updated_within_days",
    "has_email",
    "has_phone",
    "unassigned",
    "has_open_opportunity",
    "opportunity_value_at_least",
  ]),
  value: z.union([z.string(), z.number()]).optional().describe("Tag, source, field value, number of days, or amount depending on type"),
  field: z.string().optional().describe("For field_* rules: standard field name (e.g. city) or custom field ID / key"),
  points: z.number().describe("Points added when the rule matches (can be negative)"),
});

type Rule = z.infer<typeof ruleSchema>;

const DEFAULT_RULES: Rule[] = [
  { type: "has_phone", points: 10 },
  { type: "has_email", points: 10 },
  { type: "created_within_days", value: 7, points: 20 },
  { type: "updated_within_days", value: 3, points: 15 },
  { type: "has_open_opportunity", points: 20 },
  { type: "created_older_than_days", value: 90, points: -15 },
];

const DEFAULT_BUCKETS = [
  { name: "hot", min_score: 50 },
  { name: "warm", min_score: 25 },
  { name: "cold", min_score: Number.NEGATIVE_INFINITY },
];

export function scoreContact(
  c: any,
  rules: Rule[],
  oppsByContact: Map<string, any[]>,
  cfKeyToId: Record<string, string>,
  now = Date.now(),
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const tags = new Set<string>((c.tags ?? []).map((t: string) => t.toLowerCase()));
  const days = (iso: unknown) => {
    const t = toMs(iso as any);
    return t === undefined ? undefined : (now - t) / 86_400_000;
  };
  const fieldValue = (field?: string) => {
    if (!field) return undefined;
    if (c[field] !== undefined) return c[field];
    const id = cfKeyToId[field.replace(/^contact\./, "")] ?? field;
    const cf = (c.customFields ?? []).find((f: any) => f.id === id);
    return cf?.value ?? cf?.field_value;
  };
  const opps = (oppsByContact.get(c.id) ?? []).filter((o) => o.status === "open");
  for (const r of rules) {
    let hit = false;
    const v = r.value;
    switch (r.type) {
      case "has_tag":
        hit = tags.has(String(v).toLowerCase());
        break;
      case "missing_tag":
        hit = !tags.has(String(v).toLowerCase());
        break;
      case "source_is":
        hit = String(c.source ?? "").toLowerCase() === String(v).toLowerCase();
        break;
      case "field_equals": {
        const fv = fieldValue(r.field);
        hit = fv !== undefined && String(fv).toLowerCase() === String(v).toLowerCase();
        break;
      }
      case "field_exists": {
        const fv = fieldValue(r.field);
        hit = fv !== undefined && fv !== null && String(fv).trim() !== "";
        break;
      }
      case "created_within_days": {
        const d = days(c.dateAdded);
        hit = d !== undefined && d <= Number(v);
        break;
      }
      case "created_older_than_days": {
        const d = days(c.dateAdded);
        hit = d !== undefined && d > Number(v);
        break;
      }
      case "updated_within_days": {
        const d = days(c.dateUpdated ?? c.lastActivity);
        hit = d !== undefined && d <= Number(v);
        break;
      }
      case "has_email":
        hit = !!c.email;
        break;
      case "has_phone":
        hit = !!c.phone;
        break;
      case "unassigned":
        hit = !c.assignedTo;
        break;
      case "has_open_opportunity":
        hit = opps.length > 0;
        break;
      case "opportunity_value_at_least":
        hit = opps.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0) >= Number(v);
        break;
    }
    if (hit) {
      score += r.points;
      reasons.push(`${r.type}${r.field ? `(${r.field})` : ""}${v !== undefined ? `=${v}` : ""}: ${r.points >= 0 ? "+" : ""}${r.points}`);
    }
  }
  return { score, reasons };
}

export const leadTools: ToolDef<any>[] = [
  defineTool({
    name: "sort_leads",
    title: "Sort / score leads",
    description:
      "Rank and bucket leads (e.g. hot/warm/cold) using scoring rules over tags, source, custom fields, recency, and opportunities. Read-only. Follow up with add_tags or bulk_assign_leads to act on the result. If no rules are given, a sensible default (contactability + recency + open deals) is used.",
    schema: {
      filter: contactFilterSchema.optional(),
      rules: z.array(ruleSchema).optional(),
      buckets: z
        .array(z.object({ name: z.string(), min_score: z.number() }))
        .optional()
        .describe("Bucket by score, highest threshold first wins. Default: hot>=50, warm>=25, else cold"),
      max_contacts: z.number().int().min(1).max(10000).default(500),
      return_top: z.number().int().min(1).max(1000).default(50),
    },
    handler: async ({ filter, rules, buckets, max_contacts, return_top }, { data }) => {
      const useRules = rules?.length ? rules : DEFAULT_RULES;
      const useBuckets = [...(buckets?.length ? buckets : DEFAULT_BUCKETS)].sort((a, b) => b.min_score - a.min_score);
      const { items, truncated } = await data.searchContacts(filter ?? {}, max_contacts);
      const needOpps = useRules.some((r) => r.type === "has_open_opportunity" || r.type === "opportunity_value_at_least");
      const oppsByContact = new Map<string, any[]>();
      if (needOpps) {
        const opps = await data.searchOpportunities({ status: "open" }, 5000);
        for (const o of opps.items) {
          const id = o.contactId ?? o.contact?.id;
          if (!id) continue;
          if (!oppsByContact.has(id)) oppsByContact.set(id, []);
          oppsByContact.get(id)!.push(o);
        }
      }
      const cfKeyToId = await data.customFieldKeyMap();
      const scored = items
        .map((c) => {
          const { score, reasons } = scoreContact(c, useRules, oppsByContact, cfKeyToId);
          const bucket = useBuckets.find((b) => score >= b.min_score)?.name ?? "unbucketed";
          return { score, bucket, reasons, contact: compactContact(c) };
        })
        .sort((a, b) => b.score - a.score);
      const bucketCounts: Record<string, number> = {};
      const bucketIds: Record<string, string[]> = {};
      for (const s of scored) {
        bucketCounts[s.bucket] = (bucketCounts[s.bucket] ?? 0) + 1;
        (bucketIds[s.bucket] ??= []).push(s.contact.id);
      }
      return {
        contacts_scored: scored.length,
        truncated,
        rules_used: useRules,
        bucket_counts: bucketCounts,
        contact_ids_by_bucket: bucketIds,
        top: scored.slice(0, return_top),
      };
    },
  }),

  defineTool({
    name: "bulk_assign_leads",
    title: "Assign leads to users",
    description:
      "Assign contacts to sales users. Strategies: round_robin across user_ids, or explicit assignments. Optionally also reassigns the contacts' open opportunities and adds tags.",
    write: true,
    schema: {
      strategy: z.enum(["round_robin", "explicit"]).default("round_robin"),
      user_ids: z.array(z.string()).optional().describe("For round_robin: users to rotate through (see list_users)"),
      assignments: z.array(z.object({ contact_id: z.string(), user_id: z.string() })).optional().describe("For explicit strategy"),
      contact_ids: z.array(z.string()).optional(),
      filter: contactFilterSchema.optional(),
      also_assign_open_opportunities: z.boolean().default(false),
      add_tags: z.array(z.string()).optional(),
      max_contacts: z.number().int().min(1).max(10000).default(500),
      ...confirmTokenArg,
    },
    handler: async (args, ctx) => {
      const names = await ctx.data.userNames();
      let pairs: Array<{ contact_id: string; user_id: string }>;
      let contacts: any[] = [];
      if (args.strategy === "explicit") {
        if (!args.assignments?.length) throw new Error("explicit strategy needs `assignments`");
        pairs = args.assignments;
      } else {
        if (!args.user_ids?.length) throw new Error("round_robin strategy needs `user_ids`");
        contacts = await ctx.data.resolveContacts(args.contact_ids, args.filter, args.max_contacts);
        contacts.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        pairs = contacts.map((c, i) => ({ contact_id: c.id, user_id: args.user_ids![i % args.user_ids!.length] }));
      }
      const plan = {
        pairs: [...pairs].sort((a, b) => a.contact_id.localeCompare(b.contact_id)),
        also_assign_open_opportunities: args.also_assign_open_opportunities,
        add_tags: args.add_tags ?? [],
      };
      const perUser: Record<string, number> = {};
      for (const p of plan.pairs) perUser[names[p.user_id] ?? p.user_id] = (perUser[names[p.user_id] ?? p.user_id] ?? 0) + 1;
      const byId = new Map(contacts.map((c) => [c.id, c]));
      return runConfirmable(
        ctx.confirm,
        {
          tool: "bulk_assign_leads",
          plan,
          count: plan.pairs.length,
          preview: {
            action: "ASSIGN contacts to users" + (plan.also_assign_open_opportunities ? " (and their open opportunities)" : "") + (plan.add_tags.length ? ` and add tags [${plan.add_tags.join(", ")}]` : ""),
            per_user: perUser,
            sample: plan.pairs.slice(0, 10).map((p) => ({
              contact: byId.get(p.contact_id) ? compactContact(byId.get(p.contact_id)).name : p.contact_id,
              contact_id: p.contact_id,
              assign_to: names[p.user_id] ?? p.user_id,
            })),
          },
          execute: async (p) => {
            const results = [];
            for (const pair of p.pairs) {
              try {
                await ctx.client.put(`/contacts/${pair.contact_id}`, { assignedTo: pair.user_id });
                if (p.add_tags.length) await ctx.client.post(`/contacts/${pair.contact_id}/tags`, { tags: p.add_tags });
                if (p.also_assign_open_opportunities) {
                  const opps = await ctx.data.searchOpportunities({ contact_id: pair.contact_id, status: "open" }, 50);
                  for (const o of opps.items) await ctx.client.put(`/opportunities/${o.id}`, { assignedTo: pair.user_id });
                }
                results.push({ id: pair.contact_id, ok: true });
              } catch (e) {
                results.push({ id: pair.contact_id, ok: false, error: (e as Error).message });
              }
            }
            return summarize(results);
          },
        },
        args.confirm_token,
      );
    },
  }),

  defineTool({
    name: "find_duplicates",
    title: "Find duplicate contacts",
    description: "Find contacts sharing the same email or phone number (normalized). Read-only. Returns duplicate groups so they can be reviewed/merged in GHL.",
    schema: {
      filter: contactFilterSchema.optional(),
      max_contacts: z.number().int().min(1).max(20000).default(2000),
    },
    handler: async ({ filter, max_contacts }, { data, config }) => {
      const { items, truncated } = await data.searchContacts(filter ?? {}, max_contacts);
      const groups = new Map<string, any[]>();
      for (const c of items) {
        const keys = new Set<string>();
        const e = normalizeEmail(c.email);
        const p = normalizePhone(c.phone, config.defaultCountryCode);
        if (e) keys.add(`email:${e}`);
        if (p) keys.add(`phone:${p}`);
        for (const k of keys) {
          if (!groups.has(k)) groups.set(k, []);
          groups.get(k)!.push(c);
        }
      }
      const dupes = [...groups.entries()]
        .filter(([, cs]) => cs.length > 1)
        .map(([key, cs]) => ({ match: key, count: cs.length, contacts: cs.map(compactContact) }))
        .sort((a, b) => b.count - a.count);
      return { contacts_checked: items.length, truncated, duplicate_groups: dupes.length, groups: dupes.slice(0, 200) };
    },
  }),
];
