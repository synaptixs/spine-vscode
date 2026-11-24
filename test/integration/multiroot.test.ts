/**
 * B178 (SSPN-404, D123) in a real VS Code, against the real Spine: a window with two folders. The
 * first holds no plan, the second holds one. Spine used to read the first folder whatever was in
 * front; now it reads the folder of the file in front, and with nothing in front it asks.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

const EMPTY = process.env.SPINE_EMPTY_FOLDER!;
const PLANNED = process.env.SPINE_PLANNED_FOLDER!;
const ID = process.env.SPINE_PLAN_ID!;

async function focus(file: string): Promise<void> {
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
  await sleep(300); // the folder moves on VS Code's own active-editor event
}

async function until<T>(what: string, probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const found = probe();
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`never saw ${what}`);
}

const planFileIn = (root: string) => path.join(root, ".spine", "plans", `${ID}-build.md`);

describe("a window with several folders (B178, SSPN-404)", () => {
  before(async () => {
    await spineApi();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  it("opens with both folders, the empty one first", () => {
    assert.deepEqual(
      vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath),
      [EMPTY, PLANNED],
    );
  });

  it("with nothing in front and nothing chosen, asks for a folder instead of reading the first", async () => {
    await assert.rejects((await spineApi()).plans.list(), /several folders are open: choose one with Spine: Choose folder/);
  });

  it("reads the folder of the file in front: the second folder's plan", async () => {
    await focus(path.join(PLANNED, "shop", "cart.py"));
    const listed = await (await spineApi()).plans.list();
    assert.deepEqual(listed.plans.map((p) => p.intent_id), [ID]);
  });

  it("moves with the file in front: the first folder has no plan", async () => {
    await focus(path.join(EMPTY, "shop", "cart.py"));
    const listed = await (await spineApi()).plans.list();
    assert.deepEqual(listed.plans, []);
  });

  it("a plan opened in one folder is not decided in the other", async () => {
    await focus(path.join(PLANNED, "shop", "cart.py"));
    await vscode.commands.executeCommand("spine.openPlan", ID);
    await focus(path.join(EMPTY, "shop", "cart.py"));
    await assert.rejects((await spineApi()).plans.decide(ID, { reject: false }), /opened in .*, and Spine now points at .*: open it again/);
  });

  it("saving a spec re-plans in the spec's own folder while another folder's file is in front (review of #14)", async () => {
    await focus(path.join(PLANNED, "shop", "cart.py"));
    await vscode.commands.executeCommand("spine.openPlan", ID);
    await vscode.commands.executeCommand("spine.editSpec");
    const specDoc = await until("the spec in an editor", () =>
      vscode.window.activeTextEditor?.document.uri.fsPath.endsWith(`${ID}-spec.json`) ? vscode.window.activeTextEditor.document : undefined,
    );
    const spec = JSON.parse(specDoc.getText()) as { title: string };
    spec.title = `${spec.title} (saved from the other folder)`;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(specDoc.uri, new vscode.Range(0, 0, specDoc.lineCount, 0), JSON.stringify(spec, null, 2));
    await vscode.workspace.applyEdit(edit);
    await focus(path.join(EMPTY, "shop", "cart.py"));
    await specDoc.save();
    await until("the plan re-rendered in its own folder", () => fs.readFileSync(planFileIn(PLANNED), "utf8").includes("(saved from the other folder)") || undefined);
    assert.equal(fs.existsSync(planFileIn(EMPTY)), false, "nothing was planned into the folder in front");
  });
});
