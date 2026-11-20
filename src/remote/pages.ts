/** Server-rendered HTML pages: landing, connect/login, result, admin. No external assets. */

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root{--bg:#f6f7f9;--card:#fff;--text:#14171f;--muted:#5b6475;--border:#dfe3ea;--accent:#1f6feb;--accent-text:#fff;--danger:#c62828;--ok:#1b7f3b;--field:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#0f1218;--card:#171b23;--text:#e8ebf1;--muted:#9aa3b5;--border:#2a303c;--accent:#4c8dff;--accent-text:#fff;--danger:#ff6b6b;--ok:#4cc27a;--field:#10141b}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:520px;margin:0 auto;padding:40px 16px 64px}
main.wide{max-width:960px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:24px;margin-bottom:16px}
h1{font-size:22px;margin:0 0 6px}
h2{font-size:16px;margin:0 0 12px}
p{margin:0 0 12px;color:var(--muted)}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:20px}
.logo{width:40px;height:40px;flex:none}.logo svg{display:block}
label{display:block;font-weight:600;margin:14px 0 6px;font-size:14px}
input[type=text],input[type=password]{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--border);background:var(--field);color:var(--text);font-size:15px}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px 16px;border-radius:9px;border:0;background:var(--accent);color:var(--accent-text);font-weight:600;font-size:15px;cursor:pointer;text-decoration:none;margin-top:16px}
button.secondary,.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--border)}
button.danger{background:var(--danger)}
button.small{width:auto;padding:6px 12px;margin:0;font-size:13px}
.divider{display:flex;align-items:center;gap:12px;color:var(--muted);font-size:13px;margin:22px 0 4px}
.divider:before,.divider:after{content:"";flex:1;border-top:1px solid var(--border)}
.error{background:color-mix(in srgb,var(--danger) 12%,transparent);color:var(--danger);border-radius:9px;padding:10px 12px;margin-bottom:12px;font-size:14px}
.ok{color:var(--ok)}
details{margin-top:14px;font-size:14px;color:var(--muted)}
summary{cursor:pointer;color:var(--text)}
ol,ul{padding-left:20px;margin:8px 0}
code{background:color-mix(in srgb,var(--muted) 15%,transparent);padding:1px 5px;border-radius:5px;font-size:13px;word-break:break-all}
.url{display:flex;gap:8px;align-items:center}
.url code{flex:1;padding:10px;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--border);vertical-align:top}
th{color:var(--muted);font-weight:600}
.pill{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--border)}
.pill.live{color:var(--ok);border-color:var(--ok)}
.table-wrap{overflow-x:auto}
small{color:var(--muted)}
`;

function layout(title: string, body: string, wide = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex"><style>${CSS}</style></head>
<body><main class="${wide ? "wide" : ""}">${body}</main></body></html>`;
}

const ICON = `<svg viewBox="0 0 512 512" width="40" height="40" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#1f6feb"/><stop offset="1" stop-color="#0b3d91"/></linearGradient></defs><rect width="512" height="512" rx="112" fill="url(#g)"/><rect x="112" y="300" width="64" height="104" rx="14" fill="#fff" opacity=".55"/><rect x="224" y="236" width="64" height="168" rx="14" fill="#fff" opacity=".75"/><rect x="336" y="160" width="64" height="244" rx="14" fill="#fff"/><path d="M368 44l14 34 34 14-34 14-14 34-14-34-34-14 34-14z" fill="#ffd166"/></svg>`;
const brand = (subtitle: string) => `<div class="brand"><div class="logo">${ICON}</div><div><h1>GoHighLevel for Claude</h1><p style="margin:0">${subtitle}</p></div></div>`;

export function landingPage(publicUrl: string): string {
  const url = `${publicUrl}/mcp`;
  return layout(
    "GoHighLevel for Claude",
    `${brand("Your private connector is running.")}
<div class="card">
  <h2>Add it to Claude</h2>
  <ol>
    <li>In Claude, open <b>Settings → Connectors</b> and click <b>Add custom connector</b>.</li>
    <li>Name it <b>GoHighLevel</b> and paste this URL:</li>
  </ol>
  <div class="url"><code id="u">${esc(url)}</code><button class="small" onclick="navigator.clipboard.writeText(document.getElementById('u').textContent);this.textContent='Copied'">Copy</button></div>
  <ol start="3"><li>Click <b>Connect</b> and log in to GoHighLevel on the page that opens.</li></ol>
</div>
<p><small>Admin: <a href="/admin">/admin</a> · Health: <a href="/healthz">/healthz</a></small></p>`,
  );
}

export interface ConnectPageOpts {
  reqId: string;
  clientName?: string;
  passcodeRequired: boolean;
  ghlOAuthEnabled: boolean;
  error?: string;
  locationId?: string;
}

export function connectPage(o: ConnectPageOpts): string {
  const passcode = o.passcodeRequired
    ? `<label for="pc">Team passcode</label><input id="pc" type="password" name="passcode" autocomplete="current-password" required>`
    : "";
  const ghl = o.ghlOAuthEnabled
    ? `<button type="submit" formaction="/connect/ghl" formnovalidate>Log in with GoHighLevel</button>
       <p style="margin-top:10px;font-size:13px">You'll pick the sub-account to connect on GoHighLevel's own login page.</p>
       <div class="divider">or use a Private Integration token</div>`
    : "";
  return layout(
    "Connect GoHighLevel",
    `${brand(`${esc(o.clientName ?? "Claude")} wants to access your GoHighLevel account`)}
<div class="card">
  ${o.error ? `<div class="error" role="alert">${esc(o.error)}</div>` : ""}
  <form method="post" action="/connect/pit">
    <input type="hidden" name="req" value="${esc(o.reqId)}">
    ${passcode}
    ${ghl}
    <label for="loc">Location ID</label>
    <input id="loc" type="text" name="location_id" value="${esc(o.locationId ?? "")}" placeholder="e.g. ve9EPM428h8vShlRW1KT" ${o.ghlOAuthEnabled ? "" : "required"} autocomplete="off">
    <label for="tok">Private Integration token</label>
    <input id="tok" type="password" name="token" placeholder="pit-…" ${o.ghlOAuthEnabled ? "" : "required"} autocomplete="off">
    <button type="submit" formaction="/connect/pit" class="${o.ghlOAuthEnabled ? "secondary" : ""}">Connect with token</button>
    <details><summary>Where do I find these?</summary>
      <ol>
        <li>In GoHighLevel, switch into your <b>sub-account</b>.</li>
        <li><b>Settings → Private Integrations → Create new integration</b>. Select the scopes for contacts, conversations, conversation messages, opportunities, users, locations, custom fields, tags, workflows, calendars and payments/transactions.</li>
        <li>Copy the token (starts with <code>pit-</code>).</li>
        <li>The <b>Location ID</b> is under <b>Settings → Business Profile</b>, or in your browser's address bar after <code>/location/</code>.</li>
      </ol>
    </details>
    <button type="submit" formaction="/connect/cancel" formnovalidate class="secondary">Cancel</button>
  </form>
</div>
<p><small>Your token is encrypted and stored on your own connector server. Claude never sees it.</small></p>`,
  );
}

export function messagePage(title: string, message: string, ok = false): string {
  return layout(title, `${brand(esc(title))}<div class="card"><p class="${ok ? "ok" : ""}">${esc(message)}</p></div>`);
}

export function adminPage(data: {
  connections: Array<{ location_id: string; location_name?: string | null; auth_type: string; status: string; last_error?: string | null; updated_at?: Date }>;
  automations: Array<{ id: string; location_id: string; name: string; enabled: boolean; mode: string; runs_24h: number; failed_24h: number }>;
  csrf: string;
}): string {
  const conn = data.connections
    .map(
      (c) => `<tr><td><b>${esc(c.location_name ?? "")}</b><br><small>${esc(c.location_id)}</small></td><td>${esc(c.auth_type === "oauth" ? "GHL login" : "Token")}</td>
      <td><span class="pill ${c.status === "active" ? "live" : ""}">${esc(c.status)}</span>${c.last_error ? `<br><small>${esc(c.last_error)}</small>` : ""}</td>
      <td>${c.status === "active" ? `<form method="post" action="/admin/disconnect" onsubmit="return confirm('Disconnect this location? Claude will lose access and its automations stop.')"><input type="hidden" name="csrf" value="${esc(data.csrf)}"><input type="hidden" name="location_id" value="${esc(c.location_id)}"><button class="small danger">Disconnect</button></form>` : ""}</td></tr>`,
    )
    .join("");
  const autos = data.automations
    .map(
      (a) => `<tr><td><b>${esc(a.name)}</b><br><small>${esc(a.id)} · ${esc(a.location_id)}</small></td>
      <td><span class="pill ${a.enabled && a.mode === "live" ? "live" : ""}">${!a.enabled ? "disabled" : a.mode === "live" ? "live" : "dry run"}</span></td>
      <td>${a.runs_24h}${a.failed_24h ? ` <small>(${a.failed_24h} failed)</small>` : ""}</td></tr>`,
    )
    .join("");
  const locs = [...new Set(data.automations.filter((a) => a.enabled).map((a) => a.location_id))];
  return layout(
    "Connector admin",
    `${brand("Connector admin")}
<div class="card"><h2>Connected GoHighLevel accounts</h2><div class="table-wrap"><table><tr><th>Location</th><th>Login</th><th>Status</th><th></th></tr>${conn || `<tr><td colspan="4"><small>Nothing connected yet.</small></td></tr>`}</table></div></div>
<div class="card"><h2>Automations</h2><div class="table-wrap"><table><tr><th>Automation</th><th>Mode</th><th>Runs (24h)</th></tr>${autos || `<tr><td colspan="3"><small>No automations yet. Ask Claude to create one.</small></td></tr>`}</table></div>
${locs
  .map(
    (l) => `<form method="post" action="/admin/pause" onsubmit="return confirm('Pause every automation for ${esc(l)}?')"><input type="hidden" name="csrf" value="${esc(data.csrf)}"><input type="hidden" name="location_id" value="${esc(l)}"><button class="danger">Pause all automations for ${esc(l)}</button></form>`,
  )
  .join("")}
</div>`,
    true,
  );
}
