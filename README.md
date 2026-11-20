# GoHighLevel MCP connector for Claude

A local MCP server that lets Claude (Claude Desktop / Cowork and Claude Code) work inside one GoHighLevel sub-account through the GHL API v2. With it, Claude can:

- **Manage data**: search, create, update, upsert and delete contacts; add and remove tags; add notes and tasks; enroll contacts in workflows
- **Sort leads**: score and bucket leads (hot/warm/cold) with your own rules, assign them round-robin to reps, and find duplicates
- **Send emails and texts**: one-off or bulk, with merge fields; contacts with DND turned on are skipped automatically
- **Manage pipelines**: list pipelines and stages, search deals, create and update deals, move deals between stages one at a time or in bulk, and mark them won or lost
- **Handle imports**: import a CSV with automatic column mapping, validation, dedupe, upsert, tagging and optional deal creation, or export contacts to CSV
- **Check sales data**: pipeline report (stage values, win rate, owner breakdown, stale deals), call report (answered/missed/voicemail, talk time, per rep), call transcripts and recordings, an activity summary, and revenue from payments
- **Raw API access**: `ghl_api_request` reaches any other GHL v2 endpoint

### Safety: preview, then confirm
Every tool that **sends messages, changes records in bulk, or deletes** runs in two steps:

1. Claude calls the tool and gets back a **preview** that shows what would happen, how many records it affects, rendered message samples, and which contacts were skipped and why. It also gets a `confirm_token`. **Nothing has been sent or changed at this point.**
2. Claude shows you the preview. Only after you approve does it call the tool again with the token. The server rebuilds the plan, and if anything has changed since the preview (different arguments, or different matching records), it refuses to run.

Tokens expire after 10 minutes and work only once. Set `GHL_READ_ONLY=true` for a reporting-only setup in which no write tools exist.

---

## 1. Create a Private Integration Token in GHL
1. In GoHighLevel, switch into the **sub-account**.
2. Go to **Settings → Private Integrations → Create new integration**.
3. Grant these scopes (or fewer, if you want fewer capabilities):
   - `contacts.readonly`, `contacts.write`
   - `conversations.readonly`, `conversations.write`
   - `conversations/message.readonly`, `conversations/message.write`
   - `opportunities.readonly`, `opportunities.write`
   - `users.readonly`, `locations.readonly`
   - `locations/customFields.readonly`, `locations/tags.readonly`, `locations/tags.write`
   - `workflows.readonly`
   - `calendars.readonly`, `calendars/events.readonly`
   - `payments/transactions.readonly` (for `revenue_summary`)
4. Copy the token (it starts with `pit-`).
5. Copy your **Location ID** from **Settings → Business Profile**, or from the URL: `.../location/<LOCATION_ID>/...`.

Keep the token secret. Anyone who has it can act on the sub-account.

## 2. Build
Requires Node.js 20 or later.
```bash
git clone https://github.com/Camday14/GHLCLaudeConnectPlugin.git
cd GHLCLaudeConnectPlugin
npm install
npm run build
```

## 3. Connect to Claude

### Claude Desktop / Cowork
Open **Settings → Developer → Edit Config** (`claude_desktop_config.json`) and add:
```json
{
  "mcpServers": {
    "gohighlevel": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/GHLCLaudeConnectPlugin/dist/local/index.js"],
      "env": {
        "GHL_API_KEY": "pit-xxxxxxxx",
        "GHL_LOCATION_ID": "your-location-id"
      }
    }
  }
}
```
On Windows, use a path like `C:\\Users\\you\\GHLCLaudeConnectPlugin\\dist\\local\\index.js`. Restart Claude Desktop afterwards; "gohighlevel" then appears in the tools/connectors menu.

### Claude Code
```bash
claude mcp add gohighlevel --scope user -e GHL_API_KEY=pit-xxxxxxxx -e GHL_LOCATION_ID=your-location-id -- node /ABSOLUTE/PATH/TO/GHLCLaudeConnectPlugin/dist/local/index.js
```
Then run `/mcp` inside Claude Code to check that it's connected.

### Optional settings (env vars)
| Variable | Default | Purpose |
|---|---|---|
| `GHL_READ_ONLY` | `false` | `true` hides every write/send tool |
| `GHL_BULK_CONFIRM_THRESHOLD` | `1` | Operations affecting at least this many records need confirmation. `1` means always; `10` lets single sends and small edits run without the preview step |
| `GHL_DEFAULT_COUNTRY_CODE` | `1` | Country code added to phone numbers that have no `+` (imports, dedupe) |

## 4. Things to ask Claude
- "Show me all leads tagged `facebook` from the last 7 days that nobody is assigned to."
- "Score my leads: +40 if they have tag `demo-requested`, +20 if created this week, −20 if older than 60 days. Then tag the hot ones `hot-lead`."
- "Round-robin the unassigned leads from this week between Sarah and Mike, including their open deals."
- "Text every contact tagged `webinar-nov` this message: Hi {{contact.first_name|there}}, the replay is live: …"
- "Import /Users/me/Downloads/expo-leads.csv, tag them `expo-2026`, and create a deal in the New Lead stage for each."
- "Give me a pipeline report for this month: value by stage, win rate, and deals stuck more than 14 days."
- "How many calls did each rep make last week, and what were the answer rates?"
- "Move every deal in Proposal Sent that's owned by Mike to Negotiation."
- "What revenue did we collect in October?"

### Merge fields (for `send_sms`, `send_email`, `bulk_send`)
`{{contact.first_name}}`, `{{contact.last_name}}`, `{{contact.name}}`, `{{contact.email}}`, `{{contact.phone}}`, `{{contact.company_name}}`, `{{contact.city}}`, `{{contact.<custom_field_key>}}`. Add a fallback with `|`, for example `{{contact.first_name|there}}`.

## Notes and limitations
- **Call reporting:** GHL has no public call-report API, so `call_report` builds its numbers from the call logs in Conversations. Totals may differ slightly from the in-app Call Reporting dashboard. For long periods, increase `max_conversations`.
- **Imports:** the API has no bulk-import endpoint, so contacts are upserted one at a time behind a rate limiter (about 8 requests per second; GHL allows 100 per 10 seconds). 1,000 contacts take roughly 3–5 minutes. Rows that fail go to `<file>.failures.csv`.
- **Workflows and automations:** adding tags, moving stages and enrolling contacts in workflows can trigger your GHL automations, which is why those actions go through the preview step.
- **DND / compliance:** contacts with DND, or with DND turned on for the channel, are always skipped. Make sure your bulk texting complies with A2P 10DLC and TCPA rules.
- Search filters use GHL's advanced contact search. For custom-field filters, use `raw_filters`, for example `{"field":"customFields.<fieldId>","operator":"eq","value":"x"}`.

## Development
```bash
npm test           # unit + integration tests against a fake GHL API
npm run inspect    # open the MCP Inspector to try tools by hand (needs env vars set)
```
Layout: `src/client.ts` (HTTP client, rate limit, retries), `src/confirm.ts` (preview/confirm engine), `src/ghl.ts` (pagination and data helpers), `src/tools/*` (tool groups), `src/server.ts` (registration).
