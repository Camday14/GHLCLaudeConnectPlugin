import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/remote/app.js";
import { loadConfig } from "../src/remote/config.js";
import { connectPglite, migrate, type Db } from "../src/remote/db.js";
import { contacts, fakeGhl } from "./helpers.js";

const pipelines = [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New Lead" }, { id: "s2", name: "Qualified" }] }];

let db: Db;
let server: Server;
let base: string;
let ghl: ReturnType<typeof fakeGhl>;
let tokenCalls: any[] = [];
let ghlTokenExpiresIn = 86_400;

beforeAll(async () => {
  db = await connectPglite();
  await migrate(db);
  ghl = fakeGhl({
    "GET /locations/:id": (c) => {
      const tok = c.headers.Authorization;
      if (tok === "Bearer pit-bad") return new Response(JSON.stringify({ message: "Invalid JWT" }), { status: 401 });
      return { location: { id: c.path.split("/").pop(), name: "Acme Roofing" } };
    },
    "POST /oauth/token": (c) => {
      tokenCalls.push(c);
      return { access_token: `ghl-at-${tokenCalls.length}`, refresh_token: `ghl-rt-${tokenCalls.length}`, expires_in: ghlTokenExpiresIn, locationId: "LOC2", companyId: "CO1", userType: "Location" };
    },
    "GET /opportunities/pipelines": () => ({ pipelines }),
    "POST /contacts/search": () => ({ contacts, total: contacts.length }),
    "GET /contacts/:id": (c) => ({ contact: contacts.find((x) => c.path.endsWith(x.id)) }),
    "GET /locations/:id/customFields": () => ({ customFields: [] }),
    "GET /users/": () => ({ users: [] }),
    "POST /conversations/messages": () => ({ messageId: "m1" }),
  });
  // The fake's token endpoint is form-encoded; make the fake tolerate non-JSON bodies.
  const fetchImpl: typeof fetch = async (input, init: any = {}) => {
    if (typeof init.body === "string" && init.headers?.["Content-Type"] === "application/x-www-form-urlencoded") {
      init = { ...init, body: JSON.stringify(Object.fromEntries(new URLSearchParams(init.body))) };
    }
    return ghl.fetchImpl(input, init);
  };
  const app0 = (await import("express")).default();
  server = app0.listen(0);
  const port = (server.address() as AddressInfo).port;
  server.close();
  base = `http://localhost:${port}`;
  const cfg = loadConfig({
    PUBLIC_URL: base,
    ENCRYPTION_KEY: "test-encryption-key-that-is-long-enough-123",
    CONNECT_PASSCODE: "team-pass",
    ALLOWED_LOCATION_IDS: "LOC1,LOC2",
    GHL_CLIENT_ID: "ghl-client",
    GHL_CLIENT_SECRET: "ghl-secret",
    WEBHOOK_SECRET: "whsec",
    ADMIN_PASSWORD: "admin-pass",
  } as any);
  const { app } = createApp({ db, cfg, fetchImpl });
  server = app.listen(port);
  await new Promise((r) => server.once("listening", r));
});

afterAll(async () => {
  server?.close();
  await db?.close();
});

async function register() {
  const res = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.example/cb"], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  expect(res.status).toBe(201);
  return (await res.json()).client_id as string;
}

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function startAuthorize(clientId: string, challenge: string) {
  const u = new URL(`${base}/authorize`);
  Object.entries({ response_type: "code", client_id: clientId, redirect_uri: "https://claude.example/cb", code_challenge: challenge, code_challenge_method: "S256", state: "st8", scope: "ghl" }).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { redirect: "manual" });
  expect(res.status).toBe(302);
  const loc = res.headers.get("location")!;
  expect(loc).toMatch(/^\/connect\?req=/);
  return new URL(loc, base).searchParams.get("req")!;
}

const postForm = (path: string, body: Record<string, string>) =>
  fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() });

async function exchange(clientId: string, code: string, verifier: string) {
  const res = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: "https://claude.example/cb" }).toString(),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ access_token: string; refresh_token: string }>;
}

async function mcpClient(accessToken: string) {
  const client = new Client({ name: "claude-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

describe("hosted connector", () => {
  it("publishes OAuth metadata and rejects unauthenticated MCP calls", async () => {
    const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(meta.authorization_endpoint).toBe(`${base}/authorize`);
    expect(meta.registration_endpoint).toBe(`${base}/register`);
    const pr = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(pr.status).toBe(200);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata/);
  });

  it("token login: passcode + allowlist + token checks, then full MCP access", async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const req = await startAuthorize(clientId, challenge);

    const page = await (await fetch(`${base}/connect?req=${req}`)).text();
    expect(page).toContain("Log in with GoHighLevel");
    expect(page).toContain("Team passcode");

    let r = await postForm("/connect/pit", { req, passcode: "nope", location_id: "LOC1", token: "pit-good" });
    expect(r.headers.get("location")).toMatch(/error=Wrong%20team%20passcode/);
    r = await postForm("/connect/pit", { req, passcode: "team-pass", location_id: "LOC9", token: "pit-good" });
    expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/isn't allowed/);
    r = await postForm("/connect/pit", { req, passcode: "team-pass", location_id: "LOC1", token: "pit-bad" });
    expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/rejected that token/);

    r = await postForm("/connect/pit", { req, passcode: "team-pass", location_id: "LOC1", token: "pit-good" });
    expect(r.status).toBe(302);
    const cb = new URL(r.headers.get("location")!);
    expect(cb.origin + cb.pathname).toBe("https://claude.example/cb");
    expect(cb.searchParams.get("state")).toBe("st8");

    // Code can't be used with the wrong verifier, and only once.
    const bad = await fetch(`${base}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: cb.searchParams.get("code")!, code_verifier: "x".repeat(43), client_id: clientId }).toString(),
    });
    expect(bad.status).toBe(400);
    const tokens = await exchange(clientId, cb.searchParams.get("code")!, verifier);

    // Stored GHL token is encrypted.
    const { rows } = await db.query(`SELECT enc_access, location_name FROM connections WHERE location_id='LOC1'`);
    expect(rows[0].enc_access).not.toContain("pit-good");
    expect(rows[0].location_name).toBe("Acme Roofing");

    const client = await mcpClient(tokens.access_token);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_contacts", "bulk_send", "create_automation", "pause_all_automations"]));
    const res: any = await client.callTool({ name: "list_pipelines", arguments: {} });
    expect(JSON.parse(res.content[0].text)[0].stages[0].name).toBe("New Lead");
    const pipelineCall = ghl.calls.filter((c) => c.path === "/opportunities/pipelines").pop()!;
    expect(pipelineCall.headers.Authorization).toBe("Bearer pit-good");

    // Preview/confirm works across stateless requests (tokens stored in the DB).
    const args = { channel: "SMS", contact_ids: ["c1"], message: "Hi {{contact.first_name}}" };
    const preview: any = await client.callTool({ name: "bulk_send", arguments: args });
    const p = JSON.parse(preview.content[0].text);
    expect(p.status).toMatch(/PREVIEW/);
    const client2 = await mcpClient(tokens.access_token);
    const done: any = await client2.callTool({ name: "bulk_send", arguments: { ...args, confirm_token: p.confirm_token } });
    expect(JSON.parse(done.content[0].text).status).toBe("EXECUTED");

    // File paths are refused on the hosted server.
    const exp: any = await client.callTool({ name: "export_contacts_csv", arguments: { file_path: "/tmp/x.csv" } });
    expect(exp.isError).toBe(true);

    // Refresh token rotation.
    const refresh = async (rt: string) =>
      fetch(`${base}/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: clientId }).toString() });
    const r1 = await refresh(tokens.refresh_token);
    expect(r1.status).toBe(200);
    expect((await refresh(tokens.refresh_token)).status).toBe(400);
  });

  it("GoHighLevel login: OAuth redirect, callback, encrypted storage and automatic refresh", async () => {
    tokenCalls = [];
    ghlTokenExpiresIn = 60; // already inside the refresh margin → next API call refreshes
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const req = await startAuthorize(clientId, challenge);

    // Callback without passing the passcode step first is refused.
    let r = await fetch(`${base}/oauth/ghl/callback?code=abc&state=${req}`, { redirect: "manual" });
    expect(decodeURIComponent(r.headers.get("location")!)).toMatch(/passcode first/);

    r = await postForm("/connect/ghl", { req, passcode: "team-pass" });
    const go = new URL(r.headers.get("location")!);
    expect(go.origin + go.pathname).toBe("https://marketplace.gohighlevel.com/oauth/chooselocation");
    expect(go.searchParams.get("client_id")).toBe("ghl-client");
    expect(go.searchParams.get("state")).toBe(req);
    expect(go.searchParams.get("redirect_uri")).toBe(`${base}/oauth/ghl/callback`);
    expect(go.searchParams.get("scope")).toContain("contacts.write");

    r = await fetch(`${base}/oauth/ghl/callback?code=ghl-code&state=${req}`, { redirect: "manual" });
    expect(r.status).toBe(302);
    const cb = new URL(r.headers.get("location")!);
    expect(tokenCalls[0].body).toMatchObject({ grant_type: "authorization_code", code: "ghl-code", client_id: "ghl-client", client_secret: "ghl-secret", user_type: "Location" });

    const tokens = await exchange(clientId, cb.searchParams.get("code")!, verifier);
    const client = await mcpClient(tokens.access_token);
    await client.callTool({ name: "list_pipelines", arguments: {} });
    expect(tokenCalls[1].body).toMatchObject({ grant_type: "refresh_token", refresh_token: "ghl-rt-1" });
    const used = ghl.calls.filter((c) => c.path === "/opportunities/pipelines").pop()!;
    expect(used.headers.Authorization).toBe("Bearer ghl-at-2");
    const { rows } = await db.query(`SELECT auth_type, enc_refresh FROM connections WHERE location_id='LOC2'`);
    expect(rows[0].auth_type).toBe("oauth");
    expect(rows[0].enc_refresh).not.toContain("ghl-rt");
    ghlTokenExpiresIn = 86_400;
  });

  it("admin page requires the password and disconnect revokes Claude's access", async () => {
    expect((await fetch(`${base}/admin`)).status).toBe(401);
    const auth = { Authorization: `Basic ${Buffer.from("admin:admin-pass").toString("base64")}` };
    const page = await (await fetch(`${base}/admin`, { headers: auth })).text();
    expect(page).toContain("Acme Roofing");
    const csrf = page.match(/name="csrf" value="([^"]+)"/)![1];

    const clientId = await register();
    const { verifier, challenge } = pkce();
    const req = await startAuthorize(clientId, challenge);
    const r = await postForm("/connect/pit", { req, passcode: "team-pass", location_id: "LOC1", token: "pit-good" });
    const tokens = await exchange(clientId, new URL(r.headers.get("location")!).searchParams.get("code")!, verifier);

    const bad = await fetch(`${base}/admin/disconnect`, { method: "POST", headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" }, body: "location_id=LOC1&csrf=wrong", redirect: "manual" });
    expect(bad.status).toBe(403);
    const ok = await fetch(`${base}/admin/disconnect`, { method: "POST", headers: { ...auth, "Content-Type": "application/x-www-form-urlencoded" }, body: `location_id=LOC1&csrf=${csrf}`, redirect: "manual" });
    expect(ok.status).toBe(303);
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
  });

  it("webhook endpoint enforces the secret", async () => {
    const body = JSON.stringify({ type: "ContactCreate", locationId: "LOC2", id: "c1" });
    expect((await fetch(`${base}/webhooks/ghl/wrong`, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status).toBe(401);
    expect((await fetch(`${base}/webhooks/ghl/whsec`, { method: "POST", body, headers: { "Content-Type": "application/json" } })).status).toBe(200);
  });

  it("refuses to start without any access control", () => {
    expect(() => loadConfig({ ENCRYPTION_KEY: "x".repeat(40) } as any)).toThrow(/open connector/);
    expect(() => loadConfig({ ENCRYPTION_KEY: "short", CONNECT_PASSCODE: "p" } as any)).toThrow(/ENCRYPTION_KEY/);
  });
});
