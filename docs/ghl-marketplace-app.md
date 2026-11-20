# Optional: private GoHighLevel Marketplace app

Creating your own **private** Marketplace app adds two things to the hosted connector:

1. A **"Log in with GoHighLevel"** button. You pick the sub-account on GHL's own login page, so no tokens get copied around. The login refreshes itself automatically.
2. **Instant automation triggers.** GHL sends events (new contact, tag added, stage changed, inbound message, appointment, task completed) straight to the connector. Without the app, the connector checks every 5 minutes, and appointment and task triggers aren't available.

You don't need the app to use the connector; the token login works without it.

## 1. Create the app
1. Go to [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com) and sign in with your **agency** login.
2. **My Apps → Create App.**
   - App type: **Private**
   - Distribution / who can install: **Sub-account**
3. Open the app's **Advanced Settings → Auth**:
   - **Scopes:** add the scopes listed in the [README](../README.md#scopes).
   - **Redirect URL:** `https://<your-domain>/oauth/ghl/callback`
   - **Client Keys → Add:** copy the **Client ID** and **Client Secret**.
4. Back in Railway, add the variables `GHL_CLIENT_ID` and `GHL_CLIENT_SECRET`. The **Log in with GoHighLevel** button now appears on the login page.

## 2. Webhooks (instant triggers)
1. In the app, go to **Advanced Settings → Webhooks** and set the **Webhook URL** to:
   `https://<your-domain>/webhooks/ghl/<WEBHOOK_SECRET>`
   Use the same random string you put in the `WEBHOOK_SECRET` variable on Railway. It works like a password inside the URL.
2. Turn on these events:
   `ContactCreate` · `ContactUpdate` · `ContactTagUpdate` · `OpportunityCreate` · `OpportunityStageUpdate` · `OpportunityStatusUpdate` · `InboundMessage` · `AppointmentCreate` · `AppointmentUpdate` · `TaskComplete`
3. Optional, for extra verification: copy GHL's webhook **public key** from GHL's webhook documentation into the `GHL_WEBHOOK_PUBLIC_KEY` variable. Use `\n` for line breaks. The connector then also checks the `x-wh-signature` / `x-ghl-signature` headers.

GHL only sends webhooks for sub-accounts where the app is installed. Logging in through **Log in with GoHighLevel** installs it. Once webhooks are arriving, the connector stops polling that location automatically.

## Troubleshooting
- **"Pick a sub-account (not the agency)"**: on GHL's chooser page, select a location rather than the agency.
- **"This GoHighLevel location isn't allowed"**: add its Location ID to `ALLOWED_LOCATION_IDS`.
- **A tool fails with 403:** the app or token is missing a scope. Add it, then reconnect in Claude: **Settings → Connectors → GoHighLevel → Disconnect / Connect**.
- **Automations don't fire:** run `automation_history` in Claude, and check whether the automation is still in dry-run (`list_automations`). On `/admin`, check that the location shows as active.
