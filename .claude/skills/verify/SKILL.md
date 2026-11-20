---
name: verify
description: Run the GoHighLevel connector for real (hosted server + Desktop Extension) against a fake GHL HTTP server and drive it like Claude does.
---

# Verify the connector at its real surfaces

The real GHL API isn't reachable here, so we run `fake-ghl.mjs` (in this folder) on :4600 as an HTTP server. It fakes the GHL API, GHL's OAuth location chooser and token endpoint, and logs every request to `requests.jsonl`. The app is pointed at it with `GHL_BASE_URL` / `GHL_MARKETPLACE_URL`.

## Build + start
```bash
npx tsc -p . && node scripts/build-extension.mjs        # dist/ + release/GoHighLevel.mcpb
cd $SCRATCH && node <repo>/.claude/skills/verify/fake-ghl.mjs &   # :4600, logs requests.jsonl
PORT=4567 PUBLIC_URL=http://localhost:4567 PGLITE_DIR=$SCRATCH/pgdata \
ENCRYPTION_KEY=verify-encryption-key-0123456789abcdef CONNECT_PASSCODE=team-pass ALLOWED_LOCATION_IDS=LOC1,LOC2 \
ADMIN_PASSWORD=admin-pass WEBHOOK_SECRET=whsec GHL_CLIENT_ID=cid GHL_CLIENT_SECRET=csecret \
GHL_BASE_URL=http://localhost:4600 GHL_MARKETPLACE_URL=http://localhost:4600 WORKER_INTERVAL_MS=2000 \
node dist/remote/index.js &
curl --noproxy '*' localhost:4567/healthz
```
Always pass `curl --noproxy '*'` for localhost.

## Drive
- **OAuth login (Playwright):**
  1. POST `/register` with `redirect_uris: ["https://claude-cb.invalid/cb"]`.
  2. Open `/authorize?...&code_challenge=...` and fill `#pc`, `#loc`, `#tok`.
  3. Click "Connect with token", or "Log in with GoHighLevel" (that one needs `newContext({ bypassCSP: true })`, because the fake chooser is plain http).
  4. Capture the callback URL with `page.on("request")`, then POST `/token`.
- **MCP:** `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport` to `/mcp` with `Authorization: Bearer`. Load it through `createRequire("<repo>/package.json")` when the script lives outside the repo.
- **Automations:** `create_automation` → confirm → `set_automation_mode` live → confirm. Then send `curl -X POST /webhooks/ghl/whsec -d '{"type":"ContactTagUpdate","locationId":"LOC1","id":"c3","tags":["new-lead"],"webhookId":"w1"}'` and check `requests.jsonl` and `automation_history`.
- **Admin:** a Playwright context with `httpCredentials` set to `admin` / `admin-pass`, at `/admin`.
- **Extension:** `mcpb unpack release/GoHighLevel.mcpb ext`, then spawn `node ext/server/index.mjs` with the manifest env substituted (plus `GHL_BASE_URL`) and connect over `StdioClientTransport`.

## Gotchas
- Playwright's `page.route` does NOT intercept redirects. A callback on a real host (claude.ai) will actually be requested, so use a `.invalid` host for the callback.
- The login page's CSP `form-action 'self' https:` blocks redirects to `http://` callbacks and http GHL hosts in the browser.
