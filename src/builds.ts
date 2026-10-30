/**
 * Builds from the editor (SSPN-244): start a build of an approved plan, watch this checkout's runs,
 * and answer what a parked run waits on, over Spine's `sdlc_build`, `sdlc_builds` and
 * `sdlc_build_decide` (3.67.1). This module never imports `vscode`; src/runs.ts draws it, so the
 * unit tests drive the same decisions.
 *
 * - A build is always safe and detached: Spine commits on a branch in its own worktree, never in
 *   the checkout, and pushes nothing (D67, D84).
 * - A review park is shown, never decided here: that belongs to the diff review (D89, SSPN-245).
 * - Budget and "build anyway?" parks are decided with a note under the git name, the name Spine
 *   itself would record locally (D74, as P2's D43). A budget park resumes only after the person
 *   raised the cap in the checkout's `.env`; the extension never reads or writes `.env` (D91).
 * - Runs started from a terminal are read-only (D90): Spine 3.67.1 marks them `from_editor: false`
 *   (D95). A server that leaves the field out is treated as the editor's, so Resume is offered and
 *   Spine's own refusal is shown.
 * - Builds run on this machine only (D21); Restricted Mode calls nothing (D12).
 */
import type { SpineCalls } from "./calls";
import { RestrictedWorkspaceError } from "./client";

/** A row of `sdlc_builds`. */
export interface RunRow {
  run_id: string;
  intent_id: string;
  status: string;
  phase: string;
  alive: boolean;
  spent_usd: number;
  started_at: number;
  heartbeat_at: number;
  branch: string;
  worktree: string;
  parked_reason: string;
  approval_id: string;
  /** `false` marks a run started from a terminal (Spine 3.67.1, D95); older servers leave it out. */
  from_editor?: boolean;
}

/** `waiting_on` of one run in `sdlc_builds`: the approval it is parked on. */
export interface Waiting {
  approval_id: string;
  kind: string;
  title: string;
  reason: string;
  digest: string;
  raised_at: number;
}

export interface RunView {
  row: RunRow;
  waiting: Waiting | null;
}

export interface Stage {
  stage: string;
  status: string;
  detail: string;
  at: number;
}

export type RunAction = "cancel" | "resume" | "approve" | "drop" | "raiseCapAndResume" | "openWorktree" | "openPlan";

export interface BuildPrompts {
  confirm(message: string, action: string): Promise<boolean>;
  /** A note for a decision; `undefined` when the person cancelled. */
  note(title: string, required: boolean): Promise<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
}

export interface BuildRunsOptions {
  calls: () => SpineCalls;
  repo: () => string | undefined;
  isTrusted: () => boolean;
  deciderName: () => Promise<string>;
}

const REVIEW = "review";
const BUDGET = "budget";
const OWN_TESTS = "own_tests";
const NO_GIT_NAME = "set your name with `git config user.name`: a local decision is recorded under it";

const readOnly = (row: RunRow) => row.from_editor === false;

/** What a run offers, in menu order. Discard is not among them: Spine has no tool for it (D86). */
export function actionsFor(view: RunView): RunAction[] {
  const { row, waiting } = view;
  const out: RunAction[] = [];
  if (!readOnly(row)) {
    if (row.alive) out.push("cancel");
    else if (waiting?.kind === BUDGET) out.push("raiseCapAndResume", "drop");
    // Its process is gone, so approving would build again from scratch: only dropping it is offered.
    else if (waiting?.kind === REVIEW) out.push("drop");
    else if (waiting && waiting.kind !== OWN_TESTS) out.push("approve", "drop");
    else if (!waiting && ["running", "parked", "failed"].includes(row.status)) out.push("resume");
  }
  if (row.worktree) out.push("openWorktree");
  if (row.intent_id) out.push("openPlan");
  return out;
}

function stateOf(view: RunView): { said: string; icon: string } {
  const { row, waiting } = view;
  if (row.status === "running" && row.alive) return { said: `building · ${row.phase}`, icon: "sync~spin" };
  if (row.status === "running" || (row.status === "parked" && !row.alive && waiting?.kind === REVIEW)) {
    return { said: "process gone", icon: "warning" };
  }
  if (row.status === "parked") {
    if (waiting?.kind === REVIEW) return { said: "waiting for your review", icon: "eye" };
    if (waiting?.kind === BUDGET) return { said: "budget spent: raise the cap to resume", icon: "credit-card" };
    if (waiting) return { said: `waiting: ${waiting.title}`, icon: "question" };
    return { said: `parked: ${row.parked_reason || "resume to carry on"}`, icon: "debug-pause" };
  }
  const icons: Record<string, string> = { done: "pass", failed: "error", abandoned: "circle-slash" };
  return { said: row.status, icon: icons[row.status] ?? "circle-outline" };
}

/** The tree row: the plan's id, its state, the stage and what it spent. */
export function runText(view: RunView): { label: string; description: string; tooltip: string; icon: string } {
  const { row, waiting } = view;
  const { said, icon } = stateOf(view);
  const lines = [`Run ${row.run_id}`, `Stage: ${row.phase || "?"}`, `Spent: $${row.spent_usd.toFixed(2)}`];
  if (row.branch) lines.push(`Branch: ${row.branch}`);
  if (row.worktree) lines.push(`Worktree: ${row.worktree}`);
  if (waiting) lines.push(`Waiting on ${waiting.approval_id} (${waiting.kind}): ${waiting.reason}`);
  else if (row.parked_reason) lines.push(row.parked_reason);
  if (readOnly(row)) lines.push(`Started from a terminal: use \`orchestrator sdlc runs show ${row.run_id}\` there.`);
  return { label: row.intent_id || row.run_id, description: `${said} · $${row.spent_usd.toFixed(2)}`, tooltip: lines.join("\n"), icon };
}

/** D92: poll only while someone can see the runs and one of them is still alive. */
export function shouldPoll(views: RunView[], visible: boolean): boolean {
  return visible && views.some((v) => v.row.alive);
}

/** The confirm before a build starts (D72, D88). */
export function startMessage(intentId: string, branch: string, sha: string, repo: string): string {
  return (
    `Build ${intentId} from the last commit of ${branch} (${sha.slice(0, 8)}). Uncommitted changes are not included. ` +
    `Safe: the change is committed on a local branch in Spine's own worktree, and nothing is pushed. ` +
    `It spends model tokens: the key and the budget (SDLC_RUN_BUDGET_USD) come from ${repo}/.env.`
  );
}

export class BuildRuns {
  /** What each parked run waits on, by approval id: a poll does not fetch a review's diff again. */
  private readonly waits = new Map<string, Waiting | null>();

  constructor(private readonly options: BuildRunsOptions) {}

  async list(opts: { poll?: boolean } = {}): Promise<{ views: RunView[]; count: number; truncated: boolean; notShown: number }> {
    const { calls, repo } = this.guard();
    if (!opts.poll) this.waits.clear();
    const out = await calls.call("sdlc_builds", { repo_path: repo });
    const rows = (out.runs as RunRow[] | undefined) ?? [];
    const views = await Promise.all(rows.map(async (row) => ({ row, waiting: await this.waitingOf(calls, repo, row) })));
    return { views, count: Number(out.count ?? rows.length), truncated: out.truncated === true, notShown: Number(out.not_shown ?? 0) };
  }

  async stages(runId: string): Promise<Stage[]> {
    const { calls, repo } = this.guard();
    const out = await calls.call("sdlc_builds", { repo_path: repo, run_id: runId });
    return (out.stages as Stage[] | undefined) ?? [];
  }

  async start(intentId: string): Promise<{ runId: string }> {
    const { calls, repo } = this.guard();
    const out = await calls.call("sdlc_build", { repo_path: repo, action: "start", intent_id: intentId });
    return { runId: String(out.run_id) };
  }

  async resume(view: RunView, prompts: BuildPrompts): Promise<boolean> {
    const { calls, repo } = this.guard();
    const ok = await prompts.confirm(`Resume ${view.row.intent_id || view.row.run_id}? It carries on building and spends model tokens.`, "Resume");
    if (!ok) return false;
    await calls.call("sdlc_build", { repo_path: repo, action: "resume", run_id: view.row.run_id });
    return true;
  }

  async cancel(view: RunView, prompts: BuildPrompts): Promise<boolean> {
    const { calls, repo } = this.guard();
    const ok = await prompts.confirm(
      `Cancel ${view.row.intent_id || view.row.run_id}? Its process ends; its branch and worktree stay.`,
      "Cancel build",
    );
    if (!ok) return false;
    await calls.call("sdlc_build", { repo_path: repo, action: "cancel", run_id: view.row.run_id });
    return true;
  }

  /** Approve a "build anyway?" park; the run then needs Resume. */
  async approve(view: RunView, prompts: BuildPrompts): Promise<boolean> {
    const waiting = this.decidable(view);
    if (waiting.kind === BUDGET) throw new Error("a budget park resumes with Raise cap and resume");
    const name = await this.name(prompts);
    if (!name) return false;
    const note = await prompts.note(`Approve "${waiting.title}" for ${view.row.intent_id}, as ${name}`, false);
    if (note === undefined) return false;
    await this.decide(view, waiting, true, note.trim(), name);
    prompts.info(`Approved ${waiting.approval_id} as ${name}. Resume the run to carry on.`);
    return true;
  }

  /** Reject what the run waits on: it does not build on. A note is required. */
  async drop(view: RunView, prompts: BuildPrompts): Promise<boolean> {
    const waiting = this.decidable(view, true);
    const name = await this.name(prompts);
    if (!name) return false;
    const note = (await prompts.note(`Drop ${view.row.intent_id || view.row.run_id}, as ${name}: why?`, true))?.trim();
    if (!note) return false;
    await this.decide(view, waiting, false, note, name);
    prompts.info(`Dropped ${view.row.intent_id || view.row.run_id} as ${name}; its branch and worktree stay.`);
    return true;
  }

  /** D91: the person raises the cap in `.env`; then the park is approved, and only then resumed. */
  async raiseCapAndResume(view: RunView, prompts: BuildPrompts): Promise<boolean> {
    const waiting = this.decidable(view);
    if (waiting.kind !== BUDGET) throw new Error(`${waiting.approval_id} is not a budget park`);
    const { calls, repo } = this.guard();
    const name = await this.name(prompts);
    if (!name) return false;
    const ok = await prompts.confirm(
      `${view.row.intent_id} spent $${view.row.spent_usd.toFixed(2)} and stopped at its cap. Raise SDLC_RUN_BUDGET_USD in ` +
        `${repo}/.env first: the resumed build reads it when it starts, and an unchanged cap stops it again at its next model call. ` +
        `Approve as ${name} and resume?`,
      "Resume",
    );
    if (!ok) return false;
    await this.decide(view, waiting, true, "cap raised", name);
    try {
      await calls.call("sdlc_build", { repo_path: repo, action: "resume", run_id: view.row.run_id });
    } catch (err) {
      throw new Error(`the budget park is approved as ${name}, but the run did not resume: ${(err as Error).message}`);
    }
    return true;
  }

  private async waitingOf(calls: SpineCalls, repo: string, row: RunRow): Promise<Waiting | null> {
    if (row.status !== "parked" || !row.approval_id) return null;
    if (this.waits.has(row.approval_id)) return this.waits.get(row.approval_id) ?? null;
    const out = await calls.call("sdlc_builds", { repo_path: repo, run_id: row.run_id });
    const waiting = (out.waiting_on as Waiting | null | undefined) ?? null;
    this.waits.set(row.approval_id, waiting);
    return waiting;
  }

  private decidable(view: RunView, dropping = false): Waiting {
    const { row, waiting } = view;
    if (readOnly(row)) throw new Error(`${row.run_id} was started from a terminal: decide it there (sdlc runs)`);
    if (!waiting) throw new Error(`${row.intent_id || row.run_id} is not waiting on a decision`);
    if (waiting.kind === OWN_TESTS) throw new Error(`answer it in the terminal: orchestrator sdlc runs approve ${waiting.approval_id} --choice …`);
    // A live review is decided in the diff review, on the diff that was read (D89, SSPN-245).
    if (waiting.kind === REVIEW && (row.alive || !dropping)) throw new Error("a review is decided in the diff review, not here");
    return waiting;
  }

  private async decide(view: RunView, waiting: Waiting, approve: boolean, note: string, name: string): Promise<void> {
    const { calls, repo } = this.guard();
    await calls.call("sdlc_build_decide", {
      repo_path: repo,
      run_id: view.row.run_id,
      approval_id: waiting.approval_id,
      approve,
      expected_digest: waiting.digest,
      note,
      decided_by: name,
    });
    this.waits.delete(waiting.approval_id);
  }

  private async name(prompts: BuildPrompts): Promise<string> {
    const name = (await this.options.deciderName()).trim();
    if (!name) prompts.warn(`Spine: ${NO_GIT_NAME}`);
    return name;
  }

  private guard(): { calls: SpineCalls; repo: string } {
    if (!this.options.isTrusted()) throw new RestrictedWorkspaceError();
    const calls = this.options.calls();
    if (calls.remote) throw new Error(`builds run on this machine only, not on ${calls.server}: set spine.server to local`);
    const repo = this.options.repo();
    if (!repo) throw new Error("open a folder to build its plans");
    return { calls, repo };
  }
}
