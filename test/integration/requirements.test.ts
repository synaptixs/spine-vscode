/**
 * SSPN-246 in a real VS Code, against the real Spine: "Plan this requirement" on a workspace
 * Markdown file whose spec is already in Spine's intake cache (seeded by run.ts through Spine's own
 * Python, test/support/seedIntake.ts) plans it with no confirm, for $0, and opens the plan in the
 * review (D75).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

const ID = process.env.SPINE_REQUIREMENT_ID!;
const FILE = process.env.SPINE_REQUIREMENT_FILE!;
const REMOTE_FILE = process.env.SPINE_REMOTE_FILE!;

async function until<T>(what: string, probe: () => T | undefined, tries = 240): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const found = probe();
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`never saw ${what}`);
}

describe("Plan from requirement in the editor (SSPN-246)", () => {
  before(async () => {
    await spineApi();
  });

  it("offers both commands, and the requirement one on a Markdown file's menus", async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("spine.planFromRequirement"));
    assert.ok(commands.includes("spine.planThisRequirement"));
    const menus = (vscode.extensions.getExtension("synaptixs.spine-vscode")?.packageJSON as {
      contributes: { menus: Record<string, { command: string; when?: string }[]> };
    }).contributes.menus;
    for (const where of ["explorer/context", "editor/context"]) {
      const item = menus[where]?.find((m) => m.command === "spine.planThisRequirement");
      assert.ok(item, `no Plan this requirement on ${where}`);
      assert.match(item.when ?? "", /resourceExtname == \.md/);
    }
  });

  it("plans a cached requirement with no confirm and opens its plan for review", async () => {
    await vscode.commands.executeCommand("spine.planThisRequirement", vscode.Uri.file(FILE));
    const doc = await until("the plan document", () =>
      vscode.workspace.textDocuments.find((d) => d.uri.scheme === "spine-plan" && d.uri.path === `/${ID}.md`),
    );
    assert.match(doc.getText(), new RegExp(ID));
    const api = await spineApi();
    assert.equal(api.plans.current()?.intentId, ID);
    assert.equal(api.plans.current()?.state, "none");
    const listed = await api.plans.list();
    assert.deepEqual(
      listed.plans.map((p) => p.intent_id),
      [ID],
    );
  });

  it("plans nothing while spine.server names a remote server (D109)", async () => {
    const settings = vscode.workspace.getConfiguration("spine");
    await settings.update("server", "company-spine", vscode.ConfigurationTarget.Workspace);
    try {
      await vscode.commands.executeCommand("spine.planThisRequirement", vscode.Uri.file(REMOTE_FILE));
      await sleep(3000);
      const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
      assert.equal(fs.existsSync(path.join(root, ".spine", "plans", "CART-10-build.md")), false, "a remote spine.server planned on this machine");
    } finally {
      await settings.update("server", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
