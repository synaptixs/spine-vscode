/**
 * Spine in VS Code. Two ways in, one launch line (src/launch.ts):
 *  - Spine is offered to VS Code as an MCP server definition, so VS Code's chat can use it and,
 *    for a remote server, VS Code runs the sign-in (D8);
 *  - the extension's own surfaces call Spine through its own stdio client (src/client.ts).
 * In Restricted Mode neither path starts a process (D12): the definition list is empty and the
 * client refuses before it creates a transport.
 */
import * as vscode from "vscode";
import { RestrictedWorkspaceError, SpineClient } from "./client";
import { SPINE_VERSION, spineLaunch } from "./launch";

export interface SpineApi {
  readonly trusted: boolean;
  doctor(): Promise<unknown>;
  mcpDefinitions(): vscode.McpServerDefinition[];
}

const TRUST_NOTICE = "Spine is off in Restricted Mode: it starts no process here. Trust this folder to use it.";

export function activate(context: vscode.ExtensionContext): SpineApi {
  const launch = () => spineLaunch(vscode.workspace.getConfiguration("spine").get<string>("serverPath"));
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri;
  const newClient = () =>
    new SpineClient({ launch: launch(), isTrusted: () => vscode.workspace.isTrusted, cwd: folder()?.fsPath });

  let client = newClient();
  const definitionsChanged = new vscode.EventEmitter<void>();

  const mcpDefinitions = (): vscode.McpServerDefinition[] => {
    if (!vscode.workspace.isTrusted) return [];
    const { command, args } = launch();
    const server = new vscode.McpStdioServerDefinition("Spine", command, args, {}, SPINE_VERSION);
    server.cwd = folder();
    return [server];
  };

  const doctor = () => client.callTool("doctor", {});

  context.subscriptions.push(
    definitionsChanged,
    { dispose: () => void client.close() },
    vscode.lm.registerMcpServerDefinitionProvider("spine.mcp", {
      onDidChangeMcpServerDefinitions: definitionsChanged.event,
      provideMcpServerDefinitions: mcpDefinitions,
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => definitionsChanged.fire()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration("spine.serverPath")) return;
      void client.close();
      client = newClient();
      definitionsChanged.fire();
    }),
    vscode.commands.registerCommand("spine.doctor", async () => {
      try {
        const report = (await doctor()) as { server?: { version?: string }; all_passed?: boolean };
        void vscode.window.showInformationMessage(
          `Spine ${report.server?.version ?? "?"} is answering${report.all_passed ? "; every check passed" : ""}.`,
        );
      } catch (err) {
        if (err instanceof RestrictedWorkspaceError) showTrustNotice();
        else void vscode.window.showErrorMessage(`Spine did not start: ${(err as Error).message}`);
      }
    }),
  );

  if (!vscode.workspace.isTrusted) showTrustNotice();

  return {
    get trusted() {
      return vscode.workspace.isTrusted;
    },
    doctor,
    mcpDefinitions,
  };
}

function showTrustNotice(): void {
  void vscode.window.showWarningMessage(TRUST_NOTICE, "Manage Workspace Trust").then((choice) => {
    if (choice) void vscode.commands.executeCommand("workbench.trust.manage");
  });
}

export function deactivate(): void {}
