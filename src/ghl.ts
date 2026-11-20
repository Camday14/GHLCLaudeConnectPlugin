import { GhlClient } from "./client.js";
import { iso, toMs } from "./util.js";

/** Friendly contact filter, translated into GHL's advanced search filters (and re-checked client-side). */
export interface ContactFilter {
  query?: string;
  tags_any?: string[];
  tags_all?: string[];
  exclude_tags?: string[];
  assigned_to?: string;
  unassigned?: boolean;
  source?: string;
  created_after?: string;
  created_before?: string;
  updated_after?: string;
  updated_before?: string;
  has_email?: boolean;
  has_phone?: boolean;
  /** Raw GHL advanced-search filter objects, appended as-is. */
  raw_filters?: unknown[];
}

export interface SearchResult<T> {
  items: T[];
  total?: number;
  truncated: boolean;
}

const CACHE_TTL = 5 * 60 * 1000;

export class GhlData {
  private cache = new Map<string, { at: number; value: unknown }>();
  constructor(public client: GhlClient) {}

  get locationId() {
    return this.client.locationId;
  }

  private async cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value as T;
    const value = await fn();
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  invalidate(prefix?: string) {
    for (const k of [...this.cache.keys()]) if (!prefix || k.startsWith(prefix)) this.cache.delete(k);
  }

  // ---------- metadata ----------
  pipelines(): Promise<any[]> {
    return this.cached("pipelines", async () => (await this.client.get("/opportunities/pipelines", { locationId: this.locationId })).pipelines ?? []);
  }
  users(): Promise<any[]> {
    return this.cached("users", async () => (await this.client.get("/users/", { locationId: this.locationId })).users ?? []);
  }
  customFields(): Promise<any[]> {
    return this.cached("customFields", async () => (await this.client.get(`/locations/${this.locationId}/customFields`)).customFields ?? []);
  }
  tags(): Promise<any[]> {
    return this.cached("tags", async () => (await this.client.get(`/locations/${this.locationId}/tags`)).tags ?? []);
  }
  workflows(): Promise<any[]> {
    return this.cached("workflows", async () => (await this.client.get("/workflows/", { locationId: this.locationId })).workflows ?? []);
  }
  calendars(): Promise<any[]> {
    return this.cached("calendars", async () => (await this.client.get("/calendars/", { locationId: this.locationId })).calendars ?? []);
  }

  async userNames(): Promise<Record<string, string>> {
    try {
      const users = await this.users();
      return Object.fromEntries(users.map((u: any) => [u.id, u.name || [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || u.id]));
    } catch {
      return {}; // users.readonly scope missing: fall back to IDs
    }
  }

  /** Map of custom field key (e.g. "lead_score", without "contact.") -> id, for merge fields. */
  async customFieldKeyMap(): Promise<Record<string, string>> {
    try {
      const fields = await this.customFields();
      const out: Record<string, string> = {};
      for (const f of fields) {
        if (f.fieldKey) out[String(f.fieldKey).replace(/^contact\./, "")] = f.id;
      }
      return out;
    } catch {
      return {};
    }
  }

  async stageIndex(): Promise<Record<string, { pipelineId: string; pipelineName: string; stageName: string; position: number }>> {
    const out: Record<string, any> = {};
    for (const p of await this.pipelines()) {
      (p.stages ?? []).forEach((s: any, i: number) => {
        out[s.id] = { pipelineId: p.id, pipelineName: p.name, stageName: s.name, position: s.position ?? i };
      });
    }
    return out;
  }

  // ---------- contacts ----------
  buildContactFilters(f: ContactFilter): unknown[] {
    const filters: unknown[] = [];
    if (f.tags_any?.length) {
      filters.push({ group: "OR", filters: f.tags_any.map((t) => ({ field: "tags", operator: "eq", value: t })) });
    }
    for (const t of f.tags_all ?? []) filters.push({ field: "tags", operator: "eq", value: t });
    for (const t of f.exclude_tags ?? []) filters.push({ field: "tags", operator: "not_eq", value: t });
    if (f.assigned_to) filters.push({ field: "assignedTo", operator: "eq", value: f.assigned_to });
    if (f.unassigned) filters.push({ field: "assignedTo", operator: "not_exists" });
    if (f.source) filters.push({ field: "source", operator: "eq", value: f.source });
    if (f.created_after || f.created_before) {
      filters.push({ field: "dateAdded", operator: "range", value: { gte: iso(toMs(f.created_after)), lte: iso(toMs(f.created_before)) } });
    }
    if (f.updated_after || f.updated_before) {
      filters.push({ field: "dateUpdated", operator: "range", value: { gte: iso(toMs(f.updated_after)), lte: iso(toMs(f.updated_before)) } });
    }
    if (f.has_email) filters.push({ field: "email", operator: "exists" });
    if (f.has_phone) filters.push({ field: "phone", operator: "exists" });
    if (f.raw_filters?.length) filters.push(...f.raw_filters);
    return filters;
  }

  /** Client-side re-check of the friendly filters, so results are correct even if the API interprets a filter loosely. */
  matchesFilter(c: any, f: ContactFilter): boolean {
    const tags = new Set<string>((c.tags ?? []).map((t: string) => t.toLowerCase()));
    const has = (t: string) => tags.has(t.toLowerCase());
    if (f.tags_any?.length && !f.tags_any.some(has)) return false;
    if (f.tags_all?.length && !f.tags_all.every(has)) return false;
    if (f.exclude_tags?.some(has)) return false;
    if (f.assigned_to && c.assignedTo !== undefined && c.assignedTo !== f.assigned_to) return false;
    if (f.unassigned && c.assignedTo) return false;
    if (f.has_email && !c.email) return false;
    if (f.has_phone && !c.phone) return false;
    const added = toMs(c.dateAdded);
    if (added !== undefined) {
      if (f.created_after && added < toMs(f.created_after)!) return false;
      if (f.created_before && added > toMs(f.created_before)!) return false;
    }
    return true;
  }

  async searchContacts(f: ContactFilter, limit = 100): Promise<SearchResult<any>> {
    const pageLimit = Math.min(100, Math.max(1, limit));
    const filters = this.buildContactFilters(f);
    const items: any[] = [];
    let page = 1;
    let searchAfter: unknown;
    let total: number | undefined;
    for (;;) {
      const body: Record<string, unknown> = {
        locationId: this.locationId,
        pageLimit,
        sort: [{ field: "dateAdded", direction: "desc" }],
      };
      if (f.query) body.query = f.query;
      if (filters.length) body.filters = filters;
      if (searchAfter) body.searchAfter = searchAfter;
      else body.page = page;
      const res = await this.client.post("/contacts/search", body);
      const batch: any[] = res.contacts ?? [];
      total = res.total ?? total;
      for (const c of batch) if (this.matchesFilter(c, f)) items.push(c);
      if (items.length >= limit) return { items: items.slice(0, limit), total, truncated: true };
      if (batch.length < pageLimit) break;
      if (total !== undefined && page * pageLimit >= total) break;
      const last = batch[batch.length - 1];
      searchAfter = last?.searchAfter;
      page++;
    }
    return { items, total, truncated: false };
  }

  async getContact(id: string): Promise<any> {
    return (await this.client.get(`/contacts/${id}`)).contact;
  }

  /** Resolve targets from explicit IDs and/or a filter. */
  async resolveContacts(ids: string[] | undefined, filter: ContactFilter | undefined, limit: number): Promise<any[]> {
    const out = new Map<string, any>();
    for (const id of ids ?? []) out.set(id, await this.getContact(id));
    if (filter && Object.values(filter).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0))) {
      const res = await this.searchContacts(filter, limit);
      for (const c of res.items) if (!out.has(c.id)) out.set(c.id, c);
    }
    return [...out.values()].filter(Boolean);
  }

  // ---------- opportunities ----------
  async searchOpportunities(
    q: { pipeline_id?: string; stage_id?: string; status?: string; assigned_to?: string; contact_id?: string; query?: string },
    limit = 100,
  ): Promise<SearchResult<any>> {
    const items: any[] = [];
    let startAfter: unknown;
    let startAfterId: unknown;
    let total: number | undefined;
    for (;;) {
      const res = await this.client.get("/opportunities/search", {
        location_id: this.locationId,
        pipeline_id: q.pipeline_id,
        pipeline_stage_id: q.stage_id,
        status: q.status ?? "all",
        assigned_to: q.assigned_to,
        contact_id: q.contact_id,
        q: q.query,
        limit: Math.min(100, limit),
        startAfter: startAfter as any,
        startAfterId: startAfterId as any,
      });
      const batch: any[] = res.opportunities ?? [];
      total = res.meta?.total ?? total;
      items.push(...batch);
      if (items.length >= limit) return { items: items.slice(0, limit), total, truncated: true };
      if (!batch.length || !res.meta?.startAfterId || (total !== undefined && items.length >= total)) break;
      if (res.meta.startAfterId === startAfterId) break;
      startAfter = res.meta.startAfter;
      startAfterId = res.meta.startAfterId;
    }
    return { items, total, truncated: false };
  }

  // ---------- conversations ----------
  /**
   * Scan messages in a date range across conversations (newest first).
   * GHL has no location-wide message/call report endpoint, so this walks conversations whose last
   * message is inside or after the range and pulls their messages.
   */
  async scanMessages(opts: { start: number; end: number; types?: string[]; maxConversations?: number; contactId?: string }) {
    const maxConv = opts.maxConversations ?? 300;
    const messages: any[] = [];
    let scanned = 0;
    let truncated = false;
    let startAfterDate: number | undefined;
    outer: for (;;) {
      const res = await this.client.get("/conversations/search", {
        locationId: this.locationId,
        contactId: opts.contactId,
        limit: 100,
        sort: "desc",
        sortBy: "last_message_date",
        startAfterDate,
      });
      const convs: any[] = res.conversations ?? [];
      if (!convs.length) break;
      for (const conv of convs) {
        const lastDate = toMs(conv.lastMessageDate) ?? 0;
        if (lastDate && lastDate < opts.start) break outer;
        if (scanned >= maxConv) {
          truncated = true;
          break outer;
        }
        scanned++;
        let lastMessageId: string | undefined;
        for (let pages = 0; pages < 20; pages++) {
          const mres = await this.client.get(`/conversations/${conv.id}/messages`, {
            limit: 100,
            lastMessageId,
            type: opts.types?.join(","),
          });
          const box = mres.messages ?? {};
          const list: any[] = Array.isArray(box) ? box : box.messages ?? [];
          let reachedOlder = false;
          for (const m of list) {
            const t = toMs(m.dateAdded) ?? 0;
            if (t < opts.start) {
              reachedOlder = true;
              continue;
            }
            if (t > opts.end) continue;
            if (opts.types?.length && m.messageType && !opts.types.includes(m.messageType)) continue;
            messages.push({ ...m, _contactName: conv.fullName ?? conv.contactName, _conversationId: conv.id });
          }
          if (reachedOlder || !box.nextPage || !box.lastMessageId || !list.length) break;
          lastMessageId = box.lastMessageId;
        }
      }
      const last = convs[convs.length - 1];
      const next = toMs(last?.lastMessageDate);
      if (convs.length < 100 || !next || next === startAfterDate) break;
      startAfterDate = next;
    }
    return { messages, conversationsScanned: scanned, truncated };
  }
}
