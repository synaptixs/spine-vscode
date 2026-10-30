import * as assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { RestrictedWorkspaceError, SpineClient, type TransportFactory } from "../../src/client";

const LAUNCH = { command: "uvx", args: ["orchestrator-mcp"] };

/** A fake Spine with one well-behaved tool and one that fails, linked in memory. */
function fakeSpine(): { factory: TransportFactory; made: () => number } {
  let made = 0;
  const factory: TransportFactory = () => {
    made += 1;
    const server = new McpServer({ name: "fake-spine", version: "0" });
    server.registerTool("blast_radius", { inputSchema: { symbol: z.string() } }, async ({ symbol }) => ({
      content: [{ type: "text", text: JSON.stringify({ symbol, found: true, matches: [] }) }],
    }));
    server.registerTool("broken", {}, async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return clientSide;
  };
  return { factory, made: () => made };
}

describe("SpineClient", () => {
  describe("in an untrusted workspace (D12)", () => {
    it("refuses to start and creates no transport", async () => {
      const spine = fakeSpine();
      const client = new SpineClient({ launch: LAUNCH, isTrusted: () => false, transportFactory: spine.factory });
      await assert.rejects(client.start(), RestrictedWorkspaceError);
      await assert.rejects(client.listTools(), RestrictedWorkspaceError);
      await assert.rejects(client.callTool("blast_radius", { symbol: "x" }), RestrictedWorkspaceError);
      assert.equal(spine.made(), 0);
    });
  });

  describe("when the server cannot start", () => {
    it("says what the server printed, not just that the connection closed", async () => {
      const launch = { command: process.execPath, args: ["-e", "console.error('uv: no Python satisfies >=3.12'); process.exit(2)"] };
      const client = new SpineClient({ launch, isTrusted: () => true });
      await assert.rejects(client.start(), /Spine did not start[\s\S]*uv: no Python satisfies >=3\.12/);
    });

    it("starts the server with the launch's environment, on top of the default one", async () => {
      const launch = {
        command: process.execPath,
        args: ["-e", "console.error(`level=${process.env.ORCHESTRATOR_MCP_LEVEL} path=${!!process.env.PATH}`); process.exit(2)"],
        env: { ORCHESTRATOR_MCP_LEVEL: "plan" },
      };
      const client = new SpineClient({ launch, isTrusted: () => true });
      await assert.rejects(client.start(), /level=plan path=true/);
    });
  });

  describe("in a trusted workspace", () => {
    it("starts once, lists tools and returns a tool's JSON", async () => {
      const spine = fakeSpine();
      const client = new SpineClient({ launch: LAUNCH, isTrusted: () => true, transportFactory: spine.factory });
      try {
        assert.deepEqual((await client.listTools()).sort(), ["blast_radius", "broken"]);
        assert.deepEqual(await client.callTool("blast_radius", { symbol: "cart_total" }), {
          symbol: "cart_total",
          found: true,
          matches: [],
        });
        assert.equal(spine.made(), 1);
      } finally {
        await client.close();
      }
    });

    it("raises a tool's error instead of returning it as an answer", async () => {
      const spine = fakeSpine();
      const client = new SpineClient({ launch: LAUNCH, isTrusted: () => true, transportFactory: spine.factory });
      try {
        await assert.rejects(client.callTool("broken", {}), /^Error: Spine broken failed: boom$/);
      } finally {
        await client.close();
      }
    });
  });
});
