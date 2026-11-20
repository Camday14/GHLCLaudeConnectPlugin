import { z } from "zod";
import { runConfirmable } from "../confirm.js";
import { confirmTokenArg, defineTool, type Ctx, type ToolDef } from "../context.js";
import { contactFilterSchema } from "../schemas.js";
import { compactContact, renderTemplate } from "../util.js";
import { summarize } from "./contacts.js";

type Channel = "SMS" | "Email";

/** Returns a reason the contact can't be messaged on this channel, or undefined if OK. */
export function blockReason(c: any, channel: Channel): string | undefined {
  if (c.dnd === true) return "DND enabled on all channels";
  const s = c.dndSettings?.[channel]?.status;
  if (s === "active") return `DND enabled for ${channel}`;
  if (channel === "SMS" && !c.phone) return "no phone number";
  if (channel === "Email" && !c.email) return "no email address";
  return undefined;
}

interface SendItem {
  contact_id: string;
  to: string;
  message?: string;
  html?: string;
  subject?: string;
}

async function sendOne(ctx: Ctx, channel: Channel, item: SendItem, opts: { emailFrom?: string; fromNumber?: string; cc?: string[]; bcc?: string[] }) {
  const body: Record<string, unknown> = { type: channel, contactId: item.contact_id };
  if (channel === "SMS") {
    body.message = item.message;
    if (opts.fromNumber) body.fromNumber = opts.fromNumber;
  } else {
    body.subject = item.subject;
    if (item.html) body.html = item.html;
    else body.message = item.message;
    if (opts.emailFrom) body.emailFrom = opts.emailFrom;
    if (opts.cc?.length) body.emailCc = opts.cc;
    if (opts.bcc?.length) body.emailBcc = opts.bcc;
  }
  return ctx.client.post("/conversations/messages", body);
}

const emailFromArg = z.string().optional().describe('Sender, e.g. "Jane Doe <jane@yourdomain.com>". Defaults to the location\'s default sender.');
const fromNumberArg = z.string().optional().describe("Send from a specific LC Phone number (E.164). Defaults to the location's default number.");

export const messagingTools: ToolDef<any>[] = [
  defineTool({
    name: "send_sms",
    title: "Send SMS",
    description: "Send a text message to one contact. Supports merge fields like {{contact.first_name|there}}.",
    write: true,
    schema: { contact_id: z.string(), message: z.string().min(1), from_number: fromNumberArg, ...confirmTokenArg },
    handler: async ({ contact_id, message, from_number, confirm_token }, ctx) => {
      const c = await ctx.data.getContact(contact_id);
      const blocked = blockReason(c, "SMS");
      if (blocked) throw new Error(`Can't text ${compactContact(c).name ?? contact_id}: ${blocked}.`);
      const item = { contact_id, to: c.phone, message: renderTemplate(message, c, await ctx.data.customFieldKeyMap()) };
      return runConfirmable(
        ctx.confirm,
        {
          tool: "send_sms",
          plan: { item, from_number },
          count: 1,
          preview: { action: "SEND SMS", to: `${compactContact(c).name ?? ""} ${c.phone}`.trim(), from: from_number ?? "location default", message: item.message, characters: item.message.length, segments: Math.ceil(item.message.length / 160) },
          execute: async (p) => sendOne(ctx, "SMS", p.item, { fromNumber: p.from_number }),
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "send_email",
    title: "Send email",
    description: "Send an email to one contact through GHL. Provide `html` or plain `message`. Supports merge fields like {{contact.first_name}}.",
    write: true,
    schema: {
      contact_id: z.string(),
      subject: z.string().min(1),
      html: z.string().optional(),
      message: z.string().optional().describe("Plain-text body (used if html not given)"),
      email_from: emailFromArg,
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      ...confirmTokenArg,
    },
    handler: async ({ contact_id, subject, html, message, email_from, cc, bcc, confirm_token }, ctx) => {
      if (!html && !message) throw new Error("Provide html or message");
      const c = await ctx.data.getContact(contact_id);
      const blocked = blockReason(c, "Email");
      if (blocked) throw new Error(`Can't email ${compactContact(c).name ?? contact_id}: ${blocked}.`);
      const cf = await ctx.data.customFieldKeyMap();
      const item: SendItem = {
        contact_id,
        to: c.email,
        subject: renderTemplate(subject, c, cf),
        html: html ? renderTemplate(html, c, cf) : undefined,
        message: message ? renderTemplate(message, c, cf) : undefined,
      };
      return runConfirmable(
        ctx.confirm,
        {
          tool: "send_email",
          plan: { item, email_from, cc, bcc },
          count: 1,
          preview: { action: "SEND EMAIL", to: `${compactContact(c).name ?? ""} <${c.email}>`, from: email_from ?? "location default", cc, bcc, subject: item.subject, body: item.html ?? item.message },
          execute: async (p) => sendOne(ctx, "Email", p.item, { emailFrom: p.email_from, cc: p.cc, bcc: p.bcc }),
        },
        confirm_token,
      );
    },
  }),

  defineTool({
    name: "bulk_send",
    title: "Bulk SMS / email",
    description:
      "Send a personalized SMS or email to many contacts (by IDs and/or filter). Merge fields: {{contact.first_name}}, {{contact.last_name}}, {{contact.name}}, {{contact.email}}, {{contact.phone}}, {{contact.company_name}}, {{contact.<custom_field_key>}}, with fallbacks like {{contact.first_name|there}}. Contacts with DND or missing phone/email are skipped automatically.",
    write: true,
    schema: {
      channel: z.enum(["SMS", "Email"]),
      contact_ids: z.array(z.string()).optional(),
      filter: contactFilterSchema.optional(),
      message: z.string().optional().describe("SMS text, or plain-text email body"),
      subject: z.string().optional().describe("Email subject (required for Email)"),
      html: z.string().optional().describe("Email HTML body"),
      email_from: emailFromArg,
      from_number: fromNumberArg,
      max_recipients: z.number().int().min(1).max(5000).default(200),
      ...confirmTokenArg,
    },
    handler: async (args, ctx) => {
      const channel: Channel = args.channel;
      if (channel === "SMS" && !args.message) throw new Error("SMS needs `message`");
      if (channel === "Email" && (!args.subject || (!args.html && !args.message))) throw new Error("Email needs `subject` and `html` or `message`");
      const contacts = await ctx.data.resolveContacts(args.contact_ids, args.filter, args.max_recipients);
      const cf = await ctx.data.customFieldKeyMap();
      const items: SendItem[] = [];
      const skipped: Array<{ id: string; name?: string; reason: string }> = [];
      for (const c of contacts) {
        const reason = blockReason(c, channel);
        if (reason) {
          skipped.push({ id: c.id, name: compactContact(c).name, reason });
          continue;
        }
        items.push({
          contact_id: c.id,
          to: channel === "SMS" ? c.phone : c.email,
          message: args.message ? renderTemplate(args.message, c, cf) : undefined,
          subject: args.subject ? renderTemplate(args.subject, c, cf) : undefined,
          html: args.html ? renderTemplate(args.html, c, cf) : undefined,
        });
      }
      items.sort((a, b) => a.contact_id.localeCompare(b.contact_id));
      const plan = { channel, items, email_from: args.email_from, from_number: args.from_number };
      const skippedByReason: Record<string, number> = {};
      for (const s of skipped) skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
      return runConfirmable(
        ctx.confirm,
        {
          tool: "bulk_send",
          plan,
          count: items.length,
          preview: {
            action: `BULK SEND ${channel} to ${items.length} contacts`,
            matched_contacts: contacts.length,
            will_send: items.length,
            skipped: skipped.length,
            skipped_by_reason: skippedByReason,
            from: channel === "SMS" ? args.from_number ?? "location default" : args.email_from ?? "location default",
            rendered_samples: items.slice(0, 3),
            hit_max_recipients: contacts.length >= args.max_recipients,
          },
          execute: async (p) => {
            const results = [];
            for (const it of p.items) {
              try {
                const r = await sendOne(ctx, p.channel, it, { emailFrom: p.email_from, fromNumber: p.from_number });
                results.push({ id: it.contact_id, ok: true, messageId: r.messageId });
              } catch (e) {
                results.push({ id: it.contact_id, ok: false, to: it.to, error: (e as Error).message });
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
    name: "search_conversations",
    title: "Search conversations",
    description: "List conversations (inbox), newest first. Filter by contact, unread status, or text.",
    schema: {
      contact_id: z.string().optional(),
      query: z.string().optional(),
      status: z.enum(["all", "read", "unread", "starred", "recents"]).optional(),
      assigned_to: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    handler: async ({ contact_id, query, status, assigned_to, limit }, { client, data }) => {
      const res = await client.get("/conversations/search", {
        locationId: data.locationId,
        contactId: contact_id,
        query,
        status,
        assignedTo: assigned_to,
        limit,
        sort: "desc",
        sortBy: "last_message_date",
      });
      return {
        total: res.total,
        conversations: (res.conversations ?? []).map((c: any) => ({
          id: c.id,
          contactId: c.contactId,
          contact: c.fullName ?? c.contactName,
          email: c.email,
          phone: c.phone,
          lastMessageType: c.lastMessageType,
          lastMessageDirection: c.lastMessageDirection,
          lastMessageBody: c.lastMessageBody,
          lastMessageDate: c.lastMessageDate ? new Date(c.lastMessageDate).toISOString() : undefined,
          unreadCount: c.unreadCount,
          assignedTo: c.assignedTo,
        })),
      };
    },
  }),

  defineTool({
    name: "get_conversation_messages",
    title: "Get conversation messages",
    description: "Read the message history (SMS, email, calls, etc.) of a conversation, newest first.",
    schema: {
      conversation_id: z.string(),
      limit: z.number().int().min(1).max(100).default(30),
      types: z.array(z.string()).optional().describe("e.g. TYPE_SMS, TYPE_EMAIL, TYPE_CALL"),
    },
    handler: async ({ conversation_id, limit, types }, { client }) => {
      const res = await client.get(`/conversations/${conversation_id}/messages`, { limit, type: types?.join(",") });
      const box = res.messages ?? {};
      const list: any[] = Array.isArray(box) ? box : box.messages ?? [];
      return {
        nextPage: box.nextPage,
        messages: list.map((m) => ({
          id: m.id,
          type: m.messageType,
          direction: m.direction,
          status: m.status,
          date: m.dateAdded,
          body: m.body,
          subject: m.meta?.email?.subject,
          call: m.meta?.call,
          userId: m.userId,
        })),
      };
    },
  }),
];
