import { randomBytes } from "node:crypto";
import { sha256, stableStringify } from "./util.js";

/**
 * Two-phase preview/confirm engine.
 *
 * Phase 1: a write tool is called without `confirm_token`. It resolves exactly what it would do
 *          (the "plan"), and we return a preview plus a short-lived token bound to the plan's hash.
 * Phase 2: the tool is called again with identical arguments plus `confirm_token`. The plan is
 *          rebuilt; if it hashes to the same value as the token, it executes. Otherwise it refuses,
 *          so nothing runs that the user didn't see.
 */

export const CONFIRM_TTL_MS = 10 * 60 * 1000;

interface Entry {
  tool: string;
  hash: string;
  expires: number;
}

/** Storage for confirm tokens. In-memory for the desktop server, database-backed for the hosted server. */
export interface ConfirmBackend {
  issue(tool: string, plan: unknown): Promise<string> | string;
  redeem(tool: string, plan: unknown, token: string): Promise<void> | void;
}

export function planHash(plan: unknown): string {
  return sha256(stableStringify(plan));
}

export function newConfirmToken(): string {
  return `cfm_${randomBytes(9).toString("base64url")}`;
}

export const CONFIRM_ERRORS = {
  unknown: "This confirm_token is unknown or expired (tokens last 10 minutes and work once). Run the tool again without confirm_token to get a fresh preview.",
  wrongTool: (owner: string, tool: string) => `This confirm_token belongs to "${owner}", not "${tool}".`,
  changed:
    "The planned operation changed since the preview (different arguments, or the matching records changed in GHL). Nothing was executed. Run the tool again without confirm_token to see the new preview.",
};

export class ConfirmStore implements ConfirmBackend {
  private entries = new Map<string, Entry>();
  constructor(private now: () => number = Date.now) {}

  issue(tool: string, plan: unknown): string {
    this.gc();
    const token = newConfirmToken();
    this.entries.set(token, { tool, hash: planHash(plan), expires: this.now() + CONFIRM_TTL_MS });
    return token;
  }

  /** Validate and consume a token. Throws with a user-facing reason if invalid. */
  redeem(tool: string, plan: unknown, token: string): void {
    this.gc();
    const entry = this.entries.get(token);
    if (!entry) throw new ConfirmError(CONFIRM_ERRORS.unknown);
    if (entry.tool !== tool) throw new ConfirmError(CONFIRM_ERRORS.wrongTool(entry.tool, tool));
    if (entry.hash !== planHash(plan)) {
      this.entries.delete(token);
      throw new ConfirmError(CONFIRM_ERRORS.changed);
    }
    this.entries.delete(token);
  }

  private gc() {
    const t = this.now();
    for (const [k, v] of this.entries) if (v.expires < t) this.entries.delete(k);
  }
}

export class ConfirmError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ConfirmError";
  }
}

export interface ConfirmableSpec<P> {
  tool: string;
  /** Fully-resolved description of what will happen; must be deterministic for the same state. */
  plan: P;
  /** Number of records/messages affected; compared with the confirmation threshold. */
  count: number;
  /** Human-readable preview shown to the user in phase 1. */
  preview: Record<string, unknown>;
  execute: (plan: P) => Promise<unknown>;
}

export interface ConfirmContext {
  store: ConfirmBackend;
  /** Confirmation is required when count >= threshold. 0 or 1 = always. */
  threshold: number;
}

export async function runConfirmable<P>(ctx: ConfirmContext, spec: ConfirmableSpec<P>, confirmToken?: string): Promise<unknown> {
  if (spec.count === 0) {
    return { status: "NOTHING_TO_DO", message: "No records matched, so nothing was changed.", ...spec.preview };
  }
  const threshold = Number.isFinite(ctx.threshold) && ctx.threshold >= 1 ? ctx.threshold : 1;
  const needsConfirm = spec.count >= threshold;
  if (needsConfirm && !confirmToken) {
    const token = await ctx.store.issue(spec.tool, spec.plan);
    return {
      status: "PREVIEW_ONLY — NOTHING HAS BEEN EXECUTED",
      affected_count: spec.count,
      ...spec.preview,
      confirm_token: token,
      next_step: `Show this preview to the user and ask for explicit approval. Only if they approve, call ${spec.tool} again with the SAME arguments plus confirm_token="${token}". The token expires in 10 minutes.`,
    };
  }
  if (needsConfirm && confirmToken) await ctx.store.redeem(spec.tool, spec.plan, confirmToken);
  const result = await spec.execute(spec.plan);
  return { status: "EXECUTED", affected_count: spec.count, result };
}
