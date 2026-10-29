import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

describe("in an untrusted folder (D12)", () => {
  const marker = process.env.SPINE_MARKER!;

  it("opens the fixture in Restricted Mode", () => {
    assert.equal(vscode.workspace.isTrusted, false);
  });

  it("starts no Spine process and makes no tool call", async () => {
    const api = await spineApi();
    assert.equal(api.trusted, false);
    await assert.rejects(api.doctor(), (err: Error) => err.name === "RestrictedWorkspaceError");
    await vscode.commands.executeCommand("spine.doctor");
    await sleep(2000);
    assert.equal(fs.existsSync(marker), false, "the sentinel server was started");
  });

  it("shows no lenses on an open file and still starts nothing", async () => {
    const doc = await vscode.workspace.openTextDocument(`${process.env.SPINE_FIXTURE}/shop/cart.py`);
    await vscode.window.showTextDocument(doc);
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", doc.uri);
    assert.deepEqual(lenses, []);
    await sleep(1000);
    assert.equal(fs.existsSync(marker), false, "the sentinel server was started");
  });

  it("opens no plan and still starts nothing", async () => {
    await vscode.commands.executeCommand("spine.openPlan", "CART-1");
    await vscode.commands.executeCommand("spine.approvePlan");
    await assert.rejects((await spineApi()).plans.list(), (err: Error) => err.name === "RestrictedWorkspaceError");
    await sleep(1000);
    assert.equal(fs.existsSync(marker), false, "the sentinel server was started");
    assert.equal(
      vscode.workspace.textDocuments.some((d) => d.uri.scheme === "spine-plan"),
      false,
    );
  });

  it("offers VS Code no Spine server to start", async () => {
    assert.deepEqual((await spineApi()).mcpDefinitions(), []);
  });
});
