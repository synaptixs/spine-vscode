/**
 * One way to call Spine for the plan review, over either transport (P2 §3 D, D32):
 *  - local: the extension's own stdio client (src/client.ts), where the trust guard lives;
 *  - remote: a server in VS Code's own MCP configuration, through `vscode.lm.invokeTool`, so VS
 *    Code runs the company sign-in and the extension never holds a token (D19).
 * Plan code never knows which one it has. This module never imports `vscode`: the editor hands
 * the remote path an `LmTools` adapter, so the unit tests drive exactly this code.
 *
 * Spine refuses with a normal answer that carries `error` (CLAUDE.md), so every answer is
 * checked here; a refusal naming both digests is a plan that moved since it was read.
 */
import { remoteRefusal } from "./editor";

export class SpineRefusal extends Error {
  constructor(
    message: string,
    readonly answer: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SpineRefusal";
  }
}

/** `sdlc_approve` refused because the plan is no longer the one that was read (SSPN-272). */
export class PlanMovedError extends SpineRefusal {
  readonly expected: string;
  readonly current: string;

  constructor(message: string, answer: Record<string, unknown>) {
    super(message, answer);
    this.name = "PlanMovedError";
    this.expected = String(answer.expected_digest);
    this.current = String(answer.digest);
  }
}

export interface SpineCalls {
  /** `local`, or the name of the server in VS Code's MCP configuration. */
  readonly server: string;
  readonly remote: boolean;
  call(tool: string, args: Record<string, unknown>, opts?: CallOptions): Promise<Record<string, unknown>>;
}

export interface CallOptions {
  /** How long to wait for the answer; the MCP SDK's own default is 60 s. */
  timeoutMs?: number;
}

/** The slice of `vscode.lm` the remote path needs. */
export interface LmTools {
  names(): string[];
  invoke(name: string, input: Record<string, unknown>): Promise<string>;
  /** Ask VS Code to start its MCP servers: their tools are not listed until something does. */
  start(): Promise<void>;
  /** The editor's name, for a refusal that says where it is (`vscode.env.appName`). */
  readonly editor: string;
  /** Whether this editor has VS Code's own MCP connection at all (SSPN-284: Cursor does not). */
  supported(): Promise<boolean>;
}

export function checked(answer: unknown): Record<string, unknown> {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
    throw new SpineRefusal(`Spine answered with no object: ${JSON.stringify(answer)}`, {});
  }
  const out = answer as Record<string, unknown>;
  if (out.error === undefined) return out;
  const message = String(out.error);
  if (typeof out.digest === "string" && typeof out.expected_digest === "string") throw new PlanMovedError(message, out);
  throw new SpineRefusal(message, out);
}

export function localCalls(
  client: () => { callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> },
): SpineCalls {
  return {
    server: "local",
    remote: false,
    call: async (tool, args, opts) => checked(await client().callTool(tool, args, opts?.timeoutMs)),
  };
}

/**
 * The tool's name in `vscode.lm.tools`. VS Code derives the prefix from the server itself, not from
 * the name it is configured under (D8 probe: a local and a remote Spine both became
 * `mcp_synaptixs-spi_…`), so only the suffix is reliable. Two candidates are refused, never
 * guessed between: approving on the wrong server is worse than not approving (D49).
 */
export function remoteToolName(names: string[], tool: string): string {
  const found = names.filter((n) => n.endsWith(`_${tool}`));
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    throw new SpineRefusal(
      `${found.length} MCP servers in VS Code offer ${tool} (${found.join(", ")}): keep only the one spine.server names`,
      {},
    );
  }
  throw new SpineRefusal(`no MCP server in VS Code offers ${tool}: check that it is configured, running and signed in`, {});
}

export function remoteCalls(server: string, lm: LmTools): SpineCalls {
  let started = false;
  // Asked once per server: an editor without VS Code's MCP connection is refused before anything
  // is started or called, with the way out, rather than with a "command not found" (SSPN-284, D119).
  let supported: Promise<boolean> | undefined;
  // Nothing in Spine's answers names the server, so the first one to answer is the one this
  // review keeps: a later call that resolves to another prefix is refused, never followed.
  let pinned: string | undefined;
  const resolve = async (tool: string) => {
    if (!started && !lm.names().some((n) => n.endsWith(`_${tool}`))) {
      started = true;
      await lm.start();
    }
    const name = remoteToolName(lm.names(), tool);
    const prefix = name.slice(0, -(tool.length + 1));
    if (pinned !== undefined && prefix !== pinned) {
      throw new SpineRefusal(`the Spine server VS Code offers changed (${pinned} → ${prefix}): open the plan again`, {});
    }
    pinned = prefix;
    return name;
  };
  return {
    server,
    remote: true,
    call: async (tool, args) => {
      if (!(await (supported ??= lm.supported()))) throw new SpineRefusal(remoteRefusal(lm.editor), {});
      const text = await lm.invoke(await resolve(tool), args);
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        throw new SpineRefusal(`${server} answered ${tool} with no JSON: ${text.slice(0, 300)}`, {});
      }
      return checked(answer);
    },
  };
}
