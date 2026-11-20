import { z } from "zod";
import { runConfirmable } from "../confirm.js";
import { confirmTokenArg, defineTool, type ToolDef } from "../context.js";
import { contactFieldsSchema, contactFilterSchema } from "../schemas.js";
import { compactContact } from "../util.js";

const ids = z.array(z.string()).optional().describe("Explicit contact IDs");

function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export const contactTools: ToolDef<any>[] = [
  defineTool({
    name: "search_contacts",
    title: "Search contacts",
    description: "Search and filter contacts in GoHighLevel (by text, tags, owner, source, created/updated dates). Returns compact contact records, newest first.",
    schema: { filter: contactFilterSchema.optional(), limit: z.number().int().min(1).max(5000).default(50) },
    handler: async ({ filter, limit }, { data }) => {
      const res = await data.searchContacts(filter ?? {}, limit);
      return { total_matching: res.total, returned: res.items.length, truncated: res.truncated, contacts: res.items.map(compactContact) };
    },
  }),

  defineTool({
    name: "get_contact",
    title: "Get contact",
    description: "Get a single contact with all fields, plus their open opportunities, notes and tasks if requested.",
    schema: {
      contact_id: z.string(),
      include_opportunities: z.boolean().default(true),
      include_notes: z.boolean().default(false),
      include_tasks: z.boolean().default(false),
    },
    handler: async ({ contact_id, include_opportunities, include_notes, include_tasks }, { data, client }) => {
      const contact = await data.getContact(contact_id);
      const out: Record<string, unknown> = { contact };
      if (include_opportunities) out.opportunities = (await data.searchOpportunities({ contact_id }, 50)).items;
      if (include_notes) out.notes = (await client.get(`/contacts/${contact_id}/notes`)).notes;
      if (include_tasks) out.tasks = (await client.get(`/contacts/${contact_id}/tasks`)).tasks;
      return out;
    },
  }),

  defineTool({
    name: "create_contact",
    title: "Create contact",
    description: "Create a new contact. Fails if a duplicate exists and the location disallows duplicates; use upsert_contact to create-or-update by email/phone.",
    write: true,
    schema: contactFieldsSchema,
    handler: async (args, { client, data }) => {
      const res = await client.post("/contacts/", { locationId: data.locationId, ...clean(args) });
      return { contact: res.contact };
    },
  }),

  defineTool({
    name: "upsert_contact",
    title: "Upsert contact",
    description: "Create a contact or update the existing one matched by email/phone (per the location's duplicate settings).",
    write: true,
    schema: contactFieldsSchema,
    handler: async (args, { client, data }) => {
      const res = await client.post("/contacts/upsert", { locationId: data.locationId, ...clean(args) });
      return { created: res.new, contact: res.contact };
    },
  }),

  defineTool({
    name: "update_contact",
    title: "Update contact",
    description: "Update fields on one contact. Note: passing `tags` REPLACES all tags; use add_tags/remove_tags to change them incrementally.",
    write: true,
    schema: { contact_id: z.string(), ...contactFieldsSchema },
    handler: async ({ contact_id, ...fields }, { client }) => {
      const res = await client.put(`/contacts/${contact_id}`, clean(fields));
      return { contact: res.contact };
    },
  }),

  defineTool({
    name: "delete_contacts",
    title: "Delete contacts",
    description: "Permanently delete one or more contacts.",
    write: true,
    destructive: true,
    schema: { contact_ids: z.array(z.string()).min(1), ...confirmTokenArg },
    handler: async ({ contact_ids, confirm_token }, ctx) => {
      const contacts = await ctx.data.resolveContacts(contact_ids, undefined, contact_ids.length);
      const plan = { contact_ids: contacts.map((c) => c.id).sort() };
      return runConfirmable(
        ctx.confirm,
        {
          tool: "delete_contacts",
          plan,
          count: plan.contact_ids.length,
          preview: { action: "PERMANENTLY DELETE contacts", contacts: contacts.slice(0, 25).map(compactContact) },
          execute: async (p) => {
            const results = [];
            for (const id of p.contact_ids) {
              try {
                await ctx.client.delete(`/contacts/${id}`);
                results.push({ id, ok: true });
              } catch (e) {
                results.push({ id, ok: false, error: (e as Error).message });
              }
            }
            return summarize(results);
          },
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "add_tags",
    title: "Add tags",
    description: "Add tags to contacts, chosen by explicit IDs and/or a filter. Adding tags can trigger GHL workflows.",
    write: true,
    schema: {
      tags: z.array(z.string()).min(1),
      contact_ids: ids,
      filter: contactFilterSchema.optional(),
      max_contacts: z.number().int().min(1).max(10000).default(500),
      ...confirmTokenArg,
    },
    handler: (args, ctx) => tagOp("add_tags", args, ctx),
  }),

  defineTool({
    name: "remove_tags",
    title: "Remove tags",
    description: "Remove tags from contacts, chosen by explicit IDs and/or a filter.",
    write: true,
    schema: {
      tags: z.array(z.string()).min(1),
      contact_ids: ids,
      filter: contactFilterSchema.optional(),
      max_contacts: z.number().int().min(1).max(10000).default(500),
      ...confirmTokenArg,
    },
    handler: (args, ctx) => tagOp("remove_tags", args, ctx),
  }),

  defineTool({
    name: "add_note",
    title: "Add note",
    description: "Add a note to a contact.",
    write: true,
    schema: { contact_id: z.string(), body: z.string(), user_id: z.string().optional() },
    handler: async ({ contact_id, body, user_id }, { client }) => {
      return (await client.post(`/contacts/${contact_id}/notes`, clean({ body, userId: user_id }))).note;
    },
  }),

  defineTool({
    name: "create_task",
    title: "Create task",
    description: "Create a follow-up task on a contact.",
    write: true,
    schema: {
      contact_id: z.string(),
      title: z.string(),
      body: z.string().optional(),
      due_date: z.string().describe("ISO datetime"),
      assigned_to: z.string().optional().describe("User ID"),
    },
    handler: async ({ contact_id, title, body, due_date, assigned_to }, { client }) => {
      const res = await client.post(
        `/contacts/${contact_id}/tasks`,
        clean({ title, body, dueDate: new Date(due_date).toISOString(), completed: false, assignedTo: assigned_to }),
      );
      return res.task ?? res;
    },
  }),

  defineTool({
    name: "add_to_workflow",
    title: "Add contacts to workflow",
    description: "Enroll contacts in a GHL workflow (see list_workflows), or remove them from it. Workflows may send messages automatically.",
    write: true,
    schema: {
      workflow_id: z.string(),
      remove: z.boolean().default(false).describe("true = remove from the workflow instead of adding"),
      contact_ids: ids,
      filter: contactFilterSchema.optional(),
      max_contacts: z.number().int().min(1).max(10000).default(500),
      ...confirmTokenArg,
    },
    handler: async ({ workflow_id, remove, contact_ids, filter, max_contacts, confirm_token }, ctx) => {
      const contacts = await ctx.data.resolveContacts(contact_ids, filter, max_contacts);
      const wf = (await ctx.data.workflows().catch(() => [])).find((w: any) => w.id === workflow_id);
      const plan = { workflow_id, remove, contact_ids: contacts.map((c) => c.id).sort() };
      return runConfirmable(
        ctx.confirm,
        {
          tool: "add_to_workflow",
          plan,
          count: plan.contact_ids.length,
          preview: {
            action: `${remove ? "REMOVE contacts from" : "ENROLL contacts in"} workflow "${wf?.name ?? workflow_id}"${wf?.status ? ` (status: ${wf.status})` : ""}`,
            sample: contacts.slice(0, 10).map(compactContact),
          },
          execute: async (p) => {
            const results = [];
            for (const id of p.contact_ids) {
              try {
                if (p.remove) await ctx.client.delete(`/contacts/${id}/workflow/${p.workflow_id}`);
                else await ctx.client.post(`/contacts/${id}/workflow/${p.workflow_id}`, {});
                results.push({ id, ok: true });
              } catch (e) {
                results.push({ id, ok: false, error: (e as Error).message });
              }
            }
            return summarize(results);
          },
        },
        confirm_token,
      );
    },
  }),
];

async function tagOp(tool: "add_tags" | "remove_tags", args: any, ctx: any) {
  const contacts: any[] = await ctx.data.resolveContacts(args.contact_ids, args.filter, args.max_contacts);
  const tagsLower = args.tags.map((t: string) => t.toLowerCase());
  // Skip contacts where the operation would be a no-op.
  const targets = contacts.filter((c) => {
    const has = new Set((c.tags ?? []).map((t: string) => t.toLowerCase()));
    return tool === "add_tags" ? tagsLower.some((t: string) => !has.has(t)) : tagsLower.some((t: string) => has.has(t));
  });
  const plan = { tags: [...args.tags].sort(), contact_ids: targets.map((c) => c.id).sort() };
  return runConfirmable(
    ctx.confirm,
    {
      tool,
      plan,
      count: plan.contact_ids.length,
      preview: {
        action: `${tool === "add_tags" ? "ADD" : "REMOVE"} tags [${args.tags.join(", ")}]`,
        matched_contacts: contacts.length,
        skipped_already_in_desired_state: contacts.length - targets.length,
        sample: targets.slice(0, 10).map(compactContact),
      },
      execute: async (p: typeof plan) => {
        const results = [];
        for (const id of p.contact_ids) {
          try {
            if (tool === "add_tags") await ctx.client.post(`/contacts/${id}/tags`, { tags: p.tags });
            else await ctx.client.delete(`/contacts/${id}/tags`, { tags: p.tags });
            results.push({ id, ok: true });
          } catch (e) {
            results.push({ id, ok: false, error: (e as Error).message });
          }
        }
        ctx.data.invalidate("tags");
        return summarize(results);
      },
    },
    args.confirm_token,
  );
}

export function summarize(results: Array<{ ok: boolean; [k: string]: unknown }>) {
  const failed = results.filter((r) => !r.ok);
  return { succeeded: results.length - failed.length, failed: failed.length, failures: failed.slice(0, 50) };
}
