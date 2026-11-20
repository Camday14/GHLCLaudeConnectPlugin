import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifyCall, summarizeCalls, summarizePipeline } from "../src/tools/reports.js";
import { connect, contacts, fakeGhl } from "./helpers.js";

const pipelines = [
  { id: "p1", name: "Sales", stages: [{ id: "s1", name: "New Lead" }, { id: "s2", name: "Qualified" }, { id: "s3", name: "Proposal" }] },
];

function baseRoutes(extra: Record<string, any> = {}) {
  return {
    "POST /contacts/search": () => ({ contacts, total: contacts.length }),
    "GET /contacts/:id": (c: any) => ({ contact: contacts.find((x) => c.path.endsWith(x.id)) }),
    "GET /locations/LOC1/customFields": () => ({ customFields: [{ id: "cf1", name: "Budget", fieldKey: "contact.budget" }] }),
    "GET /users/": () => ({ users: [{ id: "u1", name: "Rep One" }, { id: "u2", name: "Rep Two" }] }),
    "GET /opportunities/pipelines": () => ({ pipelines }),
    "POST /conversations/messages": () => ({ messageId: "m1", conversationId: "cv1" }),
    ...extra,
  };
}

describe("MCP server", () => {
  it("lists all tools with schemas, and hides write tools in read-only mode", async () => {
    const { fetchImpl } = fakeGhl(baseRoutes());
    const { client } = await connect(fetchImpl);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["search_contacts", "bulk_send", "import_contacts_csv", "pipeline_report", "call_report", "move_opportunities", "sort_leads"]) expect(names).toContain(n);
    expect(tools.find((t) => t.name === "bulk_send")!.inputSchema.properties).toHaveProperty("confirm_token");

    const ro = await connect(fetchImpl, { readOnly: true });
    const roNames = (await ro.client.listTools()).tools.map((t) => t.name);
    expect(roNames).toContain("pipeline_report");
    expect(roNames).not.toContain("bulk_send");
    expect(roNames).not.toContain("delete_contacts");
  });

  it("search_contacts sends filters and re-checks tags client-side", async () => {
    const { fetchImpl, calls } = fakeGhl(baseRoutes());
    const { call } = await connect(fetchImpl);
    const r = await call("search_contacts", { filter: { tags_all: ["vip"] } });
    expect(r.json.contacts.map((c: any) => c.id)).toEqual(["c3"]);
    expect(calls[0].body.locationId).toBe("LOC1");
    expect(calls[0].body.filters).toEqual([{ field: "tags", operator: "eq", value: "vip" }]);
  });
});

describe("bulk_send preview/confirm", () => {
  it("previews without sending, skips DND, renders merge fields, then sends on confirm", async () => {
    const { fetchImpl, calls } = fakeGhl(baseRoutes());
    const { call } = await connect(fetchImpl);
    const args = { channel: "SMS", filter: { tags_any: ["lead"] }, message: "Hi {{contact.first_name|there}}!" };

    const preview = await call("bulk_send", args);
    expect(preview.json.status).toMatch(/PREVIEW_ONLY/);
    expect(preview.json.will_send).toBe(1);
    expect(preview.json.skipped_by_reason).toEqual({ "DND enabled on all channels": 1, "DND enabled for SMS": 1 });
    expect(preview.json.rendered_samples[0]).toMatchObject({ contact_id: "c1", message: "Hi Ann!" });
    expect(calls.filter((c) => c.path === "/conversations/messages")).toHaveLength(0);

    const bad = await call("bulk_send", { ...args, confirm_token: "cfm_bogus" });
    expect(bad.isError).toBe(true);
    expect(calls.filter((c) => c.path === "/conversations/messages")).toHaveLength(0);

    const changed = await call("bulk_send", { ...args, message: "Different", confirm_token: preview.json.confirm_token });
    expect(changed.isError).toBe(true);
    expect(changed.text).toMatch(/changed since the preview/);

    const preview2 = await call("bulk_send", args);
    const done = await call("bulk_send", { ...args, confirm_token: preview2.json.confirm_token });
    expect(done.json.status).toBe("EXECUTED");
    const sends = calls.filter((c) => c.path === "/conversations/messages");
    expect(sends).toHaveLength(1);
    expect(sends[0].body).toEqual({ type: "SMS", contactId: "c1", message: "Hi Ann!" });
  });

  it("send_sms refuses DND contacts", async () => {
    const { fetchImpl } = fakeGhl(baseRoutes());
    const { call } = await connect(fetchImpl);
    const r = await call("send_sms", { contact_id: "c2", message: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/DND/);
  });

  it("threshold lets small operations run without confirmation", async () => {
    const { fetchImpl, calls } = fakeGhl(baseRoutes());
    const { call } = await connect(fetchImpl, { confirmThreshold: 5 });
    const r = await call("send_email", { contact_id: "c1", subject: "Hi {{contact.first_name}}", message: "Body" });
    expect(r.json.status).toBe("EXECUTED");
    expect(calls.find((c) => c.path === "/conversations/messages")!.body).toMatchObject({ type: "Email", subject: "Hi Ann", message: "Body" });
  });
});

describe("pipelines", () => {
  it("move_opportunities resolves stage names and bulk-moves after confirm", async () => {
    const opps = [
      { id: "o1", pipelineId: "p1", pipelineStageId: "s1", status: "open", monetaryValue: 100 },
      { id: "o2", pipelineId: "p1", pipelineStageId: "s1", status: "open", monetaryValue: 250 },
    ];
    const { fetchImpl, calls } = fakeGhl(baseRoutes({
      "GET /opportunities/search": () => ({ opportunities: opps, meta: { total: 2 } }),
      "PUT /opportunities/:id": () => ({ opportunity: {} }),
    }));
    const { call } = await connect(fetchImpl);
    const args = { from_stage: "new lead", to_stage: "Qualified" };
    const p = await call("move_opportunities", args);
    expect(p.json.total_value).toBe(350);
    expect(calls.find((c) => c.path === "/opportunities/search")!.query).toMatchObject({ location_id: "LOC1", pipeline_stage_id: "s1", status: "open" });
    const r = await call("move_opportunities", { ...args, confirm_token: p.json.confirm_token });
    expect(r.json.result.succeeded).toBe(2);
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([
      { pipelineId: "p1", pipelineStageId: "s2" },
      { pipelineId: "p1", pipelineStageId: "s2" },
    ]);
  });
});

describe("import_contacts_csv", () => {
  it("auto-maps, validates, dedupes, upserts, tags, and writes failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ghl-"));
    const file = join(dir, "leads.csv");
    await writeFile(
      file,
      ["First Name,Last Name,Email Address,Mobile,Budget,Tags,Notes", "Ann,Lee,ANN@x.com,(555) 000-0001,5000,warm;fb,hi", "Ann,Dup,ann@x.com,,,,", "No,Contact,not-an-email,,,,", "Zed,Fail,zed@x.com,,,,"].join("\n"),
    );
    const { fetchImpl, calls } = fakeGhl(baseRoutes({
      "POST /contacts/upsert": (c: any) =>
        c.body.email === "zed@x.com" ? new Response(JSON.stringify({ message: "boom" }), { status: 400 }) : { new: true, contact: { id: "new1" } },
      "POST /contacts/:id/tags": () => ({}),
    }));
    const { call } = await connect(fetchImpl);
    const args = { file_path: file, add_tags: ["import-nov"] };
    const p = await call("import_contacts_csv", args);
    expect(p.json).toMatchObject({ rows_in_file: 4, valid_rows: 2, invalid_rows: 1, duplicate_rows_in_file: 1 });
    expect(p.json.column_mapping).toMatchObject({ "First Name": "firstName", "Email Address": "email", Mobile: "phone", Budget: "custom:cf1", Tags: "tags", Notes: "ignore" });
    expect(p.json.sample_mapped_rows[0].contact).toMatchObject({ email: "ann@x.com", phone: "+15550000001", customFields: [{ id: "cf1", field_value: "5000" }] });
    expect(calls.filter((c) => c.path === "/contacts/upsert")).toHaveLength(0);

    const r = await call("import_contacts_csv", { ...args, confirm_token: p.json.confirm_token });
    expect(r.json.result).toMatchObject({ contacts_created: 1, failed_rows: 2 });
    expect(calls.find((c) => c.path === "/contacts/new1/tags")!.body.tags).toEqual(["warm", "fb", "import-nov"]);
    const failures = await readFile(r.json.result.failures_file, "utf8");
    expect(failures).toMatch(/no valid email or phone/);
    expect(failures).toMatch(/boom/);
  });
});

describe("sort_leads", () => {
  it("scores and buckets with custom rules", async () => {
    const { fetchImpl } = fakeGhl(baseRoutes());
    const { call } = await connect(fetchImpl);
    const r = await call("sort_leads", {
      rules: [
        { type: "has_tag", value: "vip", points: 50 },
        { type: "has_phone", points: 10 },
        { type: "created_older_than_days", value: 30, points: -20 },
      ],
    });
    expect(r.json.top.map((x: any) => [x.contact.id, x.score, x.bucket])).toEqual([
      ["c3", 50, "hot"],
      ["c1", 10, "cold"],
      ["c2", -10, "cold"],
    ]);
  });
});

describe("report math", () => {
  it("classifies and summarizes calls", () => {
    const calls = [
      { direction: "outbound", userId: "u1", meta: { call: { status: "completed", duration: 120 } } },
      { direction: "outbound", userId: "u1", meta: { call: { status: "no-answer", duration: 0 } } },
      { direction: "inbound", userId: "u2", meta: { call: { status: "voicemail", duration: 30 } } },
      { direction: "inbound", meta: { call: { status: "completed", duration: 60 } } },
    ];
    expect(classifyCall(calls[1])).toBe("missed");
    const s = summarizeCalls(calls, { u1: "Rep One" });
    expect(s.total_calls).toBe(4);
    expect(s.by_outcome).toEqual({ answered: 2, missed: 1, voicemail: 1 });
    expect(s.answer_rate).toBe(0.5);
    expect(s.total_talk_minutes).toBe(3.5);
    expect(s.by_user["Rep One"]).toMatchObject({ calls: 2, outbound: 2, answered: 1, missed: 1, talk_minutes: 2 });
  });

  it("summarizes pipeline by stage, period, owner and staleness", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const opps = [
      { pipelineId: "p1", pipelineStageId: "s1", status: "open", monetaryValue: 100, assignedTo: "u1", createdAt: "2026-11-10", lastStageChangeAt: "2026-11-01" },
      { pipelineId: "p1", pipelineStageId: "s2", status: "open", monetaryValue: 200, assignedTo: "u1", createdAt: "2026-11-15", lastStageChangeAt: "2026-11-18" },
      { pipelineId: "p1", pipelineStageId: "s3", status: "won", monetaryValue: 1000, assignedTo: "u2", createdAt: "2026-10-01", lastStatusChangeAt: "2026-11-12" },
      { pipelineId: "p1", pipelineStageId: "s3", status: "lost", monetaryValue: 500, createdAt: "2026-10-01", lastStatusChangeAt: "2026-11-13" },
      { pipelineId: "p1", pipelineStageId: "s3", status: "won", monetaryValue: 999, createdAt: "2026-01-01", lastStatusChangeAt: "2026-02-01" },
    ];
    const s = summarizePipeline(opps, pipelines, { u1: "Rep One" }, { start: Date.parse("2026-11-01"), end: now }, 14, now);
    const p = s.pipelines[0];
    expect(p.open_value).toBe(300);
    expect(p.stages.map((x: any) => x.open_deals)).toEqual([1, 1, 0]);
    expect(p.in_period).toMatchObject({ created: 2, won: 1, won_value: 1000, lost: 1, win_rate: 0.5 });
    expect(s.by_owner["Rep One"]).toMatchObject({ open_deals: 2, open_value: 300 });
    expect(s.stale_count).toBe(1);
  });
});
