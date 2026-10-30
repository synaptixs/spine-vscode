import * as assert from "node:assert/strict";
import { spineLaunch } from "../../src/launch";

// Copied by hand from the pinned variant in Spine's AGENT_GUIDE §3 (3.67.0). A literal on
// purpose: drift in the version or in the extras list must fail here, not in a user's editor.
const GUIDE_PINNED_FROM = "synaptixs-spine[mcp,docs,c,cpp,csharp,go,java,kotlin,perl,php,sql,typescript]==3.67.0";

describe("spineLaunch", () => {
  it("starts Spine with the guide's pinned uvx line by default", () => {
    assert.deepEqual(spineLaunch(undefined, undefined, {}), {
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
    assert.deepEqual(spineLaunch(" /opt/spine/bin/orchestrator-mcp ", undefined, {}), {
      command: "/opt/spine/bin/orchestrator-mcp",
      args: [],
    });
  });

  it("passes the level to the server, and nothing when there is none", () => {
    assert.deepEqual(spineLaunch(undefined, "plan", {}).env, { ORCHESTRATOR_MCP_LEVEL: "plan" });
    assert.deepEqual(spineLaunch(" /opt/spine/bin/orchestrator-mcp ", " build ", {}).env, { ORCHESTRATOR_MCP_LEVEL: "build" });
    assert.equal("env" in spineLaunch(undefined, "", {}), false);
    assert.equal("env" in spineLaunch(undefined, undefined, {}), false);
  });

  // D88: the MCP SDK hands the server only HOME, LOGNAME, PATH, SHELL, TERM and USER. Without the
  // temp dir Spine keeps its runs under /tmp, a different store from `sdlc runs` in a terminal.
  it("passes where Spine keeps its runs, so the panel and the terminal share one store", () => {
    const inherited = { TMPDIR: "/var/folders/x/T/", SPINE_RUN_STATE: "/runs/state", SPINE_RUN_ARTIFACTS: "/runs/art" };
    assert.deepEqual(spineLaunch(undefined, "build", inherited).env, {
      ORCHESTRATOR_MCP_LEVEL: "build",
      TMPDIR: "/var/folders/x/T/",
      SPINE_RUN_STATE: "/runs/state",
      SPINE_RUN_ARTIFACTS: "/runs/art",
    });
    assert.deepEqual(spineLaunch("/opt/orchestrator-mcp", undefined, { TMPDIR: "/t" }).env, { TMPDIR: "/t" });
  });

  it("passes no key, budget or other variable: those come from the checkout's .env", () => {
    const inherited = {
      TMPDIR: "/t",
      ANTHROPIC_API_KEY: "k",
      OPENAI_API_KEY: "k",
      SDLC_RUN_BUDGET_USD: "100",
      ORCHESTRATOR_MCP_LEVEL: "build",
      PATH: "/bin",
      SPINE_RUN_STATE: "",
    };
    assert.deepEqual(spineLaunch(undefined, "plan", inherited).env, { ORCHESTRATOR_MCP_LEVEL: "plan", TMPDIR: "/t" });
  });

  it("reads the extension host's own environment by default", () => {
    const saved = process.env.SPINE_RUN_STATE;
    process.env.SPINE_RUN_STATE = "/from/the/host";
    try {
      assert.equal(spineLaunch(undefined, "plan").env?.SPINE_RUN_STATE, "/from/the/host");
    } finally {
      if (saved === undefined) delete process.env.SPINE_RUN_STATE;
      else process.env.SPINE_RUN_STATE = saved;
    }
  });
});
