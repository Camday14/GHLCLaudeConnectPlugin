import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GhlClient, GhlError } from "./client.js";
import { ConfirmContext, ConfirmError, ConfirmStore } from "./confirm.js";
import { GhlData } from "./ghl.js";

export interface Config {
  readOnly: boolean;
  confirmThreshold: number;
  defaultCountryCode: string;
}

export interface Ctx {
  client: GhlClient;
  data: GhlData;
  confirm: ConfirmContext;
  config: Config;
}

export function createCtx(client: GhlClient, config: Partial<Config> = {}): Ctx {
  const cfg: Config = { readOnly: false, confirmThreshold: 1, defaultCountryCode: "1", ...config };
  return {
    client,
    data: new GhlData(client),
    confirm: { store: new ConfirmStore(), threshold: cfg.confirmThreshold },
    config: cfg,
  };
}

export const confirmTokenArg = {
  confirm_token: z
    .string()
    .optional()
    .describe("Leave empty on the first call to get a preview. Only pass the token from the preview after the user explicitly approves it."),
};

type Shape = Record<string, z.ZodTypeAny>;

export interface ToolDef<S extends Shape> {
  name: string;
  title?: string;
  description: string;
  schema: S;
  /** Write tools are hidden when GHL_READ_ONLY=true. */
  write?: boolean;
  destructive?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: Ctx) => Promise<unknown>;
}

const CONFIRM_NOTE =
  " SAFETY: this tool first returns a PREVIEW and a confirm_token without changing anything. Show the preview to the user and wait for their explicit approval before calling again with confirm_token.";

export function registerTools(server: McpServer, ctx: Ctx, defs: ToolDef<any>[]): string[] {
  const registered: string[] = [];
  for (const def of defs) {
    if (def.write && ctx.config.readOnly) continue;
    const usesConfirm = "confirm_token" in def.schema;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description + (usesConfirm ? CONFIRM_NOTE : ""),
        inputSchema: def.schema,
        annotations: {
          readOnlyHint: !def.write,
          destructiveHint: def.destructive ?? false,
          openWorldHint: true,
        },
      },
      (async (args: any) => {
        try {
          const result = await def.handler(args, ctx);
          return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text" as const, text: formatError(err) }] };
        }
      }) as any,
    );
    registered.push(def.name);
  }
  return registered;
}

export function formatError(err: unknown): string {
  if (err instanceof ConfirmError) return `Not executed: ${err.message}`;
  if (err instanceof GhlError) {
    const hint =
      err.status === 401
        ? " Hint: the token is invalid or expired. Check GHL_API_KEY."
        : err.status === 403
          ? " Hint: the Private Integration is missing a scope needed for this endpoint, or the token belongs to a different location."
          : err.status === 422 || err.status === 400
            ? " Hint: the request was rejected as invalid. Check IDs and field formats."
            : "";
    return err.message + hint;
  }
  return err instanceof Error ? err.message : String(err);
}

export function defineTool<S extends Shape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
