/**
 * The builds contract (SSPN-244): the extension's own seam and `BuildRuns` against the REAL Spine's
 * `sdlc_build`, `sdlc_builds` and `sdlc_build_decide` at level `build`. Free (D94): a build is
 * started with no model key, so it stops at its first model call having spent nothing (the server
 * gets no key from the extension, D88, and the fixture has no `.env`); every park is seeded through
 * Spine's own Python (test/support/seedRuns.ts) in a store of the test's own.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { actionsFor, BuildRuns, type BuildPrompts, type RunView } from "../../src/builds";
import { localCalls, SpineRefusal } from "../../src/calls";
import { SpineClient } from "../../src/client";
import { spineLaunch } from "../../src/launch";
import { gitUserName } from "../../src/review";
import { GIT_NAME, type PlanFixture, planFixture } from "../support/planFixture";
import { runStore, type RunStoreDirs, seed } from "../support/seedRuns";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const yes = (note = "seen in the contract test"): BuildPrompts => ({
  confirm: async () => true,
  note: async () => note,
  info: () => undefined,
  warn: () => undefined,
});

describe("builds against the real Spine (SSPN-244)", function () {
  let fixture: PlanFixture;
  let repo: string;
  let store: RunStoreDirs;
  let client: SpineClient;
  let builds: BuildRuns;

  const call = (tool: string, args: Record<string, unknown>) => localCalls(() => client).call(tool, args);
  const viewOf = async (runId: string): Promise<RunView> => {
    const found = (await builds.list()).views.find((v) => v.row.run_id === runId);
    if (!found) throw new Error(`run ${runId} is not listed`);
    return found;
  };
  /** Wait for a real build to stop: it has no key, so it fails at its first model call. */
  const settle = async (runId: string, limitMs = 240_000): Promise<RunView> => {
    const t0 = Date.now();
    for (;;) {
      const v = await viewOf(runId);
      if (!v.row.alive) return v;
      if (Date.now() - t0 > limitMs) throw new Error(`${runId} still running after ${limitMs} ms`);
      await sleep(2_000);
    }
  };

  before(async () => {
    // A build starts from the last commit of a branch, and the plan must be made on that commit.
    fixture = await planFixture({ commit: true });
    repo = fs.realpathSync(fixture.root); // Spine names a run's repository by its resolved path
    store = runStore();
    client = new SpineClient({ launch: spineLaunch(process.env.SPINE_SERVER_PATH, "build", store.env), isTrusted: () => true, cwd: repo });
    builds = new BuildRuns({ calls: () => localCalls(() => client), repo: () => repo, isTrusted: () => true, deciderName: () => gitUserName(repo) });
  });

  after(async () => {
    // Nothing started here outlives the suite.
    for (const v of (await builds?.list().catch(() => ({ views: [] as RunView[] })))?.views ?? []) {
      if (v.row.alive) await call("sdlc_build", { repo_path: repo, action: "cancel", run_id: v.row.run_id }).catch(() => undefined);
    }
    await client?.close();
    store?.dispose();
    fixture?.dispose();
  });

  it("refuses to build a plan nobody approved", async () => {
    await assert.rejects(builds.start(fixture.intentId), (err: unknown) => err instanceof SpineRefusal && /not approved/.test(err.message));
  });

  it("starts an approved plan detached, lists it, and spends nothing without a key", async () => {
    const plan = await call("sdlc_plan_document", { repo_path: repo, intent_id: fixture.intentId });
    await call("sdlc_approve", { repo_path: repo, intent_id: fixture.intentId, expected_digest: plan.digest, decided_by: GIT_NAME, note: "", reject: false });
    const t0 = Date.now();
    const { runId } = await builds.start(fixture.intentId);
    const took = Date.now() - t0;
    assert.ok(took < 30_000, `start returned after ${took} ms: it must not wait for the build`);
    const listed = await viewOf(runId);
    assert.equal(listed.row.intent_id, fixture.intentId);
    const ended = await settle(runId);
    console.log(`      run ${runId} ended ${ended.row.status} at ${ended.row.phase}: ${ended.row.parked_reason || "-"}`);
    assert.notEqual(ended.row.status, "done");
    // Past the plan gate: the approval held on the commit the build started from.
    assert.doesNotMatch(ended.row.parked_reason, /has changed since/);
    assert.equal(ended.row.spent_usd, 0);
  });

  it("shows a budget park, refuses to resume it undecided, then raises and resumes (D91)", async () => {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    seed(store, { runId: "budget0000000001", intentId: fixture.intentId, repo, status: "parked", kind: "budget", spentUsd: 25.01, fromEditor: true, branch });
    const v = await viewOf("budget0000000001");
    assert.equal(v.waiting?.kind, "budget");
    assert.deepEqual(actionsFor(v), ["raiseCapAndResume", "drop", "openPlan"]);
    await assert.rejects(call("sdlc_build", { repo_path: repo, action: "resume", run_id: "budget0000000001" }), /waiting on/);
    assert.equal(await builds.raiseCapAndResume(v, yes()), true);
    const ended = await settle("budget0000000001");
    console.log(`      resumed budget run ended ${ended.row.status}: ${ended.row.parked_reason || "-"}`);
    // The fixture has no .env, so the cap was not raised: the resumed run carries its spend and
    // stops again at its next model call, on a new budget park, having spent nothing more (D91).
    assert.equal(ended.row.status, "parked");
    assert.equal(ended.waiting?.kind, "budget");
    assert.notEqual(ended.waiting?.approval_id, v.waiting?.approval_id);
    assert.equal(ended.row.spent_usd, 25.01);
  });

  it("approves a 'build anyway?' park bound to its digest, under the git name", async () => {
    const digest = "ab".repeat(16);
    const { approvalId } = seed(store, { runId: "verdict000000001", intentId: "OTHER-1", repo, status: "parked", kind: "verdict", digest, fromEditor: true });
    const v = await viewOf("verdict000000001");
    assert.equal(v.waiting?.digest, digest);
    // A view of another digest is refused, and nothing is recorded.
    await assert.rejects(builds.approve({ ...v, waiting: { ...v.waiting!, digest: "cd".repeat(16) } }, yes()), SpineRefusal);
    assert.equal((await viewOf("verdict000000001")).waiting?.approval_id, approvalId);
    assert.equal(await builds.approve(v, yes("the ticket is right")), true);
    const after = await viewOf("verdict000000001");
    assert.equal(after.waiting, null);
    assert.deepEqual(actionsFor(after), ["resume", "openPlan"]);
  });

  it("drops a park only with a note", async () => {
    seed(store, { runId: "design0000000001", intentId: "OTHER-2", repo, status: "parked", kind: "design", digest: "ef".repeat(16), fromEditor: true });
    const v = await viewOf("design0000000001");
    assert.equal(await builds.drop(v, yes("   ")), false);
    assert.equal((await viewOf("design0000000001")).waiting?.kind, "design");
    assert.equal(await builds.drop(v, yes("wrong ticket")), true);
    assert.equal((await viewOf("design0000000001")).waiting, null);
  });

  it("a dropped park whose process is gone is abandoned, and the plan builds again (D87, Spine 3.67.1)", async () => {
    // A budget park exits its process once it has asked. The D91 test above leaves one on this
    // plan too, so every such park of the plan is dropped, and the plan must then build again.
    seed(store, { runId: "stuck00000000001", intentId: fixture.intentId, repo, status: "parked", kind: "budget", fromEditor: true });
    await assert.rejects(builds.start(fixture.intentId), (err: unknown) => err instanceof SpineRefusal && /already being built/.test(err.message));
    const held = (await builds.list()).views.filter((v) => v.row.intent_id === fixture.intentId && v.row.status === "parked" && !v.row.alive);
    assert.ok(held.some((v) => v.row.run_id === "stuck00000000001"));
    for (const v of held) {
      assert.equal(await builds.drop(v, yes("not worth more")), true);
      assert.equal((await viewOf(v.row.run_id)).row.status, "abandoned");
    }
    const { runId } = await builds.start(fixture.intentId);
    const ended = await settle(runId);
    assert.equal(ended.row.spent_usd, 0);
  });

  it("lists a run started from a terminal read-only, and an editor's run with its actions (D90, D95)", async () => {
    seed(store, { runId: "terminal00000001", intentId: "OTHER-6", repo, status: "failed" });
    seed(store, { runId: "editor0000000001", intentId: "OTHER-6", repo, status: "failed", fromEditor: true });
    const terminal = await viewOf("terminal00000001");
    assert.equal(terminal.row.from_editor, false);
    assert.deepEqual(actionsFor(terminal), ["openPlan"]);
    const editor = await viewOf("editor0000000001");
    assert.equal(editor.row.from_editor, true);
    assert.deepEqual(actionsFor(editor), ["resume", "openPlan"]);
  });

  it("cancels a live run; its record says abandoned", async () => {
    seed(store, { runId: "live000000000001", intentId: "OTHER-4", repo, status: "running", live: true, fromEditor: true });
    const v = await viewOf("live000000000001");
    assert.equal(v.row.alive, true);
    assert.equal(await builds.cancel(v, yes()), true);
    const after = await viewOf("live000000000001");
    assert.equal(after.row.status, "abandoned");
    assert.equal(after.row.alive, false);
  });

  it("offers a live review park's Review, never the panel's Approve (D89; decided on the diff, SSPN-245)", async () => {
    seed(store, { runId: "review0000000001", intentId: "OTHER-5", repo, status: "parked", kind: "review", digest: "01".repeat(16), live: true, fromEditor: true });
    const v = await viewOf("review0000000001");
    assert.equal(v.waiting?.kind, "review");
    assert.deepEqual(actionsFor(v), ["review", "cancel", "openPlan"]);
    await assert.rejects(builds.approve(v, yes()), /diff review/);
  });

  it("lists only this checkout's runs, and counts the others", async () => {
    const before = await builds.list();
    seed(store, { runId: "elsewhere0000001", intentId: "X-1", repo: "/somewhere/else", status: "parked" });
    const after = await builds.list();
    assert.equal(after.views.some((v) => v.row.run_id === "elsewhere0000001"), false);
    assert.equal(after.notShown, before.notShown + 1);
  });
});
