#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GhlClient } from "../core/client.js";
import { buildServer } from "../core/server.js";

/** Treat empty or unsubstituted "${user_config.x}" placeholders as unset. */
function envVal(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && !v.startsWith("${") ? v : undefined;
}

async function main() {
  const env = {
    GHL_API_KEY: envVal("GHL_API_KEY"),
    GHL_LOCATION_ID: envVal("GHL_LOCATION_ID"),
    GHL_BASE_URL: envVal("GHL_BASE_URL"),
    GHL_READ_ONLY: envVal("GHL_READ_ONLY"),
    GHL_BULK_CONFIRM_THRESHOLD: envVal("GHL_BULK_CONFIRM_THRESHOLD"),
    GHL_DEFAULT_COUNTRY_CODE: envVal("GHL_DEFAULT_COUNTRY_CODE"),
  };
  const threshold = Number(env.GHL_BULK_CONFIRM_THRESHOLD);
  const readOnly = /^(1|true|yes)$/i.test(env.GHL_READ_ONLY ?? "");
  const client = new GhlClient({
    apiKey: env.GHL_API_KEY ?? "",
    locationId: env.GHL_LOCATION_ID ?? "",
    baseUrl: env.GHL_BASE_URL,
  });
  const { server, tools } = buildServer(client, {
    readOnly,
    confirmThreshold: Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : 1,
    defaultCountryCode: (env.GHL_DEFAULT_COUNTRY_CODE ?? "1").replace(/\D/g, "") || "1",
    fileAccess: true,
  });
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error(`[ghl-mcp] connected: ${tools.length} tools, location ${client.locationId}${readOnly ? " (read-only)" : ""}`);
}

main().catch((err) => {
  console.error(`[ghl-mcp] fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
