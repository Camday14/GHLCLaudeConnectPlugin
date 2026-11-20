import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GhlClient } from "./client.js";
import { createCtx, registerTools, type Config, type Ctx, type ToolDef } from "./context.js";
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

export const SERVER_VERSION = "1.1.0";

export function buildServer(client: GhlClient, config: Partial<Config> = {}): { server: McpServer; ctx: Ctx; tools: string[] } {
  const ctx = createCtx(client, config);
  return { ...buildServerForCtx(ctx), ctx };
}

/** Build an MCP server around an existing context, optionally with extra tools (hosted mode adds automation tools). */
export function buildServerForCtx(ctx: Ctx, extraTools: ToolDef<any>[] = [], extraInstructions = ""): { server: McpServer; tools: string[] } {
  const server = new McpServer({ name: "gohighlevel", version: SERVER_VERSION }, { instructions: INSTRUCTIONS + extraInstructions });
  const tools = registerTools(server, ctx, [...ALL_TOOLS, ...extraTools]);
  return { server, tools };
}
