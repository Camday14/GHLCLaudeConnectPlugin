import { DEFAULT_BASE_URL, GhlClient } from "../core/client.js";
import { decrypt, encrypt, type RemoteConfig } from "./config.js";
import type { Db } from "./db.js";

export interface Connection {
  location_id: string;
  auth_type: "pit" | "oauth";
  location_name?: string | null;
  company_id?: string | null;
  status: string;
  last_error?: string | null;
  access_expires_at?: Date | null;
  created_at?: Date;
  updated_at?: Date;
}

export interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  locationId?: string;
  companyId?: string;
  userId?: string;
  userType?: string;
  scope?: string;
}

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * Stores GHL credentials (encrypted) per location and hands out API clients that
 * transparently refresh OAuth tokens.
 */
export class ConnectionStore {
  private refreshing = new Map<string, Promise<string>>();

  constructor(
    private db: Db,
    private cfg: RemoteConfig,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get ghlBaseUrl() {
    return this.cfg.ghlBaseUrl ?? DEFAULT_BASE_URL;
  }

  isAllowed(locationId: string): boolean {
    return !this.cfg.allowedLocationIds.length || this.cfg.allowedLocationIds.includes(locationId);
  }

  async savePit(locationId: string, token: string, locationName?: string) {
    await this.db.query(
      `INSERT INTO connections (location_id, auth_type, enc_access, enc_refresh, access_expires_at, location_name, status, last_error, updated_at)
       VALUES ($1, 'pit', $2, NULL, NULL, $3, 'active', NULL, now())
       ON CONFLICT (location_id) DO UPDATE SET auth_type='pit', enc_access=$2, enc_refresh=NULL, access_expires_at=NULL,
         location_name=COALESCE($3, connections.location_name), status='active', last_error=NULL, updated_at=now()`,
      [locationId, encrypt(this.cfg.encryptionKey, token), locationName ?? null],
    );
  }

  async saveOAuth(t: OAuthTokenResponse, locationName?: string) {
    if (!t.locationId) throw new Error("GoHighLevel did not return a locationId. Make sure the app is installed on a sub-account (Location), not the agency.");
    await this.db.query(
      `INSERT INTO connections (location_id, auth_type, enc_access, enc_refresh, access_expires_at, location_name, company_id, ghl_user_id, status, last_error, updated_at)
       VALUES ($1, 'oauth', $2, $3, $4, $5, $6, $7, 'active', NULL, now())
       ON CONFLICT (location_id) DO UPDATE SET auth_type='oauth', enc_access=$2, enc_refresh=$3, access_expires_at=$4,
         location_name=COALESCE($5, connections.location_name), company_id=$6, ghl_user_id=$7, status='active', last_error=NULL, updated_at=now()`,
      [
        t.locationId,
        encrypt(this.cfg.encryptionKey, t.access_token),
        t.refresh_token ? encrypt(this.cfg.encryptionKey, t.refresh_token) : null,
        new Date(Date.now() + (t.expires_in ?? 86_400) * 1000),
        locationName ?? null,
        t.companyId ?? null,
        t.userId ?? null,
      ],
    );
  }

  async get(locationId: string): Promise<Connection | undefined> {
    const { rows } = await this.db.query<Connection>(
      `SELECT location_id, auth_type, location_name, company_id, status, last_error, access_expires_at, created_at, updated_at FROM connections WHERE location_id=$1`,
      [locationId],
    );
    return rows[0];
  }

  async list(): Promise<Connection[]> {
    const { rows } = await this.db.query<Connection>(
      `SELECT location_id, auth_type, location_name, company_id, status, last_error, access_expires_at, created_at, updated_at FROM connections ORDER BY created_at`,
    );
    return rows;
  }

  async disconnect(locationId: string) {
    await this.db.query(`UPDATE connections SET status='disconnected', updated_at=now() WHERE location_id=$1`, [locationId]);
    await this.db.query(`UPDATE tokens SET revoked=true WHERE location_id=$1`, [locationId]);
  }

  /** Returns a valid GHL access token for the location, refreshing OAuth tokens when needed. */
  async accessToken(locationId: string): Promise<string> {
    const { rows } = await this.db.query(`SELECT * FROM connections WHERE location_id=$1`, [locationId]);
    const c = rows[0];
    if (!c || c.status !== "active") throw new Error(`GoHighLevel location ${locationId} is not connected. Reconnect the connector in Claude.`);
    if (c.auth_type === "pit") return decrypt(this.cfg.encryptionKey, c.enc_access);
    const expires = c.access_expires_at ? new Date(c.access_expires_at).getTime() : 0;
    if (expires - Date.now() > REFRESH_MARGIN_MS) return decrypt(this.cfg.encryptionKey, c.enc_access);
    // Single-flight refresh per location (refresh tokens rotate, so never refresh twice concurrently).
    let p = this.refreshing.get(locationId);
    if (!p) {
      p = this.refresh(locationId).finally(() => this.refreshing.delete(locationId));
      this.refreshing.set(locationId, p);
    }
    return p;
  }

  private async refresh(locationId: string): Promise<string> {
    if (!this.cfg.ghlClientId || !this.cfg.ghlClientSecret) throw new Error("GHL_CLIENT_ID / GHL_CLIENT_SECRET are not configured, so the GoHighLevel login can't be refreshed.");
    return this.db.tx(async (q) => {
      const { rows } = await q.query(`SELECT * FROM connections WHERE location_id=$1 FOR UPDATE`, [locationId]);
      const c = rows[0];
      const expires = c.access_expires_at ? new Date(c.access_expires_at).getTime() : 0;
      if (expires - Date.now() > REFRESH_MARGIN_MS) return decrypt(this.cfg.encryptionKey, c.enc_access); // refreshed by someone else
      if (!c.enc_refresh) throw new Error("No refresh token stored; reconnect the connector in Claude.");
      let t: OAuthTokenResponse;
      try {
        t = await this.tokenRequest({
          grant_type: "refresh_token",
          refresh_token: decrypt(this.cfg.encryptionKey, c.enc_refresh),
          user_type: "Location",
        });
      } catch (e) {
        await q.query(`UPDATE connections SET last_error=$2, updated_at=now() WHERE location_id=$1`, [locationId, (e as Error).message]);
        throw new Error(`Couldn't refresh the GoHighLevel login (${(e as Error).message}). Reconnect the connector in Claude.`);
      }
      await q.query(
        `UPDATE connections SET enc_access=$2, enc_refresh=COALESCE($3, enc_refresh), access_expires_at=$4, last_error=NULL, updated_at=now() WHERE location_id=$1`,
        [
          locationId,
          encrypt(this.cfg.encryptionKey, t.access_token),
          t.refresh_token ? encrypt(this.cfg.encryptionKey, t.refresh_token) : null,
          new Date(Date.now() + (t.expires_in ?? 86_400) * 1000),
        ],
      );
      return t.access_token;
    });
  }

  /** POST to GHL's OAuth token endpoint (form-encoded). */
  async tokenRequest(params: Record<string, string>): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({ client_id: this.cfg.ghlClientId!, client_secret: this.cfg.ghlClientSecret!, ...params });
    const res = await this.fetchImpl(`${this.ghlBaseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
    const text = await res.text();
    let json: any = {};
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (!res.ok || !json.access_token) throw new Error(`token endpoint returned ${res.status}: ${json.error_description ?? json.message ?? json.error ?? text.slice(0, 200)}`);
    return json;
  }

  client(locationId: string): GhlClient {
    return new GhlClient({
      locationId,
      baseUrl: this.ghlBaseUrl,
      fetchImpl: this.fetchImpl,
      getAccessToken: () => this.accessToken(locationId),
    });
  }

  /** Validate a Private Integration Token by reading the location. Returns the location name. */
  async verifyPit(locationId: string, token: string): Promise<string | undefined> {
    const client = new GhlClient({ apiKey: token, locationId, baseUrl: this.ghlBaseUrl, fetchImpl: this.fetchImpl, maxRetries: 1 });
    try {
      const res = await client.get(`/locations/${locationId}`);
      return res.location?.name ?? res.name;
    } catch (e: any) {
      if (e?.status === 403) {
        // Token may simply lack locations.readonly; fall back to a contacts read to prove it works for this location.
        await client.post("/contacts/search", { locationId, pageLimit: 1 });
        return undefined;
      }
      throw e;
    }
  }
}
