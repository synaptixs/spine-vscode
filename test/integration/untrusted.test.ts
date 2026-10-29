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

  it("offers VS Code no Spine server to start", async () => {
    assert.deepEqual((await spineApi()).mcpDefinitions(), []);
  });
});
