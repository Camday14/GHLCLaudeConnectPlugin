import { readFile, writeFile } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { z } from "zod";
import { runConfirmable } from "../confirm.js";
import { confirmTokenArg, defineTool, type Ctx, type ToolDef } from "../context.js";
import { contactFilterSchema } from "../schemas.js";
import { normalizeEmail, normalizePhone, sha256 } from "../util.js";

/** Normalized header -> GHL contact field. */
const HEADER_ALIASES: Record<string, string> = {
  firstname: "firstName", first: "firstName", fname: "firstName", givenname: "firstName",
  lastname: "lastName", last: "lastName", lname: "lastName", surname: "lastName", familyname: "lastName",
  name: "name", fullname: "name", contactname: "name",
  email: "email", emailaddress: "email", mail: "email", workemail: "email",
  phone: "phone", phonenumber: "phone", mobile: "phone", mobilephone: "phone", cell: "phone", cellphone: "phone", tel: "phone", telephone: "phone",
  company: "companyName", companyname: "companyName", business: "companyName", businessname: "companyName", organization: "companyName", organisation: "companyName",
  address: "address1", address1: "address1", street: "address1", streetaddress: "address1",
  city: "city", town: "city",
  state: "state", province: "state", region: "state",
  zip: "postalCode", zipcode: "postalCode", postalcode: "postalCode", postcode: "postalCode",
  country: "country",
  website: "website", url: "website", site: "website",
  source: "source", leadsource: "source",
  tags: "tags", tag: "tags",
  dateofbirth: "dateOfBirth", dob: "dateOfBirth", birthday: "dateOfBirth",
  timezone: "timezone",
  opportunityvalue: "opportunity_value", dealvalue: "opportunity_value", value: "opportunity_value", amount: "opportunity_value",
  opportunityname: "opportunity_name", dealname: "opportunity_name",
};

const STANDARD = new Set(["firstName", "lastName", "name", "email", "phone", "companyName", "address1", "city", "state", "postalCode", "country", "website", "source", "dateOfBirth", "timezone"]);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export function autoMap(headers: string[], customFields: any[]): Record<string, string> {
  const cfByNorm = new Map<string, string>();
  for (const f of customFields) {
    if (f.name) cfByNorm.set(norm(f.name), f.id);
    if (f.fieldKey) cfByNorm.set(norm(String(f.fieldKey).replace(/^contact\./, "")), f.id);
  }
  const out: Record<string, string> = {};
  for (const h of headers) {
    const n = norm(h);
    if (HEADER_ALIASES[n]) out[h] = HEADER_ALIASES[n];
    else if (cfByNorm.has(n)) out[h] = `custom:${cfByNorm.get(n)}`;
    else out[h] = "ignore";
  }
  return out;
}

export interface MappedRow {
  row: number;
  contact: Record<string, any>;
  tags: string[];
  opportunity_value?: number;
  opportunity_name?: string;
}

export function mapRows(rows: Record<string, string>[], mapping: Record<string, string>, defaultCountryCode: string) {
  const valid: MappedRow[] = [];
  const invalid: Array<{ row: number; reason: string; data: Record<string, string> }> = [];
  rows.forEach((r, i) => {
    const rowNum = i + 2; // header is row 1
    const contact: Record<string, any> = {};
    const customFields: Array<{ id: string; field_value: string }> = [];
    let tags: string[] = [];
    let oppValue: number | undefined;
    let oppName: string | undefined;
    const problems: string[] = [];
    for (const [header, target] of Object.entries(mapping)) {
      const raw = r[header];
      if (raw === undefined || raw === null || String(raw).trim() === "" || target === "ignore") continue;
      const v = String(raw).trim();
      if (target === "tags") tags.push(...v.split(/[,;|]/).map((t) => t.trim()).filter(Boolean));
      else if (target === "opportunity_value") {
        const n = Number(v.replace(/[^0-9.-]/g, ""));
        if (Number.isFinite(n)) oppValue = n;
      } else if (target === "opportunity_name") oppName = v;
      else if (target.startsWith("custom:")) customFields.push({ id: target.slice(7), field_value: v });
      else if (target === "email") {
        const e = normalizeEmail(v);
        if (e) contact.email = e;
        else problems.push(`invalid email "${v}"`);
      } else if (target === "phone") {
        const p = normalizePhone(v, defaultCountryCode);
        if (p) contact.phone = p;
        else problems.push(`invalid phone "${v}"`);
      } else if (STANDARD.has(target)) contact[target] = v;
    }
    if (contact.name && !contact.firstName && !contact.lastName) {
      const parts = String(contact.name).split(/\s+/);
      contact.firstName = parts.shift();
      if (parts.length) contact.lastName = parts.join(" ");
    }
    if (customFields.length) contact.customFields = customFields;
    tags = [...new Set(tags)];
    if (!contact.email && !contact.phone) {
      invalid.push({ row: rowNum, reason: ["no valid email or phone", ...problems].join("; "), data: r });
      return;
    }
    valid.push({ row: rowNum, contact, tags, opportunity_value: oppValue, opportunity_name: oppName, ...(problems.length ? { warnings: problems } : {}) } as MappedRow);
  });
  return { valid, invalid };
}

/** Within-file duplicates by email/phone: keep the first occurrence. */
export function dedupeRows(rows: MappedRow[]) {
  const seen = new Set<string>();
  const kept: MappedRow[] = [];
  const dupes: number[] = [];
  for (const r of rows) {
    const keys = [r.contact.email && `e:${r.contact.email}`, r.contact.phone && `p:${r.contact.phone}`].filter(Boolean) as string[];
    if (keys.some((k) => seen.has(k))) {
      dupes.push(r.row);
      continue;
    }
    keys.forEach((k) => seen.add(k));
    kept.push(r);
  }
  return { kept, dupes };
}

async function resolveStageForImport(ctx: Ctx, stage?: string, pipelineId?: string) {
  if (!stage) return undefined;
  const idx = await ctx.data.stageIndex();
  if (idx[stage]) return { stageId: stage, ...idx[stage] };
  const m = Object.entries(idx).filter(([, s]) => s.stageName.toLowerCase() === stage.toLowerCase() && (!pipelineId || s.pipelineId === pipelineId));
  if (m.length !== 1) throw new Error(`Stage "${stage}" ${m.length ? "is ambiguous; pass pipeline_id" : "not found"}.`);
  return { stageId: m[0][0], ...m[0][1] };
}

export const importTools: ToolDef<any>[] = [
  defineTool({
    name: "import_contacts_csv",
    title: "Import contacts from CSV",
    description:
      "Import contacts from a CSV (a file path on the computer running the desktop extension, or the CSV text itself via csv_text). Columns are auto-mapped to GHL fields (first/last name, email, phone, company, address, source, tags, and custom fields by name); override with `mapping`. Rows are validated and normalized, deduplicated, and upserted (existing contacts matched by email/phone are updated, not duplicated). Can tag every imported contact and create a deal for each in a pipeline stage. Failed rows are written to <file>.failures.csv.",
    write: true,
    schema: {
      file_path: z.string().optional().describe("Absolute path to the CSV file (desktop/local only)"),
      csv_text: z.string().optional().describe("The CSV content itself, including the header row (use this when connected via the hosted connector)"),
      mapping: z
        .record(z.string())
        .optional()
        .describe('Override column mapping: {"CSV Header": "firstName" | "lastName" | "name" | "email" | "phone" | "companyName" | "address1" | "city" | "state" | "postalCode" | "country" | "website" | "source" | "tags" | "custom:<fieldId>" | "opportunity_value" | "opportunity_name" | "ignore"}'),
      add_tags: z.array(z.string()).optional().describe("Tags to add to every imported contact (e.g. an import batch tag)"),
      source: z.string().optional().describe("Lead source to set on contacts that don't have one in the file"),
      assigned_to: z.string().optional().describe("User ID to assign all imported contacts to"),
      opportunity_stage: z.string().optional().describe("If set, create a deal in this stage (ID or name) for each imported contact"),
      pipeline_id: z.string().optional(),
      skip_if_open_opportunity: z.boolean().default(true).describe("Don't create a deal if the contact already has an open deal in that pipeline"),
      default_country_code: z.string().optional().describe('Phone country code for numbers without "+", default "1"'),
      max_rows: z.number().int().min(1).max(50000).default(5000),
      ...confirmTokenArg,
    },
    handler: async (a, ctx) => {
      const buf = await loadCsv(a, ctx);
      const records: Record<string, string>[] = parse(buf, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
      if (records.length > a.max_rows) throw new Error(`File has ${records.length} rows, above max_rows=${a.max_rows}. Raise max_rows or split the file.`);
      const headers = records.length ? Object.keys(records[0]) : [];
      const customFields = await ctx.data.customFields().catch(() => []);
      const mapping = { ...autoMap(headers, customFields), ...(a.mapping ?? {}) };
      const cc = a.default_country_code ?? ctx.config.defaultCountryCode;
      const { valid, invalid } = mapRows(records, mapping, cc);
      const { kept, dupes } = dedupeRows(valid);
      for (const r of kept) {
        if (a.source && !r.contact.source) r.contact.source = a.source;
        if (a.assigned_to) r.contact.assignedTo = a.assigned_to;
      }
      const stage = await resolveStageForImport(ctx, a.opportunity_stage, a.pipeline_id);
      const plan = {
        file_sha256: sha256(buf),
        mapping,
        rows: kept,
        add_tags: a.add_tags ?? [],
        stage_id: stage?.stageId,
        pipeline_id: stage?.pipelineId,
        skip_if_open_opportunity: a.skip_if_open_opportunity,
      };
      const failuresPath = a.file_path && ctx.config.fileAccess ? a.file_path.replace(/\.csv$/i, "") + ".failures.csv" : undefined;
      return runConfirmable(
        ctx.confirm,
        {
          tool: "import_contacts_csv",
          plan,
          count: kept.length,
          preview: {
            action: `IMPORT ${kept.length} contacts (create or update)` + (stage ? ` and create deals in "${stage.stageName}" (${stage.pipelineName})` : ""),
            rows_in_file: records.length,
            valid_rows: kept.length,
            invalid_rows: invalid.length,
            duplicate_rows_in_file: dupes.length,
            column_mapping: mapping,
            unmapped_columns: Object.entries(mapping).filter(([, t]) => t === "ignore").map(([h]) => h),
            tags_added_to_all: plan.add_tags,
            sample_mapped_rows: kept.slice(0, 5),
            sample_invalid_rows: invalid.slice(0, 5),
          },
          execute: async (p) => {
            let created = 0, updated = 0, oppsCreated = 0;
            const failures: Array<Record<string, string>> = invalid.map((x) => ({ row: String(x.row), reason: x.reason, ...x.data }));
            for (const r of p.rows) {
              try {
                const res = await ctx.client.post("/contacts/upsert", { locationId: ctx.data.locationId, ...r.contact });
                const id = res.contact?.id;
                if (res.new) created++;
                else updated++;
                const tags = [...new Set([...r.tags, ...p.add_tags])];
                if (id && tags.length) await ctx.client.post(`/contacts/${id}/tags`, { tags });
                if (id && p.stage_id) {
                  let skip = false;
                  if (!res.new && p.skip_if_open_opportunity) {
                    const existing = await ctx.data.searchOpportunities({ contact_id: id, pipeline_id: p.pipeline_id, status: "open" }, 1);
                    skip = existing.items.length > 0;
                  }
                  if (!skip) {
                    const name = r.opportunity_name ?? ([r.contact.firstName, r.contact.lastName].filter(Boolean).join(" ") || r.contact.email || r.contact.phone);
                    await ctx.client.post("/opportunities/", {
                      locationId: ctx.data.locationId,
                      pipelineId: p.pipeline_id,
                      pipelineStageId: p.stage_id,
                      contactId: id,
                      name,
                      status: "open",
                      monetaryValue: r.opportunity_value,
                      assignedTo: r.contact.assignedTo,
                    });
                    oppsCreated++;
                  }
                }
              } catch (e) {
                failures.push({ row: String(r.row), reason: (e as Error).message, ...flatten(r.contact) });
              }
            }
            const failuresCsv = failures.length ? stringify(failures, { header: true, columns: unionKeys(failures) }) : undefined;
            if (failuresCsv && failuresPath) await writeFile(failuresPath, failuresCsv);
            ctx.data.invalidate("tags");
            return {
              contacts_created: created,
              contacts_updated: updated,
              opportunities_created: oppsCreated,
              failed_rows: failures.length,
              failures_file: failuresCsv && failuresPath ? failuresPath : undefined,
              failures_csv: failuresCsv && !failuresPath ? failuresCsv.slice(0, 200_000) : undefined,
              sample_failures: failures.slice(0, 10),
            };
          },
        },
        a.confirm_token,
      );
    },
  }),

  defineTool({
    name: "export_contacts_csv",
    title: "Export contacts to CSV",
    description: "Export contacts matching a filter as CSV: written to a file (desktop/local only) or returned as CSV text.",
    schema: {
      file_path: z.string().optional().describe("Absolute output path, e.g. /Users/me/Desktop/leads.csv (desktop/local only). Omit to get the CSV text back."),
      filter: contactFilterSchema.optional(),
      include_custom_fields: z.boolean().default(true),
      max_contacts: z.number().int().min(1).max(50000).default(5000),
    },
    handler: async (a, ctx) => {
      const { items, truncated } = await ctx.data.searchContacts(a.filter ?? {}, a.max_contacts);
      const cfs = a.include_custom_fields ? await ctx.data.customFields().catch(() => []) : [];
      const cfName = new Map(cfs.map((f: any) => [f.id, f.name]));
      const names = await ctx.data.userNames();
      const rows = items.map((c) => {
        const row: Record<string, string> = {
          id: c.id,
          firstName: c.firstName ?? "",
          lastName: c.lastName ?? "",
          email: c.email ?? "",
          phone: c.phone ?? "",
          companyName: c.companyName ?? "",
          address1: c.address1 ?? "",
          city: c.city ?? "",
          state: c.state ?? "",
          postalCode: c.postalCode ?? "",
          country: c.country ?? "",
          source: c.source ?? "",
          tags: (c.tags ?? []).join(", "),
          assignedTo: c.assignedTo ? names[c.assignedTo] ?? c.assignedTo : "",
          dnd: c.dnd ? "true" : "",
          dateAdded: c.dateAdded ?? "",
          dateUpdated: c.dateUpdated ?? "",
        };
        for (const f of c.customFields ?? []) {
          if (a.include_custom_fields) row[String(cfName.get(f.id) ?? f.id)] = Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "");
        }
        return row;
      });
      const csv = stringify(rows, { header: true, columns: unionKeys(rows) });
      if (a.file_path) {
        if (!ctx.config.fileAccess) throw new Error("file_path is only available in the desktop extension. Omit it to get the CSV text back.");
        await writeFile(a.file_path, csv);
        return { file: a.file_path, contacts_exported: rows.length, truncated };
      }
      const MAX = 1_000_000;
      return { contacts_exported: rows.length, truncated, csv_truncated: csv.length > MAX || undefined, csv: csv.slice(0, MAX) };
    },
  }),
];

async function loadCsv(a: { file_path?: string; csv_text?: string }, ctx: Ctx): Promise<Buffer> {
  if (a.csv_text) return Buffer.from(a.csv_text, "utf8");
  if (!a.file_path) throw new Error("Provide file_path or csv_text.");
  if (!ctx.config.fileAccess) throw new Error("This server can't read files from your computer. Pass the CSV content as csv_text instead.");
  return readFile(a.file_path);
}

function flatten(c: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(c)) out[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  return out;
}

function unionKeys(rows: Array<Record<string, unknown>>): string[] {
  const keys = new Set<string>();
  rows.forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return [...keys];
}
