import * as assert from "node:assert/strict";
import { fetchArgs, parseStatus, patchFiles } from "../../src/diffs";

describe("the files a review shows (D96)", () => {
  it("reads `git status --porcelain=v1 -z -uall`: added, modified, deleted, untracked", () => {
    const z = ["M  src/tax.py", " M src/cart.py", "D  old.py", "A  tests/test_tax.py", "?? notes/new file.md", ""].join("\0");
    assert.deepEqual(parseStatus(z), [
      { path: "notes/new file.md", status: "added" },
      { path: "old.py", status: "deleted" },
      { path: "src/cart.py", status: "modified" },
      { path: "src/tax.py", status: "modified" },
      { path: "tests/test_tax.py", status: "added" },
    ]);
  });

  it("reads a rename, whose old path is the next field", () => {
    const z = ["R  src/price.py", "src/cost.py", "M  README.md", ""].join("\0");
    assert.deepEqual(parseStatus(z), [
      { path: "README.md", status: "modified" },
      { path: "src/price.py", status: "renamed", from: "src/cost.py" },
    ]);
  });

  it("an empty status is no change", () => {
    assert.deepEqual(parseStatus(""), []);
  });

  it("names the files of a saved patch, new and deleted ones included", () => {
    const patch = [
      "diff --git a/src/tax.py b/src/tax.py",
      "index 1..2 100644",
      "--- a/src/tax.py",
      "+++ b/src/tax.py",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "diff --git a/tests/test_tax.py b/tests/test_tax.py",
      "new file mode 100644",
      "diff --git a/old.py b/old.py",
      "deleted file mode 100644",
      "",
    ].join("\n");
    assert.deepEqual(patchFiles(patch), ["old.py", "src/tax.py", "tests/test_tax.py"]);
  });
});

describe("Fetch into my checkout (D99)", () => {
  it("creates the local branch only: an explicit refspec, never forced", () => {
    const args = fetchArgs("/cache/spine/wt-1", "feat/INT-7/tax");
    assert.deepEqual(args, ["fetch", "--no-tags", "/cache/spine/wt-1", "refs/heads/feat/INT-7/tax:refs/heads/feat/INT-7/tax"]);
    assert.equal(args.some((a) => a.startsWith("+") || a === "--force" || a === "-f"), false);
  });
});
