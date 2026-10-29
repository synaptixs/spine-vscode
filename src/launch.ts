/**
 * How the extension starts Spine (D9, D10). One pinned line, the same as the pinned variant in
 * Spine's AGENT_GUIDE §3, so only `uv` has to be installed. Bump SPINE_VERSION on each Spine
 * release, together with the contract test run against it.
 */
export const SPINE_VERSION = "3.64.0";

/** Every wheel-only language extra (Spine D23); `[all]` fails to install where Rust's grammar must build from source. */
export const SPINE_EXTRAS = ["mcp", "docs", "c", "cpp", "csharp", "go", "java", "kotlin", "perl", "php", "sql", "typescript"] as const;

export interface Launch {
  command: string;
  args: string[];
}

/** The command that starts Spine: the pinned `uvx` line, or an installed `orchestrator-mcp` when the setting names one. */
export function spineLaunch(serverPath?: string): Launch {
  const installed = serverPath?.trim();
  if (installed) return { command: installed, args: [] };
  // `--python >=3.12` is not in the guide's line: without it uvx takes the system Python, and on
  // Debian 12 (python3 = 3.11) it refuses to resolve instead of downloading a managed 3.12+.
  return {
    command: "uvx",
    args: ["--python", ">=3.12", "--from", `synaptixs-spine[${SPINE_EXTRAS.join(",")}]==${SPINE_VERSION}`, "orchestrator-mcp"],
  };
}
