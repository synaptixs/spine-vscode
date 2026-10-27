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
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `spine-vsx-${suite}-`));
  const userData = path.join(dir, "user-data");
  fs.mkdirSync(path.join(userData, "User"), { recursive: true });
  fs.writeFileSync(path.join(userData, "User", "settings.json"), JSON.stringify(settings, null, 2));
  for (const [name, body] of Object.entries(userFiles)) {
    fs.writeFileSync(path.join(userData, "User", name), JSON.stringify(body, null, 2));
  }
  const exe = process.env.VSCODE_PATH ?? (await downloadAndUnzipVSCode(VSCODE_VERSION));
  const args = [
    fixture,
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
    `--extensionTestsPath=${path.join(__dirname, "index.js")}`,
    ...(trust ? [] : ["--disable-workspace-trust"]),
  ];
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn(exe, args, {
      env: { ...process.env, SPINE_SUITE: suite, SPINE_FIXTURE: fixture, ...env },
      stdio: "inherit",
    });
    child.on("exit", resolve);
  });
  if (code !== 0) throw new Error(`suite ${suite} failed (exit ${code})`);
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
  ];
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
