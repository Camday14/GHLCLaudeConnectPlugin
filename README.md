# GoHighLevel for Claude

Connect Claude directly to your GoHighLevel sub-account. Claude can then manage contacts and leads, send texts and emails, run your pipelines, import CSVs, report on calls, deals and revenue, and **build automations that run for you**.

There are two ways to install it:

| | **Desktop Extension** (one click) | **Hosted connector** (Connectors tab + GHL login) |
|---|---|---|
| Works in | Claude Desktop / Cowork | claude.ai web, mobile, Desktop, Claude Code |
| Setup | Double-click `GoHighLevel.mcpb`, then paste your token in the form | Deploy once to Railway, then in Claude go to **Settings → Connectors → Add** and log in |
| Login | Private Integration token | **Log in with GoHighLevel** (OAuth) or a token |
| Automations | — | ✅ runs 24/7 on your server |
| Cost | Free | Railway, about $5–10/month |

Every tool that **sends messages, changes records in bulk, or deletes** shows Claude a **preview first** and only runs after you approve it.

---

## Option A: one-click Desktop Extension

1. Download **`GoHighLevel.mcpb`** from the [latest release](https://github.com/Camday14/GHLCLaudeConnectPlugin/releases/latest).
2. Double-click it. Claude Desktop opens an install screen.
3. Fill in the form:
   - **Private Integration Token**: in GoHighLevel, go into your sub-account → **Settings → Private Integrations → Create new integration**. Grant the [scopes below](#scopes), then copy the token (starts with `pit-`). Claude Desktop stores it in your system keychain.
   - **Location ID**: under **Settings → Business Profile**, or in your GHL URL after `/location/`.
   - Optional: read-only mode, the approval threshold, and the phone country code.
4. Click **Install**. You'll find **GoHighLevel** under **Settings → Extensions**, where you can switch it on and off.

To build the `.mcpb` yourself, run `npm ci && npm run build:extension`. The file is written to `release/GoHighLevel.mcpb`.

## Option B: hosted connector (Connectors tab, "Log in with GoHighLevel", automations)

1. **Deploy** this repo to Railway (about 10 minutes, step by step): **[docs/deploy-railway.md](docs/deploy-railway.md)**
2. **Optional:** create a private GHL Marketplace app. This adds the **"Log in with GoHighLevel"** button and **instant** automation triggers: **[docs/ghl-marketplace-app.md](docs/ghl-marketplace-app.md)**. Without the app, you log in with a Private Integration token and automations check for changes every 5 minutes.
3. In Claude: **Settings → Connectors → Add custom connector**. Paste `https://<your-app>.up.railway.app/mcp`, then click **Connect**.
4. A login page opens. Enter your team passcode, then either click **Log in with GoHighLevel** and pick your sub-account, or paste a token and Location ID.
5. Done. GoHighLevel now appears in Claude's tools menu in every chat.

The hosted connector is private to you and your team:
- People need the **team passcode** to connect.
- Only the GHL locations in **`ALLOWED_LOCATION_IDS`** can be connected.
- GHL tokens are encrypted (AES-256-GCM) and never sent to Claude.
- The **`/admin`** page shows connections and automations, and has a disconnect button and a kill switch.

---

## What Claude can do

**Contacts and data:** search and filter; create, update, upsert and delete; tags, notes and tasks; enroll contacts in workflows.
**Lead sorting:** score and bucket leads (hot/warm/cold) with your own rules, assign them round-robin, find duplicates.
**Texts and emails:** single or bulk, with merge fields like `{{contact.first_name|there}}`. Contacts with Do Not Disturb (DND) on are always skipped.
**Pipelines:** list stages, search deals, create and update deals, move them between stages in bulk, mark them won or lost.
**Imports:** CSV import with automatic column mapping, validation, dedupe, upsert, tagging and deal creation. Exports too.
**Sales reports:**
- pipeline value and win rate, per-owner breakdown, stale deals
- calls (answered, missed, voicemail; talk time per rep), with transcripts and recordings
- activity summary and revenue
**Anything else:** `ghl_api_request` reaches any GHL API v2 endpoint.

### Automations (hosted connector)

GoHighLevel's API can't create or edit workflows in GHL's own builder. Instead, Claude builds automations that **run on your connector server** and act on GHL through the API. They can also enroll contacts in your existing GHL workflows.

Ask Claude something like:

> "When a contact gets the tag `new-lead`: text them *Hi {{contact.first_name|there}}, thanks for reaching out!*, create a deal in New Lead worth $500, wait 1 day, and if they haven't replied, text a follow-up. Only during business hours."

> "Every weekday at 8:30am, create a task for the owner of every deal stuck in Proposal for more than 14 days."

> "When someone replies STOP or UNSUBSCRIBE, tag them `opted-out` and remove them from workflow X."

| Triggers | Actions |
|---|---|
| contact created · tag added/removed · deal created · deal stage changed · deal won/lost · inbound message (channel, keywords) · appointment booked/status changed · task completed · **schedule** (cron) · manual | send SMS · send email · add/remove tags · assign user (round-robin) · create deal · move deal stage · set deal status · create task · add note · add to/remove from GHL workflow · webhook · **wait** · **stop if** (replied / tag / deal status) |

Conditions can be a contact filter, a minimum lead score, deal filters, or business hours.

**Safety:**
- New automations start in **dry-run** mode: they log what they *would* do.
- `test_automation` shows exactly what would happen for a real contact, with merge fields filled in.
- Going live needs your approval.
- Each automation is limited to a maximum number of actions per hour, runs at most once per contact by default, and can never re-trigger itself.
- `pause_all_automations` (or the button on `/admin`) stops everything instantly.

---

## Scopes
In the Private Integration (or Marketplace app), select:
`contacts.readonly` `contacts.write` `conversations.readonly` `conversations.write` `conversations/message.readonly` `conversations/message.write` `opportunities.readonly` `opportunities.write` `users.readonly` `locations.readonly` `locations/customFields.readonly` `locations/tags.readonly` `locations/tags.write` `workflows.readonly` `calendars.readonly` `calendars/events.readonly` `payments/transactions.readonly`

## Settings

**Desktop extension:** you set these in the install form.

**Hosted connector:** set these as environment variables (see [`.env.example`](.env.example)).

| Variable | Required | Purpose |
|---|---|---|
| `ENCRYPTION_KEY` | ✅ | Encrypts stored GHL tokens. Generate with `openssl rand -base64 32` |
| `DATABASE_URL` | ✅ (prod) | Postgres connection string (Railway provides it) |
| `CONNECT_PASSCODE` | ✅* | Team passcode on the login page |
| `ALLOWED_LOCATION_IDS` | ✅* | Comma-separated GHL Location IDs allowed to connect |
| `ADMIN_PASSWORD` | recommended | Turns on `/admin` (HTTP basic auth, any username) |
| `PUBLIC_URL` | auto on Railway | Public base URL of the server |
| `GHL_CLIENT_ID` / `GHL_CLIENT_SECRET` | optional | Turns on **Log in with GoHighLevel** |
| `WEBHOOK_SECRET` | optional | Turns on instant triggers at `/webhooks/ghl/<secret>` |
| `GHL_WEBHOOK_PUBLIC_KEY` | optional | Also checks GHL webhook signatures |
| `GHL_READ_ONLY` | optional | `true` hides every tool that writes or sends |
| `GHL_BULK_CONFIRM_THRESHOLD` | optional | Default `1`, so every write asks for approval first |

\* You need at least one of these two. The server won't start as an open connector.

## Notes and limitations
- **Call reporting** comes from Conversations call logs, because GHL has no public call-report API. Totals can differ slightly from the in-app dashboard.
- **Imports** upsert contacts one at a time behind a rate limiter, about 3–5 minutes per 1,000 rows. On the hosted connector, Claude passes the CSV text itself, since the server can't read files on your computer.
- **Polling mode** (no Marketplace webhooks) detects new contacts, tag changes, deal changes and inbound messages every 5 minutes. Appointment and task triggers need webhooks.
- Texting must follow A2P 10DLC and TCPA rules. Contacts with DND on are always skipped.

## Development
```bash
npm ci
npm test                  # 41 tests: tools, OAuth flow, automations (in-process Postgres + fake GHL)
npm run build             # TypeScript → dist/
npm run build:extension   # → release/GoHighLevel.mcpb
npm run dev:remote        # hosted connector on :3000 with embedded PGlite (set ENCRYPTION_KEY + CONNECT_PASSCODE)
```
Layout:
- `src/core/`: GHL client and every CRM tool, shared by both install options
- `src/local/`: the desktop/stdio entry point
- `src/remote/`: HTTP server, OAuth, login page, admin, database
- `src/automations/`: the automation engine and its tools
- `extension/`: manifest template and icon
