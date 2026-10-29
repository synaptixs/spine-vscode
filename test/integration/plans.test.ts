/**
 * SSPN-243 in a real VS Code, against the real Spine, on a throwaway copy of the fixture holding
 * one plan (test/support/planFixture.ts): the picker's list, the read-only document and its
 * Markdown preview, an approval under the git name, stale after an edit, and a decision on a plan
 * edited after it was read refused.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

const ID = process.env.SPINE_PLAN_ID!;
const PLAN_FILE = process.env.SPINE_PLAN_FILE!;

const planDocument = () => vscode.workspace.textDocuments.find((d) => d.uri.scheme === "spine-plan");

async function until<T>(what: string, probe: () => T | undefined): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const found = probe();
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`never saw ${what}`);
}

describe("plan review in the editor (SSPN-243)", () => {
  before(async () => {
    await spineApi();
  });

  it("lists the folder's plans", async () => {
    const listed = await (await spineApi()).plans.list();
    assert.deepEqual(
      listed.plans.map((p) => [p.intent_id, p.state]),
      [[ID, "none"]],
    );
  });

  it("opens a plan read-only, in the Markdown preview, with who would approve it", async () => {
    await vscode.commands.executeCommand("spine.openPlan", ID);
    const doc = await until("the plan document", planDocument);
    assert.equal(doc.getText(), fs.readFileSync(PLAN_FILE, "utf8"));
    assert.equal(doc.languageId, "markdown");
    // A content provider, not a file system: there is nothing the editor could save it to.
    assert.equal(vscode.workspace.fs.isWritableFileSystem("spine-plan"), undefined);
    await until("the Markdown preview", () =>
      vscode.window.tabGroups.all
        .flatMap((g) => g.tabs)
        .find((t) => t.input instanceof vscode.TabInputWebview && /markdown\.preview/.test(t.input.viewType)),
    );
    const view = (await spineApi()).plans.current();
    assert.equal(view?.intentId, ID);
    assert.equal(view?.state, "none");
    assert.equal(view?.approver, "Spine Test");
    assert.equal(view?.canDecide, true, view?.reason);
  });

  it("approves it under the git name, bound to the digest shown", async () => {
    const api = await spineApi();
    const shown = api.plans.current()!;
    const after = await api.plans.decide(ID, { reject: false });
    assert.equal(after.state, "approved");
    assert.equal(after.approval?.decided_by, "Spine Test");
    assert.equal(after.approval?.digest, shown.digest);
  });

  it("shows the plan as stale after it is edited on disk", async () => {
    fs.appendFileSync(PLAN_FILE, "\nEdited after the approval.\n");
    await vscode.commands.executeCommand("spine.openPlan", ID);
    const api = await spineApi();
    assert.equal(api.plans.current()?.state, "stale");
    await until("the edit in the open document", () => (planDocument()?.getText().includes("Edited after the approval.") ? true : undefined));
  });

  it("stops offering a decision on open plans when Spine's settings change (review item 7)", async () => {
    const api = await spineApi();
    assert.equal(api.plans.current()?.canDecide, true);
    const spine = vscode.workspace.getConfiguration("spine");
    await spine.update("level", "pkg", vscode.ConfigurationTarget.Global);
    try {
      const view = await until("the plan marked undecidable", () => (api.plans.current()?.canDecide === false ? api.plans.current() : undefined));
      assert.match(view.reason, /settings changed/);
    } finally {
      await spine.update("level", undefined, vscode.ConfigurationTarget.Global);
    }
    await vscode.commands.executeCommand("spine.openPlan", ID);
    assert.equal(api.plans.current()?.canDecide, true);
  });

  it("refuses a decision on a plan edited after it was read, and records nothing", async () => {
    const api = await spineApi();
    fs.appendFileSync(PLAN_FILE, "\nEdited while the reviewer was reading.\n");
    await assert.rejects(api.plans.decide(ID, { reject: false }), /changed since you opened it/);
    const reopened = api.plans.current()!;
    assert.equal(reopened.state, "stale");
    assert.ok(reopened.document.includes("Edited while the reviewer was reading."), "the plan was reopened");
  });
});
