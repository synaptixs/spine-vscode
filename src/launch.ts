/**
 * How the extension starts Spine (D9, D10). One pinned line, the same as the pinned variant in
 * Spine's AGENT_GUIDE §3, so only `uv` has to be installed. Bump SPINE_VERSION on each Spine
 * release, together with the contract test run against it.
 */
export const SPINE_VERSION = "3.68.0";

/** Every wheel-only language extra (Spine D23); `[all]` fails to install where Rust's grammar must build from source. */
export const SPINE_EXTRAS = ["mcp", "docs", "c", "cpp", "csharp", "go", "java", "kotlin", "perl", "php", "sql", "typescript"] as const;

export interface Launch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** The variable Spine reads for how much of itself to serve: `pkg`, `plan` or `build` (Spine D23 levels). */
export const LEVEL_ENV = "ORCHESTRATOR_MCP_LEVEL";

/**
 * Where Spine keeps its run records, approvals and run artifacts (D88). The MCP SDK hands a server
 * only HOME, LOGNAME, PATH, SHELL, TERM and USER, and without the temp dir Spine keeps its runs under
 * /tmp: a different store from `sdlc runs` in a terminal. Nothing else is passed: the model key and
 * the budget come from the checkout's `.env`, which Spine reads itself.
 */
export const RUN_STORE_ENV = ["TMPDIR", "SPINE_RUN_STATE", "SPINE_RUN_ARTIFACTS"] as const;

/**
 * Where Spine caches the specs its intake model derived (D110, SSPN-246), for the same reason: a
 * requirement planned in a terminal is reused by the editor, for $0, only when both read one cache.
 */
export const INTAKE_CACHE_ENV = "ORCHESTRATOR_INTAKE_CACHE_DIR";

/**
 * The command that starts Spine: the pinned `uvx` line, or an installed `orchestrator-mcp` when the
 * setting names one, at `level` when one is given (D22), with the run store's location from the
 * extension host (`inherited`), and the intake cache's. An unknown level is passed through as it is: Spine refuses it at
 * start rather than serving a default nobody asked for.
 */
export function spineLaunch(serverPath?: string, level?: string, inherited: NodeJS.ProcessEnv = process.env): Launch {
  const vars: Record<string, string> = level?.trim() ? { [LEVEL_ENV]: level.trim() } : {};
  for (const name of [...RUN_STORE_ENV, INTAKE_CACHE_ENV]) {
    const value = inherited[name];
    if (value) vars[name] = value;
  }
  const env = Object.keys(vars).length ? { env: vars } : {};
  const installed = serverPath?.trim();
  if (installed) return { command: installed, args: [], ...env };
  // `--python >=3.12` is not in the guide's line: without it uvx takes the system Python, and on
  // Debian 12 (python3 = 3.11) it refuses to resolve instead of downloading a managed 3.12+.
  return {
    command: "uvx",
    args: ["--python", ">=3.12", "--from", `synaptixs-spine[${SPINE_EXTRAS.join(",")}]==${SPINE_VERSION}`, "orchestrator-mcp"],
    ...env,
  };
}
