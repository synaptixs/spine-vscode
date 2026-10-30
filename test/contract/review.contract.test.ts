/**
 * The diff review contract (SSPN-245): `BuildRuns`' review and fetch against the REAL Spine's
 * `sdlc_builds` and `sdlc_build_decide` at level `build`. Free: nothing is built. A live review park
 * is seeded through Spine's own Python on a real git worktree, so the patch and its digest are the
 * ones Spine's own gate makes (`review_diff`, `diff_digest`), not hand-written.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { actionsFor, BuildRuns, type BuildPrompts, type RunView } from "../../src/builds";
import { localCalls, PlanMovedError } from "../../src/calls";
import { SpineClient } from "../../src/client";
import { parseStatus, patchFiles } from "../../src/diffs";
import { spineLaunch } from "../../src/launch";
import { gitUserName } from "../../src/review";
import { GIT_NAME, type PlanFixture, planFixture } from "../support/planFixture";
import { gitWorktree, runStore, type RunStoreDirs, seed } from "../support/seedRuns";

const yes = (note = "read in the contract test"): BuildPrompts => ({
  confirm: async () => true,
  note: async () => note,
  info: () => undefined,
  warn: () => undefined,
});

describe("the diff review against the real Spine (SSPN-245)", function () {
  let fixture: PlanFixture;
  let repo: string;
  let store: RunStoreDirs;
  let client: SpineClient;
  let builds: BuildRuns;
  const disposers: (() => void)[] = [];

  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const viewOf = async (runId: string): Promise<RunView> => {
    const found = (await builds.list()).views.find((v) => v.row.run_id === runId);
    if (!found) throw new Error(`run ${runId} is not listed`);
    return found;
  };
  /** The approval as Spine recorded it, in `$SPINE_RUN_STATE/_approvals` (escalate.default_approval_dir). */
  const decision = (approvalId: string): string => {
    const dir = `${store.state}/_approvals`;
    return fs
      .readdirSync(dir)
      .map((f) => fs.readFileSync(`${dir}/${f}`, "utf8"))
      .filter((t) => t.includes(approvalId))
      .join("\n");
  };
  const reviewPark = (runId: string) => {
    const wt = gitWorktree("review");
    disposers.push(wt.dispose);
    seed(store, { runId, intentId: "REVIEW-1", repo, status: "parked", kind: "review", live: true, fromEditor: true, worktree: wt.root, commitBranch: "feat/REVIEW-1/tax" });
    return wt.root;
  };

  before(async () => {
    fixture = await planFixture({ commit: true });
    repo = fs.realpathSync(fixture.root);
    store = runStore();
    client = new SpineClient({ launch: spineLaunch(process.env.SPINE_SERVER_PATH, "build", store.env), isTrusted: () => true, cwd: repo });
    builds = new BuildRuns({ calls: () => localCalls(() => client), repo: () => repo, isTrusted: () => true, deciderName: () => gitUserName(repo) });
  });

  after(async () => {
    await client?.close();
    store?.dispose();
    for (const d of disposers) d();
    fixture?.dispose();
  });

  it("a live review park offers Review; its patch is the worktree's diff, and git status names the same files", async () => {
    const wt = reviewPark("review0000000001");
    const v = await viewOf("review0000000001");
    assert.deepEqual(actionsFor(v), ["review", "cancel", "openWorktree", "openPlan"]);
    const review = await builds.readReview(v);
    assert.equal(review.truncated, false);
    assert.equal(review.bytes, Buffer.byteLength(review.patch, "utf8"));
    assert.match(review.patch, /round\(x \* 0\.2, 2\)/);
    assert.equal(review.view.row.worktree, wt);
    // What the editor lists (git status, read only) is what Spine bound (the patch).
    const listed = parseStatus(git(wt, "status", "--porcelain=v1", "-z", "-uall")).map((c) => c.path);
    assert.deepEqual(listed, patchFiles(review.patch));
    assert.deepEqual(listed, ["old.py", "tax.py", "test_tax.py"]);
  });

  it("refuses another digest and records nothing; approves the digest that was read, under the git name", async () => {
    reviewPark("review0000000002");
    const review = await builds.readReview(await viewOf("review0000000002"));
    const stale = { ...review, view: { ...review.view, waiting: { ...review.view.waiting!, digest: "0".repeat(64) } } };
    await assert.rejects(builds.approveReview(stale, 3, yes()), PlanMovedError);
    assert.equal((await viewOf("review0000000002")).waiting?.kind, "review");
    assert.equal(await builds.approveReview(review, 3, yes("reads right")), true);
    const after = await viewOf("review0000000002");
    assert.equal(after.waiting, null);
    const decided = decision(review.view.waiting!.approval_id);
    assert.match(decided, /APPROVED/);
    assert.match(decided, new RegExp(GIT_NAME));
  });

  it("rejects a review only with a note", async () => {
    reviewPark("review0000000003");
    const review = await builds.readReview(await viewOf("review0000000003"));
    assert.equal(await builds.rejectReview(review, yes("   ")), false);
    assert.equal((await viewOf("review0000000003")).waiting?.kind, "review");
    assert.equal(await builds.rejectReview(review, yes("tax is rounded twice")), true);
    assert.equal((await viewOf("review0000000003")).waiting, null);
    const recorded = decision(review.view.waiting!.approval_id);
    assert.match(recorded, /REJECTED/);
    assert.match(recorded, /tax is rounded twice/);
  });

  it("fetches a finished build's branch into the checkout as a new local branch, leaving HEAD and the tree alone; never twice", async () => {
    const wt = gitWorktree("done", "feat/DONE-1/tax");
    disposers.push(wt.dispose);
    seed(store, { runId: "done000000000001", intentId: "DONE-1", repo, status: "done", fromEditor: true, worktree: wt.root, commitBranch: "feat/DONE-1/tax" });
    const v = await viewOf("done000000000001");
    assert.deepEqual(actionsFor(v), ["fetch", "openWorktree", "openPlan"]);
    const head = git(repo, "rev-parse", "HEAD");
    const branch = git(repo, "rev-parse", "--abbrev-ref", "HEAD");
    const status = git(repo, "status", "--porcelain");
    assert.equal(await builds.fetch(v, yes()), true);
    assert.equal(git(repo, "rev-parse", "refs/heads/feat/DONE-1/tax"), git(wt.root, "rev-parse", "HEAD"));
    assert.equal(git(repo, "rev-parse", "HEAD"), head);
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), branch);
    assert.equal(git(repo, "status", "--porcelain"), status);
    await assert.rejects(builds.fetch(v, yes()), /already has a branch feat\/DONE-1\/tax/);
  });
});
