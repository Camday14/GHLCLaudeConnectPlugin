import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface RemoteConfig {
  publicUrl: string;
  port: number;
  databaseUrl?: string;
  encryptionKey: Buffer;
  connectPasscode?: string;
  allowedLocationIds: string[];
  allowOpen: boolean;
  adminPassword?: string;
  ghlClientId?: string;
  ghlClientSecret?: string;
  ghlScopes: string[];
  webhookSecret?: string;
  webhookPublicKey?: string;
  readOnly: boolean;
  confirmThreshold: number;
  defaultCountryCode: string;
  ghlBaseUrl?: string;
  /** Base URL of the GHL marketplace (OAuth location chooser). */
  ghlMarketplaceUrl: string;
  workerIntervalMs: number;
  pollIntervalMs: number;
}

export const DEFAULT_GHL_SCOPES = [
  "contacts.readonly",
  "contacts.write",
  "conversations.readonly",
  "conversations.write",
  "conversations/message.readonly",
  "conversations/message.write",
  "opportunities.readonly",
  "opportunities.write",
  "users.readonly",
  "locations.readonly",
  "locations/customFields.readonly",
  "locations/tags.readonly",
  "locations/tags.write",
  "workflows.readonly",
  "calendars.readonly",
  "calendars/events.readonly",
  "payments/transactions.readonly",
];

/** Accepts a 32-byte key as base64/hex, or any passphrase of 32+ chars (hashed to 32 bytes). */
export function parseEncryptionKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error("ENCRYPTION_KEY is required (generate one with: openssl rand -base64 32).");
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(raw)) return b64;
  if (raw.length < 32) throw new Error("ENCRYPTION_KEY must be 32 random bytes (base64/hex) or a passphrase of at least 32 characters.");
  return createHash("sha256").update(raw).digest();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RemoteConfig {
  const port = Number(env.PORT ?? 3000);
  const publicUrl = (env.PUBLIC_URL ?? (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${port}`)).replace(/\/+$/, "");
  const cfg: RemoteConfig = {
    publicUrl,
    port,
    databaseUrl: env.DATABASE_URL,
    encryptionKey: parseEncryptionKey(env.ENCRYPTION_KEY),
    connectPasscode: env.CONNECT_PASSCODE || undefined,
    allowedLocationIds: (env.ALLOWED_LOCATION_IDS ?? "").split(/[,\s]+/).filter(Boolean),
    allowOpen: /^(1|true|yes)$/i.test(env.ALLOW_OPEN ?? ""),
    adminPassword: env.ADMIN_PASSWORD || undefined,
    ghlClientId: env.GHL_CLIENT_ID || undefined,
    ghlClientSecret: env.GHL_CLIENT_SECRET || undefined,
    ghlScopes: env.GHL_SCOPES ? env.GHL_SCOPES.split(/[,\s]+/).filter(Boolean) : DEFAULT_GHL_SCOPES,
    webhookSecret: env.WEBHOOK_SECRET || undefined,
    webhookPublicKey: env.GHL_WEBHOOK_PUBLIC_KEY ? env.GHL_WEBHOOK_PUBLIC_KEY.replace(/\\n/g, "\n") : undefined,
    readOnly: /^(1|true|yes)$/i.test(env.GHL_READ_ONLY ?? ""),
    confirmThreshold: Math.max(1, Math.floor(Number(env.GHL_BULK_CONFIRM_THRESHOLD ?? 1)) || 1),
    defaultCountryCode: (env.GHL_DEFAULT_COUNTRY_CODE ?? "1").replace(/\D/g, "") || "1",
    ghlBaseUrl: env.GHL_BASE_URL || undefined,
    ghlMarketplaceUrl: (env.GHL_MARKETPLACE_URL ?? "https://marketplace.gohighlevel.com").replace(/\/+$/, ""),
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS ?? 15_000),
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? 5 * 60_000),
  };
  if (!cfg.connectPasscode && !cfg.allowedLocationIds.length && !cfg.allowOpen) {
    throw new Error(
      "Refusing to start an open connector: set CONNECT_PASSCODE and/or ALLOWED_LOCATION_IDS so only you and your team can connect (or ALLOW_OPEN=true if you really want anyone to be able to connect).",
    );
  }
  return cfg;
}

// ---------- crypto helpers ----------

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encrypt(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(key: Buffer, payload: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || ct === undefined) throw new Error("Unrecognized encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}
