import { describe, expect, it } from "vitest";
import { GhlClient, GhlError } from "../src/core/client.js";
import { ConfirmStore } from "../src/core/confirm.js";
import { normalizePhone, renderTemplate, stableStringify } from "../src/core/util.js";
import { fakeGhl } from "./helpers.js";

describe("GhlClient", () => {
  it("sends auth + version headers and builds query strings", async () => {
    const { fetchImpl, calls } = fakeGhl({ "GET /contacts/:id": () => ({ contact: { id: "c1" } }) });
    const c = new GhlClient({ apiKey: "pit-abc", locationId: "L", fetchImpl, minIntervalMs: 0 });
    const res = await c.get("/contacts/c1", { a: 1, skip: undefined, list: ["x", "y"] });
    expect(res.contact.id).toBe("c1");
    expect(calls[0].headers.Authorization).toBe("Bearer pit-abc");
    expect(calls[0].headers.Version).toBe("2021-07-28");
    expect(calls[0].query).toEqual({ a: "1", list: "y" });
  });

  it("retries 429 using Retry-After, then succeeds", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const { fetchImpl } = fakeGhl({
      "GET /x": () => (++n < 3 ? new Response("{}", { status: 429, headers: { "retry-after": "2" } }) : { ok: true }),
    });
    const c = new GhlClient({ apiKey: "k", locationId: "L", fetchImpl, minIntervalMs: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(await c.get("/x")).toEqual({ ok: true });
    expect(sleeps.filter((s) => s === 2000)).toHaveLength(2);
  });

  it("throws GhlError with API message on 4xx (no retry)", async () => {
    const { fetchImpl, calls } = fakeGhl({ "POST /contacts/": () => new Response(JSON.stringify({ message: ["email must be an email"] }), { status: 422 }) });
    const c = new GhlClient({ apiKey: "k", locationId: "L", fetchImpl, minIntervalMs: 0 });
    await expect(c.post("/contacts/", {})).rejects.toThrow(/422: email must be an email/);
    await expect(c.post("/contacts/", {})).rejects.toBeInstanceOf(GhlError);
    expect(calls).toHaveLength(2);
  });

  it("requires credentials", () => {
    expect(() => new GhlClient({ apiKey: "", locationId: "L" })).toThrow(/GHL_API_KEY/);
  });
});

describe("ConfirmStore", () => {
  it("accepts matching plan once, rejects changed plan, wrong tool and reuse", () => {
    const s = new ConfirmStore();
    const t = s.issue("bulk_send", { b: 2, a: 1 });
    expect(() => s.redeem("other", { a: 1, b: 2 }, t)).toThrow(/belongs to/);
    s.redeem("bulk_send", { a: 1, b: 2 }, t); // key order doesn't matter
    expect(() => s.redeem("bulk_send", { a: 1, b: 2 }, t)).toThrow(/unknown or expired/);
    const t2 = s.issue("bulk_send", { a: 1 });
    expect(() => s.redeem("bulk_send", { a: 2 }, t2)).toThrow(/changed/);
  });

  it("expires tokens", () => {
    let now = 0;
    const s = new ConfirmStore(() => now);
    const t = s.issue("x", {});
    now = 11 * 60 * 1000;
    expect(() => s.redeem("x", {}, t)).toThrow(/expired/);
  });
});

describe("utils", () => {
  it("normalizes phones", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("+15551234567");
    expect(normalizePhone("1-555-123-4567")).toBe("+15551234567");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("12345")).toBeUndefined();
  });

  it("renders merge fields with fallbacks and custom fields", () => {
    const c = { firstName: "", lastName: "Cruz", customFields: [{ id: "cf1", value: "Gold" }] };
    expect(renderTemplate("Hi {{contact.first_name|there}} {{ contact.last_name }}, tier {{contact.tier}}", c, { tier: "cf1" })).toBe("Hi there Cruz, tier Gold");
  });

  it("stable stringify ignores key order", () => {
    expect(stableStringify({ b: [1, { d: 1, c: 2 }], a: 1 })).toBe(stableStringify({ a: 1, b: [1, { c: 2, d: 1 }] }));
  });
});
