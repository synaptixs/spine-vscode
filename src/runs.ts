/**
 * The Runs view (SSPN-244, D77, D93): this checkout's builds in the Spine sidebar, one row per run
 * with its stages as children, and the actions each run offers (src/builds.ts decides which). A
 * tree, no webview (D27). It polls every 5 s only while it is visible and a run is alive (D92);
 * otherwise it refreshes when shown and after each action.
 *
 * Builds need the local server at `spine.level=build` (D21); anywhere else the view says why and
 * calls nothing.
 */
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { type BuildPrompts, type BuildRuns, type RunAction, type RunView, actionsFor, runText, shouldPoll, startMessage, type Stage } from "./builds";
import { RestrictedWorkspaceError } from "./client";

export const POLL_MS = 5_000;

type Node = { kind: "run"; view: RunView } | { kind: "stage"; stage: Stage; runId: string } | { kind: "note"; text: string };

const prompts: BuildPrompts = {
  confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
  note: async (title, required) =>
    vscode.window.showInputBox({
      title,
      prompt: required ? "Why? The note is recorded with the decision." : "A note for the record (optional).",
      ignoreFocusOut: true,
      validateInput: (value) => (required && !value.trim() ? "A note is needed." : undefined),
    }),
  info: (message) => void vscode.window.showInformationMessage(message),
  warn: (message) => void vscode.window.showWarningMessage(message),
};

export interface RunsOptions {
  builds: () => BuildRuns;
  /** Why builds are unavailable here, or `undefined` when they are (level, server, trust). */
  unavailable: () => string | undefined;
  folder: () => string | undefined;
  onRestricted: () => void;
}

export class SpineRuns implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private nodes: Node[] = [];
  private views: RunView[] = [];
  private poll = false;
  private readonly timer: NodeJS.Timeout;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly options: RunsOptions) {
    this.view = vscode.window.createTreeView("spine.runs", { treeDataProvider: this, showCollapseAll: true });
    this.timer = setInterval(() => this.tick(), POLL_MS);
    const action = (name: RunAction, run: (view: RunView) => Promise<boolean>) =>
      vscode.commands.registerCommand(`spine.runs.${name}`, (node?: Node) =>
        this.guarded(async () => {
          if (node?.kind !== "run") return;
          if (await run(node.view)) this.refresh();
        }),
      );
    this.subscriptions = [
      this.changed,
      this.view,
      { dispose: () => clearInterval(this.timer) },
      this.view.onDidChangeVisibility((e) => e.visible && this.refresh()),
      vscode.commands.registerCommand("spine.runs.refresh", () => this.refresh()),
      action("cancel", (v) => this.options.builds().cancel(v, prompts)),
      action("resume", (v) => this.options.builds().resume(v, prompts)),
      action("approve", (v) => this.options.builds().approve(v, prompts)),
      action("drop", (v) => this.options.builds().drop(v, prompts)),
      action("raiseCapAndResume", (v) => this.options.builds().raiseCapAndResume(v, prompts)),
      action("openWorktree", async (v) => {
        await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(v.row.worktree), { forceNewWindow: true });
        return false;
      }),
      action("openPlan", async (v) => {
        await vscode.commands.executeCommand("spine.openPlan", v.row.intent_id);
        return false;
      }),
    ];
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  /** Spine's settings or trust changed: read the runs again. */
  invalidate(): void {
    this.refresh();
  }

  refresh(): void {
    this.poll = false;
    this.changed.fire(undefined);
  }

  /** The Build button: confirm what is built from, start it, and show it here. */
  async build(intentId: string): Promise<void> {
    const why = this.options.unavailable();
    if (why) {
      const choice = await vscode.window.showWarningMessage(`Spine: cannot build ${intentId}: ${why}`, "Open settings");
      if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", "spine.");
      return;
    }
    const root = this.options.folder();
    if (!root) return void vscode.window.showInformationMessage("Spine: open a folder to build its plans.");
    const [branch, sha] = await Promise.all([git(root, "rev-parse", "--abbrev-ref", "HEAD"), git(root, "rev-parse", "HEAD")]);
    if (!(await prompts.confirm(startMessage(intentId, branch || "?", sha, root), "Build"))) return;
    const { runId } = await this.options.builds().start(intentId);
    await vscode.commands.executeCommand("spine.runs.focus");
    this.refresh();
    const found = await this.find(runId);
    if (found) await this.view.reveal(found, { select: true, focus: false });
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "note") {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (node.kind === "stage") {
      const { stage } = node;
      const item = new vscode.TreeItem(stage.stage, vscode.TreeItemCollapsibleState.None);
      item.description = stage.status;
      item.tooltip = stage.detail || undefined;
      item.iconPath = new vscode.ThemeIcon(stage.status === "passed" ? "check" : stage.status === "failed" ? "error" : "circle-outline");
      return item;
    }
    const text = runText(node.view);
    const item = new vscode.TreeItem(text.label, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = node.view.row.run_id;
    item.description = text.description;
    item.tooltip = text.tooltip;
    item.iconPath = new vscode.ThemeIcon(text.icon);
    // Menus match on `:<action>:` (package.json), so a run offers exactly what builds.ts allows.
    item.contextValue = `spineRun:${actionsFor(node.view).join(":")}:`;
    return item;
  }

  getParent(node: Node): Node | undefined {
    if (node.kind !== "stage") return undefined;
    return this.nodes.find((n) => n.kind === "run" && n.view.row.run_id === node.runId);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node?.kind === "run") {
      try {
        const stages = await this.options.builds().stages(node.view.row.run_id);
        return stages.length ? stages.map((stage) => ({ kind: "stage", stage, runId: node.view.row.run_id })) : [{ kind: "note", text: "no stage recorded yet" }];
      } catch (err) {
        return [{ kind: "note", text: (err as Error).message }];
      }
    }
    if (node) return [];
    const why = this.options.unavailable();
    if (why) {
      this.view.message = `Builds are off here: ${why}`;
      this.nodes = [];
      this.views = [];
      return [];
    }
    this.view.message = undefined;
    try {
      const listed = await this.options.builds().list({ poll: this.poll });
      this.views = listed.views;
      this.nodes = listed.views.map((view) => ({ kind: "run", view }));
      const notes: Node[] = [];
      if (listed.truncated) notes.push({ kind: "note", text: `showing the newest ${listed.views.length} of ${listed.count} runs` });
      if (listed.notShown) notes.push({ kind: "note", text: `${listed.notShown} runs from other repositories or older versions, not shown` });
      if (!listed.views.length) this.view.message = "No builds yet. Open an approved plan (Spine: Open plan…) and press Build.";
      return [...this.nodes, ...notes];
    } catch (err) {
      if (err instanceof RestrictedWorkspaceError) this.view.message = err.message;
      else this.view.message = `Spine: ${(err as Error).message}`;
      return [];
    } finally {
      this.poll = false;
    }
  }

  /** For the integration suites only (src/hooks.ts). */
  api() {
    return {
      runs: async () => {
        this.refresh();
        await this.getChildren();
        return this.views.map((view) => ({ runId: view.row.run_id, status: view.row.status, actions: actionsFor(view), text: runText(view) }));
      },
      message: () => this.view.message,
    };
  }

  private tick(): void {
    if (!shouldPoll(this.views, this.view.visible)) return;
    this.poll = true;
    this.changed.fire(undefined);
  }

  private async find(runId: string): Promise<Node | undefined> {
    await this.getChildren();
    return this.nodes.find((n) => n.kind === "run" && n.view.row.run_id === runId);
  }

  private async guarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (err) {
      if (err instanceof RestrictedWorkspaceError) this.options.onRestricted();
      else void vscode.window.showErrorMessage(`Spine: ${(err as Error).message}`);
      this.refresh();
    }
  }
}

function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 10_000 }, (err, stdout) => resolve(err ? "" : stdout.trim()));
  });
}
