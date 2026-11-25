/**
 * The plan-review contract (SSPN-243): the extension's own seam and review core against the REAL
 * Spine, at levels `plan` and `pkg`. Needs Spine 3.66.0 or later (`sdlc_plan_document`,
 * `sdlc_approve(expected_digest)`); until the pin reaches it, set SPINE_SERVER_PATH to a build.
 */
import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { localCalls, PlanMovedError } from "../../src/calls";
import { SpineClient } from "../../src/client";
import { spineLaunch } from "../../src/launch";
import { gitUserName, PlanReview, specFile } from "../../src/review";
import { GIT_NAME, type PlanFixture, planFixture } from "../support/planFixture";

describe("plan review against the real Spine (SSPN-243)", () => {
  let fixture: PlanFixture;
  const clients: SpineClient[] = [];

  const review = (level: string) => {
    const client = new SpineClient({ launch: spineLaunch(process.env.SPINE_SERVER_PATH, level), isTrusted: () => true, cwd: fixture.root });
    clients.push(client);
    return new PlanReview({
      calls: () => localCalls(() => client),
      repo: () => fixture.root,
      isTrusted: () => true,
      approverName: () => gitUserName(fixture.root),
    });
  };

  before(async () => {
    fixture = await planFixture();
  });

  after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    fixture?.dispose();
  });

  it("lists the folder's plans", async () => {
    const listed = await review("plan").list();
    assert.deepEqual(listed.plans, [{ intent_id: fixture.intentId, state: "none", decided_by: "" }]);
    assert.equal(listed.count, 1);
    assert.equal(listed.truncated, false);
  });

  it("reads a plan as it is on disk, with the digest an approval binds to", async () => {
    const view = await review("plan").open(fixture.intentId);
    assert.equal(view.document, fs.readFileSync(fixture.planFile, "utf8"));
    assert.match(view.digest, /^[0-9a-f]{16,}$/);
    assert.equal(view.state, "none");
    assert.equal(view.approver, GIT_NAME);
    assert.equal(view.canDecide, true, view.reason);
  });

  it("cannot approve at level pkg, and names the level to set", async () => {
    const view = await review("pkg").open(fixture.intentId);
    assert.equal(view.canDecide, false);
    assert.match(view.reason, /ORCHESTRATOR_MCP_LEVEL=plan/);
  });

  it("refuses an approval bound to another digest, and records nothing", async () => {
    const r = review("plan");
    const view = await r.open(fixture.intentId);
    await assert.rejects(
      r.decide({ ...view, digest: "0".repeat(view.digest.length) }, { reject: false }),
      (err: unknown) => err instanceof PlanMovedError && err.current === view.digest,
    );
    assert.equal((await r.open(fixture.intentId)).state, "none");
  });

  it("approves with the digest that was read, under the git name", async () => {
    const r = review("plan");
    const view = await r.open(fixture.intentId);
    const after = await r.decide(view, { reject: false });
    assert.equal(after.state, "approved");
    assert.equal(after.approval?.decided_by, GIT_NAME);
    assert.equal(after.approval?.digest, view.digest);
  });

  it("reads as stale after an edit, and refuses a decision on what was read before it", async () => {
    const r = review("plan");
    const before = await r.open(fixture.intentId);
    fs.appendFileSync(fixture.planFile, "\nAn edit made after the plan was read.\n");
    const reopened = await r.open(fixture.intentId);
    assert.equal(reopened.state, "stale");
    assert.notEqual(reopened.digest, before.digest);
    await assert.rejects(r.decide(before, { reject: false }), PlanMovedError);
    assert.equal((await r.open(fixture.intentId)).state, "stale");
  });

  it("says a plan is no longer the checkout's after a commit, and Re-plan makes it fresh again (B182, D126, Spine 3.71)", async () => {
    const r = review("plan");
    const before = await r.open(fixture.intentId);
    execFileSync("git", ["add", "-A"], { cwd: fixture.root });
    execFileSync("git", ["commit", "-qm", "a commit after the plan"], { cwd: fixture.root });
    const moved = await r.open(fixture.intentId);
    assert.equal(moved.fresh, false);
    assert.equal(moved.derivedAt, before.derivedAt);
    assert.notEqual(moved.derivedNow, moved.derivedAt);
    const replanned = await r.replanFromKept(fixture.intentId, fixture.root);
    assert.equal(replanned.fresh, true, `${replanned.derivedAt} vs ${replanned.derivedNow}`);
  });

  it("re-plans from the spec Spine kept, edited: no model, the new text, an approval of the old one stale (B180, D127)", async () => {
    const r = review("plan");
    const approved = await r.decide(await r.open(fixture.intentId), { reject: false });
    assert.equal(approved.state, "approved");
    const file = specFile(fixture.root, fixture.intentId);
    const spec = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown> & { title: string };
    spec.title = `${spec.title} (narrowed in the contract test)`;
    const after = await r.replan(fixture.intentId, spec, fixture.root);
    assert.ok(after.document.includes("(narrowed in the contract test)"), "the plan is rendered from the edited spec");
    assert.equal(after.state, "stale");
    assert.equal(fs.readFileSync(fixture.planFile, "utf8"), after.document, "Spine wrote the plan file");
    assert.equal((JSON.parse(fs.readFileSync(file, "utf8")) as { title: string }).title, spec.title, "and kept the edited spec for the build gate");
  });
});
