/**
 * SSPN-244 in a real VS Code, against the real Spine at `spine.level=build`, on a throwaway copy of
 * the fixture holding one plan, with runs seeded in a store of the suite's own (test/integration/run.ts).
 * The Runs view reading that store at all is the proof that the extension hands its server the
 * run store's location (D88). Nothing is built: no build is started here.
 */
import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { spineApi } from "./helpers";

const ID = process.env.SPINE_PLAN_ID!;

describe("the Runs view and the Build button (SSPN-244)", () => {
  before(async () => {
    await spineApi();
  });

  it("lists this checkout's seeded run, with what its park offers, and not another repository's", async () => {
    const runs = await (await spineApi()).runs.runs();
    assert.deepEqual(
      runs.map((r) => r.runId),
      ["budget0000000001"],
    );
    assert.deepEqual(runs[0].actions, ["raiseCapAndResume", "drop", "openPlan"]);
    assert.match(runs[0].text.description, /budget/);
    assert.match(runs[0].text.description, /\$3\.50/);
  });

  it("enables Build only on an approved plan", async () => {
    const api = await spineApi();
    await vscode.commands.executeCommand("spine.openPlan", ID);
    assert.equal(api.plans.current()?.state, "none");
    assert.deepEqual(api.plans.build(), { enabled: false, blocker: undefined });
    await api.plans.decide(ID, { reject: false });
    assert.deepEqual(api.plans.build(), { enabled: true, blocker: undefined });
  });

  it("turns builds off below level build, and says which setting to change", async () => {
    const api = await spineApi();
    const config = vscode.workspace.getConfiguration("spine");
    await config.update("level", "plan", vscode.ConfigurationTarget.Global);
    try {
      const build = api.plans.build();
      assert.equal(build.enabled, false);
      assert.match(build.blocker ?? "", /spine\.level/);
      assert.deepEqual(await api.runs.runs(), []);
      assert.match(api.runs.message() ?? "", /spine\.level/);
    } finally {
      await config.update("level", "build", vscode.ConfigurationTarget.Global);
    }
  });
});
