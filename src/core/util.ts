import { createHash } from "node:crypto";

/** Deterministic JSON stringify (sorted keys) so plan hashes are stable. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function sha256(s: string | Buffer): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Parse a date-ish input (ISO string, YYYY-MM-DD, or ms epoch) to epoch ms. */
export function toMs(input: string | number | undefined | null): number | undefined {
  if (input === undefined || input === null || input === "") return undefined;
  if (typeof input === "number") return input;
  if (/^\d{12,}$/.test(input)) return Number(input);
  const t = Date.parse(input);
  if (Number.isNaN(t)) throw new Error(`Invalid date: "${input}". Use ISO format like 2026-01-31 or 2026-01-31T15:00:00Z.`);
  return t;
}

/** Resolve a [start, end] range; defaults to the last `defaultDays` days. A bare end date includes that whole day. */
export function dateRange(start?: string, end?: string, defaultDays = 30): { start: number; end: number } {
  const endMs = end ? toMs(end)! + (/^\d{4}-\d{2}-\d{2}$/.test(end) ? 86_399_999 : 0) : Date.now();
  const startMs = start ? toMs(start)! : endMs - defaultDays * 86_400_000;
  if (startMs > endMs) throw new Error("start_date must be before end_date");
  return { start: startMs, end: endMs };
}

export function iso(ms: number | undefined): string | undefined {
  return ms === undefined ? undefined : new Date(ms).toISOString();
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(email: unknown): string | undefined {
  if (typeof email !== "string") return undefined;
  const e = email.trim().toLowerCase();
  return e && EMAIL_RE.test(e) ? e : undefined;
}

/**
 * Normalize a phone number to E.164. Numbers without a leading "+" get
 * `defaultCountryCode` prefixed (10-digit numbers) — "1" (US/Canada) by default.
 */
export function normalizePhone(phone: unknown, defaultCountryCode = "1"): string | undefined {
  if (phone === undefined || phone === null) return undefined;
  const raw = String(phone).trim();
  if (!raw) return undefined;
  const plus = raw.startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : undefined;
  if (digits.length === 10) return `+${defaultCountryCode}${digits}`;
  if (digits.length === 11 && defaultCountryCode === "1" && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 10 && digits.length <= 15 && digits.startsWith(defaultCountryCode)) return `+${digits}`;
  return undefined;
}

/** Render {{contact.first_name}}-style merge fields. Supports fallbacks: {{contact.first_name|there}}. */
export function renderTemplate(
  template: string,
  contact: Record<string, any>,
  customFieldsByKey: Record<string, string> = {},
  extra: Record<string, unknown> = {},
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*(?:\|\s*([^}]*?)\s*)?\}\}/g, (_m, key: string, fallback?: string) => {
    const value = key in extra ? extra[key] : mergeValue(key, contact, customFieldsByKey);
    return value !== undefined && value !== null && String(value).trim() !== "" ? String(value) : fallback ?? "";
  });
}

function mergeValue(key: string, c: Record<string, any>, cfByKey: Record<string, string>): unknown {
  const k = key.replace(/^contact\./, "");
  const first = c.firstName ?? c.firstNameRaw;
  const last = c.lastName ?? c.lastNameRaw;
  switch (k) {
    case "first_name":
    case "firstName":
      return first;
    case "last_name":
    case "lastName":
      return last;
    case "name":
    case "full_name":
      return c.contactName ?? c.name ?? [first, last].filter(Boolean).join(" ");
    case "email":
      return c.email;
    case "phone":
      return c.phone;
    case "company_name":
    case "companyName":
      return c.companyName;
    case "city":
      return c.city;
    case "state":
      return c.state;
    case "source":
      return c.source;
  }
  // custom fields: {{contact.<fieldKey>}} or {{custom.<fieldId>}}
  const cfId = key.startsWith("custom.") ? key.slice(7) : cfByKey[k] ?? cfByKey[key];
  if (cfId && Array.isArray(c.customFields)) {
    const f = c.customFields.find((x: any) => x.id === cfId);
    return f?.value ?? f?.field_value;
  }
  return c[k];
}

/** Keep only the useful parts of a contact to keep tool output small. */
export function compactContact(c: any) {
  if (!c) return c;
  return {
    id: c.id,
    name: c.contactName ?? c.name ?? ([c.firstName, c.lastName].filter(Boolean).join(" ") || undefined),
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email,
    phone: c.phone,
    companyName: c.companyName,
    tags: c.tags,
    source: c.source,
    assignedTo: c.assignedTo,
    dnd: c.dnd || undefined,
    dateAdded: c.dateAdded,
    dateUpdated: c.dateUpdated,
    customFields: Array.isArray(c.customFields) && c.customFields.length ? c.customFields : undefined,
  };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function groupCount<T>(items: T[], key: (t: T) => string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it) ?? "(none)";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
