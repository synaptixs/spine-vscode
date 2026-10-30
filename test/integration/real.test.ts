import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { spineApi } from "./helpers";

describe("in a trusted folder, with the real pinned server", () => {
  it("drives Spine over stdio from the extension host", async () => {
    const api = await spineApi();
    const t0 = Date.now();
    const report = (await api.doctor()) as { server: { version: string } };
    console.log(`      doctor from the extension host in ${Date.now() - t0} ms`);
    assert.equal(report.server.version, "3.67.0");
  });

  it("offers VS Code the pinned uvx line as its Spine server", async () => {
    const defs = (await spineApi()).mcpDefinitions() as vscode.McpStdioServerDefinition[];
    assert.equal(defs.length, 1);
    assert.equal(defs[0].command, "uvx");
    assert.equal(defs[0].args.at(-1), "orchestrator-mcp");
  });
});
