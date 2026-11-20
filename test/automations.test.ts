import { beforeEach, describe, expect, it } from "vitest";
import { AutomationEngine, nextBusinessTime, triggerMatches } from "../src/automations/engine.js";
import { loadConfig } from "../src/remote/config.js";
import { ConnectionStore } from "../src/remote/connections.js";
import { connectPglite, migrate, type Db } from "../src/remote/db.js";
import { fakeGhl } from "./helpers.js";

const LOC = "LOC1";
const pipelines = [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New Lead" }, { id: "s2", name: "Qualified" }, { id: "s3", name: "Proposal" }] }];

interface World {
  db: Db;
  engine: AutomationEngine;
  calls: ReturnType<typeof fakeGhl>["calls"];
  contacts: Record<string, any>;
  opps: any[];
  inbound: any[];
  clock: { t: number };
}

async function world(): Promise<World> {
  const db = await connectPglite();
  await migrate(db);
  const contacts: Record<string, any> = {
    c1: { id: "c1", firstName: "Ann", lastName: "Lee", phone: "+15550000001", email: "ann@x.com", tags: [], assignedTo: "u1", dateAdded: "2026-11-01T00:00:00Z" },
    c2: { id: "c2", firstName: "Bob", phone: "+15550000002", tags: [], dnd: true, dateAdded: "2026-11-01T00:00:00Z" },
    c3: { id: "c3", firstName: "Cat", phone: "+15550000003", tags: [], dateAdded: "2026-11-01T00:00:00Z" },
  };
  const opps: any[] = [];
  const inbound: any[] = [];
  const clock = { t: Date.parse("2026-11-18T15:00:00Z") };
  const { fetchImpl, calls } = fakeGhl({
    "GET /contacts/:id": (c) => ({ contact: contacts[c.path.split("/").pop()!] }),
    "POST /contacts/search": () => ({ contacts: Object.values(contacts), total: Object.keys(contacts).length }),
    "POST /contacts/:id/tags": (c) => {
      const ct = contacts[c.path.split("/")[2]];
      ct.tags = [...new Set([...ct.tags, ...c.body.tags])];
      return { tags: ct.tags };
    },
    "DELETE /contacts/:id/tags": (c) => {
      const ct = contacts[c.path.split("/")[2]];
      ct.tags = ct.tags.filter((t: string) => !c.body.tags.includes(t));
      return {};
    },
    "PUT /contacts/:id": (c) => {
      Object.assign(contacts[c.path.split("/")[2]], c.body);
      return { contact: contacts[c.path.split("/")[2]] };
    },
    "POST /contacts/:id/tasks": () => ({ task: { id: "t1" } }),
    "POST /conversations/messages": () => ({ messageId: "m" }),
    "GET /opportunities/pipelines": () => ({ pipelines }),
    "GET /opportunities/search": (c) => {
      const list = opps.filter((o) => (!c.query.contact_id || o.contactId === c.query.contact_id) && (c.query.status === "all" || !c.query.status || o.status === c.query.status) && (!c.query.pipeline_stage_id || o.pipelineStageId === c.query.pipeline_stage_id));
      return { opportunities: list, meta: { total: list.length } };
    },
    "GET /opportunities/:id": (c) => ({ opportunity: opps.find((o) => o.id === c.path.split("/").pop()) }),
    "POST /opportunities/": (c) => {
      const o = { id: `o${opps.length + 1}`, ...c.body, createdAt: new Date(clock.t).toISOString() };
      opps.push(o);
      return { opportunity: o };
    },
    "PUT /opportunities/:id": (c) => {
      Object.assign(opps.find((o) => o.id === c.path.split("/")[2]), c.body);
      return {};
    },
    "GET /conversations/search": () => ({ conversations: inbound.length ? [{ id: "cv1", contactId: "c1", lastMessageDate: inbound[inbound.length - 1].t, lastMessageDirection: "inbound", lastMessageType: "TYPE_SMS", lastMessageBody: "yes" }] : [] }),
    "GET /conversations/:id/messages": () => ({ messages: { messages: inbound.map((m) => ({ id: "im", direction: "inbound", messageType: "TYPE_SMS", dateAdded: new Date(m.t).toISOString(), body: m.body })), nextPage: false } }),
    "GET /locations/:id/customFields": () => ({ customFields: [] }),
    "GET /users/": () => ({ users: [{ id: "u1", name: "Rep One" }, { id: "u2", name: "Rep Two" }] }),
    "GET /workflows/": () => ({ workflows: [] }),
  });
  const cfg = loadConfig({ ENCRYPTION_KEY: "k".repeat(40), CONNECT_PASSCODE: "p" } as any);
  const connections = new ConnectionStore(db, cfg, fetchImpl);
  await connections.savePit(LOC, "pit-test");
  const engine = new AutomationEngine(db, connections, { now: () => clock.t, log: () => {} });
  return { db, engine, calls, contacts, opps, inbound, clock };
}

async function make(w: World, def: any, mode: "live" | "dry_run" = "live") {
  const { definition } = await w.engine.resolve(LOC, def);
  const a = await w.engine.create(LOC, definition);
  if (mode === "live") await w.engine.setState(LOC, a.id, { mode: "live" });
  return a;
}

const tagEvent = (contactId: string, tags: string[], id = Math.random().toString(36)) => {
  const p = { type: "ContactTagUpdate", locationId: LOC, id: contactId, tags, webhookId: id };
  return [p, JSON.stringify(p)] as const;
};

const sms = (w: World) => w.calls.filter((c) => c.path === "/conversations/messages" && c.method === "POST");

describe("automation engine", () => {
  let w: World;
  beforeEach(async () => {
    w = await world();
  });

  it("runs a follow-up sequence: tag → SMS + deal → wait → stop if replied → follow-up", async () => {
    const a = await make(w, {
      name: "New lead follow-up",
      trigger: { type: "tag_added", tag: "new-lead" },
      actions: [
        { type: "send_sms", message: "Hi {{contact.first_name|there}}, thanks for reaching out!" },
        { type: "create_opportunity", stage: "New Lead", monetary_value: 500 },
        { type: "wait", days: 1 },
        { type: "stop_if", condition: { replied: true } },
        { type: "send_sms", message: "Just checking in, {{contact.first_name}} — any questions?" },
      ],
    });
    expect(a.definition.actions[1]).toMatchObject({ stage: "s1", pipeline_id: "p1" }); // stage name resolved

    await w.engine.handleWebhook(...tagEvent("c1", ["new-lead"]));
    expect(sms(w).map((c) => c.body.message)).toEqual(["Hi Ann, thanks for reaching out!"]);
    expect(w.opps[0]).toMatchObject({ pipelineId: "p1", pipelineStageId: "s1", contactId: "c1", monetaryValue: 500, name: "Ann Lee" });
    let [run] = await w.engine.history(LOC, { automationId: a.id });
    expect(run.status).toBe("waiting");

    // Not due yet
    w.clock.t += 3_600_000;
    await w.engine.runDueJobs();
    expect(sms(w)).toHaveLength(1);

    // A day later, no reply → follow-up goes out
    w.clock.t += 86_400_000;
    await w.engine.runDueJobs();
    expect(sms(w).map((c) => c.body.message)[1]).toBe("Just checking in, Ann — any questions?");
    [run] = await w.engine.history(LOC, { automationId: a.id });
    expect(run.status).toBe("completed");
    expect(run.opportunity_id).toBe("o1");
  });

  it("stops the sequence when the contact replied", async () => {
    await make(w, {
      name: "seq",
      trigger: { type: "tag_added", tag: "go" },
      actions: [{ type: "wait", hours: 2 }, { type: "stop_if", condition: { replied: true } }, { type: "send_sms", message: "follow up" }],
    });
    await w.engine.handleWebhook(...tagEvent("c1", ["go"]));
    w.clock.t += 3_600_000;
    w.inbound.push({ t: w.clock.t, body: "yes please" });
    w.clock.t += 2 * 3_600_000;
    await w.engine.runDueJobs();
    expect(sms(w)).toHaveLength(0);
    const [run] = await w.engine.history(LOC, {});
    expect(run.status).toBe("stopped");
  });

  it("dry-run mode logs instead of acting", async () => {
    const a = await make(w, { name: "dry", trigger: { type: "tag_added", tag: "x" }, actions: [{ type: "send_sms", message: "hello" }, { type: "add_tags", tags: ["y"] }] }, "dry_run");
    await w.engine.handleWebhook(...tagEvent("c1", ["x"]));
    expect(sms(w)).toHaveLength(0);
    expect(w.calls.some((c) => c.path.endsWith("/tags") && c.method === "POST")).toBe(false);
    const [run] = await w.engine.history(LOC, { automationId: a.id });
    expect(run.status).toBe("completed");
    expect(run.log.map((l: any) => l.detail)).toEqual(['[dry run] would send SMS to +15550000001: "hello"', "[dry run] would add tags y"]);
  });

  it("dedupes webhooks, runs once per contact, skips DND and respects conditions", async () => {
    await make(w, {
      name: "welcome",
      trigger: { type: "tag_added", tag: "lead" },
      conditions: { contact_filter: { has_phone: true } },
      actions: [{ type: "send_sms", message: "welcome" }],
    });
    const [p, raw] = tagEvent("c1", ["lead"], "same-id");
    await w.engine.handleWebhook(p, raw);
    expect((await w.engine.handleWebhook(p, raw)).reason).toBe("duplicate");
    await w.engine.handleWebhook(...tagEvent("c1", [])); // removed
    await w.engine.handleWebhook(...tagEvent("c1", ["lead"])); // added again → once per contact
    expect(sms(w)).toHaveLength(1);

    await w.engine.handleWebhook(...tagEvent("c2", ["lead"])); // DND
    const runs = await w.engine.history(LOC, {});
    const c2 = runs.find((r: any) => r.contact_id === "c2");
    expect(c2.log[0].detail).toMatch(/skip SMS \(DND/);
    expect(sms(w)).toHaveLength(1);
  });

  it("never treats old tags on a never-seen contact as newly added", async () => {
    w.contacts.c1.tags = ["customer"]; // had the tag before the automation existed
    await make(w, { name: "cust", trigger: { type: "tag_added", tag: "customer" }, actions: [{ type: "send_sms", message: "welcome aboard" }] });
    const upd = { type: "ContactUpdate", locationId: LOC, id: "c1", tags: ["customer", "newsletter"], webhookId: "u1" };
    await w.engine.handleWebhook(upd, JSON.stringify(upd)); // unrelated update of an existing customer
    expect(sms(w)).toHaveLength(0);
    await w.engine.handleWebhook(...tagEvent("c3", ["customer"])); // never-seen contact actually gains the tag
    expect(sms(w).map((c) => c.body.contactId)).toEqual(["c3"]);
    const other = { type: "ContactTagUpdate", locationId: LOC, id: "c2", tags: ["random"], webhookId: "u2" };
    await w.engine.handleWebhook(other, JSON.stringify(other));
    expect(await w.db.query(`SELECT tags FROM contact_snapshots WHERE contact_id='c2'`).then((r) => r.rows[0].tags)).toEqual(["random"]);
  });

  it("an automation never re-triggers itself, and chains are depth-limited", async () => {
    const a = await make(w, {
      name: "self",
      trigger: { type: "tag_added", tag: "hot" },
      actions: [{ type: "remove_tags", tags: ["hot"] }, { type: "add_tags", tags: ["hot"] }],
      settings: { once_per_contact: false },
    });
    await w.engine.handleWebhook(...tagEvent("c1", ["hot"]));
    // GHL would now send the tag changes our actions caused:
    await w.engine.handleWebhook(...tagEvent("c1", []));
    await w.engine.handleWebhook(...tagEvent("c1", ["hot"]));
    const runs = await w.engine.history(LOC, { automationId: a.id });
    expect(runs).toHaveLength(1);
  });

  it("enforces the per-hour action cap", async () => {
    await make(w, { name: "cap", trigger: { type: "tag_added", tag: "z" }, actions: [{ type: "add_tags", tags: ["done"] }], settings: { max_actions_per_hour: 1 } });
    await w.engine.handleWebhook(...tagEvent("c1", ["z"]));
    await w.engine.handleWebhook(...tagEvent("c3", ["z"]));
    const statuses = (await w.engine.history(LOC, {})).map((r: any) => r.status).sort();
    expect(statuses).toEqual(["completed", "rate_limited"]);
  });

  it("round-robins assignment and handles stage-change triggers", async () => {
    await make(w, {
      name: "qualified",
      trigger: { type: "opportunity_stage_changed", stage: "Qualified" },
      actions: [{ type: "assign_user", user_ids: ["u1", "u2"] }, { type: "create_task", title: "Call {{contact.first_name}}", due_in_hours: 2 }],
    });
    w.opps.push({ id: "oA", contactId: "c1", pipelineId: "p1", pipelineStageId: "s2", status: "open", name: "A" }, { id: "oB", contactId: "c3", pipelineId: "p1", pipelineStageId: "s2", status: "open", name: "B" });
    for (const o of w.opps) {
      const p = { type: "OpportunityStageUpdate", locationId: LOC, ...o, webhookId: o.id };
      await w.engine.handleWebhook(p, JSON.stringify(p));
    }
    const other = { type: "OpportunityStageUpdate", locationId: LOC, id: "oC", contactId: "c1", pipelineId: "p1", pipelineStageId: "s3", status: "open", webhookId: "oc" };
    await w.engine.handleWebhook(other, JSON.stringify(other)); // different stage → no run
    expect(w.contacts.c1.assignedTo).toBe("u1");
    expect(w.contacts.c3.assignedTo).toBe("u2");
    const tasks = w.calls.filter((c) => c.path.endsWith("/tasks"));
    expect(tasks.map((t) => t.body.title)).toEqual(["Call Ann", "Call Cat"]);
    expect(tasks[0].body.assignedTo).toBe("u1");
  });

  it("schedules: stale-deal reminders run on the cron", async () => {
    w.opps.push({ id: "old", contactId: "c1", pipelineId: "p1", pipelineStageId: "s3", status: "open", name: "Old deal", lastStageChangeAt: "2026-10-01T00:00:00Z" });
    w.opps.push({ id: "fresh", contactId: "c3", pipelineId: "p1", pipelineStageId: "s3", status: "open", name: "Fresh", lastStageChangeAt: new Date(w.clock.t).toISOString() });
    await make(w, {
      name: "stale",
      trigger: { type: "schedule", cron: "0 9 * * *", timezone: "UTC", target: { kind: "opportunities", stage: "Proposal", stale_days: 14 } },
      actions: [{ type: "create_task", title: "Nudge {{opportunity.name}}", due_in_hours: 4 }],
    });
    await w.engine.runSchedules(); // created at 15:00, next 09:00 is tomorrow
    expect(w.calls.filter((c) => c.path.endsWith("/tasks"))).toHaveLength(0);
    w.clock.t = Date.parse("2026-11-19T09:00:30Z");
    await w.engine.runSchedules();
    await w.engine.runSchedules(); // no double fire
    const tasks = w.calls.filter((c) => c.path.endsWith("/tasks"));
    expect(tasks.map((t) => t.body.title)).toEqual(["Nudge Old deal"]);
  });

  it("business hours delay messages until opening time", async () => {
    w.clock.t = Date.parse("2026-11-21T02:00:00Z"); // Friday 9pm New York
    await make(w, {
      name: "bh",
      trigger: { type: "tag_added", tag: "b" },
      conditions: { business_hours: { timezone: "America/New_York", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] } },
      actions: [{ type: "add_tags", tags: ["seen"] }, { type: "send_sms", message: "morning!" }],
    });
    await w.engine.handleWebhook(...tagEvent("c1", ["b"]));
    expect(w.contacts.c1.tags).toContain("seen");
    expect(sms(w)).toHaveLength(0);
    w.clock.t = Date.parse("2026-11-24T14:00:00Z"); // Monday 9am New York
    await w.engine.runDueJobs();
    expect(sms(w)).toHaveLength(1);
  });

  it("kill switch disables everything and cancels waiting runs", async () => {
    await make(w, { name: "k", trigger: { type: "tag_added", tag: "k" }, actions: [{ type: "wait", hours: 1 }, { type: "send_sms", message: "later" }] });
    await w.engine.handleWebhook(...tagEvent("c1", ["k"]));
    expect(await w.engine.pauseAll(LOC)).toBe(1);
    w.clock.t += 2 * 3_600_000;
    await w.engine.runDueJobs();
    expect(sms(w)).toHaveLength(0);
    expect((await w.engine.history(LOC, {}))[0].status).toBe("cancelled");
  });

  it("polling detects tag changes when no webhooks arrive", async () => {
    await make(w, { name: "poll", trigger: { type: "tag_added", tag: "vip" }, actions: [{ type: "send_sms", message: "vip!" }] });
    expect(await w.engine.pollLocation(LOC)).toBe(0); // first poll only snapshots
    w.contacts.c3.tags = ["vip"];
    w.clock.t += 5 * 60_000;
    await w.engine.pollLocation(LOC);
    expect(sms(w).map((c) => c.body.contactId)).toEqual(["c3"]);
  });

  it("simulate shows rendered steps without side effects", async () => {
    const { definition } = await w.engine.resolve(LOC, {
      name: "sim",
      trigger: { type: "inbound_message", channel: "SMS", keywords: ["price"] },
      actions: [{ type: "send_sms", message: "Hi {{contact.first_name}}, you said: {{message.body}}" }, { type: "wait", hours: 1 }, { type: "add_tags", tags: ["pricing"] }],
    });
    const out: any = await w.engine.simulate(LOC, definition, { contactId: "c1" }, { type: "inbound_message", locationId: LOC, channel: "SMS", body: "what's the price?" });
    expect(out.steps[0]).toBe("Trigger: matches the sample event");
    expect(out.steps[1]).toMatch(/would send SMS to \+15550000001/);
    expect(out.steps[2]).toBe("2. wait 1h");
    expect(w.calls.filter((c) => c.method !== "GET" && c.path !== "/contacts/search")).toHaveLength(0);
  });

  it("rejects unknown stages and invalid cron at creation", async () => {
    await expect(w.engine.resolve(LOC, { name: "x", trigger: { type: "manual" }, actions: [{ type: "move_opportunity", stage: "Nope" }] })).rejects.toThrow(/not found/);
    await expect(
      w.engine.resolve(LOC, { name: "x", trigger: { type: "schedule", cron: "nonsense", target: { kind: "contacts" } }, actions: [{ type: "add_tags", tags: ["a"] }] }),
    ).rejects.toThrow(/cron/);
  });
});

describe("automation helpers", () => {
  it("matches keywords on word boundaries", () => {
    const t = { type: "inbound_message", keywords: ["stop", "price"] } as any;
    const e = (body: string) => ({ type: "inbound_message", locationId: "L", body }) as any;
    expect(triggerMatches(t, e("What is the PRICE?"))).toBe(true);
    expect(triggerMatches(t, e("unstoppable"))).toBe(false);
  });

  it("computes next business time across weekends and time zones", () => {
    const bh = { timezone: "America/New_York", start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] };
    const open = Date.parse("2026-11-18T15:00:00Z"); // Wed 10am NY
    expect(nextBusinessTime(open, bh)).toBe(open);
    expect(new Date(nextBusinessTime(Date.parse("2026-11-21T02:00:00Z"), bh)).toISOString()).toBe("2026-11-23T14:00:00.000Z"); // Fri 9pm → Mon 9am
  });
});
