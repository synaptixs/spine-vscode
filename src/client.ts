/**
 * The extension's own MCP client for Spine. It never imports `vscode`, so the contract test
 * drives exactly this code against the real server outside the editor.
 *
 * Workspace trust (D12) is checked here, at the only place a process can start: in an untrusted
 * folder no transport is created, so no Spine process starts and no tool call is made.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Launch } from "./launch";

export class RestrictedWorkspaceError extends Error {
  constructor() {
    super("Spine is off in Restricted Mode: trust this folder to use it.");
    this.name = "RestrictedWorkspaceError";
  }
}

export type TransportFactory = (launch: Launch, cwd?: string) => Transport;

export interface SpineClientOptions {
  launch: Launch;
  isTrusted: () => boolean;
  cwd?: string;
  transportFactory?: TransportFactory;
}

const stdio: TransportFactory = (launch, cwd) =>
  // The SDK puts `env` on top of its default environment (PATH, HOME, …), so only the level is added.
  new StdioClientTransport({ command: launch.command, args: launch.args, env: launch.env, cwd, stderr: "pipe" });

/** The last few KB a server printed to stderr: the only clue when it exits before answering. */
function stderrTail(transport: Transport): () => string {
  let tail = "";
  const stream = transport instanceof StdioClientTransport ? transport.stderr : null;
  stream?.on("data", (chunk: Buffer) => (tail = (tail + chunk.toString()).slice(-4096)));
  return () => tail.trim();
}

export class SpineClient {
  private connecting: Promise<Client> | undefined;

  constructor(private readonly options: SpineClientOptions) {}

  /** Start Spine once; later calls share the same server. */
  async start(): Promise<void> {
    await this.connected();
  }

  async listTools(): Promise<string[]> {
    const client = await this.connected();
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {});
      names.push(...page.tools.map((t) => t.name));
      cursor = page.nextCursor;
    } while (cursor);
    return names;
  }

  /** Call a tool and return its JSON answer; a tool error is raised, never returned as an answer. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const client = await this.connected();
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    if (result.isError) throw new Error(`Spine ${name} failed: ${text}`);
    if (result.structuredContent !== undefined) return unwrap(result.structuredContent);
    return JSON.parse(text);
  }

  async close(): Promise<void> {
    const pending = this.connecting;
    this.connecting = undefined;
    if (pending) await (await pending).close();
  }

  private connected(): Promise<Client> {
    if (!this.options.isTrusted()) return Promise.reject(new RestrictedWorkspaceError());
    if (!this.connecting) {
      const transport = (this.options.transportFactory ?? stdio)(this.options.launch, this.options.cwd);
      const printed = stderrTail(transport);
      const client = new Client({ name: "spine-vscode", version: "0.0.1" });
      this.connecting = client.connect(transport).then(
        () => client,
        (err: Error) => {
          throw new Error(`Spine did not start: ${err.message}${printed() ? `\n${printed()}` : ""}`);
        },
      );
      this.connecting.catch(() => (this.connecting = undefined));
    }
    return this.connecting;
  }
}

/** FastMCP wraps a non-object return as `{ "result": … }`; a dict comes through as itself. */
function unwrap(structured: unknown): unknown {
  if (structured && typeof structured === "object" && Object.keys(structured).length === 1 && "result" in structured) {
    return (structured as { result: unknown }).result;
  }
  return structured;
}
