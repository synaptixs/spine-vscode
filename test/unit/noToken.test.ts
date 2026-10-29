import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanEnv, scanText, scanTree } from "../support/noToken";

// Shaped like a real access token (header and payload are base64url JSON), signed with nothing.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ sub: "1", email: "planner@example.test", exp: 1 })}.c2lnbmF0dXJlLWJ5dGVz`;

describe("no-token check (D58)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-notoken-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("finds a JWT in a nested file and names the file, never the token", () => {
    fs.mkdirSync(path.join(dir, "logs", "window1"), { recursive: true });
    fs.writeFileSync(path.join(dir, "logs", "window1", "mcp.log"), `got token ${JWT} from the server\n`);
    fs.writeFileSync(path.join(dir, "settings.json"), "{}");
    const scan = scanTree(dir);
    assert.equal(scan.files, 2);
    assert.equal(scan.hits.length, 1);
    assert.equal(scan.hits[0].where, path.join("logs", "window1", "mcp.log"));
    assert.equal(scan.hits[0].kind, "jwt");
    assert.ok(!JSON.stringify(scan).includes(JWT.slice(12)), "a report must not carry the token");
  });

  it("finds a bearer header whatever the token's shape", () => {
    const hits = scanText('headers: {"Authorization": "Bearer abcdefghijklmnopqrstuvwxyz0123"}', "x");
    assert.deepEqual(
      hits.map((h) => h.kind),
      ["bearer"],
    );
  });

  it("does not flag digests, ids or a lone base64 header", () => {
    const text = [
      "digest 3617b09bb4b7510a8d8d9b9fc5707399e2d70688dbcc2f8fb013a144829be1b9",
      `header only ${b64({ alg: "RS256" })}`,
      "Bearer realm=\"spine\"", // a WWW-Authenticate challenge, not a token
      "uuid 8a228f22-a341-4302-8f6d-886923cec3d0",
    ].join("\n");
    assert.deepEqual(scanText(text, "x"), []);
  });

  it("reads binary files too: VS Code keeps state in SQLite", () => {
    fs.writeFileSync(path.join(dir, "state.vscdb"), Buffer.concat([Buffer.from([0, 1, 2, 255, 0]), Buffer.from(JWT), Buffer.from([0, 0])]));
    assert.equal(scanTree(dir).hits.length, 1);
  });

  it("finds a token in an environment value, naming the variable", () => {
    const hits = scanEnv({ PATH: "/usr/bin", SPINE_X: `prefix ${JWT}` }, "extension host");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].where, "extension host: SPINE_X");
  });

  it("counts what it read, so an empty scan cannot pass as a clean one", () => {
    const scan = scanTree(dir);
    assert.deepEqual(scan, { hits: [], files: 0, bytes: 0 });
    fs.writeFileSync(path.join(dir, "a.txt"), "12345");
    assert.deepEqual(scanTree(dir), { hits: [], files: 1, bytes: 5 });
  });
});
