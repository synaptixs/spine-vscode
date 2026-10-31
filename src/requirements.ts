/**
 * Plan from requirement (SSPN-246): a workspace Markdown file, or a pasted ticket or URL, becomes a
 * build document opened in the plan review (D75). Spine derives the spec through its own intake, as
 * `orchestrator sdlc plan --source` does (3.68.0, D102), so a requirement planned here and in a
 * terminal renders the same plan. This module never imports `vscode`; src/plan-from-requirement.ts
 * draws it and hands it `RequirementPrompts`, so the unit tests drive the same flow.
 *
 * - `extract: false` is asked first: it says whether the spec is cached, spending nothing (D105).
 *   A cached spec plans for $0 with no confirm; deriving one is confirmed first, and the spend is
 *   shown after.
 * - A source holding several intents asks which one (D106). Deriving caches every intent, so the
 *   chosen one is then planned from the cache, with no second spend.
 * - A cached spec is never re-derived here (D107): that is `--refresh` in a terminal.
 * - The local server only (D109), and Restricted Mode calls nothing (D12).
 */
import * as path from "node:path";
import type { SpineCalls } from "./calls";
import { RestrictedWorkspaceError } from "./client";

export const SPEND_ACTION = "Derive and plan";

/** Deriving a spec waits on Spine's intake model, and rendering the plan on its graph of the checkout. */
export const PLAN_TIMEOUT_MS = 15 * 60_000;

export interface Intent {
  id: string;
  title: string;
}

export interface RequirementPrompts {
  confirmSpend(message: string, action: string): Promise<boolean>;
  /** The chosen intent's id; `undefined` when the person cancelled. */
  pickIntent(source: string, intents: Intent[]): Promise<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
}

export interface Planned {
  intentId: string;
  spentUsd: number;
  cached: boolean;
  estimated: boolean;
}

export interface RequirementPlannerOptions {
  calls: () => SpineCalls;
  repo: () => string | undefined;
  isTrusted: () => boolean;
  /** Why this window cannot plan from a requirement (server, level), or `undefined`. */
  blocker: () => string | undefined;
  /** Open the plan in the review (`spine.openPlan`). */
  open: (intentId: string) => Promise<void>;
}

/**
 * Why this window cannot plan from a requirement, or `undefined`. Deriving a spec spends the
 * checkout's own key, so on this machine only (D109); `sdlc_plan` is served from level `plan`.
 */
export function requirementBlocker(server: string, level: string): string | undefined {
  if (server !== "local") return `Plan from requirement runs on this machine only, and spine.server names ${server}: set spine.server to local`;
  if (level === "pkg") return "set spine.level to plan or build (it is pkg): planning is not served at pkg";
  return undefined;
}

/** A workspace file, as Spine reads it: `file://` and the absolute path, kept verbatim. */
export function sourceForFile(absPath: string): string {
  // Spine resolves a relative `file://` path from its own working directory, not the workspace's.
  if (!path.isAbsolute(absPath)) throw new Error(`a requirement file needs an absolute path, not ${absPath}`);
  return `file://${absPath}`;
}

/** A pasted ticket or URL, passed as typed: Spine says which sources it reads. */
export function sourceTyped(text: string): string {
  const source = text.trim();
  if (!source) throw new Error("give a URL or ticket (jira://…, confluence://…, notion://… or file://…)");
  return source;
}

export function spendText(source: string, checkout: string): string {
  return (
    `Spine derives the spec of ${source} with its intake model, on the key in ${path.join(checkout, ".env")}: ` +
    "this spends tokens. A spec derived once is reused for $0 until the source changes."
  );
}

function intentsOf(out: Record<string, unknown>): Intent[] {
  return Array.isArray(out.intents) ? (out.intents as Intent[]) : [];
}

function spendLine(spent: number, cached: boolean, estimated: boolean): string {
  if (cached) return "spent $0 (its spec was cached)";
  return `spent $${spent.toFixed(4)}${estimated ? " (estimated)" : ""}`;
}

export class RequirementPlanner {
  constructor(private readonly options: RequirementPlannerOptions) {}

  /** Plan `source` and open it for review; `undefined` when the person stopped before a plan. */
  async plan(source: string, prompts: RequirementPrompts): Promise<Planned | undefined> {
    if (!this.options.isTrusted()) throw new RestrictedWorkspaceError();
    const blocked = this.options.blocker();
    if (blocked) throw new Error(blocked);
    const repo = this.options.repo();
    if (!repo) throw new Error("open a folder first: a plan is written into its checkout");
    const calls = this.options.calls();
    const plan = (intentId?: string) =>
      calls.call("sdlc_plan", { repo_path: repo, source, ...(intentId ? { intent_id: intentId } : {}) }, { timeoutMs: PLAN_TIMEOUT_MS });

    const state = await calls.call("sdlc_plan", { repo_path: repo, source, extract: false });
    const cached = state.cached === true;
    let intentId: string | undefined;
    if (cached && intentsOf(state).length > 1) {
      intentId = await prompts.pickIntent(source, intentsOf(state));
      if (!intentId) return undefined;
    }
    if (!cached && !(await prompts.confirmSpend(spendText(source, repo), SPEND_ACTION))) return undefined;

    let out = await plan(intentId);
    let spent = Number(out.spent_usd ?? 0);
    let estimated = out.spent_estimated === true;
    if (typeof out.document !== "string" && intentsOf(out).length) {
      intentId = await prompts.pickIntent(source, intentsOf(out));
      if (!intentId) {
        prompts.info(`Spine: ${source} holds ${intentsOf(out).length} intents and none was chosen. Its spec is cached: planning it again spends nothing.`);
        return undefined;
      }
      for (const w of (out.warnings as string[] | undefined) ?? []) prompts.warn(`Spine: ${w}`);
      out = await plan(intentId);
      spent += Number(out.spent_usd ?? 0);
      estimated ||= out.spent_estimated === true;
    }
    const planned = String(out.intent_id ?? "");
    if (!planned) throw new Error(`Spine planned nothing from ${source}`);
    for (const w of (out.warnings as string[] | undefined) ?? []) prompts.warn(`Spine: ${w}`);
    prompts.info(`Spine planned ${planned} from ${source}: ${spendLine(spent, cached, estimated)}.`);
    await this.options.open(planned);
    return { intentId: planned, spentUsd: spent, cached, estimated };
  }
}
