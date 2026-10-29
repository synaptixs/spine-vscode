/**
 * SSPN-242's exit criteria in a real VS Code: opening a Python and a TypeScript file in the fixture
 * shows the counts and stalls neither, and a symbol with untraced calls is not shown as having none.
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import { sleep, spineApi } from "./helpers";

const root = process.env.SPINE_FIXTURE!;
const COUNTING = "Spine: counting…";

async function open(rel: string): Promise<vscode.Uri> {
  const doc = await vscode.workspace.openTextDocument(path.join(root, rel));
  await vscode.window.showTextDocument(doc);
  return doc.uri;
}

const lensesAt = (uri: vscode.Uri) =>
  vscode.commands.executeCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri);

async function settled(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
  for (let i = 0; i < 120; i++) {
    const lenses = await lensesAt(uri);
    if (lenses.length && !lenses.some((l) => l.command?.title === COUNTING)) return lenses;
    await sleep(500);
  }
  throw new Error(`lenses for ${uri.fsPath} never settled`);
}

const titles = (lenses: vscode.CodeLens[]) =>
  lenses.map((l) => [l.range.start.line, l.command?.title] as const).sort((a, b) => a[0] - b[0]);

describe("CodeLens and hover in the fixture (SSPN-242)", () => {
  before(async () => {
    await spineApi();
  });

  it("answers at once while Spine counts, so opening a file never waits on the server", async () => {
    const uri = await open("shop/checkout.py");
    const t0 = Date.now();
    const first = await lensesAt(uri);
    const took = Date.now() - t0;
    console.log(`      first lenses in ${took} ms: ${first.map((l) => l.command?.title).join(" | ")}`);
    assert.ok(took < 2000, `the provider took ${took} ms`);
  });

  it("shows a Python file's counts, with its untraced call, never as none", async () => {
    const t0 = Date.now();
    const lenses = await settled(await open("shop/cart.py"));
    console.log(`      shop/cart.py settled in ${Date.now() - t0} ms`);
    assert.deepEqual(titles(lenses), [[0, "2 callers (at least) · 1 untested in reach · 1 possible untraced call"]]);
  });

  it("shows a TypeScript file's counts and says untraced calls are not tracked", async () => {
    const lenses = await settled(await open("web/price.ts"));
    assert.deepEqual(titles(lenses), [
      [0, "1 caller (at least) · 1 untested in reach · untraced calls not tracked for typescript"],
      [4, "0 callers (at least) · untraced calls not tracked for typescript"],
    ]);
  });

  it("explains a symbol on hover", async () => {
    const uri = await open("shop/cart.py");
    await settled(uri);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      new vscode.Position(0, 6),
    );
    const text = hovers
      .flatMap((h) => h.contents)
      .map((c) => (typeof c === "string" ? c : "value" in c ? c.value : ""))
      .join("\n");
    assert.match(text, /cart_total/);
    assert.match(text, /Function/);
    assert.match(text, /Called by 2 \(at least/);
  });

  it("points a lens at the callers", async () => {
    const uri = await open("shop/cart.py");
    const [lens] = await settled(uri);
    assert.equal(lens.command?.command, "spine.showCallers");
    const where = await vscode.commands.executeCommand<vscode.Location[]>(
      "spine.showCallers",
      ...(lens.command?.arguments ?? []),
    );
    const at = where.map((l) => `${path.relative(root, l.uri.fsPath)}:${l.range.start.line + 1}`).sort();
    assert.deepEqual(at, ["shop/checkout.py:5", "tests/test_cart.py:5"]);
  });
});
