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
}

export interface Listed {
  intent_id: string;
  state: string;
  decided_by: string;
}

export interface Prompts {
  confirm(message: string, action: string): Promise<boolean>;
  /** A rejection's note; `undefined` when the person cancelled. */
  note(intentId: string): Promise<string | undefined>;
  info(message: string): void;
  warn(message: string): void;
}

export interface PlanReviewOptions {
  calls: () => SpineCalls;
  repo: () => string | undefined;
  isTrusted: () => boolean;
  approverName: () => Promise<string>;
}

export const NOT_A_GATE = "a signed record, not a gate on the build";
const NO_DIGEST = "Spine gave no digest for this plan, so a decision would bind to nothing: update Spine";
const NO_GIT_NAME = "set your name with `git config user.name`: a local approval is recorded under it";

export class PlanReview {
  constructor(private readonly options: PlanReviewOptions) {}

  async list(): Promise<{ plans: Listed[]; count: number; truncated: boolean }> {
    const calls = this.options.calls();
    const repo = this.guard(calls);
    const out = await calls.call("sdlc_plan_document", { repo_path: repo });
    return { plans: (out.plans as Listed[] | undefined) ?? [], count: Number(out.count ?? 0), truncated: out.truncated === true };
  }

  async open(intentId: string): Promise<PlanView> {
    const calls = this.options.calls();
    const repo = this.guard(calls);
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
    };
  }

  /** Decide on exactly the plan in `view`; returns the plan as it now stands. */
  async decide(view: PlanView, decision: { reject: boolean; note?: string }): Promise<PlanView> {
    const calls = this.options.calls();
    const repo = this.guard(calls);
    // Spine skips the check on an empty `expected_digest`: deciding then would bind nothing.
    if (!view.digest) throw new Error(NO_DIGEST);
    if (!view.canDecide) throw new Error(view.reason || `you cannot decide on ${view.intentId}`);
    const note = (decision.note ?? "").trim();
    if (decision.reject && !note) throw new Error("a rejection needs a note saying why");
    if (calls.server !== view.server) {
      throw new Error(`${view.intentId} was opened on ${view.server}, and Spine is now ${calls.server}: open it again`);
    }
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

  /** The Approve button: confirm who is approving, then decide. `undefined` when nothing was recorded. */
  async approve(view: PlanView, prompts: Prompts): Promise<PlanView | undefined> {
    if (!view.canDecide) return void prompts.warn(`Spine: you cannot approve ${view.intentId}: ${view.reason}`);
    const message = view.remote
      ? `Approve ${view.intentId} on ${view.server}? The server records who approves: with a company sign-in, that is you. This is ${NOT_A_GATE}.`
      : `Approve ${view.intentId}, approving as ${view.approver}?`;
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

  private guard(calls: SpineCalls): string {
    if (!this.options.isTrusted()) throw new RestrictedWorkspaceError();
    const repo = this.options.repo();
    if (repo) return repo;
    // A shared server reads only the checkouts its admin listed, by their path on the server.
    throw new Error(
      calls.remote ? `set spine.serverRepo to this repository's path on ${calls.server}` : "open a folder to review its plans",
    );
  }
}

const short = (digest: string) => digest.slice(0, 8);

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
