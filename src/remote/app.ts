import { createHmac, verify as cryptoVerify } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AutomationEngine } from "../automations/engine.js";
import { AUTOMATION_INSTRUCTIONS, automationTools } from "../automations/tools.js";
import { createCtx, type Ctx } from "../core/context.js";
import { buildServerForCtx } from "../core/server.js";
import { safeEqual, type RemoteConfig } from "./config.js";
import { ConnectionStore } from "./connections.js";
import type { Db } from "./db.js";
import { DbConfirmStore, GhlConnectorOAuthProvider, SCOPE } from "./oauth.js";
import { adminPage, connectPage, landingPage, messagePage } from "./pages.js";

export interface AppDeps {
  db: Db;
  cfg: RemoteConfig;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** Simple fixed-window limiter for passcode/login attempts. */
class AttemptLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(
    private max: number,
    private windowMs: number,
  ) {}
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

export function createApp({ db, cfg, fetchImpl = fetch, now }: AppDeps) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  const connections = new ConnectionStore(db, cfg, fetchImpl);
  const provider = new GhlConnectorOAuthProvider(db);
  const engine = new AutomationEngine(db, connections, { readOnly: cfg.readOnly, pollIntervalMs: cfg.pollIntervalMs, fetchImpl, now });
  const limiter = new AttemptLimiter(10, 15 * 60_000);
  const issuer = new URL(cfg.publicUrl);
  const mcpUrl = new URL("/mcp", cfg.publicUrl);
  const ghlOAuthEnabled = !!(cfg.ghlClientId && cfg.ghlClientSecret);
  const callbackUrl = `${cfg.publicUrl}/oauth/ghl/callback`;

  // Security headers for our HTML pages.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });
  const htmlHeaders = (res: Response) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self' https:; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("Cache-Control", "no-store");
    res.type("html");
  };

  // ---------------------------------------------------------------- OAuth (Claude ↔ connector)
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: issuer,
      resourceServerUrl: mcpUrl,
      scopesSupported: [SCOPE],
      resourceName: "GoHighLevel",
      serviceDocumentationUrl: new URL("https://github.com/Camday14/GHLCLaudeConnectPlugin"),
    }),
  );

  // ---------------------------------------------------------------- Login page
  const form = express.urlencoded({ extended: false, limit: "20kb" });

  app.get("/", (_req, res) => {
    htmlHeaders(res);
    res.send(landingPage(cfg.publicUrl));
  });

  app.get("/connect", async (req, res) => {
    htmlHeaders(res);
    const reqId = String(req.query.req ?? "");
    const p = await provider.getPending(reqId);
    if (!p) return void res.status(400).send(messagePage("Link expired", "This login link has expired. Go back to Claude and click Connect again."));
    res.send(
      connectPage({
        reqId,
        clientName: await provider.clientName(p.client_id),
        passcodeRequired: !!cfg.connectPasscode,
        ghlOAuthEnabled,
        error: typeof req.query.error === "string" ? req.query.error : undefined,
      }),
    );
  });

  const checkPasscode = (req: Request): string | undefined => {
    if (!cfg.connectPasscode) return undefined;
    if (!limiter.allow(`pc:${req.ip}`)) return "Too many attempts. Wait 15 minutes and try again.";
    const given = String(req.body?.passcode ?? "");
    return safeEqual(given, cfg.connectPasscode) ? undefined : "Wrong team passcode.";
  };

  const backToForm = (res: Response, reqId: string, error: string) => {
    res.redirect(303, `/connect?req=${encodeURIComponent(reqId)}&error=${encodeURIComponent(error)}`);
  };

  app.post("/connect/pit", form, async (req, res) => {
    const reqId = String(req.body?.req ?? "");
    const p = await provider.getPending(reqId);
    htmlHeaders(res);
    if (!p) return void res.status(400).send(messagePage("Link expired", "This login link has expired. Go back to Claude and click Connect again."));
    const pcErr = checkPasscode(req);
    if (pcErr) return backToForm(res, reqId, pcErr);
    const locationId = String(req.body?.location_id ?? "").trim();
    const token = String(req.body?.token ?? "").trim();
    if (!locationId || !token) return backToForm(res, reqId, "Enter both the Location ID and the token.");
    if (!connections.isAllowed(locationId)) return backToForm(res, reqId, "This GoHighLevel location isn't allowed to connect to this connector.");
    if (!limiter.allow(`pit:${req.ip}`)) return backToForm(res, reqId, "Too many attempts. Wait 15 minutes and try again.");
    let name: string | undefined;
    try {
      name = await connections.verifyPit(locationId, token);
    } catch (e: any) {
      const msg =
        e?.status === 401
          ? "GoHighLevel rejected that token. Check you copied the whole token."
          : e?.status === 403 || e?.status === 400 || e?.status === 422
            ? "That token doesn't have access to this Location ID. Check the Location ID and the token's scopes."
            : `Couldn't reach GoHighLevel: ${e?.message ?? e}`;
      return backToForm(res, reqId, msg);
    }
    await connections.savePit(locationId, token, name);
    res.redirect(302, await provider.completeAuthorization(reqId, locationId));
  });

  app.post("/connect/ghl", form, async (req, res) => {
    const reqId = String(req.body?.req ?? "");
    const p = await provider.getPending(reqId);
    htmlHeaders(res);
    if (!p) return void res.status(400).send(messagePage("Link expired", "This login link has expired. Go back to Claude and click Connect again."));
    if (!ghlOAuthEnabled) return backToForm(res, reqId, "GoHighLevel login isn't configured on this connector. Use a Private Integration token.");
    const pcErr = checkPasscode(req);
    if (pcErr) return backToForm(res, reqId, pcErr);
    await provider.markPasscodeOk(reqId);
    const url = new URL(`${cfg.ghlMarketplaceUrl}/oauth/chooselocation`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.ghlClientId!);
    url.searchParams.set("redirect_uri", callbackUrl);
    url.searchParams.set("scope", cfg.ghlScopes.join(" "));
    url.searchParams.set("state", reqId);
    res.redirect(302, url.toString());
  });

  app.post("/connect/cancel", form, async (req, res) => {
    const url = await provider.failAuthorization(String(req.body?.req ?? ""), "access_denied", "The user cancelled the GoHighLevel login.");
    htmlHeaders(res);
    if (url) return void res.redirect(302, url);
    res.send(messagePage("Cancelled", "You can close this window."));
  });

  app.get("/oauth/ghl/callback", async (req, res) => {
    htmlHeaders(res);
    const reqId = String(req.query.state ?? "");
    const code = String(req.query.code ?? "");
    const p = await provider.getPending(reqId);
    if (!p) return void res.status(400).send(messagePage("Link expired", "This login link has expired. Go back to Claude and click Connect again."));
    if (cfg.connectPasscode && !p.passcode_ok) return backToForm(res, reqId, "Enter the team passcode first.");
    if (!code) return backToForm(res, reqId, `GoHighLevel didn't complete the login${req.query.error ? ` (${req.query.error})` : ""}.`);
    try {
      const t = await connections.tokenRequest({ grant_type: "authorization_code", code, user_type: "Location", redirect_uri: callbackUrl });
      if (!t.locationId) return backToForm(res, reqId, "Pick a sub-account (not the agency) when GoHighLevel asks which account to connect.");
      if (!connections.isAllowed(t.locationId)) return backToForm(res, reqId, "This GoHighLevel location isn't allowed to connect to this connector.");
      let name: string | undefined;
      try {
        const loc = await new (await import("../core/client.js")).GhlClient({ apiKey: t.access_token, locationId: t.locationId, baseUrl: connections.ghlBaseUrl, fetchImpl, maxRetries: 0 }).get(`/locations/${t.locationId}`);
        name = loc.location?.name;
      } catch {
        /* name is optional */
      }
      await connections.saveOAuth(t, name);
      res.redirect(302, await provider.completeAuthorization(reqId, t.locationId));
    } catch (e) {
      backToForm(res, reqId, `GoHighLevel login failed: ${(e as Error).message}`);
    }
  });

  // ---------------------------------------------------------------- MCP endpoint
  const ctxCache = new Map<string, { ctx: Ctx; at: number }>();
  const ctxFor = (locationId: string): Ctx => {
    const hit = ctxCache.get(locationId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ctx;
    const ctx = createCtx(
      connections.client(locationId),
      { readOnly: cfg.readOnly, confirmThreshold: cfg.confirmThreshold, defaultCountryCode: cfg.defaultCountryCode, fileAccess: false },
      new DbConfirmStore(db, locationId),
    );
    ctx.services = { automations: engine };
    ctxCache.set(locationId, { ctx, at: Date.now() });
    return ctx;
  };

  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl) });

  app.post("/mcp", bearer, express.json({ limit: "8mb" }), async (req, res) => {
    const locationId = String(req.auth?.extra?.locationId ?? "");
    const { server } = buildServerForCtx(ctxFor(locationId), automationTools, AUTOMATION_INSTRUCTIONS);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) =>
    void res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)." }, id: null });
  app.get("/mcp", bearer, methodNotAllowed);
  app.delete("/mcp", bearer, methodNotAllowed);

  // ---------------------------------------------------------------- GHL webhooks
  const webhookHandler = async (req: Request, res: Response) => {
    if (!cfg.webhookSecret && !cfg.webhookPublicKey) return void res.status(404).json({ error: "Webhooks are not configured (set WEBHOOK_SECRET)." });
    if (cfg.webhookSecret && !safeEqual(String(req.params.secret ?? req.query.secret ?? ""), cfg.webhookSecret)) return void res.status(401).json({ error: "bad secret" });
    const raw = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
    if (cfg.webhookPublicKey && !verifyGhlSignature(raw, req, cfg.webhookPublicKey)) return void res.status(401).json({ error: "bad signature" });
    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return void res.status(400).json({ error: "invalid JSON" });
    }
    void engine.acceptWebhook(payload, raw);
    res.status(200).json({ received: true });
  };
  const rawJson = express.raw({ type: "*/*", limit: "1mb" });
  app.post("/webhooks/ghl", rawJson, webhookHandler);
  app.post("/webhooks/ghl/:secret", rawJson, webhookHandler);

  // ---------------------------------------------------------------- Admin
  const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.adminPassword) return void res.status(404).send("Admin page is disabled (set ADMIN_PASSWORD).");
    const header = req.headers.authorization ?? "";
    const [, b64] = header.split(" ");
    const pass = b64 ? Buffer.from(b64, "base64").toString().split(":").slice(1).join(":") : "";
    if (!header.startsWith("Basic ") || !safeEqual(pass, cfg.adminPassword)) {
      if (header && !limiter.allow(`admin:${req.ip}`)) return void res.status(429).send("Too many attempts");
      res.setHeader("WWW-Authenticate", 'Basic realm="GoHighLevel connector admin"');
      return void res.status(401).send("Authentication required");
    }
    next();
  };
  const csrfToken = () => createHmac("sha256", cfg.encryptionKey).update(`admin-csrf:${cfg.adminPassword}`).digest("base64url");
  const checkCsrf = (req: Request) => safeEqual(String(req.body?.csrf ?? ""), csrfToken());

  app.get("/admin", adminAuth, async (_req, res) => {
    const conns = await connections.list();
    const { rows } = await db.query(
      `SELECT a.id, a.location_id, a.name, a.enabled, a.mode,
         (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id=a.id AND r.started_at > now() - interval '1 day' AND r.status <> 'skipped') AS runs_24h,
         (SELECT count(*)::int FROM automation_runs r WHERE r.automation_id=a.id AND r.started_at > now() - interval '1 day' AND r.status = 'failed') AS failed_24h
       FROM automations a ORDER BY a.location_id, a.created_at`,
    );
    htmlHeaders(res);
    res.send(adminPage({ connections: conns, automations: rows, csrf: csrfToken() }));
  });
  app.post("/admin/disconnect", adminAuth, form, async (req, res) => {
    if (!checkCsrf(req)) return void res.status(403).send("Bad request");
    const loc = String(req.body.location_id);
    await engine.pauseAll(loc);
    await connections.disconnect(loc);
    ctxCache.delete(loc);
    res.redirect(303, "/admin");
  });
  app.post("/admin/pause", adminAuth, form, async (req, res) => {
    if (!checkCsrf(req)) return void res.status(403).send("Bad request");
    await engine.pauseAll(String(req.body.location_id));
    res.redirect(303, "/admin");
  });

  app.get("/healthz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: (e as Error).message });
    }
  });

  return { app, engine, connections, provider };
}

/**
 * Verify a GHL webhook signature. Supports the RSA-SHA256 `x-wh-signature` header and the
 * Ed25519 `x-ghl-signature` header, using the public key from GHL's webhook docs.
 */
export function verifyGhlSignature(raw: string, req: Request, publicKeyPem: string): boolean {
  const ed = req.headers["x-ghl-signature"];
  const rsa = req.headers["x-wh-signature"];
  try {
    if (typeof ed === "string" && ed) return cryptoVerify(null, Buffer.from(raw), publicKeyPem, Buffer.from(ed, "base64"));
    if (typeof rsa === "string" && rsa) return cryptoVerify("sha256", Buffer.from(raw), publicKeyPem, Buffer.from(rsa, "base64"));
  } catch {
    return false;
  }
  return false;
}
