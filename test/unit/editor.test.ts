import * as assert from "node:assert/strict";
import { editorFeatures, mcpNotice, remoteRefusal, remoteServersSupported, START_SERVERS } from "../../src/editor";

/** What each editor's extension host offers, as measured on 2026-10-31 (SSPN-284). */
const VSCODE = { appName: "Visual Studio Code", hasDefinitionProvider: true };
const CURSOR = { appName: "Cursor", hasDefinitionProvider: true }; // a stub that only logs "not supported in Cursor"
const commands = (...ids: string[]) => async () => ["vscode.diff", ...ids];

describe("what this editor really supports (SSPN-284)", () => {
  describe("editorFeatures: the MCP server definition provider", () => {
    it("is real in VS Code", () => {
      assert.deepEqual(editorFeatures(VSCODE), { name: "Visual Studio Code", mcpDefinitions: true });
    });

    it("is a stub in Cursor, though the function is there", () => {
      assert.deepEqual(editorFeatures(CURSOR), { name: "Cursor", mcpDefinitions: false });
    });

    it("is missing in an editor whose API has no provider at all", () => {
      assert.equal(editorFeatures({ appName: "Some Editor", hasDefinitionProvider: false }).mcpDefinitions, false);
    });
  });

  describe("remoteServersSupported: VS Code's own MCP connection, which holds the sign-in (D19)", () => {
    it("is there when invokeTool exists and VS Code can start its servers", async () => {
      assert.equal(await remoteServersSupported(true, commands(START_SERVERS)), true);
    });

    it("is not in Cursor, which has invokeTool (always rejecting) but no command to start servers", async () => {
      assert.equal(await remoteServersSupported(true, commands("vscode.changes")), false);
    });

    it("is not where invokeTool is missing", async () => {
      assert.equal(await remoteServersSupported(false, commands(START_SERVERS)), false);
    });
  });

  it("refuses remote review with the reason and the way out (D119)", () => {
    assert.equal(
      remoteRefusal("Cursor"),
      "remote plan review needs VS Code's MCP sign-in, which Cursor does not give extensions: set spine.server to local, or use VS Code",
    );
  });

  describe("mcpNotice: once, and only where the agent cannot get Spine from here (D118)", () => {
    it("says nothing in VS Code", () => {
      assert.equal(mcpNotice(editorFeatures(VSCODE), false), undefined);
    });

    it("points Cursor at Spine's own install guide, the first time only", () => {
      const notice = mcpNotice(editorFeatures(CURSOR), false);
      assert.ok(notice);
      assert.match(notice, /^Cursor does not take MCP servers from extensions/);
      assert.match(notice, /AGENT_GUIDE\.md#cursor/);
      assert.match(notice, /lenses, plans and runs here work as they are/);
      assert.equal(mcpNotice(editorFeatures(CURSOR), true), undefined);
    });
  });
});
