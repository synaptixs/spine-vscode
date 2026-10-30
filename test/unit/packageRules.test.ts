import * as assert from "node:assert/strict";
import { MAX_FILE_BYTES, packageProblems } from "../support/packageRules";

const ok = (path: string, size = 100) => ({ path: `extension/${path}`, size });
// The smallest package that is otherwise fine: a manifest and the built entry point.
const base = () => [ok("package.json"), ok("out/src/extension.js")];

describe("what a .vsix may hold (SSPN-275)", () => {
  it("accepts what a user needs: the manifest, the built extension, its runtime deps, the docs", () => {
    const entries = [
      { path: "extension.vsixmanifest", size: 900 },
      { path: "[Content_Types].xml", size: 400 },
      ok("package.json"),
      ok("README.md"),
      ok("CHANGELOG.md"),
      ok("LICENSE.txt"),
      ok("out/src/extension.js"),
      ok("node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js"),
    ];
    assert.deepEqual(packageProblems(entries), []);
  });

  for (const path of [
    "src/extension.ts",
    "test/unit/launch.test.ts",
    "out/test/unit/launch.test.js",
    "test/fixture/.repo/shop/cart.py",
    "test/keycloak/realm-spine-test.json",
    "out/src/extension.js.map",
    ".vscode-test/vscode-darwin-arm64-1.142.0/x",
    ".github/workflows/ci.yml",
    ".devcontainer/devcontainer.json",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    "tsconfig.json",
    "eslint.config.mjs",
    "spine-vscode-0.0.9.vsix",
  ]) {
    it(`refuses ${path}`, () => {
      const problems = packageProblems([...base(), ok(path)]);
      assert.equal(problems.length, 1, `expected one problem for ${path}, got ${JSON.stringify(problems)}`);
      assert.match(problems[0], new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  }

  it("refuses a file over 1 MB, naming it and its size", () => {
    const problems = packageProblems([...base(), ok("out/src/big.js", MAX_FILE_BYTES + 1)]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /out\/src\/big\.js/);
    assert.match(problems[0], /1048577/);
  });

  it("accepts a file of exactly 1 MB", () => {
    assert.deepEqual(packageProblems([...base(), ok("out/src/edge.js", MAX_FILE_BYTES)]), []);
  });

  it("refuses a package with no built entry point", () => {
    const problems = packageProblems([ok("package.json"), ok("README.md")]);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /out\/src\/extension\.js/);
  });
});
