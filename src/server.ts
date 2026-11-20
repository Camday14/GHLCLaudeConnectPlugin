import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GhlClient } from "./client.js";
import { createCtx, registerTools, type Config, type Ctx } from "./context.js";
import { contactTools } from "./tools/contacts.js";
import { importTools } from "./tools/imports.js";
import { leadTools } from "./tools/leads.js";
import { messagingTools } from "./tools/messaging.js";
import { metaTools } from "./tools/meta.js";
import { pipelineTools } from "./tools/pipelines.js";
import { reportTools } from "./tools/reports.js";

export const ALL_TOOLS = [...contactTools, ...leadTools, ...messagingTools, ...pipelineTools, ...importTools, ...reportTools, ...metaTools];

const INSTRUCTIONS = `GoHighLevel CRM connector for one sub-account.
- Resolve names to IDs with list_users, list_pipelines, list_custom_fields, list_workflows before writing.
- Any tool that sends messages, changes many records, or deletes returns a PREVIEW + confirm_token first. Always show the preview to the user and get explicit approval before calling again with confirm_token. Never confirm on the user's behalf.
- Reports (pipeline_report, call_report, activity_summary, revenue_summary) are read-only and safe to run.`;

export function buildServer(client: GhlClient, config: Partial<Config> = {}): { server: McpServer; ctx: Ctx; tools: string[] } {
  const server = new McpServer({ name: "gohighlevel", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const ctx = createCtx(client, config);
  const tools = registerTools(server, ctx, ALL_TOOLS);
  return { server, ctx, tools };
}
