import * as assert from "node:assert/strict";
import { spineLaunch } from "../../src/launch";

// Copied by hand from the pinned variant in Spine's AGENT_GUIDE §3 (3.63.1). A literal on
// purpose: drift in the version or in the extras list must fail here, not in a user's editor.
const GUIDE_PINNED_FROM = "synaptixs-spine[mcp,docs,c,cpp,csharp,go,java,kotlin,perl,php,sql,typescript]==3.63.1";

describe("spineLaunch", () => {
  it("starts Spine with the guide's pinned uvx line by default", () => {
    assert.deepEqual(spineLaunch(), {
      command: "uvx",
      args: ["--python", ">=3.12", "--from", GUIDE_PINNED_FROM, "orchestrator-mcp"],
    });
  });

  it("asks uv for Python 3.12 or newer, so an older system Python is not picked", () => {
    // Measured in the Dev Container (Debian 12, python3 = 3.11): without it uvx refuses to resolve.
    const args = spineLaunch().args;
    assert.deepEqual(args.slice(0, 2), ["--python", ">=3.12"]);
  });

  it("treats an empty or blank setting as the default", () => {
    assert.deepEqual(spineLaunch(""), spineLaunch());
    assert.deepEqual(spineLaunch("   "), spineLaunch());
  });

  it("runs an installed orchestrator-mcp when the setting names one", () => {
    assert.deepEqual(spineLaunch(" /opt/spine/bin/orchestrator-mcp "), {
      command: "/opt/spine/bin/orchestrator-mcp",
      args: [],
    });
  });
});
