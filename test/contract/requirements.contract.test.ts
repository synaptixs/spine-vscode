/**
 * Plan from requirement (SSPN-246) against the REAL Spine 3.68.0 (SSPN-279), free: the extension's
 * own flow and seam on a requirement whose spec is seeded into Spine's intake cache through Spine's
 * own Python (test/support/seedIntake.ts). No model is called: the checkout has no `.env`, so a
 * derivation would fail rather than spend. The one real extraction is D108's paid run, not here.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { localCalls } from "../../src/calls";
import { SpineClient } from "../../src/client";
import { INTAKE_CACHE_ENV, spineLaunch } from "../../src/launch";
import { type Intent, RequirementPlanner, type RequirementPrompts, sourceForFile, sourceTyped } from "../../src/requirements";
import { gitUserName, PlanReview } from "../../src/review";
import { CRITERION, type IntakeCache, intakeCache, REQUIREMENT_ID, type RequirementFixture, requirementFixture, seedIntake } from "../support/seedIntake";

describe("Plan from requirement against the real Spine (SSPN-246)", () => {
  let fixture: RequirementFixture;
  let cache: IntakeCache;
  let saved: string | undefined;
  const clients: SpineClient[] = [];

  const client = () => {
    // The launch passes the intake cache's location from this process (D110), as it would from the editor's host.
    const c = new SpineClient({ launch: spineLaunch(process.env.SPINE_SERVER_PATH, "plan"), isTrusted: () => true, cwd: fixture.root });
    clients.push(c);
    return c;
  };

  const planner = (opened: string[]) => {
    const c = client();
    return new RequirementPlanner({
      calls: () => localCalls(() => c),
      repo: () => fixture.root,
      isTrusted: () => true,
      blocker: () => undefined,
      open: async (id) => {
        opened.push(id);
      },
    });
  };

  const prompts = (answers: { confirm?: boolean; pick?: string } = {}) => {
    const asked = { confirms: 0, picks: [] as Intent[][], infos: [] as string[] };
    const p: RequirementPrompts = {
      confirmSpend: async () => {
        asked.confirms += 1;
        return answers.confirm ?? false;
      },
      pickIntent: async (_s, intents) => {
        asked.picks.push(intents);
        return answers.pick;
      },
      info: (m) => asked.infos.push(m),
      warn: () => {},
    };
    return { p, asked };
  };

  const plansDir = () => path.join(fixture.root, ".spine", "plans");

  beforeEach(() => {
    fixture = requirementFixture([REQUIREMENT_ID, "CART-10"]);
    cache = intakeCache();
    saved = process.env[INTAKE_CACHE_ENV];
    process.env[INTAKE_CACHE_ENV] = cache.dir;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    if (saved === undefined) delete process.env[INTAKE_CACHE_ENV];
    else process.env[INTAKE_CACHE_ENV] = saved;
    cache.dispose();
    fixture.dispose();
  });

  it("extract: false says a seeded source is cached, with its intents, and spends and writes nothing", async () => {
    const source = sourceForFile(fixture.files[REQUIREMENT_ID]);
    seedIntake(cache, source);
    const out = await localCalls(() => client()).call("sdlc_plan", { repo_path: fixture.root, source, extract: false });
    assert.equal(out.cached, true);
    assert.deepEqual(out.intents, [{ id: REQUIREMENT_ID, title: `${REQUIREMENT_ID}: show the cart total with tax` }]);
    assert.equal(out.spent_usd, 0);
    assert.equal(fs.existsSync(plansDir()), false);
  });

  it("extract: false says an unseeded source is not cached, and writes nothing", async () => {
    const out = await localCalls(() => client()).call("sdlc_plan", {
      repo_path: fixture.root,
      source: sourceForFile(fixture.files["CART-10"]),
      extract: false,
    });
    assert.equal(out.cached, false);
    assert.deepEqual(out.intents, []);
    assert.equal(fs.existsSync(plansDir()), false);
  });

  it("plans a cached Markdown requirement with no confirm, for $0, and the review lists and opens it", async () => {
    const source = sourceForFile(fixture.files[REQUIREMENT_ID]);
    seedIntake(cache, source);
    const opened: string[] = [];
    const { p, asked } = prompts();
    const done = await planner(opened).plan(source, p);
    assert.deepEqual(done, { intentId: REQUIREMENT_ID, spentUsd: 0, cached: true, estimated: false });
    assert.equal(asked.confirms, 0);
    assert.deepEqual(opened, [REQUIREMENT_ID]);

    const c = client();
    const review = new PlanReview({ calls: () => localCalls(() => c), repo: () => fixture.root, isTrusted: () => true, approverName: () => gitUserName(fixture.root) });
    assert.deepEqual((await review.list()).plans, [{ intent_id: REQUIREMENT_ID, state: "none", decided_by: "" }]);
    const view = await review.open(REQUIREMENT_ID);
    assert.equal(view.document, fs.readFileSync(path.join(plansDir(), `${REQUIREMENT_ID}-build.md`), "utf8"));
    assert.match(view.document, new RegExp(CRITERION));
    assert.equal(view.canDecide, true, view.reason);
    // The requirement's own text is kept beside the plan, for §8's criteria check and the gate.
    assert.match(fs.readFileSync(path.join(plansDir(), `${REQUIREMENT_ID}-source.txt`), "utf8"), new RegExp(CRITERION));
  });

  it("plans a pasted file:// URL the same way", async () => {
    const source = sourceForFile(fixture.files[REQUIREMENT_ID]);
    seedIntake(cache, source);
    const opened: string[] = [];
    const done = await planner(opened).plan(sourceTyped(`  ${source}\n`), prompts().p);
    assert.equal(done?.intentId, REQUIREMENT_ID);
    assert.equal(done?.spentUsd, 0);
    assert.deepEqual(opened, [REQUIREMENT_ID]);
  });

  it("asks which intent when the cached source holds several, and plans only that one", async () => {
    const source = sourceForFile(fixture.files[REQUIREMENT_ID]);
    seedIntake(cache, source, [REQUIREMENT_ID, "CART-10"]);
    const opened: string[] = [];
    const { p, asked } = prompts({ pick: "CART-10" });
    const done = await planner(opened).plan(source, p);
    assert.deepEqual(
      asked.picks.map((list) => list.map((i) => i.id)),
      [[REQUIREMENT_ID, "CART-10"]],
    );
    assert.equal(asked.confirms, 0);
    assert.deepEqual(done, { intentId: "CART-10", spentUsd: 0, cached: true, estimated: false });
    assert.deepEqual(fs.readdirSync(plansDir()).filter((f) => f.endsWith("-build.md")), ["CART-10-build.md"]);
  });

  it("asks before deriving an uncached requirement, and a no spends and writes nothing", async () => {
    const opened: string[] = [];
    const { p, asked } = prompts({ confirm: false });
    assert.equal(await planner(opened).plan(sourceForFile(fixture.files["CART-10"]), p), undefined);
    assert.equal(asked.confirms, 1);
    assert.deepEqual(opened, []);
    assert.equal(fs.existsSync(plansDir()), false);
  });

  it("shows Spine's refusal of a paste that is not a source, as Spine says it, before any confirm", async () => {
    const { p, asked } = prompts({ confirm: true });
    await assert.rejects(planner([]).plan(sourceTyped("PROJ-1"), p), /source must be '<kind>:\/\/<root>', got 'PROJ-1'/);
    assert.equal(asked.confirms, 0);
    assert.equal(fs.existsSync(plansDir()), false);
  });
});
