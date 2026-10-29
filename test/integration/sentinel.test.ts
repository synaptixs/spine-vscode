import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

// The untrusted suite's control: the same settings in a trusted folder DO start the sentinel,
// so "no marker" there means the guard held, not that the launch path was broken.
describe("in a trusted folder, with a sentinel server", () => {
  const marker = process.env.SPINE_MARKER!;

  it("is trusted", () => {
    assert.equal(vscode.workspace.isTrusted, true);
  });

  it("starts the configured server when a tool is called", async () => {
    const api = await spineApi();
    assert.equal(api.trusted, true);
    await assert.rejects(api.doctor());
    await sleep(500);
    assert.equal(fs.existsSync(marker), true, "the sentinel server was not started");
  });

  it("offers VS Code one Spine server with the configured command", async () => {
    const defs = (await spineApi()).mcpDefinitions();
    assert.equal(defs.length, 1);
    assert.ok(defs[0] instanceof vscode.McpStdioServerDefinition);
    assert.equal((defs[0] as vscode.McpStdioServerDefinition).command.endsWith("fake-orchestrator-mcp"), true);
  });

  it("serves VS Code's chat at the spine.level setting, `plan` by default (D41)", async () => {
    const defs = (await spineApi()).mcpDefinitions();
    assert.deepEqual((defs[0] as vscode.McpStdioServerDefinition).env, { ORCHESTRATOR_MCP_LEVEL: "plan" });
  });

  it("offers no local server while spine.server names a remote one (D49)", async () => {
    const spine = vscode.workspace.getConfiguration("spine");
    await spine.update("server", "company-spine", vscode.ConfigurationTarget.Global);
    try {
      assert.deepEqual((await spineApi()).mcpDefinitions(), []);
    } finally {
      await spine.update("server", undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal((await spineApi()).mcpDefinitions().length, 1);
  });
});
