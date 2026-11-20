// Fake GoHighLevel API + marketplace chooser + Claude callback, as a real HTTP server.
import http from "node:http";
import fs from "node:fs";
const LOG = process.env.LOG ?? "requests.jsonl";
const contacts = {
  c1: { id: "c1", firstName: "Ann", lastName: "Lee", email: "ann@x.com", phone: "+15550000001", tags: ["customer"], dateAdded: "2026-10-01T00:00:00Z", assignedTo: "u1" },
  c2: { id: "c2", firstName: "Bob", email: "bob@x.com", phone: "+15550000002", tags: [], dnd: true, dateAdded: "2026-10-01T00:00:00Z" },
  c3: { id: "c3", firstName: "Cat", email: "cat@x.com", phone: "+15550000003", tags: [], dateAdded: "2026-10-01T00:00:00Z" },
};
const opps = [];
const pipelines = [{ id: "p1", name: "Sales", stages: [{ id: "s1", name: "New Lead" }, { id: "s2", name: "Qualified" }] }];
let tokenN = 0;
const send = (res, code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace(/\/+$/, "") || "/";
    let body;
    try { body = raw ? (req.headers["content-type"]?.includes("urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw)) : undefined; } catch { body = raw; }
    fs.appendFileSync(LOG, JSON.stringify({ m: req.method, p, q: Object.fromEntries(url.searchParams), body, auth: req.headers.authorization, ver: req.headers.version }) + "\n");
    const seg = p.split("/");
    if (p === "/claude-cb") { res.writeHead(200, { "content-type": "text/html" }); return res.end(`<h1>Claude callback received</h1><p>code=${url.searchParams.get("code") ? "present" : "missing"} state=${url.searchParams.get("state")} error=${url.searchParams.get("error") ?? ""}</p>`); }
    if (p === "/oauth/chooselocation") { const r = new URL(url.searchParams.get("redirect_uri")); r.searchParams.set("code", "ghl-code-123"); r.searchParams.set("state", url.searchParams.get("state")); res.writeHead(302, { location: r.toString() }); return res.end(); }
    if (p === "/oauth/token" && req.method === "POST") { tokenN++; return send(res, 200, { access_token: `ghl-at-${tokenN}`, refresh_token: `ghl-rt-${tokenN}`, expires_in: tokenN === 1 ? 60 : 86400, locationId: "LOC2", companyId: "CO1", userType: "Location" }); }
    if (req.headers.authorization === "Bearer pit-bad") return send(res, 401, { message: "Invalid JWT" });
    if (seg[1] === "locations" && seg.length === 3) return send(res, 200, { location: { id: seg[2], name: seg[2] === "LOC2" ? "Beta Plumbing" : "Acme Roofing" } });
    if (seg[1] === "locations" && seg[3] === "customFields") return send(res, 200, { customFields: [] });
    if (seg[1] === "locations" && seg[3] === "tags") return send(res, 200, { tags: [{ name: "customer" }] });
    if (p === "/users") return send(res, 200, { users: [{ id: "u1", name: "Rep One" }, { id: "u2", name: "Rep Two" }] });
    if (p === "/workflows") return send(res, 200, { workflows: [] });
    if (p === "/contacts/search") return send(res, 200, { contacts: Object.values(contacts), total: 3 });
    if (seg[1] === "contacts" && seg.length === 3 && req.method === "GET") return contacts[seg[2]] ? send(res, 200, { contact: contacts[seg[2]] }) : send(res, 404, { message: "not found" });
    if (seg[1] === "contacts" && seg[3] === "tags") { const c = contacts[seg[2]]; c.tags = req.method === "POST" ? [...new Set([...c.tags, ...body.tags])] : c.tags.filter((t) => !body.tags.includes(t)); return send(res, 200, { tags: c.tags }); }
    if (seg[1] === "contacts" && seg.length === 3 && req.method === "PUT") { Object.assign(contacts[seg[2]], body); return send(res, 200, { contact: contacts[seg[2]] }); }
    if (seg[1] === "contacts" && seg[3] === "tasks") return send(res, 201, { task: { id: "t1" } });
    if (p === "/conversations/messages" && req.method === "POST") return send(res, 201, { messageId: `m${Date.now()}`, conversationId: "cv1" });
    if (p === "/conversations/search") return send(res, 200, { conversations: [] });
    if (p === "/opportunities/pipelines") return send(res, 200, { pipelines });
    if (p === "/opportunities/search") { const l = opps.filter((o) => (!url.searchParams.get("contact_id") || o.contactId === url.searchParams.get("contact_id")) && (["all", null].includes(url.searchParams.get("status")) || o.status === url.searchParams.get("status"))); return send(res, 200, { opportunities: l, meta: { total: l.length } }); }
    if (p === "/opportunities" && req.method === "POST") { const o = { id: `o${opps.length + 1}`, ...body }; opps.push(o); return send(res, 201, { opportunity: o }); }
    if (seg[1] === "opportunities" && seg.length === 3) return send(res, 200, { opportunity: opps.find((o) => o.id === seg[2]) });
    send(res, 404, { message: `fake: no route ${req.method} ${p}` });
  });
}).listen(4600, () => console.log("fake GHL on :4600"));
