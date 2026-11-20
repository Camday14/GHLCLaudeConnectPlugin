#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GhlClient } from "./client.js";
import { buildServer } from "./server.js";

async function main() {
  const env = process.env;
  const client = new GhlClient({
    apiKey: env.GHL_API_KEY ?? "",
    locationId: env.GHL_LOCATION_ID ?? "",
    baseUrl: env.GHL_BASE_URL,
  });
  const { server, tools } = buildServer(client, {
    readOnly: /^(1|true|yes)$/i.test(env.GHL_READ_ONLY ?? ""),
    confirmThreshold: env.GHL_BULK_CONFIRM_THRESHOLD ? Number(env.GHL_BULK_CONFIRM_THRESHOLD) : 1,
    defaultCountryCode: env.GHL_DEFAULT_COUNTRY_CODE ?? "1",
  });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error(`[ghl-mcp] connected: ${tools.length} tools, location ${client.locationId}${env.GHL_READ_ONLY ? " (read-only)" : ""}`);
}

main().catch((err) => {
  console.error(`[ghl-mcp] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
