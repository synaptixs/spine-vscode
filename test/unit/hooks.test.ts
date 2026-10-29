import * as assert from "node:assert/strict";
import { exposesTestHooks } from "../../src/hooks";

// vscode.ExtensionMode's values: Production 1, Development 2, Test 3.
const PRODUCTION = 1;

describe("test hooks (D51, revised in step E)", () => {
  it("are never exposed to an installed extension", () => {
    assert.equal(exposesTestHooks(1, PRODUCTION), false);
  });

  it("are exposed when the extension is loaded from source: test runs and development windows", () => {
    assert.equal(exposesTestHooks(3, PRODUCTION), true);
    assert.equal(exposesTestHooks(2, PRODUCTION), true);
  });
});
