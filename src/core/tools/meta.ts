import { z } from "zod";
import { runConfirmable } from "../confirm.js";
import { confirmTokenArg, defineTool, type ToolDef } from "../context.js";

export const metaTools: ToolDef<any>[] = [
  defineTool({
    name: "list_users",
    title: "List users",
    description: "List users (sales reps/staff) in the sub-account with their IDs. Use these IDs for assigned_to fields.",
    schema: {},
    handler: async (_a, { data }) =>
      (await data.users()).map((u: any) => ({ id: u.id, name: u.name ?? [u.firstName, u.lastName].filter(Boolean).join(" "), email: u.email, phone: u.phone, role: u.roles?.role ?? u.roles?.type })),
  }),

  defineTool({
    name: "list_custom_fields",
    title: "List custom fields",
    description: "List contact custom fields (ID, name, merge key, type, options).",
    schema: {},
    handler: async (_a, { data }) =>
      (await data.customFields()).map((f: any) => ({ id: f.id, name: f.name, key: f.fieldKey, type: f.dataType, options: f.picklistOptions ?? f.options })),
  }),

  defineTool({
    name: "list_tags",
    title: "List tags",
    description: "List all contact tags defined in the sub-account.",
    schema: {},
    handler: async (_a, { data }) => (await data.tags()).map((t: any) => t.name),
  }),

  defineTool({
    name: "list_workflows",
    title: "List workflows",
    description: "List automation workflows (ID, name, published/draft status).",
    schema: {},
    handler: async (_a, { data }) => (await data.workflows()).map((w: any) => ({ id: w.id, name: w.name, status: w.status })),
  }),

  defineTool({
    name: "list_calendars",
    title: "List calendars",
    description: "List calendars (ID, name, type).",
    schema: {},
    handler: async (_a, { data }) => (await data.calendars()).map((c: any) => ({ id: c.id, name: c.name, type: c.calendarType, active: c.isActive })),
  }),

  defineTool({
    name: "get_appointments",
    title: "Get appointments",
    description: "List calendar appointments in a date range (all calendars, or one calendar/user).",
    schema: {
      start_date: z.string().describe("ISO date"),
      end_date: z.string().describe("ISO date"),
      calendar_id: z.string().optional(),
      user_id: z.string().optional(),
    },
    handler: async (a, { client, data }) => {
      const start = Date.parse(a.start_date);
      const end = Date.parse(a.end_date) + (/^\d{4}-\d{2}-\d{2}$/.test(a.end_date) ? 86_399_999 : 0);
      const targets: Array<Record<string, string>> = a.user_id
        ? [{ userId: a.user_id }]
        : a.calendar_id
          ? [{ calendarId: a.calendar_id }]
          : (await data.calendars()).map((c: any) => ({ calendarId: c.id }));
      const events: any[] = [];
      for (const t of targets) {
        const r = await client.get("/calendars/events", { locationId: data.locationId, startTime: start, endTime: end, ...t });
        events.push(...(r.events ?? []));
      }
      return events
        .sort((x, y) => String(x.startTime).localeCompare(String(y.startTime)))
        .map((e) => ({ id: e.id, title: e.title, start: e.startTime, end: e.endTime, status: e.appointmentStatus, contactId: e.contactId, assignedUserId: e.assignedUserId, calendarId: e.calendarId }));
    },
  }),

  defineTool({
    name: "ghl_api_request",
    title: "Raw GHL API request",
    description:
      "Escape hatch for any GoHighLevel API v2 endpoint not covered by other tools (see https://highlevel.stoplight.io/docs/integrations). Path is relative to https://services.leadconnectorhq.com, e.g. /contacts/abc123. GET requests run directly; POST/PUT/PATCH/DELETE require preview + confirmation.",
    schema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
      path: z.string().regex(/^\//, "path must start with /"),
      query: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
      body: z.any().optional(),
      version: z.string().optional().describe("Override the Version header if an endpoint needs it"),
      ...confirmTokenArg,
    },
    handler: async (a, ctx) => {
      if (a.method === "GET") return ctx.client.request("GET", a.path, { query: a.query, version: a.version });
      if (ctx.config.readOnly) throw new Error("Server is in read-only mode (GHL_READ_ONLY=true); only GET requests are allowed.");
      const plan = { method: a.method, path: a.path, query: a.query, body: a.body, version: a.version };
      return runConfirmable(
        ctx.confirm,
        {
          tool: "ghl_api_request",
          plan,
          count: 1,
          preview: { action: `${a.method} ${a.path}`, query: a.query, body: a.body },
          execute: (p) => ctx.client.request(p.method, p.path, { query: p.query, body: p.body, version: p.version }),
        },
        a.confirm_token,
      );
    },
  }),
];
