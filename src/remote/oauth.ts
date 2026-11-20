import type { Response } from "express";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { CONFIRM_ERRORS, CONFIRM_TTL_MS, ConfirmError, newConfirmToken, planHash, type ConfirmBackend } from "../core/confirm.js";
import { hashToken, randomToken } from "./config.js";
import type { Db } from "./db.js";

export const ACCESS_TOKEN_TTL_S = 60 * 60;
export const REFRESH_TOKEN_TTL_S = 90 * 24 * 60 * 60;
const PENDING_TTL_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
export const SCOPE = "ghl";

/**
 * OAuth 2.1 authorization server that Claude talks to. The "login" step is our own /connect page,
 * where the user either logs in with GoHighLevel or pastes a Private Integration Token.
 */
export class GhlConnectorOAuthProvider implements OAuthServerProvider {
  constructor(private db: Db) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    const db = this.db;
    return {
      async getClient(clientId: string) {
        const { rows } = await db.query(`SELECT data FROM oauth_clients WHERE client_id=$1`, [clientId]);
        return rows[0]?.data as OAuthClientInformationFull | undefined;
      },
      async registerClient(client: any) {
        await db.query(`INSERT INTO oauth_clients (client_id, data) VALUES ($1, $2)`, [client.client_id, JSON.stringify(client)]);
        return client as OAuthClientInformationFull;
      },
    };
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = randomToken(18);
    await this.db.query(
      `INSERT INTO pending_auth (id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, client.client_id, params.redirectUri, params.codeChallenge, params.state ?? null, (params.scopes ?? []).join(" "), params.resource?.href ?? null, new Date(Date.now() + PENDING_TTL_MS)],
    );
    res.redirect(302, `/connect?req=${encodeURIComponent(id)}`);
  }

  async getPending(id: string) {
    const { rows } = await this.db.query(`SELECT * FROM pending_auth WHERE id=$1 AND expires_at > now()`, [id]);
    return rows[0] as
      | { id: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null; resource: string | null; passcode_ok: boolean }
      | undefined;
  }

  async markPasscodeOk(id: string) {
    await this.db.query(`UPDATE pending_auth SET passcode_ok=true WHERE id=$1`, [id]);
  }

  async clientName(clientId: string): Promise<string | undefined> {
    const c = await this.clientsStore.getClient(clientId);
    return (c as any)?.client_name;
  }

  /** Finish the login: mint an authorization code for the location and return Claude's redirect URL. */
  async completeAuthorization(pendingId: string, locationId: string): Promise<string> {
    const { rows } = await this.db.query(`DELETE FROM pending_auth WHERE id=$1 AND expires_at > now() RETURNING *`, [pendingId]);
    const p = rows[0];
    if (!p) throw new Error("This login link expired. Go back to Claude and click Connect again.");
    const code = randomToken(32);
    await this.db.query(
      `INSERT INTO auth_codes (code_hash, client_id, location_id, code_challenge, redirect_uri, resource, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [hashToken(code), p.client_id, locationId, p.code_challenge, p.redirect_uri, p.resource, new Date(Date.now() + CODE_TTL_MS)],
    );
    const url = new URL(p.redirect_uri);
    url.searchParams.set("code", code);
    if (p.state) url.searchParams.set("state", p.state);
    return url.toString();
  }

  /** Redirect back to Claude with an OAuth error (e.g. the user cancelled). */
  async failAuthorization(pendingId: string, error: string, description: string): Promise<string | undefined> {
    const { rows } = await this.db.query(`DELETE FROM pending_auth WHERE id=$1 RETURNING *`, [pendingId]);
    const p = rows[0];
    if (!p) return undefined;
    const url = new URL(p.redirect_uri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (p.state) url.searchParams.set("state", p.state);
    return url.toString();
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const { rows } = await this.db.query(`SELECT * FROM auth_codes WHERE code_hash=$1`, [hashToken(code)]);
    const c = rows[0];
    if (!c || c.used || new Date(c.expires_at).getTime() < Date.now() || c.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    return c.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const { rows } = await this.db.query(`UPDATE auth_codes SET used=true WHERE code_hash=$1 AND used=false RETURNING *`, [hashToken(code)]);
    const c = rows[0];
    if (!c || new Date(c.expires_at).getTime() < Date.now() || c.client_id !== client.client_id) throw new InvalidGrantError("Invalid or expired authorization code");
    if (redirectUri && redirectUri !== c.redirect_uri) throw new InvalidGrantError("redirect_uri does not match");
    return this.issueTokens(client.client_id, c.location_id, c.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const { rows } = await this.db.query(
      `UPDATE tokens SET revoked=true WHERE token_hash=$1 AND kind='refresh' AND revoked=false AND expires_at > now() RETURNING *`,
      [hashToken(refreshToken)],
    );
    const t = rows[0];
    if (!t || t.client_id !== client.client_id) throw new InvalidGrantError("Invalid refresh token");
    await this.assertConnected(t.location_id, InvalidGrantError);
    return this.issueTokens(client.client_id, t.location_id, t.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { rows } = await this.db.query(
      `SELECT t.*, c.status AS conn_status FROM tokens t LEFT JOIN connections c ON c.location_id=t.location_id
       WHERE t.token_hash=$1 AND t.kind='access'`,
      [hashToken(token)],
    );
    const t = rows[0];
    if (!t || t.revoked || new Date(t.expires_at).getTime() < Date.now()) throw new InvalidTokenError("Invalid or expired access token");
    if (t.conn_status !== "active") throw new InvalidTokenError("This GoHighLevel connection was disconnected. Reconnect in Claude.");
    return {
      token,
      clientId: t.client_id,
      scopes: [SCOPE],
      expiresAt: Math.floor(new Date(t.expires_at).getTime() / 1000),
      resource: t.resource ? new URL(t.resource) : undefined,
      extra: { locationId: t.location_id },
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.db.query(`UPDATE tokens SET revoked=true WHERE token_hash=$1`, [hashToken(request.token)]);
  }

  private async assertConnected(locationId: string, Err: new (m: string) => Error) {
    const { rows } = await this.db.query(`SELECT status FROM connections WHERE location_id=$1`, [locationId]);
    if (rows[0]?.status !== "active") throw new Err("The GoHighLevel connection was disconnected. Reconnect in Claude.");
  }

  private async issueTokens(clientId: string, locationId: string, resource: string | null): Promise<OAuthTokens> {
    const access = randomToken(32);
    const refresh = randomToken(32);
    const now = Date.now();
    await this.db.query(
      `INSERT INTO tokens (token_hash, kind, client_id, location_id, resource, expires_at) VALUES ($1,'access',$2,$3,$4,$5), ($6,'refresh',$2,$3,$4,$7)`,
      [hashToken(access), clientId, locationId, resource, new Date(now + ACCESS_TOKEN_TTL_S * 1000), hashToken(refresh), new Date(now + REFRESH_TOKEN_TTL_S * 1000)],
    );
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: SCOPE };
  }
}

/** Confirm tokens stored in Postgres, so previews survive restarts and work across stateless requests. */
export class DbConfirmStore implements ConfirmBackend {
  constructor(
    private db: Db,
    private locationId: string,
  ) {}

  async issue(tool: string, plan: unknown): Promise<string> {
    const token = newConfirmToken();
    await this.db.query(`INSERT INTO confirm_tokens (token, location_id, tool, plan_hash, expires_at) VALUES ($1,$2,$3,$4,$5)`, [
      token,
      this.locationId,
      tool,
      planHash(plan),
      new Date(Date.now() + CONFIRM_TTL_MS),
    ]);
    return token;
  }

  async redeem(tool: string, plan: unknown, token: string): Promise<void> {
    const { rows } = await this.db.query(`DELETE FROM confirm_tokens WHERE token=$1 AND location_id=$2 RETURNING *`, [token, this.locationId]);
    const e = rows[0];
    if (!e || new Date(e.expires_at).getTime() < Date.now()) throw new ConfirmError(CONFIRM_ERRORS.unknown);
    if (e.tool !== tool) throw new ConfirmError(CONFIRM_ERRORS.wrongTool(e.tool, tool));
    if (e.plan_hash !== planHash(plan)) throw new ConfirmError(CONFIRM_ERRORS.changed);
  }
}
