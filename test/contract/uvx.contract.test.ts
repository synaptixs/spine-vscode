/**
 * The contract test (D10): start the REAL Spine with the pinned uvx line, list its tools, and call
 * blast_radius on the fixture repo. Run on every Spine release; a renamed tool or a changed
 * answer shape fails here first. Needs `uv` on PATH and network for the first run.
 */
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { SpineClient } from "../../src/client";
import { SPINE_VERSION, spineLaunch } from "../../src/launch";

const FIXTURE = path.resolve(__dirname, "../../../test/fixture/.repo");
// The tools the first slice uses (plan §3, slice 1) plus doctor.
const SLICE_1_TOOLS = ["doctor", "blast_radius", "regression_gaps", "explain_symbol", "docs_for"];

interface Match {
  id: string;
  caller_count: number;
  callers: { id: string; at: string }[];
}

describe("Spine MCP contract (pinned uvx line)", () => {
  let client: SpineClient;

  before(async () => {
    client = new SpineClient({ launch: spineLaunch(), isTrusted: () => true });
    const t0 = Date.now();
    await client.start();
    console.log(`      server ready in ${Date.now() - t0} ms`);
  });

  after(async () => client?.close());

  it("serves the pinned version", async () => {
    const report = (await client.callTool("doctor", {})) as { server: { version: string } };
    assert.equal(report.server.version, SPINE_VERSION);
  });

  it("lists every tool the first slice uses", async () => {
    const tools = await client.listTools();
    for (const name of SLICE_1_TOOLS) assert.ok(tools.includes(name), `missing tool ${name}`);
  });

  it("finds a Python function's caller", async () => {
    const t0 = Date.now();
    const out = (await client.callTool("blast_radius", { repo_path: FIXTURE, symbol: "cart_total" })) as {
      found: boolean;
      matches: Match[];
    };
    console.log(`      first blast_radius in ${Date.now() - t0} ms`);
    assert.equal(out.found, true);
    const callers = out.matches.flatMap((m) => m.callers.map((c) => c.id));
    assert.ok(callers.some((id) => id.includes("checkout")), JSON.stringify(out.matches));
  });

  it("finds a TypeScript function's caller", async () => {
    const out = (await client.callTool("blast_radius", { repo_path: FIXTURE, symbol: "applyTax" })) as {
      found: boolean;
      matches: Match[];
    };
    assert.equal(out.found, true);
    const callers = out.matches.flatMap((m) => m.callers.map((c) => c.id));
    assert.ok(callers.some((id) => id.includes("orderTotal")), JSON.stringify(out.matches));
  });
});
