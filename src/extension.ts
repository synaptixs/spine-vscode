/**
 * Spine in VS Code. Two ways in, one launch line (src/launch.ts):
 *  - Spine is offered to VS Code as an MCP server definition, so VS Code's chat can use it and,
 *    for a remote server, VS Code runs the sign-in (D8);
 *  - the extension's own surfaces call Spine through its own stdio client (src/client.ts).
 * In Restricted Mode neither path starts a process (D12): the definition list is empty and the
 * client refuses before it creates a transport.
 *
 * Plan review (src/plans.ts) goes to `spine.server`: `local` uses the extension's own client;
 * the name of a server in VS Code's MCP configuration goes through `vscode.lm`, so VS Code runs
 * the sign-in (D19, D32). Lenses stay local either way (D34). While a remote server is named, the
 * extension offers VS Code no local definition: VS Code names both servers' tools alike, and a
 * plan must never be approved on the wrong one (D49).
 *
 * Builds (src/runs.ts, src/builds.ts) run on the local server only, at `spine.level=build` (D21).
 * Plan from requirement (src/plan-from-requirement.ts, src/requirements.ts) runs on the local server
 * only too (D109): deriving a spec spends the checkout's own key.
 *
 * The same .vsix runs in Cursor (SSPN-284). Cursor stubs the definition provider and has no MCP
 * connection of VS Code's own, so src/editor.ts decides what this editor really gives: the
 * definition is registered only where it is real, and remote review is refused where it cannot work.
 */
import * as vscode from "vscode";
import { BuildRuns, nodeGit } from "./builds";
import { type LmTools, localCalls, remoteCalls, type SpineCalls } from "./calls";
import { RestrictedWorkspaceError, SpineClient } from "./client";
import { editorFeatures, mcpNotice, remoteServersSupported } from "./editor";
import { exposesTestHooks } from "./hooks";
import { SPINE_VERSION, spineLaunch } from "./launch";
import { SpineLenses } from "./lenses";
import { SpineRequirements } from "./plan-from-requirement";
import { SpinePlans } from "./plans";
import { RequirementPlanner, requirementBlocker } from "./requirements";
import { gitUserName, PlanReview } from "./review";
import { ReviewDiffs } from "./review-diff";
import { SpineRuns } from "./runs";

export interface SpineApi {
  readonly trusted: boolean;
  doctor(): Promise<unknown>;
  mcpDefinitions(): vscode.McpServerDefinition[];
  editor(): Promise<{ name: string; mcpDefinitions: boolean; remoteServers: boolean }>;
  /** Only when loaded from source, for the integration suites (src/hooks.ts). */
  plans?: ReturnType<SpinePlans["api"]>;
  runs?: ReturnType<SpineRuns["api"]>;
}

/** Set once the D118 notice was shown in this editor, so it is shown once, not on every start. */
const MCP_NOTICE_SHOWN = "spine.mcpNoticeShown";

const TRUST_NOTICE = "Spine is off in Restricted Mode: it starts no process here. Trust this folder to use it.";

export function activate(context: vscode.ExtensionContext): SpineApi {
  const settings = () => vscode.workspace.getConfiguration("spine");
  const launch = () => spineLaunch(settings().get<string>("serverPath"), settings().get<string>("level"));
  const server = () => settings().get<string>("server")?.trim() || "local";
  const level = () => settings().get<string>("level")?.trim() || "plan";
  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri;
  const newClient = () =>
    new SpineClient({ launch: launch(), isTrusted: () => vscode.workspace.isTrusted, cwd: folder()?.fsPath });

  let client = newClient();
  const definitionsChanged = new vscode.EventEmitter<void>();
  // The same .vsix runs in Cursor, which stubs the definition provider (SSPN-284, src/editor.ts).
  const editor = editorFeatures({
    appName: vscode.env.appName,
    hasDefinitionProvider: typeof vscode.lm?.registerMcpServerDefinitionProvider === "function",
  });

  const mcpDefinitions = (): vscode.McpServerDefinition[] => {
    if (!vscode.workspace.isTrusted || server() !== "local") return [];
    const { command, args, env } = launch();
    const definition = new vscode.McpStdioServerDefinition("Spine", command, args, env ?? {}, SPINE_VERSION);
    definition.cwd = folder();
    return [definition];
  };

  const doctor = () => client.callTool("doctor", {});

  const lenses = new SpineLenses(() => client, folder);
  let remote: SpineCalls | undefined;
  const calls = (): SpineCalls => {
    const name = server();
    if (name === "local") return localCalls(() => client);
    if (remote?.server !== name) remote = remoteCalls(name, lmTools);
    return remote;
  };
  const review = new PlanReview({
    calls,
    // Remotely the server reads only the checkouts its admin listed, by their path on the server.
    repo: () => (server() === "local" ? folder()?.fsPath : settings().get<string>("serverRepo")?.trim() || undefined),
    isTrusted: () => vscode.workspace.isTrusted,
    approverName: async () => {
      const root = folder();
      return root ? gitUserName(root.fsPath) : "";
    },
  });
  // Builds run on this machine, with the person's own keys, at level `build` only (D21, SSPN-244).
  const buildBlocker = (): string | undefined => {
    if (!vscode.workspace.isTrusted) return "trust this folder first (Restricted Mode)";
    if (server() !== "local") return `builds run on this machine only, and spine.server names ${server()}`;
    if (level() !== "build") return `set spine.level to build (it is ${level()}): builds spend model tokens with your own keys`;
    return undefined;
  };
  const builds = new BuildRuns({
    calls: () => localCalls(() => client),
    repo: () => folder()?.fsPath,
    isTrusted: () => vscode.workspace.isTrusted,
    deciderName: async () => {
      const root = folder();
      return root ? gitUserName(root.fsPath) : "";
    },
  });
  const diffs = new ReviewDiffs(nodeGit);
  const runs = new SpineRuns({
    builds: () => builds,
    unavailable: buildBlocker,
    folder: () => folder()?.fsPath,
    onRestricted: showTrustNotice,
    diffs,
    state: context.workspaceState,
  });
  const plans = new SpinePlans(() => review, showTrustNotice, buildBlocker, (id) => runs.build(id));
  const planner = new RequirementPlanner({
    calls: () => localCalls(() => client),
    repo: () => folder()?.fsPath,
    isTrusted: () => vscode.workspace.isTrusted,
    blocker: () => requirementBlocker(server(), level()),
    open: async (id) => {
      await vscode.commands.executeCommand("spine.openPlan", id);
    },
  });
  const requirements = new SpineRequirements(() => planner, showTrustNotice);
  let refresh: NodeJS.Timeout | undefined;
  const changedOnDisk = () => {
    clearTimeout(refresh);
    refresh = setTimeout(() => lenses.invalidate(), 500);
  };
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");

  context.subscriptions.push(
    definitionsChanged,
    { dispose: () => void client.close() },
    ...(editor.mcpDefinitions
      ? [
          vscode.lm.registerMcpServerDefinitionProvider("spine.mcp", {
            onDidChangeMcpServerDefinitions: definitionsChanged.event,
            provideMcpServerDefinitions: mcpDefinitions,
          }),
        ]
      : []),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      definitionsChanged.fire();
      lenses.invalidate();
      runs.invalidate();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (["spine.serverPath", "spine.level", "spine.server", "spine.serverRepo"].some((s) => event.affectsConfiguration(s))) {
        plans.invalidate();
        runs.invalidate();
      }
      if (!["spine.serverPath", "spine.level", "spine.server"].some((s) => event.affectsConfiguration(s))) return;
      void client.close();
      client = newClient();
      definitionsChanged.fire();
      lenses.invalidate();
    }),
    lenses,
    plans,
    requirements,
    runs,
    diffs,
    watcher,
    watcher.onDidChange(changedOnDisk),
    watcher.onDidCreate(changedOnDisk),
    watcher.onDidDelete(changedOnDisk),
    vscode.workspace.onDidSaveTextDocument(() => lenses.invalidate()),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, lenses),
    vscode.languages.registerHoverProvider({ scheme: "file" }, lenses),
    vscode.commands.registerCommand("spine.showCallers", async (id: string, uri?: vscode.Uri, line?: number) => {
      try {
        const where = await lenses.callers(id);
        if (uri && line !== undefined && vscode.window.activeTextEditor) {
          await vscode.commands.executeCommand("editor.action.showReferences", uri, new vscode.Position(line, 0), where);
        }
        return where;
      } catch (err) {
        if (err instanceof RestrictedWorkspaceError) showTrustNotice();
        else void vscode.window.showErrorMessage(`Spine: ${(err as Error).message}`);
        return [];
      }
    }),
    vscode.commands.registerCommand("spine.doctor", async () => {
      try {
        const report = (await doctor()) as { server?: { version?: string }; all_passed?: boolean };
        const off = [
          editor.mcpDefinitions ? "" : "its agent takes Spine from its own MCP settings",
          (await lmTools.supported()) ? "" : "remote plan review is off",
        ].filter(Boolean);
        void vscode.window.showInformationMessage(
          `Spine ${report.server?.version ?? "?"} is answering${report.all_passed ? "; every check passed" : ""}.` +
            (off.length ? ` In ${editor.name}, ${off.join(" and ")}.` : ""),
        );
      } catch (err) {
        if (err instanceof RestrictedWorkspaceError) showTrustNotice();
        else void vscode.window.showErrorMessage(`Spine did not start: ${(err as Error).message}`);
      }
    }),
  );

  if (!vscode.workspace.isTrusted) showTrustNotice();
  const notice = mcpNotice(editor, context.globalState.get<boolean>(MCP_NOTICE_SHOWN, false));
  if (notice) {
    void context.globalState.update(MCP_NOTICE_SHOWN, true);
    void vscode.window.showInformationMessage(`Spine: ${notice}`);
  }

  return {
    get trusted() {
      return vscode.workspace.isTrusted;
    },
    doctor,
    mcpDefinitions,
    editor: async () => ({ ...editor, remoteServers: await lmTools.supported() }),
    plans: exposesTestHooks(context.extensionMode, vscode.ExtensionMode.Production) ? plans.api() : undefined,
    runs: exposesTestHooks(context.extensionMode, vscode.ExtensionMode.Production) ? runs.api() : undefined,
  };
}

/** The remote path: VS Code's own MCP connection, which holds the sign-in, never the extension (D19). */
const lmTools: LmTools = {
  names: () => vscode.lm.tools.map((t) => t.name),
  invoke: async (name, input) => {
    const result = await vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined });
    return result.content.map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : "")).join("");
  },
  // Internal and undocumented (D8 probe, VS Code 1.142): re-check on every VS Code bump.
  start: async () => {
    await vscode.commands.executeCommand("workbench.mcp.startServer", "*", { waitForLiveTools: true });
  },
  editor: vscode.env.appName,
  supported: () => remoteServersSupported(typeof vscode.lm?.invokeTool === "function", () => vscode.commands.getCommands(true)),
};

function showTrustNotice(): void {
  void vscode.window.showWarningMessage(TRUST_NOTICE, "Manage Workspace Trust").then((choice) => {
    if (choice) void vscode.commands.executeCommand("workbench.trust.manage");
  });
}

export function deactivate(): void {}
