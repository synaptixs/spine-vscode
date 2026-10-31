import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { releaseProblems } from "../support/releaseRules";

const ROOT = path.resolve(__dirname, "../../..");
const read = (name: string) => fs.readFileSync(path.join(ROOT, name), "utf8");

const CHANGELOG = "# Changelog\n\n## Unreleased\n\n## 0.2.0 — 2026-10-31\n\n- Plan from requirement.\n\n## 0.1.0 — 2026-10-30\n";
const README = "You get `spine-vscode-0.2.0.vsix`.\n\n```bash\ncode --install-extension spine-vscode-0.2.0.vsix\n```\n";

describe("what a release says about itself (SSPN-247)", () => {
  it("accepts a CHANGELOG section and README install lines for the package's version", () => {
    assert.deepEqual(releaseProblems("0.2.0", CHANGELOG, README), []);
  });

  it("refuses a CHANGELOG with no section for the version", () => {
    assert.deepEqual(releaseProblems("0.3.0", CHANGELOG, README.replaceAll("0.2.0", "0.3.0")), ['CHANGELOG.md has no "## 0.3.0" section']);
  });

  it("does not take a longer version, or an Unreleased section, for the version's own", () => {
    assert.deepEqual(releaseProblems("0.2", "## 0.2.0 — x\n", "spine-vscode-0.2.vsix"), [
      'CHANGELOG.md has no "## 0.2" section',
      "README.md names no spine-vscode-<version>.vsix to install",
    ]);
    assert.deepEqual(releaseProblems("0.2.0", "## Unreleased\n- 0.2.0\n", README), ['CHANGELOG.md has no "## 0.2.0" section']);
  });

  it("refuses a README that still names the last release's .vsix", () => {
    const stale = README.replace("code --install-extension spine-vscode-0.2.0.vsix", "code --install-extension spine-vscode-0.1.0.vsix");
    assert.deepEqual(releaseProblems("0.2.0", CHANGELOG, stale), ["README.md names spine-vscode-0.1.0.vsix, not 0.2.0"]);
  });

  it("refuses a README that names no .vsix to install", () => {
    assert.deepEqual(releaseProblems("0.2.0", CHANGELOG, "Install it from the Marketplace.\n"), ["README.md names no spine-vscode-<version>.vsix to install"]);
  });

  it("holds for this repository at package.json's version", () => {
    const version = JSON.parse(read("package.json")).version as string;
    assert.deepEqual(releaseProblems(version, read("CHANGELOG.md"), read("README.md")), []);
  });
});
