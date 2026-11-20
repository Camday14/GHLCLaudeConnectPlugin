import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { GhlClient } from "../src/core/client.js";
import type { Config } from "../src/core/context.js";
import { buildServer } from "../src/core/server.js";

export interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  body: any;
  headers: Record<string, string>;
}

type Handler = (call: Call) => unknown | Response;

/** A tiny fake GHL API: route "METHOD /path/with/:params" -> handler. Records every call. */
export function fakeGhl(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(" ");
    const re = new RegExp("^" + pattern.replace(/:[a-zA-Z]+/g, "[^/]+") + "/?$");
    return { method, re, handler };
  });
  const fetchImpl = (async (input: any, init: any = {}) => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers ?? {},
    };
    calls.push(call);
    const route = compiled.find((r) => r.method === call.method && r.re.test(call.path));
    if (!route) return new Response(JSON.stringify({ message: `no fake route for ${call.method} ${call.path}` }), { status: 404 });
    const out = route.handler(call);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export async function connect(fetchImpl: typeof fetch, config: Partial<Config> = {}) {
  const ghl = new GhlClient({ apiKey: "pit-test", locationId: "LOC1", fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  const { server, tools } = buildServer(ghl, config);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res: any = await client.callTool({ name, arguments: args });
    const text = res.content?.[0]?.text ?? "";
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { isError: !!res.isError, text, json };
  };
  return { client, call, tools };
}

export const contacts = [
  { id: "c1", firstName: "Ann", lastName: "Lee", email: "ann@x.com", phone: "+15550000001", tags: ["lead"], dateAdded: new Date().toISOString(), source: "facebook" },
  { id: "c2", firstName: "Bob", email: "bob@x.com", phone: "+15550000002", tags: ["lead"], dnd: true, dateAdded: "2025-01-01T00:00:00Z" },
  { id: "c3", firstName: "", lastName: "Cruz", email: "cruz@x.com", tags: ["lead", "vip"], dateAdded: new Date().toISOString(), dndSettings: { SMS: { status: "active" } } },
];
