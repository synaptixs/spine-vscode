/**
 * SSPN-275's exit criteria: the packaged `.vsix`, installed into a fresh VS Code profile, works
 * as a user gets it. The copy under test is the installed one (its path is inside the fresh
 * extensions folder), not this repository, so VS Code runs it in Production mode, and the
 * integration hooks must not be there.
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { sleep, type SpineApiForTests } from "./helpers";

const root = process.env.SPINE_FIXTURE!;
const ID = process.env.SPINE_PLAN_ID!;
const EXTENSIONS = process.env.SPINE_EXTENSIONS_DIR!;
const VERSION = process.env.SPINE_VSIX_VERSION!;
const COUNTING = "Spine: counting…";

describe("the installed .vsix in a fresh profile (SSPN-275)", () => {
  let ext: vscode.Extension<SpineApiForTests>;

  before(async () => {
    const found = vscode.extensions.getExtension<SpineApiForTests>("synaptixs.spine-vscode");
    assert.ok(found, "synaptixs.spine-vscode is not installed in the fresh profile");
    ext = found;
    await ext.activate();
  });

  it("is the installed copy at the packaged version, not the repository", () => {
    const where = path.resolve(ext.extensionPath);
    assert.ok(where.startsWith(path.resolve(EXTENSIONS) + path.sep), `loaded from ${where}, not from ${EXTENSIONS}`);
    assert.equal(ext.packageJSON.version, VERSION);
  });

  it("does not expose the integration hooks to a user", () => {
    assert.equal(ext.exports.plans, undefined);
  });

  it("registers its commands", async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ["spine.doctor", "spine.openPlan", "spine.approvePlan", "spine.rejectPlan"]) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  it("shows the lenses on a fixture file", async () => {
    const doc = await vscode.workspace.openTextDocument(path.join(root, "shop/cart.py"));
    await vscode.window.showTextDocument(doc);
    let titles: (string | undefined)[] = [];
    for (let i = 0; i < 120; i++) {
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
      titles = lenses.map((l) => l.command?.title);
      if (titles.length && !titles.includes(COUNTING)) break;
      await sleep(500);
    }
    assert.deepEqual(titles, ["2 callers (at least) · 1 untested in reach · 1 possible untraced call"]);
  });

  it("opens a plan from the list", async () => {
    await vscode.commands.executeCommand("spine.openPlan", ID);
    let plan: vscode.TextDocument | undefined;
    for (let i = 0; i < 60 && !plan; i++) {
      plan = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "spine-plan");
      if (!plan) await sleep(500);
    }
    assert.ok(plan, "no plan document opened");
    assert.match(plan.getText(), /Show the cart total with tax/);
  });
});
