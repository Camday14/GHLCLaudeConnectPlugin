# Deploy the hosted connector on Railway

This takes about 10 minutes. At the end you'll have a private URL like `https://ghl-claude-connector-production.up.railway.app/mcp` to add to Claude.

## 1. Create the project
1. Sign in at [railway.com](https://railway.com) with GitHub.
2. **New Project → Deploy from GitHub repo** → pick **Camday14/GHLCLaudeConnectPlugin**. Railway finds the `Dockerfile` and `railway.json` and starts building.
3. In the same project, click **+ New → Database → Add PostgreSQL**.

## 2. Set the variables
Open the connector service, go to **Variables**, and add:

| Name | Value |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway autocompletes it) |
| `ENCRYPTION_KEY` | 32 random bytes. Run `openssl rand -base64 32`, or use any password generator to make a 40+ character string. **Keep a copy.** If you lose it, everyone has to reconnect. |
| `CONNECT_PASSCODE` | A passcode you'll share with your team |
| `ALLOWED_LOCATION_IDS` | Your GHL Location ID(s), comma-separated |
| `ADMIN_PASSWORD` | A password for the `/admin` page |
| `WEBHOOK_SECRET` | A random string (only needed if you set up the Marketplace app) |

`PUBLIC_URL` is set automatically on Railway from the generated domain. Set it yourself only if you use a custom domain.

## 3. Give it a public URL
Go to **Settings → Networking → Generate Domain**. Railway redeploys. Open the domain in your browser: you should see **"Your private connector is running"** and the URL to paste into Claude.

Check `https://<domain>/healthz`. It should return `{"ok":true}`.

## 4. Add it to Claude
1. In Claude (web or desktop), go to **Settings → Connectors → Add custom connector**.
   - On a **Team or Enterprise** plan, an owner adds it under **Organization settings → Connectors**. Each member then clicks **Connect**.
2. Name: `GoHighLevel`. URL: `https://<domain>/mcp`.
3. Click **Connect**. On the login page, enter the passcode, then use **Log in with GoHighLevel** (if you set up the Marketplace app) or a Private Integration token plus Location ID.
4. In a chat, open the tools menu and make sure **GoHighLevel** is on. Try: *"List my pipelines."*

## 5. Optional extras
- **Log in with GoHighLevel and instant automation triggers:** follow [ghl-marketplace-app.md](ghl-marketplace-app.md), then add `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET`.
- **Read-only for a while:** set `GHL_READ_ONLY=true`.

## Updating
Railway redeploys automatically whenever `main` changes on GitHub. The database schema migrates itself on startup.

## Render instead of Railway
In Render, go to **New → Blueprint** and pick this repo. `render.yaml` creates the web service and a Postgres database and generates `ENCRYPTION_KEY` and `WEBHOOK_SECRET`. Fill in `PUBLIC_URL` (your `onrender.com` URL), `CONNECT_PASSCODE`, `ADMIN_PASSWORD` and `ALLOWED_LOCATION_IDS` when prompted.
