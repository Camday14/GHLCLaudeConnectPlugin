import { z } from "zod";

export const contactFilterSchema = z
  .object({
    query: z.string().optional().describe("Free-text search across name, email, phone, company"),
    tags_any: z.array(z.string()).optional().describe("Contact has at least one of these tags"),
    tags_all: z.array(z.string()).optional().describe("Contact has all of these tags"),
    exclude_tags: z.array(z.string()).optional().describe("Contact has none of these tags"),
    assigned_to: z.string().optional().describe("User ID the contact is assigned to (see list_users)"),
    unassigned: z.boolean().optional().describe("Only contacts with no assigned user"),
    source: z.string().optional().describe("Exact lead source"),
    created_after: z.string().optional().describe("ISO date, e.g. 2026-01-01"),
    created_before: z.string().optional(),
    updated_after: z.string().optional(),
    updated_before: z.string().optional(),
    has_email: z.boolean().optional(),
    has_phone: z.boolean().optional(),
    raw_filters: z
      .array(z.any())
      .optional()
      .describe('Advanced: raw GHL search filters, e.g. {"field":"customFields.<fieldId>","operator":"eq","value":"x"}'),
  })
  .describe("Contact filter");

export const contactFieldsSchema = {
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional().describe("E.164 preferred, e.g. +15551234567"),
  companyName: z.string().optional(),
  address1: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional().describe("2-letter country code"),
  website: z.string().optional(),
  timezone: z.string().optional(),
  source: z.string().optional(),
  assignedTo: z.string().optional().describe("User ID"),
  dnd: z.boolean().optional().describe("Do-not-disturb on all channels"),
  tags: z.array(z.string()).optional(),
  customFields: z
    .array(z.object({ id: z.string().describe("Custom field ID (see list_custom_fields)"), field_value: z.any() }))
    .optional(),
};

export const dateRangeSchema = {
  start_date: z.string().optional().describe("ISO date (default: 30 days ago)"),
  end_date: z.string().optional().describe("ISO date (default: now). A bare date includes the whole day."),
};
