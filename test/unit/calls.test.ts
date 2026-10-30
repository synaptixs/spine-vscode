import * as assert from "node:assert/strict";
import { checked, localCalls, type LmTools, PlanMovedError, remoteCalls, remoteToolName, SpineRefusal } from "../../src/calls";

/** VS Code's tool list, as the D8 probe saw it: the prefix is derived from the server, not its configured name. */
function fakeLm(names: string[], answer: string): LmTools & { seen: [string, unknown][]; started: number } {
  const lm = {
    seen: [] as [string, unknown][],
    started: 0,
    names: () => names,
    invoke: async (name: string, input: Record<string, unknown>) => {
      lm.seen.push([name, input]);
      return answer;
    },
    start: async () => {
      lm.started += 1;
    },
  };
  return lm;
}

describe("SpineCalls", () => {
  describe("checked: Spine refuses with a normal answer carrying `error`", () => {
    it("returns an answer without `error` as it is", () => {
      assert.deepEqual(checked({ plans: [], count: 0 }), { plans: [], count: 0 });
    });

    it("raises a refusal and keeps the answer", () => {
      assert.throws(
        () => checked({ error: "no plan", hint: "run sdlc_plan" }),
        (err: unknown) =>
          err instanceof SpineRefusal &&
          !(err instanceof PlanMovedError) &&
          err.message === "no plan" &&
          err.answer.hint === "run sdlc_plan",
      );
    });

    it("raises PlanMovedError when the refusal names both digests", () => {
      assert.throws(
        () => checked({ error: "the plan for x has changed since it was read", expected_digest: "aaa", digest: "bbb" }),
        (err: unknown) => err instanceof PlanMovedError && err.expected === "aaa" && err.current === "bbb",
      );
    });

    it("refuses an answer that is not an object", () => {
      assert.throws(() => checked("text"), SpineRefusal);
      assert.throws(() => checked(null), SpineRefusal);
    });
  });

  describe("local", () => {
    it("calls the extension's own client and checks the answer", async () => {
      const seen: [string, unknown][] = [];
      const calls = localCalls(() => ({
        callTool: async (name: string, args: Record<string, unknown>) => {
          seen.push([name, args]);
          return { error: "changed", expected_digest: "a", digest: "b" };
        },
      }));
      assert.equal(calls.remote, false);
      assert.equal(calls.server, "local");
      await assert.rejects(calls.call("sdlc_approve", { intent_id: "x" }), PlanMovedError);
      assert.deepEqual(seen, [["sdlc_approve", { intent_id: "x" }]]);
    });
  });

  describe("remote, through VS Code's MCP connection", () => {
    it("finds a tool by its suffix, whatever prefix VS Code derived", () => {
      const names = ["mcp_synaptixs-spi_sdlc_plan_document", "mcp_synaptixs-spi_sdlc_approve", "mcp_synaptixs-spi_doctor"];
      assert.equal(remoteToolName(names, "sdlc_approve"), "mcp_synaptixs-spi_sdlc_approve");
      assert.equal(remoteToolName(names, "sdlc_plan_document"), "mcp_synaptixs-spi_sdlc_plan_document");
    });

    it("refuses when two servers offer the tool, rather than guess which one approves", () => {
      assert.throws(
        () => remoteToolName(["mcp_synaptixs-spi_sdlc_approve", "mcp_synaptixs-spi2_sdlc_approve"], "sdlc_approve"),
        /2 MCP servers in VS Code offer sdlc_approve/,
      );
    });

    it("asks VS Code to start its servers once when the tool is not there yet, then says so", async () => {
      const lm = fakeLm([], "{}");
      const calls = remoteCalls("company-spine", lm);
      assert.equal(calls.remote, true);
      assert.equal(calls.server, "company-spine");
      await assert.rejects(calls.call("sdlc_plan_document", {}), /no MCP server in VS Code offers sdlc_plan_document/);
      assert.equal(lm.started, 1);
      assert.deepEqual(lm.seen, []);
    });

    it("refuses when the server offering the tools changed since the first call (review item 2)", async () => {
      const names = ["mcp_synaptixs-spi_sdlc_plan_document", "mcp_synaptixs-spi_sdlc_approve"];
      const lm = { ...fakeLm(names, "{}"), names: () => names };
      const calls = remoteCalls("company-spine", lm);
      await calls.call("sdlc_plan_document", {});
      names.splice(0, 2, "mcp_other-spine_sdlc_plan_document", "mcp_other-spine_sdlc_approve");
      await assert.rejects(calls.call("sdlc_approve", {}), /the Spine server VS Code offers changed .*open the plan again/);
    });

    it("parses the tool's JSON text and checks it", async () => {
      const ok = fakeLm(["mcp_s_sdlc_plan_document"], '{"plans": [], "count": 0}');
      assert.deepEqual(await remoteCalls("s", ok).call("sdlc_plan_document", { repo_path: "/r" }), { plans: [], count: 0 });
      assert.deepEqual(ok.seen, [["mcp_s_sdlc_plan_document", { repo_path: "/r" }]]);
      assert.equal(ok.started, 0);

      const refused = fakeLm(["mcp_s_sdlc_approve"], '{"error": "approving needs scope spine:plan"}');
      await assert.rejects(remoteCalls("s", refused).call("sdlc_approve", {}), /approving needs scope spine:plan/);

      const text = fakeLm(["mcp_s_sdlc_approve"], "Error: the server is not running");
      await assert.rejects(
        remoteCalls("s", text).call("sdlc_approve", {}),
        (err: unknown) => err instanceof SpineRefusal && /the server is not running/.test(err.message),
      );
    });
  });
});
