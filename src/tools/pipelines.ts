import { z } from "zod";
import { runConfirmable } from "../confirm.js";
import { confirmTokenArg, defineTool, type Ctx, type ToolDef } from "../context.js";
import { summarize } from "./contacts.js";

const statusEnum = z.enum(["open", "won", "lost", "abandoned"]);

export function compactOpp(o: any, stages: Record<string, any> = {}, names: Record<string, string> = {}) {
  const st = stages[o.pipelineStageId];
  return {
    id: o.id,
    name: o.name,
    value: o.monetaryValue,
    status: o.status,
    pipeline: st?.pipelineName ?? o.pipelineId,
    stage: st?.stageName ?? o.pipelineStageId,
    stageId: o.pipelineStageId,
    assignedTo: o.assignedTo ? names[o.assignedTo] ?? o.assignedTo : undefined,
    contactId: o.contactId ?? o.contact?.id,
    contact: o.contact?.name ?? o.contact?.email,
    source: o.source,
    createdAt: o.createdAt,
    lastStageChangeAt: o.lastStageChangeAt,
    lastStatusChangeAt: o.lastStatusChangeAt,
  };
}

/** Resolve a stage by ID or by (case-insensitive) name, optionally within a pipeline. */
async function resolveStage(ctx: Ctx, stage: string, pipelineId?: string) {
  const idx = await ctx.data.stageIndex();
  if (idx[stage]) return { stageId: stage, ...idx[stage] };
  const matches = Object.entries(idx).filter(
    ([, s]) => s.stageName.toLowerCase() === stage.toLowerCase() && (!pipelineId || s.pipelineId === pipelineId),
  );
  if (matches.length === 1) return { stageId: matches[0][0], ...matches[0][1] };
  if (matches.length > 1) throw new Error(`Stage name "${stage}" exists in several pipelines (${matches.map(([, s]) => s.pipelineName).join(", ")}); pass pipeline_id or the stage ID.`);
  throw new Error(`Stage "${stage}" not found. Use list_pipelines to see stages.`);
}

export const pipelineTools: ToolDef<any>[] = [
  defineTool({
    name: "list_pipelines",
    title: "List pipelines",
    description: "List all sales pipelines with their stages (IDs and names, in order).",
    schema: {},
    handler: async (_a, { data }) => {
      const pipelines = await data.pipelines();
      return pipelines.map((p: any) => ({
        id: p.id,
        name: p.name,
        stages: (p.stages ?? []).map((s: any) => ({ id: s.id, name: s.name, position: s.position })),
      }));
    },
  }),

  defineTool({
    name: "search_opportunities",
    title: "Search opportunities",
    description: "Search deals/opportunities by pipeline, stage (ID or name), status, owner, contact, or text.",
    schema: {
      pipeline_id: z.string().optional(),
      stage: z.string().optional().describe("Stage ID or name"),
      status: z.enum(["open", "won", "lost", "abandoned", "all"]).default("open"),
      assigned_to: z.string().optional(),
      contact_id: z.string().optional(),
      query: z.string().optional(),
      limit: z.number().int().min(1).max(5000).default(100),
    },
    handler: async (a, ctx) => {
      const stageId = a.stage ? (await resolveStage(ctx, a.stage, a.pipeline_id)).stageId : undefined;
      const res = await ctx.data.searchOpportunities(
        { pipeline_id: a.pipeline_id, stage_id: stageId, status: a.status, assigned_to: a.assigned_to, contact_id: a.contact_id, query: a.query },
        a.limit,
      );
      const stages = await ctx.data.stageIndex();
      const names = await ctx.data.userNames();
      const total_value = res.items.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0);
      return { total_matching: res.total, returned: res.items.length, truncated: res.truncated, total_value, opportunities: res.items.map((o) => compactOpp(o, stages, names)) };
    },
  }),

  defineTool({
    name: "create_opportunity",
    title: "Create opportunity",
    description: "Create a deal for a contact in a pipeline stage.",
    write: true,
    schema: {
      contact_id: z.string(),
      name: z.string(),
      stage: z.string().describe("Stage ID or name"),
      pipeline_id: z.string().optional().describe("Needed only if the stage name is ambiguous"),
      monetary_value: z.number().optional(),
      status: statusEnum.default("open"),
      assigned_to: z.string().optional(),
      source: z.string().optional(),
    },
    handler: async (a, ctx) => {
      const st = await resolveStage(ctx, a.stage, a.pipeline_id);
      const res = await ctx.client.post("/opportunities/", {
        locationId: ctx.data.locationId,
        pipelineId: st.pipelineId,
        pipelineStageId: st.stageId,
        contactId: a.contact_id,
        name: a.name,
        status: a.status,
        monetaryValue: a.monetary_value,
        assignedTo: a.assigned_to,
        source: a.source,
      });
      return res.opportunity ?? res;
    },
  }),

  defineTool({
    name: "update_opportunity",
    title: "Update opportunity",
    description: "Update a deal's name, value, owner, or source. To change stage or status use move_opportunities / set_opportunity_status.",
    write: true,
    schema: {
      opportunity_id: z.string(),
      name: z.string().optional(),
      monetary_value: z.number().optional(),
      assigned_to: z.string().optional(),
      source: z.string().optional(),
    },
    handler: async (a, { client }) => {
      const body = Object.fromEntries(
        Object.entries({ name: a.name, monetaryValue: a.monetary_value, assignedTo: a.assigned_to, source: a.source }).filter(([, v]) => v !== undefined),
      );
      const res = await client.put(`/opportunities/${a.opportunity_id}`, body);
      return res.opportunity ?? res;
    },
  }),

  defineTool({
    name: "move_opportunities",
    title: "Move opportunities to a stage",
    description: "Move one or many deals to a pipeline stage. Select deals by IDs, or by from_stage (+ optional owner) to bulk-move a whole stage. Stage changes can trigger GHL automations.",
    write: true,
    schema: {
      to_stage: z.string().describe("Target stage ID or name"),
      pipeline_id: z.string().optional(),
      opportunity_ids: z.array(z.string()).optional(),
      from_stage: z.string().optional().describe("Bulk: move all open deals currently in this stage"),
      assigned_to: z.string().optional().describe("Bulk: only deals owned by this user"),
      max_opportunities: z.number().int().min(1).max(5000).default(500),
      ...confirmTokenArg,
    },
    handler: async (a, ctx) => {
      const target = await resolveStage(ctx, a.to_stage, a.pipeline_id);
      let opps: any[] = [];
      for (const id of a.opportunity_ids ?? []) opps.push((await ctx.client.get(`/opportunities/${id}`)).opportunity);
      if (a.from_stage) {
        const from = await resolveStage(ctx, a.from_stage, a.pipeline_id);
        const res = await ctx.data.searchOpportunities({ pipeline_id: from.pipelineId, stage_id: from.stageId, status: "open", assigned_to: a.assigned_to }, a.max_opportunities);
        opps.push(...res.items);
      }
      if (!a.opportunity_ids?.length && !a.from_stage) throw new Error("Provide opportunity_ids or from_stage");
      opps = [...new Map(opps.filter(Boolean).map((o) => [o.id, o])).values()].filter((o) => o.pipelineStageId !== target.stageId);
      const plan = { to_stage_id: target.stageId, pipeline_id: target.pipelineId, ids: opps.map((o) => o.id).sort() };
      const stages = await ctx.data.stageIndex();
      const names = await ctx.data.userNames();
      return runConfirmable(
        ctx.confirm,
        {
          tool: "move_opportunities",
          plan,
          count: plan.ids.length,
          preview: {
            action: `MOVE deals to "${target.stageName}" (${target.pipelineName})`,
            total_value: opps.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0),
            sample: opps.slice(0, 15).map((o) => compactOpp(o, stages, names)),
          },
          execute: async (p) => {
            const results = [];
            for (const id of p.ids) {
              try {
                await ctx.client.put(`/opportunities/${id}`, { pipelineId: p.pipeline_id, pipelineStageId: p.to_stage_id });
                results.push({ id, ok: true });
              } catch (e) {
                results.push({ id, ok: false, error: (e as Error).message });
              }
            }
            return summarize(results);
          },
        },
        a.confirm_token,
      );
    },
  }),

  defineTool({
    name: "set_opportunity_status",
    title: "Set deal status (won/lost)",
    description: "Mark one or more deals as open, won, lost, or abandoned.",
    write: true,
    schema: {
      opportunity_ids: z.array(z.string()).min(1),
      status: statusEnum,
      ...confirmTokenArg,
    },
    handler: async (a, ctx) => {
      const opps = [];
      for (const id of a.opportunity_ids) opps.push((await ctx.client.get(`/opportunities/${id}`)).opportunity);
      const targets = opps.filter((o) => o && o.status !== a.status);
      const plan = { status: a.status, ids: targets.map((o) => o.id).sort() };
      const stages = await ctx.data.stageIndex();
      return runConfirmable(
        ctx.confirm,
        {
          tool: "set_opportunity_status",
          plan,
          count: plan.ids.length,
          preview: {
            action: `MARK deals as ${a.status.toUpperCase()}`,
            total_value: targets.reduce((s, o) => s + (Number(o.monetaryValue) || 0), 0),
            deals: targets.slice(0, 25).map((o) => compactOpp(o, stages)),
          },
          execute: async (p) => {
            const results = [];
            for (const id of p.ids) {
              try {
                await ctx.client.put(`/opportunities/${id}/status`, { status: p.status });
                results.push({ id, ok: true });
              } catch (e) {
                results.push({ id, ok: false, error: (e as Error).message });
              }
            }
            return summarize(results);
          },
        },
        a.confirm_token,
      );
    },
  }),
];
