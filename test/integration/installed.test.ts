/**
 * SSPN-275's exit criteria: the packaged `.vsix`, installed into a fresh VS Code profile, works
 * as a user gets it. The copy under test is the installed one (its path is inside the fresh
 * extensions folder), not this repository, so VS Code runs it in Production mode, and the
 * integration hooks must not be there. SSPN-247 widens it to P3–P5: every contributed command,
 * the Runs view, and a requirement planned from the installed copy. In CI the `.vsix` is the one
 * the check job built, on another runner (`SPINE_VSIX`, D113).
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { sleep, type SpineApiForTests } from "./helpers";

const root = process.env.SPINE_FIXTURE!;
const ID = process.env.SPINE_PLAN_ID!;
const EXTENSIONS = process.env.SPINE_EXTENSIONS_DIR!;
const VERSION = process.env.SPINE_VSIX_VERSION!;
const REQUIREMENT_ID = process.env.SPINE_REQUIREMENT_ID;
const REQUIREMENT_FILE = process.env.SPINE_REQUIREMENT_FILE;
const COUNTING = "Spine: counting…";

describe("the installed .vsix in a fresh profile (SSPN-275, SSPN-247)", () => {
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

  // SSPN-284: the same .vsix in VS Code and in Cursor. Cursor stubs the MCP definition provider
  // and has no MCP connection of VS Code's own, so the installed copy must know that, not guess it.
  it("knows what this editor supports", async () => {
    const cursor = vscode.env.appName === "Cursor";
    assert.deepEqual(await ext.exports.editor(), { name: vscode.env.appName, mcpDefinitions: !cursor, remoteServers: !cursor });
  });

  // The other half of the same guard: where the definition provider is real, VS Code's own MCP
  // list must hold Spine (as the D8 probe found). Nothing else checks the registration itself.
  it("offers VS Code's chat the Spine server, where the editor takes one", async function () {
    if (!(await ext.exports.editor()).mcpDefinitions) this.skip();
    // Extension-provided servers load lazily: only the "MCP: List Servers" quick pick (or chat)
    // makes VS Code ask providers, so open and close it first (D8 probe, 2026-10-27: without it
    // `startServer *` ran in 4 ms and listed no Spine tool).
    void vscode.commands.executeCommand("workbench.mcp.listServer");
    await sleep(3000);
    await vscode.commands.executeCommand("workbench.action.closeQuickOpen");
    await vscode.commands.executeCommand("workbench.mcp.startServer", "*", { waitForLiveTools: true, autoTrustChanges: true });
    let names: string[] = [];
    for (let i = 0; i < 60 && !names.length; i++) {
      names = vscode.lm.tools.map((t) => t.name).filter((n) => n.endsWith("_doctor"));
      if (!names.length) await sleep(500);
    }
    assert.equal(names.length, 1, `Spine's tools are not in VS Code's MCP list: ${vscode.lm.tools.map((t) => t.name).join(", ")}`);
  });

  it("registers every command it contributes, and its Runs view", async () => {
    const commands = await vscode.commands.getCommands(true);
    const contributed = (ext.packageJSON as { contributes: { commands: { command: string }[] } }).contributes.commands.map((c) => c.command);
    assert.ok(contributed.length >= 23, `only ${contributed.length} commands contributed`);
    const missing = contributed.filter((id) => !commands.includes(id));
    assert.deepEqual(missing, [], `contributed but not registered: ${missing.join(", ")}`);
    // VS Code adds a focus command for each contributed view (SSPN-244's Runs view).
    assert.ok(commands.includes("spine.runs.focus"), "the Runs view is not contributed");
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

  // SSPN-246 from the installed copy: a requirement whose spec run.ts cached through Spine's own
  // Python plans with no dialog, for $0, and its plan opens for review.
  it("plans a cached Markdown requirement and opens its plan", async () => {
    assert.ok(REQUIREMENT_FILE && REQUIREMENT_ID, "run.ts seeded no requirement for the installed copy");
    await vscode.commands.executeCommand("spine.planThisRequirement", vscode.Uri.file(REQUIREMENT_FILE));
    let plan: vscode.TextDocument | undefined;
    for (let i = 0; i < 240 && !plan; i++) {
      plan = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "spine-plan" && d.uri.path === `/${REQUIREMENT_ID}.md`);
      if (!plan) await sleep(250);
    }
    assert.ok(plan, `no plan document opened for ${REQUIREMENT_ID}`);
    assert.match(plan.getText(), new RegExp(REQUIREMENT_ID));
  });
});
