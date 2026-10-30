import * as assert from "node:assert/strict";
import { checked, PlanMovedError, type SpineCalls } from "../../src/calls";
import { RestrictedWorkspaceError } from "../../src/client";
import {
  actionsFor,
  BuildRuns,
  type BuildPrompts,
  type GitRun,
  reviewsToAnnounce,
  type RunRow,
  type RunView,
  runText,
  shouldPoll,
  shouldWatch,
  startMessage,
  type Waiting,
} from "../../src/builds";

const REPO = "/work/shop";
const NAME = "Ada Lovelace";

function row(over: Partial<RunRow> = {}): RunRow {
  return {
    run_id: "r1",
    intent_id: "INT-7",
    status: "running",
    phase: "implement",
    alive: true,
    spent_usd: 0.42,
    started_at: 1_700_000_000,
    heartbeat_at: 1_700_000_100,
    branch: "",
    worktree: "",
    parked_reason: "",
    approval_id: "",
    ...over,
  };
}

function waiting(kind: string, over: Partial<Waiting> = {}): Waiting {
  return { approval_id: "a1", kind, title: `${kind} title`, reason: `${kind} reason`, digest: kind === "budget" ? "" : "d".repeat(16), raised_at: 1, ...over };
}

const view = (r: Partial<RunRow> = {}, w: Waiting | null = null): RunView => ({ row: row(r), waiting: w });

describe("which actions a run offers (D86, D89–D91)", () => {
  it("a live build offers Cancel, never a decision", () => {
    assert.deepEqual(actionsFor(view({ worktree: "/wt" })), ["cancel", "openWorktree", "openPlan"]);
  });

  it("a live review park offers Review first, then Cancel (SSPN-245)", () => {
    const v = view({ status: "parked", alive: true, approval_id: "a1", worktree: "/wt" }, waiting("review"));
    assert.deepEqual(actionsFor(v), ["review", "cancel", "openWorktree", "openPlan"]);
  });

  it("a review park started from a terminal is not reviewed here (D90)", () => {
    const v = view({ status: "parked", alive: true, approval_id: "a1", from_editor: false, worktree: "/wt" }, waiting("review"));
    assert.deepEqual(actionsFor(v), ["openWorktree", "openPlan"]);
  });

  it("a finished editor build with a branch offers Fetch into my checkout (D99)", () => {
    const v = view({ status: "done", alive: false, branch: "feat/INT-7/tax", worktree: "/wt" });
    assert.deepEqual(actionsFor(v), ["fetch", "openWorktree", "openPlan"]);
    assert.deepEqual(actionsFor(view({ status: "done", alive: false, branch: "feat/INT-7/tax", worktree: "/wt", from_editor: false })), ["openWorktree", "openPlan"]);
    assert.deepEqual(actionsFor(view({ status: "abandoned", alive: false, branch: "feat/INT-7/tax", worktree: "/wt" })), ["openWorktree", "openPlan"]);
  });

  it("a budget park offers Raise cap and resume, and Drop", () => {
    const v = view({ status: "parked", alive: false, approval_id: "a1" }, waiting("budget"));
    assert.deepEqual(actionsFor(v), ["raiseCapAndResume", "drop", "openPlan"]);
  });

  it("a 'build anyway?' park offers Approve and Drop", () => {
    for (const kind of ["verdict", "design"]) {
      const v = view({ status: "parked", alive: false, approval_id: "a1" }, waiting(kind));
      assert.deepEqual(actionsFor(v), ["approve", "drop", "openPlan"], kind);
    }
  });

  it("an own-test question is answered only in the terminal", () => {
    const v = view({ status: "parked", alive: false, approval_id: "a1" }, waiting("own_tests"));
    assert.deepEqual(actionsFor(v), ["openPlan"]);
  });

  it("a review park whose process is gone can be dropped, not approved", () => {
    const v = view({ status: "parked", alive: false, approval_id: "a1" }, waiting("review"));
    assert.deepEqual(actionsFor(v), ["drop", "openPlan"]);
  });

  it("a plan-gate park, or one already decided, offers Resume and Open plan", () => {
    assert.deepEqual(actionsFor(view({ status: "parked", alive: false, parked_reason: "plan not approved" })), ["resume", "openPlan"]);
  });

  it("a run whose process is gone offers Resume (D78)", () => {
    assert.deepEqual(actionsFor(view({ status: "running", alive: false })), ["resume", "openPlan"]);
    assert.deepEqual(actionsFor(view({ status: "failed", alive: false })), ["resume", "openPlan"]);
  });

  it("a finished, abandoned or rejected run offers nothing that runs", () => {
    for (const status of ["done", "abandoned"]) {
      // No branch: nothing to fetch.
      assert.deepEqual(actionsFor(view({ status, alive: false, worktree: "/wt" })), ["openWorktree", "openPlan"], status);
    }
  });

  it("a run started from a terminal is read-only (D90)", () => {
    const v = view({ status: "parked", alive: false, approval_id: "a1", from_editor: false, worktree: "/wt" }, waiting("budget"));
    assert.deepEqual(actionsFor(v), ["openWorktree", "openPlan"]);
    assert.deepEqual(actionsFor(view({ alive: true, from_editor: false })), ["openPlan"]);
  });

  it("never offers Discard (D86)", () => {
    const all = [view(), view({ status: "done", alive: false, worktree: "/wt" }), view({ status: "abandoned", alive: false, worktree: "/wt" })];
    for (const v of all) assert.equal((actionsFor(v) as string[]).includes("discard"), false);
  });
});

describe("what a run says", () => {
  it("names the state a person has to act on", () => {
    assert.match(runText(view({ status: "parked", alive: true }, waiting("review"))).description, /waiting for your review/);
    assert.match(runText(view({ status: "parked", alive: false }, waiting("budget"))).description, /budget/);
    assert.match(runText(view({ status: "running", alive: false })).description, /process gone/);
    assert.match(runText(view({ status: "parked", alive: false }, waiting("review"))).description, /process gone/);
    assert.match(runText(view({ status: "parked", alive: false, from_editor: false })).tooltip, /sdlc runs/);
  });

  it("shows the spend and the stage", () => {
    const t = runText(view({ phase: "implement", spent_usd: 1.5 }));
    assert.equal(t.label, "INT-7");
    assert.match(t.description, /implement/);
    assert.match(t.description, /\$1\.50/);
  });
});

describe("refresh (D92)", () => {
  it("polls only while the view is visible and a run is alive", () => {
    const live = view({ alive: true });
    const parked = view({ status: "parked", alive: false });
    assert.equal(shouldPoll([parked, live], true), true);
    assert.equal(shouldPoll([parked, live], false), false);
    assert.equal(shouldPoll([parked], true), false);
    assert.equal(shouldPoll([], true), false);
  });
});

describe("the start dialog", () => {
  it("says what is built from, what is left out, and where the key and budget come from", () => {
    const m = startMessage("INT-7", "feat/tax", "0123456789abcdef", REPO);
    assert.match(m, /feat\/tax/);
    assert.match(m, /01234567/);
    assert.match(m, /uncommitted changes are not included/i);
    assert.match(m, /nothing is pushed/i);
    assert.match(m, /\/work\/shop\/\.env/);
    assert.match(m, /SDLC_RUN_BUDGET_USD/);
  });
});

/** A fake Spine with 3.67.1's three build tools: decisions behave as the real ones do. */
function fakeSpine(
  opts: { rows?: RunRow[]; waits?: Record<string, Waiting | null>; remote?: boolean; diffs?: Record<string, { diff: string; bytes: number; truncated: boolean }> } = {},
) {
  const seen: { tool: string; args: Record<string, unknown> }[] = [];
  const decided = new Set<string>();
  const calls: SpineCalls = {
    server: opts.remote ? "company-spine" : "local",
    remote: !!opts.remote,
    // Answers go through `checked`, as the real transports do: a refusal throws.
    call: async (tool, args) => checked(await answer(tool, args)),
  };
  async function answer(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    seen.push({ tool, args });
    if (tool === "sdlc_builds" && !args.run_id) {
      return { runs: opts.rows ?? [], count: 52, truncated: true, not_shown: 3 };
    }
    if (tool === "sdlc_builds") {
      const r = (opts.rows ?? []).find((x) => x.run_id === args.run_id);
      const w = opts.waits?.[String(args.run_id)] ?? null;
      const d = opts.diffs?.[String(args.run_id)];
      const pending = w && !decided.has(w.approval_id) ? w : null;
      return {
        run: r,
        stages: [{ stage: "intake", status: "passed", detail: "", at: 1 }],
        waiting_on: pending,
        ...(pending?.kind === "review" && d ? { diff: d.diff, diff_bytes: d.bytes, diff_truncated: d.truncated } : {}),
      };
    }
    if (tool === "sdlc_build_decide") {
      const w = Object.values(opts.waits ?? {}).find((x) => x?.approval_id === args.approval_id);
      if (!w) return { error: "not an approval of this run" };
      if (w.digest && args.expected_digest !== w.digest) return { error: "bound to another digest", digest: w.digest, expected_digest: args.expected_digest };
      if (!args.approve && !String(args.note ?? "").trim()) return { error: "a rejection needs a note" };
      decided.add(w.approval_id);
      return { decision: args.approve ? "APPROVED" : "REJECTED", decided_by: args.decided_by, next: "resume" };
    }
    if (tool === "sdlc_build") return { run_id: args.run_id || "new-run", status: "running", pid: 42 };
    throw new Error(`unexpected tool ${tool}`);
  }
  return { calls, seen, of: (tool: string) => seen.filter((s) => s.tool === tool) };
}

function prompts(answers: { confirm?: boolean; note?: string | undefined } = {}) {
  const said: string[] = [];
  const asked: string[] = [];
  const p: BuildPrompts = {
    confirm: async (message) => {
      asked.push(message);
      return answers.confirm ?? true;
    },
    note: async (title) => {
      asked.push(title);
      return "note" in answers ? answers.note : "looks fine";
    },
    info: (m) => void said.push(m),
    warn: (m) => void said.push(`WARN ${m}`),
  };
  return { p, said, asked };
}

/** A fake git for Fetch: which local branches exist, and every command it was given. */
function fakeGit(existing: string[] = []) {
  const ran: { cwd: string; args: string[] }[] = [];
  const git: GitRun = async (cwd, args) => {
    ran.push({ cwd, args });
    if (args[0] === "rev-parse") return { ok: existing.includes(String(args.at(-1))), out: "" };
    return { ok: true, out: "" };
  };
  return { git, ran };
}

function runs(spine: ReturnType<typeof fakeSpine>, opts: { trusted?: boolean; name?: string; repo?: string; git?: GitRun } = {}) {
  return new BuildRuns({
    calls: () => spine.calls,
    repo: () => ("repo" in opts ? opts.repo : REPO),
    isTrusted: () => opts.trusted ?? true,
    deciderName: async () => opts.name ?? NAME,
    git: opts.git ?? fakeGit().git,
  });
}

describe("BuildRuns against a fake Spine", () => {
  const parkedBudget = row({ run_id: "b1", status: "parked", alive: false, approval_id: "ab", spent_usd: 25.01 });
  const parkedVerdict = row({ run_id: "v1", status: "parked", alive: false, approval_id: "av" });
  const reviewing = row({ run_id: "w1", status: "parked", alive: true, approval_id: "aw" });
  const waits = {
    b1: waiting("budget", { approval_id: "ab" }),
    v1: waiting("verdict", { approval_id: "av", digest: "v".repeat(16) }),
    w1: waiting("review", { approval_id: "aw" }),
  };

  it("lists this checkout's runs, with what each parked one waits on and how many are not shown", async () => {
    const spine = fakeSpine({ rows: [row(), parkedBudget, parkedVerdict, reviewing], waits });
    const listed = await runs(spine).list();
    assert.equal(listed.views.length, 4);
    assert.equal(listed.notShown, 3);
    assert.equal(listed.count, 52);
    assert.equal(listed.truncated, true);
    assert.equal(listed.views[1].waiting?.kind, "budget");
    assert.equal(listed.views[0].waiting, null);
    // Only parked runs with an approval are asked about; a live build is not.
    assert.deepEqual(spine.of("sdlc_builds").map((s) => s.args.run_id ?? "").sort(), ["", "b1", "v1", "w1"]);
    assert.equal(spine.of("sdlc_builds")[0].args.repo_path, REPO);
  });

  it("a poll does not fetch a review's diff again for an approval it already read", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits });
    const r = runs(spine);
    await r.list();
    await r.list({ poll: true });
    await r.list({ poll: true });
    assert.equal(spine.of("sdlc_builds").filter((s) => s.args.run_id === "w1").length, 1);
    await r.list();
    assert.equal(spine.of("sdlc_builds").filter((s) => s.args.run_id === "w1").length, 2);
  });

  it("approves a 'build anyway?' park with its digest and a note, under the git name", async () => {
    const spine = fakeSpine({ rows: [parkedVerdict], waits });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    const { p, said } = prompts({ note: "the ticket is right" });
    assert.equal(await r.approve(v, p), true);
    const [d] = spine.of("sdlc_build_decide");
    assert.deepEqual(d.args, {
      repo_path: REPO,
      run_id: "v1",
      approval_id: "av",
      approve: true,
      expected_digest: "v".repeat(16),
      note: "the ticket is right",
      decided_by: NAME,
    });
    assert.match(said.join("\n"), /Resume/);
    assert.equal(spine.of("sdlc_build").length, 0);
  });

  it("records nothing when the note prompt is cancelled", async () => {
    const spine = fakeSpine({ rows: [parkedVerdict], waits });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    assert.equal(await r.approve(v, prompts({ note: undefined }).p), false);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
  });

  it("refuses to decide with no git name: a local decision is recorded under it", async () => {
    const spine = fakeSpine({ rows: [parkedVerdict], waits });
    const r = runs(spine, { name: "  " });
    const [v] = (await r.list()).views;
    const { p, said } = prompts();
    assert.equal(await r.approve(v, p), false);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
    assert.match(said.join("\n"), /git config user\.name/);
  });

  it("drops a park only with a note", async () => {
    const spine = fakeSpine({ rows: [parkedVerdict], waits });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    assert.equal(await r.drop(v, prompts({ note: "   " }).p), false);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
    assert.equal(await r.drop(v, prompts({ note: "wrong ticket" }).p), true);
    const [d] = spine.of("sdlc_build_decide");
    assert.equal(d.args.approve, false);
    assert.equal(d.args.note, "wrong ticket");
  });

  it("Raise cap and resume: says where the cap is, approves, THEN resumes (D91)", async () => {
    const spine = fakeSpine({ rows: [parkedBudget], waits });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    const { p, asked } = prompts();
    assert.equal(await r.raiseCapAndResume(v, p), true);
    assert.match(asked.join("\n"), /SDLC_RUN_BUDGET_USD/);
    assert.match(asked.join("\n"), /\/work\/shop\/\.env/);
    assert.match(asked.join("\n"), /\$25\.01/);
    const order = spine.seen.map((s) => s.tool).filter((t) => t !== "sdlc_builds");
    assert.deepEqual(order, ["sdlc_build_decide", "sdlc_build"]);
    assert.equal(spine.of("sdlc_build_decide")[0].args.approve, true);
    assert.equal(spine.of("sdlc_build_decide")[0].args.note, "cap raised");
    assert.deepEqual(spine.of("sdlc_build")[0].args, { repo_path: REPO, action: "resume", run_id: "b1" });
  });

  it("Raise cap and resume does nothing when not confirmed", async () => {
    const spine = fakeSpine({ rows: [parkedBudget], waits });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    assert.equal(await r.raiseCapAndResume(v, prompts({ confirm: false }).p), false);
    assert.equal(spine.seen.filter((s) => s.tool !== "sdlc_builds").length, 0);
  });

  it("never decides a live review from the panel (D89)", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    await assert.rejects(r.approve(v, prompts().p), /review/);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
  });

  it("cancels after a confirm that says the branch and worktree stay", async () => {
    const spine = fakeSpine({ rows: [row({ worktree: "/wt", branch: "feat/INT-7/x" })] });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    const { p, asked } = prompts();
    assert.equal(await r.cancel(v, p), true);
    assert.match(asked.join("\n"), /branch and worktree/);
    assert.deepEqual(spine.of("sdlc_build")[0].args, { repo_path: REPO, action: "cancel", run_id: "r1" });
    assert.equal(await r.cancel(v, prompts({ confirm: false }).p), false);
    assert.equal(spine.of("sdlc_build").length, 1);
  });

  it("resumes after a confirm, and starts a build of a plan", async () => {
    const spine = fakeSpine({ rows: [row({ status: "running", alive: false })] });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    assert.equal(await r.resume(v, prompts().p), true);
    assert.deepEqual(spine.of("sdlc_build")[0].args, { repo_path: REPO, action: "resume", run_id: "r1" });
    const started = await r.start("INT-7");
    assert.equal(started.runId, "new-run");
    assert.deepEqual(spine.of("sdlc_build")[1].args, { repo_path: REPO, action: "start", intent_id: "INT-7" });
  });

  it("reads one run's stages", async () => {
    const spine = fakeSpine({ rows: [row()] });
    assert.deepEqual(await runs(spine).stages("r1"), [{ stage: "intake", status: "passed", detail: "", at: 1 }]);
  });

  it("calls nothing in Restricted Mode, without a folder, or on a remote server (D12, D21)", async () => {
    await assert.rejects(runs(fakeSpine(), { trusted: false }).list(), RestrictedWorkspaceError);
    await assert.rejects(runs(fakeSpine(), { repo: undefined }).list(), /open a folder/);
    const remote = fakeSpine({ remote: true });
    await assert.rejects(runs(remote).list(), /this machine/);
    assert.equal(remote.seen.length, 0);
  });
});

describe("the diff review (SSPN-245)", () => {
  const PATCH = "diff --git a/src/tax.py b/src/tax.py\n--- a/src/tax.py\n+++ b/src/tax.py\n@@ -1 +1 @@\n-x\n+y\n";
  const reviewing = row({ run_id: "w1", status: "parked", alive: true, approval_id: "aw", worktree: "/cache/wt-1", branch: "feat/INT-7/tax" });
  const waits = { w1: waiting("review", { approval_id: "aw", digest: "e".repeat(16) }) };
  const diffs = { w1: { diff: PATCH, bytes: PATCH.length, truncated: false } };

  it("reads the bound patch, its size and digest from Spine", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits, diffs });
    const r = runs(spine);
    const [v] = (await r.list()).views;
    const review = await r.readReview(v);
    assert.equal(review.patch, PATCH);
    assert.equal(review.bytes, PATCH.length);
    assert.equal(review.truncated, false);
    assert.equal(review.view.waiting?.digest, "e".repeat(16));
    assert.equal(review.view.row.worktree, "/cache/wt-1");
  });

  it("refuses to review a park whose process is gone, a terminal run's, or a run not waiting on a review", async () => {
    const r = runs(fakeSpine({ rows: [reviewing], waits, diffs }));
    await assert.rejects(r.readReview(view({ run_id: "w1", status: "parked", alive: false, approval_id: "aw" }, waits.w1)), /process is gone/);
    await assert.rejects(r.readReview(view({ run_id: "w1", status: "parked", alive: true, approval_id: "aw", from_editor: false }, waits.w1)), /terminal/);
    await assert.rejects(r.readReview(view({ status: "parked", alive: false }, waiting("budget"))), /not waiting on a review/);
  });

  it("approves with the digest of the diff that was read, under the git name, after a confirm that says what it covers", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits, diffs });
    const r = runs(spine);
    const review = await r.readReview((await r.list()).views[0]);
    const { p, asked, said } = prompts({ note: "" });
    assert.equal(await r.approveReview(review, 3, p), true);
    const [d] = spine.of("sdlc_build_decide");
    assert.deepEqual(d.args, {
      repo_path: REPO,
      run_id: "w1",
      approval_id: "aw",
      approve: true,
      expected_digest: "e".repeat(16),
      note: "",
      decided_by: NAME,
    });
    assert.match(asked[0], /3 files/);
    assert.match(asked[0], /eeeeeeeeeeee/);
    assert.match(asked[0], /committed on feat\/INT-7\/tax/);
    assert.doesNotMatch(asked[0], /cut/);
    assert.match(said.join("\n"), /carries on/);
  });

  it("says when the patch view was cut, and that the yes covers the whole diff (D97)", async () => {
    const big = { w1: { diff: PATCH, bytes: 512_000, truncated: true } };
    const spine = fakeSpine({ rows: [reviewing], waits, diffs: big });
    const r = runs(spine);
    const review = await r.readReview((await r.list()).views[0]);
    const { p, asked } = prompts();
    assert.equal(await r.approveReview(review, 40, p), true);
    assert.match(asked[0], /500 KB/);
    assert.match(asked[0], /cut at 200 KB/);
    assert.match(asked[0], /whole diff/);
  });

  it("records nothing when the confirm is declined or the note cancelled", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits, diffs });
    const r = runs(spine);
    const review = await r.readReview((await r.list()).views[0]);
    assert.equal(await r.approveReview(review, 1, prompts({ confirm: false }).p), false);
    assert.equal(await r.approveReview(review, 1, prompts({ note: undefined }).p), false);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
  });

  it("a diff that moved since it was read is refused, so the caller can reopen it", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits, diffs });
    const r = runs(spine);
    const review = await r.readReview((await r.list()).views[0]);
    const stale = { ...review, view: { ...review.view, waiting: { ...review.view.waiting!, digest: "f".repeat(16) } } };
    await assert.rejects(r.approveReview(stale, 1, prompts().p), PlanMovedError);
  });

  it("rejects only with a note; the run ends and its branch and worktree stay (D98)", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits, diffs });
    const r = runs(spine);
    const review = await r.readReview((await r.list()).views[0]);
    assert.equal(await r.rejectReview(review, prompts({ note: "  " }).p), false);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
    const { p, said } = prompts({ note: "tax is rounded twice" });
    assert.equal(await r.rejectReview(review, p), true);
    const [d] = spine.of("sdlc_build_decide");
    assert.equal(d.args.approve, false);
    assert.equal(d.args.note, "tax is rounded twice");
    assert.equal(d.args.expected_digest, "e".repeat(16));
    assert.match(said.join("\n"), /branch and worktree stay/);
    assert.match(said.join("\n"), /new build/);
  });

  it("refuses to decide a review with no git name", async () => {
    const spine = fakeSpine({ rows: [reviewing], waits, diffs });
    const r = runs(spine, { name: "" });
    const review = await r.readReview((await r.list()).views[0]);
    assert.equal(await r.approveReview(review, 1, prompts().p), false);
    assert.equal(spine.of("sdlc_build_decide").length, 0);
  });
});

describe("Fetch into my checkout (D99)", () => {
  const done = row({ run_id: "f1", status: "done", alive: false, worktree: "/cache/wt-1", branch: "feat/INT-7/tax" });

  it("fetches the branch into the checkout after a confirm, then says to push it yourself", async () => {
    const g = fakeGit();
    const r = runs(fakeSpine({ rows: [done] }), { git: g.git });
    const [v] = (await r.list()).views;
    const { p, asked, said } = prompts();
    assert.equal(await r.fetch(v, p), true);
    assert.match(asked[0], /local branch/);
    assert.match(asked[0], /not touched/);
    assert.deepEqual(g.ran.at(-1), { cwd: REPO, args: ["fetch", "--no-tags", "/cache/wt-1", "refs/heads/feat/INT-7/tax:refs/heads/feat/INT-7/tax"] });
    assert.match(said.join("\n"), /git push -u origin feat\/INT-7\/tax/);
  });

  it("refuses when the checkout already has that branch, and runs no fetch", async () => {
    const g = fakeGit(["refs/heads/feat/INT-7/tax"]);
    const r = runs(fakeSpine({ rows: [done] }), { git: g.git });
    const [v] = (await r.list()).views;
    await assert.rejects(r.fetch(v, prompts().p), /already has a branch feat\/INT-7\/tax/);
    assert.equal(g.ran.some((c) => c.args[0] === "fetch"), false);
  });

  it("does nothing when not confirmed, and refuses a run that is not a finished editor build", async () => {
    const g = fakeGit();
    const r = runs(fakeSpine({ rows: [done] }), { git: g.git });
    const [v] = (await r.list()).views;
    assert.equal(await r.fetch(v, prompts({ confirm: false }).p), false);
    await assert.rejects(r.fetch({ ...v, row: { ...v.row, status: "abandoned" } }, prompts().p), /finished/);
    await assert.rejects(r.fetch({ ...v, row: { ...v.row, from_editor: false } }, prompts().p), /terminal/);
    assert.equal(g.ran.some((c) => c.args[0] === "fetch"), false);
  });
});

describe("telling the person a review is waiting (D101)", () => {
  const review = (id: string, over: Partial<RunRow> = {}) =>
    view({ run_id: id, status: "parked", alive: true, approval_id: `a-${id}`, ...over }, waiting("review", { approval_id: `a-${id}` }));

  it("announces each review approval once, and only an editor build's that is still waiting", () => {
    const views = [review("1"), review("2", { from_editor: false }), review("3", { alive: false }), view({ alive: true }), view({ status: "parked", alive: false }, waiting("budget"))];
    assert.deepEqual(reviewsToAnnounce(views, new Set()).map((v) => v.row.run_id), ["1"]);
    assert.deepEqual(reviewsToAnnounce(views, new Set(["a-1"])), []);
  });

  it("watches in the background only while the view is hidden and an editor build is alive", () => {
    assert.equal(shouldWatch([view({ alive: true })], false), true);
    assert.equal(shouldWatch([view({ alive: true })], true), false);
    assert.equal(shouldWatch([view({ alive: true, from_editor: false })], false), false);
    assert.equal(shouldWatch([view({ status: "done", alive: false })], false), false);
    assert.equal(shouldWatch([], false), false);
  });
});
