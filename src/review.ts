/**
 * Plan review (SSPN-243): read a build document as Spine holds it, then approve or reject that
 * exact text. This module never imports `vscode`; src/plans.ts draws it in the editor and hands
 * it `Prompts`, so the unit tests drive the same decisions.
 *
 * - Every decision sends `expected_digest`, the digest of the document that was shown, so Spine
 *   refuses a plan that changed since it was read (D23) and nothing is recorded.
 * - `can_approve` and `reason` come from Spine (D25, D37); they are advice for the buttons, and
 *   Spine's own scope check stays the enforcement.
 * - Locally the approver is `git config user.name`, the name Spine itself would record; it is
 *   confirmed before the call and passed as `decided_by`, so what was confirmed is what is
 *   recorded (D43). Remotely nothing is passed: the sign-in names the approver (B114).
 * - A remote approval is a signed record of a decision, not a gate on the build (D33).
 * - Restricted Mode calls nothing, over either transport (D12).
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { PlanMovedError, type SpineCalls } from "./calls";
import { RestrictedWorkspaceError } from "./client";

export interface Decision {
  decision: string;
  decided_by: string;
  decided_at: string;
  note: string;
  digest: string;
}

export interface PlanView {
  intentId: string;
  document: string;
  digest: string;
  /** `none`, `approved`, `rejected`, or `stale` when it changed after the decision. */
  state: string;
  approval: Decision | null;
  canDecide: boolean;
  reason: string;
  server: string;
  remote: boolean;
  /** Locally, who the record will name; empty on a remote server. */
  approver: string;
  /** The checkout (or, remotely, the server's path) the plan was read from (B178). */
  repo: string;
  /** The commit the plan was derived at, and the checkout's now (Spine 3.71, B182); "" from an older Spine. */
  derivedAt: string;
  derivedNow: string;
  /** `false` when they differ or the tree is dirty: the build would refuse this approval. Unknown from an older Spine. */
  fresh?: boolean;
}

export interface Listed {
  intent_id: string;
  state: string;
  decided_by: string;
}

export interface Prompts {
  confirm(message: string, action: string): Promise<boolean>;
  /** One of `actions`, or `undefined` when the person dismissed it. */
  choose(message: string, actions: string[]): Promise<string | undefined>;
  /** A rejection's note; `undefined` when the person cancelled. */
  note(intentId: string): Promise<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
}

export interface PlanReviewOptions {
  /**
   * The Spine to call. Locally, `repo` names the folder whose own Spine process answers: Spine reads
   * its start folder's `.env`, so a call about one folder must reach that folder's process (B178).
   */
  calls: (repo?: string) => SpineCalls;
  repo: () => string | undefined;
  isTrusted: () => boolean;
  approverName: () => Promise<string>;
  /** Reads a kept spec (B182's Re-plan); the file system unless a test gives its own. */
  readFile?: (file: string) => string;
}

export const APPROVE_ANYWAY = "Approve anyway";
export const BUILD_ANYWAY = "Build anyway";
export const REPLAN = "Re-plan ($0)";

export const NOT_A_GATE = "a signed record, not a gate on the build";
const NO_DIGEST = "Spine gave no digest for this plan, so a decision would bind to nothing: update Spine";
const NO_GIT_NAME = "set your name with `git config user.name`: a local approval is recorded under it";

export class PlanReview {
  constructor(private readonly options: PlanReviewOptions) {}

  async list(): Promise<{ plans: Listed[]; count: number; truncated: boolean }> {
    const { calls, repo } = this.bound();
    const out = await calls.call("sdlc_plan_document", { repo_path: repo });
    return { plans: (out.plans as Listed[] | undefined) ?? [], count: Number(out.count ?? 0), truncated: out.truncated === true };
  }

  /** Read a plan from `at`, else from the folder in use. */
  async open(intentId: string, at?: string): Promise<PlanView> {
    const { calls, repo } = this.bound(at);
    const out = await calls.call("sdlc_plan_document", { repo_path: repo, intent_id: intentId });
    const digest = typeof out.digest === "string" ? out.digest : "";
    let canDecide = out.can_approve === true;
    let reason = typeof out.reason === "string" ? out.reason : "";
    if (canDecide && !digest) {
      canDecide = false;
      reason = NO_DIGEST;
    }
    let approver = "";
    if (!calls.remote) {
      approver = (await this.options.approverName()).trim();
      if (canDecide && !approver) {
        canDecide = false;
        reason = NO_GIT_NAME;
      }
    }
    return {
      intentId,
      document: String(out.document ?? ""),
      digest,
      state: String(out.state ?? "none"),
      approval: (out.approval as Decision | null | undefined) ?? null,
      canDecide,
      reason,
      server: calls.server,
      remote: calls.remote,
      approver,
      repo,
      derivedAt: typeof out.derived_at === "string" ? out.derived_at : "",
      derivedNow: typeof out.derived_now === "string" ? out.derived_now : "",
      ...(typeof out.fresh === "boolean" ? { fresh: out.fresh } : {}),
    };
  }

  /** Decide on exactly the plan in `view`; returns the plan as it now stands. */
  async decide(view: PlanView, decision: { reject: boolean; note?: string }): Promise<PlanView> {
    const { calls, repo } = this.assertHere(view);
    // Spine skips the check on an empty `expected_digest`: deciding then would bind nothing.
    if (!view.digest) throw new Error(NO_DIGEST);
    if (!view.canDecide) throw new Error(view.reason || `you cannot decide on ${view.intentId}`);
    const note = (decision.note ?? "").trim();
    if (decision.reject && !note) throw new Error("a rejection needs a note saying why");
    const answer = await calls.call("sdlc_approve", {
      repo_path: repo,
      intent_id: view.intentId,
      expected_digest: view.digest,
      decided_by: view.approver, // empty on a remote server, where the sign-in names the approver
      note,
      reject: decision.reject,
    });
    try {
      return await this.open(view.intentId);
    } catch (err) {
      const what = `${String(answer.decision ?? "the decision").toLowerCase()} for ${view.intentId}`;
      throw new Error(`${what} is recorded as ${String(answer.decided_by ?? "?")}, but Spine could not reopen the plan: ${(err as Error).message}`);
    }
  }

  /**
   * Re-plan from an edited spec (B180, D127): `sdlc_plan` with `spec` renders the document again,
   * deterministically, with no model and nothing spent. The build gate re-derives the plan from
   * that spec, so the spec, not the document, is what a person edits. The plan is then read again:
   * an approval of the old text reads stale.
   */
  async replan(intentId: string, spec: Record<string, unknown>, at: string): Promise<PlanView> {
    // `at` is the folder the spec file is in, not the folder in front: saving it while another
    // folder's file is in front must not plan into that folder (review of #14).
    const { calls, repo } = this.bound(at);
    if (calls.remote) throw new Error(`Edit spec works on the local server only: the spec of ${intentId} is a file in this checkout`);
    const named = typeof spec.intent_id === "string" ? spec.intent_id : intentId;
    if (named !== intentId) throw new Error(`the edited spec names intent ${named}, not ${intentId}: it would write another plan. Put the id back`);
    // A spec with no id is planned by Spine as `spec`: keep it this plan's.
    await calls.call("sdlc_plan", { repo_path: repo, spec: { ...spec, intent_id: intentId } });
    return this.open(intentId, repo);
  }

  /**
   * Throws unless `view` was read on the server and in the folder Spine now uses. A window with
   * several folders moves between checkouts (B178): a plan read in one must not be decided or built
   * in another, where the same id may name another plan or none.
   */
  assertHere(view: PlanView): { calls: SpineCalls; repo: string } {
    const { calls, repo } = this.bound();
    if (calls.server !== view.server) {
      throw new Error(`${view.intentId} was opened on ${view.server}, and Spine is now ${calls.server}: open it again`);
    }
    if (repo !== view.repo) throw new Error(`${view.intentId} was opened in ${view.repo}, and Spine now points at ${repo}: open it again`);
    return { calls, repo };
  }

  /** Re-plan from the spec Spine kept, unchanged: the plan at today's commit, for $0 (B182). */
  async replanFromKept(intentId: string, at: string): Promise<PlanView> {
    const { repo } = this.bound(at);
    const file = specFile(repo, intentId);
    let spec: Record<string, unknown>;
    try {
      spec = JSON.parse((this.options.readFile ?? ((f) => fs.readFileSync(f, "utf8")))(file)) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`cannot re-plan ${intentId} from ${file}: ${(err as Error).message}`);
    }
    return this.replan(intentId, spec, repo);
  }

  /**
   * `view` with its freshness asked of Spine again (B182): a commit since the plan was opened changes
   * no plan file, so nothing else would notice (review of #15). One read, nothing spent.
   */
  private async freshNow(view: PlanView): Promise<PlanView> {
    const again = await this.open(view.intentId, view.repo);
    const now: PlanView = { ...view, derivedAt: again.derivedAt, derivedNow: again.derivedNow };
    if (again.fresh === undefined) delete now.fresh;
    else now.fresh = again.fresh;
    return now;
  }

  /**
   * Before a build of an approved plan (B182): the build derives the plan again and parks at its gate
   * when the plan is from another commit. `replanned` is the plan to show when Re-plan was chosen.
   */
  async beforeBuild(view: PlanView, prompts: Prompts): Promise<{ build: boolean; replanned?: PlanView }> {
    const now = await this.freshNow(view);
    if (now.fresh !== false) return { build: true };
    const choice = await prompts.choose(staleMessage(now, "build"), canReplan(now) ? [BUILD_ANYWAY, REPLAN] : [BUILD_ANYWAY]);
    if (choice === BUILD_ANYWAY) return { build: true };
    if (choice === REPLAN) return { build: false, replanned: await this.replanFromKept(view.intentId, view.repo) };
    return { build: false };
  }

  /** The Approve button: confirm who is approving, then decide. `undefined` when nothing was recorded. */
  async approve(given: PlanView, prompts: Prompts): Promise<PlanView | undefined> {
    if (!given.canDecide) return void prompts.warn(`Spine: you cannot approve ${given.intentId}: ${given.reason}`);
    // B182: the build derives the plan again, and the commit stamp is part of what is approved.
    const view = given.fresh === undefined && !given.derivedNow ? given : await this.freshNow(given);
    if (view.fresh === false) {
      const actions = canReplan(view) ? [APPROVE_ANYWAY, REPLAN] : [APPROVE_ANYWAY];
      // The confirm it stands in for names who is approving; so does this one.
      const choice = await prompts.choose(`${staleMessage(view)} ${approvingAs(view)}`, actions);
      if (choice === REPLAN) {
        const after = await this.replanFromKept(view.intentId, view.repo);
        prompts.info(`Spine: re-planned ${view.intentId} at ${after.derivedNow || "the checkout's commit"}, for $0. Read it, then approve.`);
        return after;
      }
      if (choice !== APPROVE_ANYWAY) return undefined;
      return this.settle(view, { reject: false }, prompts, "Approved");
    }
    const message = view.remote ? `Approve ${view.intentId} on ${view.server}? ${approvingAs(view)}` : `Approve ${view.intentId}, approving as ${view.approver}?`;
    if (!(await prompts.confirm(message, "Approve"))) return undefined;
    return this.settle(view, { reject: false }, prompts, "Approved");
  }

  /** The Reject button: a note is required. */
  async reject(view: PlanView, prompts: Prompts): Promise<PlanView | undefined> {
    if (!view.canDecide) return void prompts.warn(`Spine: you cannot reject ${view.intentId}: ${view.reason}`);
    const note = await prompts.note(view.intentId);
    if (note === undefined) return undefined;
    return this.settle(view, { reject: true, note }, prompts, "Rejected");
  }

  private async settle(
    view: PlanView,
    decision: { reject: boolean; note?: string },
    prompts: Prompts,
    verb: string,
  ): Promise<PlanView | undefined> {
    try {
      const after = await this.decide(view, decision);
      const where = view.remote ? ` on ${view.server}: ${NOT_A_GATE}` : "";
      prompts.info(`${verb} ${view.intentId} at digest ${short(view.digest)}, recorded as ${after.approval?.decided_by || "?"}${where}.`);
      return after;
    } catch (err) {
      if (!(err instanceof PlanMovedError)) throw err;
      prompts.warn(`The plan ${view.intentId} changed since you opened it, so nothing was recorded. It is reopened: read it again, then decide.`);
      return this.open(view.intentId);
    }
  }

  /** The folder a call is about (`at`, else the one in use), and the Spine that answers for it. */
  private bound(at?: string): { calls: SpineCalls; repo: string } {
    const server = this.options.calls();
    const repo = this.guard(server, at);
    return { calls: server.remote ? server : this.options.calls(repo), repo };
  }

  private guard(calls: SpineCalls, at?: string): string {
    if (!this.options.isTrusted()) throw new RestrictedWorkspaceError();
    const repo = at ?? this.options.repo();
    if (repo) return repo;
    // A shared server reads only the checkouts its admin listed, by their path on the server.
    throw new Error(
      calls.remote ? `set spine.serverRepo to this repository's path on ${calls.server}` : "open a folder to review its plans",
    );
  }
}

const short = (digest: string) => digest.slice(0, 8);

/** Spine's own rule: a plan derived while the tree has uncommitted changes is never fresh. */
const dirty = (view: PlanView) => view.derivedNow.endsWith("-dirty");
/** Re-planning reads the local spec, and from a dirty tree it is stale again at once (review of #15). */
const canReplan = (view: PlanView) => !view.remote && !dirty(view);

function approvingAs(view: PlanView): string {
  return view.remote ? `The server records who approves: with a company sign-in, that is you. This is ${NOT_A_GATE}.` : `Locally you are approving as ${view.approver}.`;
}

/** The warning before approving or building a plan from another commit or a dirty tree (B182). */
export function staleMessage(view: PlanView, purpose: "approve" | "build" = "approve"): string {
  const head = `${view.intentId} was derived at ${view.derivedAt || "an unknown commit"}, and the checkout is now at ${view.derivedNow || "an unknown commit"}. `;
  const gate =
    purpose === "build"
      ? "The build derives the plan again, so a build now would park at the plan gate. "
      : "The build derives the plan again, so the build will refuse this approval and park. ";
  if (dirty(view) && view.derivedAt === view.derivedNow) {
    // Equal stamps pass the build gate; the plan is still not what a build of the commit would do.
    return `${head}The checkout has uncommitted changes: a build uses only committed code, so this plan does not describe what would be built. Commit or stash them, then re-plan.`;
  }
  if (view.remote) return `${head}${gate}Plan it again on the server first.`;
  if (dirty(view)) return `${head}${gate}The checkout also has uncommitted changes: commit or stash them, then re-plan.`;
  return purpose === "build"
    ? `${head}${gate}Re-plan it for $0 (no model); its approval no longer holds after that, and you read and approve it again before building.`
    : `${head}${gate}Re-plan it for $0 (no model) and read it again, or approve it anyway.`;
}

/** The status line for an open plan: state, approver, short digest; the tooltip says where and who. */
export function statusText(view: PlanView): { text: string; tooltip: string } {
  const by = view.approval?.decided_by ?? "";
  const states: Record<string, [string, string]> = {
    none: ["circle-outline", "not decided"],
    approved: ["pass", `approved by ${by}`],
    rejected: ["error", `rejected by ${by}`],
    stale: ["warning", `changed since it was ${view.approval?.decision.toLowerCase() ?? "decided"} by ${by}`],
  };
  const [icon, said] = states[view.state] ?? ["question", view.state];
  const lines = [
    view.remote ? `Server: ${view.server}, signed in through VS Code` : "Server: local",
    view.remote
      ? `A decision here is ${NOT_A_GATE}.`
      : `Locally you are approving as ${view.approver || "nobody: set git config user.name"}.`,
  ];
  if (!view.remote) lines.push(`File: ${planFile(view.repo, view.intentId)} (read-only here: change it with Edit spec…)`);
  if (view.fresh === false) lines.push(`Derived at ${view.derivedAt}; the checkout is now at ${view.derivedNow}: re-plan before approving.`);
  if (view.approval) lines.push(`Decided ${view.approval.decided_at} on digest ${short(view.approval.digest)}.`);
  if (!view.canDecide) lines.push(`You cannot decide: ${view.reason}`);
  return { text: `$(${icon}) Spine plan ${view.intentId}: ${said} · ${short(view.digest)}`, tooltip: lines.join("\n") };
}

/** `git config user.name` in the folder: the name Spine records for a local approval. */
export function gitUserName(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", ["config", "user.name"], { cwd, timeout: 10_000 }, (err, stdout) => resolve(err ? "" : stdout.trim()));
  });
}

/**
 * The `spine-plan:` document's path: the name Spine gives the plan's file, `<id>-build.md` (B180).
 * It is a read-only view of what Spine holds, so a decision binds to the text shown (D27, D28).
 */
export const planPath = (intentId: string) => `/${intentId}-build.md`;
export const idOfPlanPath = (docPath: string) => docPath.replace(/^\//, "").replace(/-build\.md$/, "");

/** Where Spine keeps a plan's spec: `.spine/plans/<id>-spec.json`, beside the plan (`builddoc.spec_path`). */
export const specFile = (repo: string, intentId: string) => path.join(repo, ".spine", "plans", `${intentId}-spec.json`);
/** Where Spine keeps the plan itself: `.spine/plans/<id>-build.md` (`builddoc.plan_file`). */
export const planFile = (repo: string, intentId: string) => path.join(repo, ".spine", "plans", `${intentId}-build.md`);

/** The intent whose spec `file` is, when it is one directly under `repo`'s `.spine/plans`. */
export function intentOfSpecFile(file: string, repo: string): string | undefined {
  const rel = path.relative(path.join(repo, ".spine", "plans"), file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) return undefined;
  return rel.endsWith("-spec.json") ? rel.slice(0, -"-spec.json".length) || undefined : undefined;
}
