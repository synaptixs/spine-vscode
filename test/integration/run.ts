/**
 * Runs the extension-host suites in a real VS Code (version pinned below, D6). Three launches,
 * because workspace trust is decided when the window opens:
 *   untrusted  — trust on, no prompt: the folder stays in Restricted Mode;
 *   sentinel   — trust off: the same launch path, so the sentinel proves a process WOULD start;
 *   real       — trust off, the real pinned uvx line: the MCP client works from the extension host.
 * The sentinel is set as a USER setting, which Restricted Mode still honours, so the untrusted
 * suite is a real test of the guard and not of a setting being ignored.
 *
 * VS Code is spawned here rather than through `runTests`, because `runTests` always passes
 * `--disable-workspace-trust`, which would make every folder trusted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { scanEnv, scanTree } from "../support/noToken";
import { planFixture } from "../support/planFixture";

export const VSCODE_VERSION = "1.142.0";

const root = path.resolve(__dirname, "../../..");
const fixture = path.join(root, "test/fixture/.repo");

function sentinel(dir: string, marker: string): string {
  const script = path.join(dir, "fake-orchestrator-mcp");
  fs.writeFileSync(script, `#!/bin/sh\necho started >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  return script;
}

async function launch(
  suite: string,
  settings: Record<string, unknown>,
  trust: boolean,
  env: Record<string, string>,
  userFiles: Record<string, unknown> = {},
  folder: string = fixture,
  dir: string = fs.mkdtempSync(path.join(os.tmpdir(), `spine-vsx-${suite}-`)),
  driver?: string,
) {
  const userData = path.join(dir, "user-data");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify(settings, null, 2));
  for (const [name, body] of Object.entries(userFiles)) {
    fs.writeFileSync(path.join(userData, "User", name), JSON.stringify(body, null, 2));
  }
  const exe = process.env.VSCODE_PATH ?? (await downloadAndUnzipVSCode(VSCODE_VERSION));
  const args = [
    folder,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--no-cached-data",
    "--disable-extensions",
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(dir, "extensions")}`,
    `--extensionDevelopmentPath=${root}`,
    // A driver runs the suite inside a normal window (companyDriver.ts); otherwise VS Code's test runner does.
    ...(driver ? [`--extensionDevelopmentPath=${driver}`] : [`--extensionTestsPath=${path.join(__dirname, "index.js")}`]),
    ...(trust ? [] : ["--disable-workspace-trust"]),
  ];
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(exe, args, {
      env: { ...process.env, SPINE_SUITE: suite, SPINE_FIXTURE: folder, ...env },
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`suite ${suite} failed (exit ${code}); its files are in ${dir}`);
}

/**
 * Step E (plan D56-D58): Spine over HTTP checking Keycloak's tokens, the plan fixture as the one
 * listed repository, VS Code told about the server only through its own `mcp.json` with a
 * pre-registered client, then the no-token check over everything the run left. Keycloak must be
 * up (test/keycloak/up.sh); SPINE_SERVER_PATH must be a Spine with the plan tools (3.66.0+).
 */
const ISSUER = "http://localhost:8180/realms/spine-test";
const SPINE_URL = "http://127.0.0.1:8765/mcp";

async function company(role: string | undefined) {
  if (role !== "planner" && role !== "reader") throw new Error("usage: run.js company planner|reader");
  const server = process.env.SPINE_SERVER_PATH;
  if (!server) throw new Error("set SPINE_SERVER_PATH to an orchestrator-mcp with the plan tools");
  const plans = await planFixture();
  // Short on purpose: VS Code's IPC socket lives in the user-data dir, and macOS caps a socket
  // path at 103 characters, which $TMPDIR alone nearly fills.
  const out = fs.mkdtempSync(path.join(process.platform === "win32" ? os.tmpdir() : "/tmp", `svx-${role}-`));
  fs.writeFileSync(path.join(out, "repos.yaml"), `repos:\n  shop: ${plans.root}\n`);
  const log = fs.openSync(path.join(out, "spine.log"), "a");
  const spine = spawn(server, ["--http", "--port", "8765"], {
    env: {
      ...process.env,
      ORCHESTRATOR_MCP_LEVEL: "plan",
      ORCHESTRATOR_MCP_ISSUER_URL: ISSUER,
      ORCHESTRATOR_MCP_RESOURCE_URL: SPINE_URL,
      ORCHESTRATOR_MCP_ROLE_MAP: "spine-readers=spine:read; spine-planners=spine:read spine:plan",
      ORCHESTRATOR_MCP_REPOS: path.join(out, "repos.yaml"),
    },
    stdio: ["ignore", log, log],
  });
  const vscodeDir = path.join(out, "v");
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch("http://127.0.0.1:8765/.well-known/oauth-protected-resource/mcp").then((r) => r.ok, () => false);
      if (!up) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!up) throw new Error(`Spine did not come up; see ${path.join(out, "spine.log")}`);
    const env = {
      SPINE_COMPANY_ROLE: role,
      SPINE_PLAN_ID: plans.intentId,
      SPINE_SERVER_REPO: plans.root,
      SPINE_COMPANY_OUT: path.join(out, "findings.json"),
      SPINE_ENV_OUT: path.join(out, "env.json"),
    };
    const mcp = { servers: { "company-spine": { type: "http", url: SPINE_URL, oauth: { clientId: "spine-vscode" } } } };
    const settings = { "spine.server": "company-spine", "spine.serverRepo": plans.root };
    // One normal window (VS Code shows no dialog in a test window and keeps no sign-in there):
    // the driver extension runs the suite while the person answers VS Code's sign-in, then quits.
    const driver = path.join(out, "driver");
    fs.mkdirSync(driver);
    fs.writeFileSync(
      path.join(driver, "package.json"),
      JSON.stringify({ name: "spine-company-driver", publisher: "synaptixs", version: "0.0.0", engines: { vscode: "^1.140.0" }, main: "./index.js", activationEvents: ["onStartupFinished"] }),
    );
    fs.writeFileSync(path.join(driver, "index.js"), `module.exports = require(${JSON.stringify(path.join(__dirname, "companyDriver.js"))});\n`);
    const result = path.join(out, "result.txt");
    console.log(`\n>>> A VS Code window opens. Allow it to sign in to localhost:8180, log in as ${role} in the browser\n` +
      ">>> (the password is on your clipboard), and let the browser hand back to VS Code. Nothing else:\n" +
      ">>> the checks run and the window closes by itself (it waits up to 10 minutes for you).\n");
    await launch("company", settings, false, { ...env, SPINE_COMPANY_RESULT: result }, { "mcp.json": mcp }, plans.root, vscodeDir, driver);
    const outcome = fs.existsSync(result) ? fs.readFileSync(result, "utf8") : "no result: the window was closed before the checks finished";
    console.log(`company suite as ${role}: ${outcome}`);
    if (outcome !== "passed") throw new Error(`company suite as ${role}: ${outcome}`);
  } finally {
    spine.kill();
    fs.closeSync(log);
    const approval = path.join(plans.root, ".spine", "plans", `${plans.intentId}-approval.json`);
    if (fs.existsSync(approval)) fs.copyFileSync(approval, path.join(out, "approval.json"));
    const lines: string[] = [];
    let hits = 0;
    for (const target of [vscodeDir, path.join(out, "spine.log"), path.join(out, "findings.json")]) {
      if (!fs.existsSync(target)) continue;
      const scan = scanTree(target);
      hits += scan.hits.length;
      lines.push(`${target}: ${scan.files} files, ${scan.bytes} bytes, ${scan.hits.length} token-shaped`, ...scan.hits.map((h) => `  ${h.kind} in ${h.where}: ${h.preview}`));
    }
    const envFile = path.join(out, "env.json");
    if (fs.existsSync(envFile)) {
      const found = scanEnv(JSON.parse(fs.readFileSync(envFile, "utf8")) as Record<string, string>, "extension host env");
      hits += found.length;
      lines.push(`${envFile}: ${found.length} token-shaped values`, ...found.map((h) => `  ${h.kind} in ${h.where}: ${h.preview}`));
    }
    // A run that never signed in left nothing a token could be in: that is not a clean result.
    const passed = fs.existsSync(path.join(out, "result.txt")) && fs.readFileSync(path.join(out, "result.txt"), "utf8") === "passed";
    if (!passed) lines.push("no-token check: NOT VALID, the checks did not pass, so no sign-in is proven to have happened");
    else lines.push(hits ? `NO-TOKEN CHECK FAILED: ${hits}` : "no-token check: clean");
    fs.writeFileSync(path.join(out, "no-token.txt"), `${lines.join("\n")}\n`);
    console.log(`\n${lines.join("\n")}\nevidence: ${out}`);
  }
}

async function main() {
  const only = process.argv[2];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "spine-vsx-sentinel-"));
  const runs: [string, () => Promise<void>][] = [
    [
      "untrusted",
      async () => {
        const marker = path.join(scratch, "untrusted.marker");
        await launch(
          "untrusted",
          {
            "spine.serverPath": sentinel(scratch, marker),
            "security.workspace.trust.enabled": true,
            "security.workspace.trust.startupPrompt": "never",
          },
          true,
          { SPINE_MARKER: marker },
        );
      },
    ],
    [
      "sentinel",
      async () => {
        const marker = path.join(scratch, "sentinel.marker");
        await launch("sentinel", { "spine.serverPath": sentinel(scratch, marker) }, false, { SPINE_MARKER: marker });
      },
    ],
    ["real", async () => launch("real", {}, false, {})],
    [
      "lenses",
      async () =>
        launch("lenses", process.env.SPINE_SERVER_PATH ? { "spine.serverPath": process.env.SPINE_SERVER_PATH } : {}, false, {}),
    ],
    [
      "plans",
      async () => {
        const plans = await planFixture();
        try {
          await launch(
            "plans",
            process.env.SPINE_SERVER_PATH ? { "spine.serverPath": process.env.SPINE_SERVER_PATH } : {},
            false,
            { SPINE_PLAN_ID: plans.intentId, SPINE_PLAN_FILE: plans.planFile },
            {},
            plans.root,
          );
        } finally {
          plans.dispose();
        }
      },
    ],
  ];
  if (only === "company") return company(process.argv[3]);
  // The D8 probe is evidence-gathering, not a gate: run it by name (`probe`), never by default.
  if (only === "probe") {
    const mcp = process.env.SPINE_PROBE_MCP_JSON ? JSON.parse(fs.readFileSync(process.env.SPINE_PROBE_MCP_JSON, "utf8")) : undefined;
    await launch("probe", {}, false, { SPINE_PROBE_OUT: process.env.SPINE_PROBE_OUT ?? path.join(scratch, "probe.json") }, mcp ? { "mcp.json": mcp } : {});
    return;
  }
  for (const [name, run] of runs) if (!only || only === name) await run();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
