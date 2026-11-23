import * as assert from "node:assert/strict";
import { ChooseFolderError, containing, FolderChoice } from "../../src/folders";

const APP = "/work/app";
const DOCS = "/work/docs";
const NESTED = "/work/app/packages/ui";

describe("which folder a request uses (B178, SSPN-404, D123)", () => {
  it("a file belongs to the deepest open folder that holds it", () => {
    assert.equal(containing("/work/app/src/a.ts", [APP, DOCS]), APP);
    assert.equal(containing("/work/app/packages/ui/b.tsx", [APP, NESTED]), NESTED);
    assert.equal(containing("/work/application/c.ts", [APP]), undefined, "a shared prefix is not a parent");
    assert.equal(containing("/elsewhere/d.ts", [APP, DOCS]), undefined);
  });

  it("with one folder open, that folder, whatever is in front", () => {
    const choice = new FolderChoice();
    assert.deepEqual(choice.current([APP]), { folder: APP, why: "only" });
    choice.focus("/elsewhere/x.ts", [APP]);
    assert.deepEqual(choice.current([APP]), { folder: APP, why: "only" });
  });

  it("with several open, the folder of the file last in front, not the first folder", () => {
    const choice = new FolderChoice();
    assert.equal(choice.focus("/work/docs/README.md", [APP, DOCS]), true);
    assert.deepEqual(choice.current([APP, DOCS]), { folder: DOCS, why: "active" });
  });

  it("a document outside every folder (a plan, a diff) keeps the folder you were in", () => {
    const choice = new FolderChoice();
    choice.focus("/work/docs/README.md", [APP, DOCS]);
    assert.equal(choice.focus(undefined, [APP, DOCS]), false);
    assert.equal(choice.focus("/elsewhere/x.ts", [APP, DOCS]), false);
    assert.deepEqual(choice.current([APP, DOCS]), { folder: DOCS, why: "active" });
  });

  it("with several open and nothing in front, the folder chosen before, remembered", () => {
    const remembered = new FolderChoice(DOCS);
    assert.deepEqual(remembered.current([APP, DOCS]), { folder: DOCS, why: "chosen" });
  });

  it("with several open, nothing in front and nothing chosen, it asks: never the first folder", () => {
    const choice = new FolderChoice();
    assert.deepEqual(choice.current([APP, DOCS]), { folder: undefined, why: "ambiguous" });
    assert.throws(() => choice.require([APP, DOCS]), ChooseFolderError);
    assert.throws(() => choice.require([APP, DOCS]), /several folders are open: choose one with Spine: Choose folder/);
  });

  it("choosing a folder wins until a file in another folder comes in front", () => {
    const choice = new FolderChoice();
    choice.focus("/work/app/src/a.ts", [APP, DOCS]);
    choice.choose(DOCS);
    assert.deepEqual(choice.current([APP, DOCS]), { folder: DOCS, why: "chosen" });
    choice.focus("/work/app/src/a.ts", [APP, DOCS]);
    assert.deepEqual(choice.current([APP, DOCS]), { folder: APP, why: "active" });
  });

  it("a folder that was closed is forgotten", () => {
    const choice = new FolderChoice(DOCS);
    assert.deepEqual(choice.current([APP, NESTED]), { folder: undefined, why: "ambiguous" });
    choice.focus("/work/app/src/a.ts", [APP, NESTED]);
    assert.deepEqual(choice.current([NESTED, DOCS]), { folder: undefined, why: "ambiguous" });
  });

  it("no folder open: none, and the request says to open one", () => {
    const choice = new FolderChoice();
    assert.deepEqual(choice.current([]), { folder: undefined, why: "none" });
    assert.equal(choice.require([]), undefined);
  });
});
