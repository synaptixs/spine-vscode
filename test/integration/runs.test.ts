/**
 * SSPN-244 in a real VS Code, against the real Spine at `spine.level=build`, on a throwaway copy of
 * the fixture holding one plan, with runs seeded in a store of the suite's own (test/integration/run.ts).
 * The Runs view reading that store at all is the proof that the extension hands its server the
 * run store's location (D88). Nothing is built: no build is started here.
 */
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as vscode from "vscode";
import { spineApi } from "./helpers";

const ID = process.env.SPINE_PLAN_ID!;

describe("the Runs view and the Build button (SSPN-244)", () => {
  before(async () => {
    await spineApi();
  });

  it("lists this checkout's seeded runs, with what each offers, and not another repository's", async () => {
    const runs = await (await spineApi()).runs.runs();
    const byId = new Map(runs.map((r) => [r.runId, r]));
    assert.deepEqual([...byId.keys()].sort(), ["budget0000000001", "done000000000001", "review0000000001"]);
    const budget = byId.get("budget0000000001")!;
    assert.deepEqual(budget.actions, ["raiseCapAndResume", "drop", "openPlan"]);
    assert.match(budget.text.description, /budget/);
    assert.match(budget.text.description, /\$3\.50/);
    assert.deepEqual(byId.get("review0000000001")!.actions, ["review", "cancel", "openWorktree", "openPlan"]);
    assert.deepEqual(byId.get("done000000000001")!.actions, ["fetch", "openWorktree", "openPlan"]);
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

  it("Review opens every changed file of the run's worktree read-only, and the bound patch (SSPN-245, D96)", async () => {
    const api = await spineApi();
    const opened = await api.runs.review("review0000000001");
    assert.deepEqual(
      opened.files.map((f) => `${f.status} ${f.path}`),
      ["deleted old.py", "modified tax.py", "added test_tax.py"],
    );
    const tax = opened.files.find((f) => f.path === "tax.py")!;
    const left = await vscode.workspace.openTextDocument(vscode.Uri.parse(tax.left));
    const right = await vscode.workspace.openTextDocument(vscode.Uri.parse(tax.right));
    assert.equal(left.uri.scheme, "spine-diff");
    assert.equal(right.uri.scheme, "spine-diff");
    assert.match(left.getText(), /return x \* 0\.2/);
    assert.match(right.getText(), /round\(x \* 0\.2, 2\)/);
    const added = opened.files.find((f) => f.path === "test_tax.py")!;
    assert.equal((await vscode.workspace.openTextDocument(vscode.Uri.parse(added.left))).getText(), "");
    // One multi-file diff editor (`vscode.changes`), not the per-file fallback.
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs.map((t) => t.label));
    assert.ok(tabs.includes("Spine review: REVIEW-1 (3 files)"), `tabs: ${tabs.join(", ")}`);
    const patch = await vscode.workspace.openTextDocument(vscode.Uri.parse(opened.patch));
    assert.equal(patch.uri.scheme, "spine-patch");
    assert.match(patch.getText(), /^diff --git a\/old\.py b\/old\.py/m);
    assert.match(patch.getText(), /^diff --git a\/test_tax\.py b\/test_tax\.py/m);
  });

  it("Approve decides the review on the digest that was opened, and the run stops waiting", async () => {
    const api = await spineApi();
    assert.equal(await api.runs.approveReview("review0000000001", "reads right"), true);
    const review = (await api.runs.runs()).find((r) => r.runId === "review0000000001")!;
    assert.equal(review.actions.includes("review"), false);
  });

  it("Fetch into my checkout creates the branch and leaves HEAD and the working tree alone (D99)", async () => {
    const api = await spineApi();
    const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
    // The fixture checkout may have no commit yet: HEAD is then a branch with no commit, which
    // `symbolic-ref` still names, and `rev-parse --verify -q` answers with nothing.
    const git = (...args: string[]) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;
    const before = [git("symbolic-ref", "HEAD"), git("rev-parse", "--verify", "-q", "HEAD"), git("status", "--porcelain")];
    assert.equal(await api.runs.fetch("done000000000001"), true);
    assert.match(git("rev-parse", "--verify", "refs/heads/feat/DONE-1/tax"), /^[0-9a-f]{40}/);
    assert.deepEqual([git("symbolic-ref", "HEAD"), git("rev-parse", "--verify", "-q", "HEAD"), git("status", "--porcelain")], before);
    assert.match(before[0], /^refs\/heads\//);
  });
});
