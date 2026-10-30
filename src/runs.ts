/**
 * The Runs view (SSPN-244, D77, D93): this checkout's builds in the Spine sidebar, one row per run
 * with its stages as children, and the actions each run offers (src/builds.ts decides which). A
 * tree, no webview (D27). It polls every 5 s only while it is visible and a run is alive (D92);
 * otherwise it refreshes when shown and after each action.
 *
 * Builds need the local server at `spine.level=build` (D21); anywhere else the view says why and
 * calls nothing.
 *
 * A review park (SSPN-245) opens in the diff editor (src/review-diff.ts) and is decided on the review
 * that was shown: Approve/Reject on a run nobody has opened here opens it first and asks to read it.
 * A decision Spine refuses because the diff moved reopens the new diff. With the view hidden, a
 * build this editor started is watched every 30 s, and its review announced once (D101).
 */
import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { type BuildPrompts, type BuildRuns, type RunView, actionsFor, reviewsToAnnounce, runText, shouldPoll, shouldWatch, startMessage, type Stage } from "./builds";
import { PlanMovedError } from "./calls";
import { RestrictedWorkspaceError } from "./client";
import type { Opened, ReviewDiffs } from "./review-diff";

export const POLL_MS = 5_000;
/** D101: with the view hidden, how often a live editor build is checked for a review. */
export const WATCH_MS = 30_000;
/** The review approvals already announced, kept per workspace so a reload does not repeat them. */
const ANNOUNCED = "spine.announcedReviews";

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
  diffs: ReviewDiffs;
  state: vscode.Memento;
}

const yes = (note: string): BuildPrompts => ({ confirm: async () => true, note: async () => note, info: () => undefined, warn: () => undefined });

export class SpineRuns implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private nodes: Node[] = [];
  private views: RunView[] = [];
  private poll = false;
  private readonly timer: NodeJS.Timeout;
  private readonly watcher: NodeJS.Timeout;
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly options: RunsOptions) {
    this.view = vscode.window.createTreeView("spine.runs", { treeDataProvider: this, showCollapseAll: true });
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.watcher = setInterval(() => void this.watch(), WATCH_MS);
    const action = (name: string, run: (view: RunView) => Promise<boolean>) =>
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
      { dispose: () => clearInterval(this.watcher) },
      this.view.onDidChangeVisibility((e) => e.visible && this.refresh()),
      vscode.commands.registerCommand("spine.runs.refresh", () => this.refresh()),
      action("cancel", (v) => this.options.builds().cancel(v, prompts)),
      action("resume", (v) => this.options.builds().resume(v, prompts)),
      action("approve", (v) => this.options.builds().approve(v, prompts)),
      action("drop", (v) => this.options.builds().drop(v, prompts)),
      action("raiseCapAndResume", (v) => this.options.builds().raiseCapAndResume(v, prompts)),
      action("review", async (v) => {
        await this.openReview(v);
        return false;
      }),
      action("approveReview", (v) => this.decideReview(v, true)),
      action("rejectReview", (v) => this.decideReview(v, false)),
      action("openPatch", async (v) => {
        const opened = this.options.diffs.opened(v.row.run_id, v.waiting?.approval_id) ?? (await this.options.diffs.read(await this.options.builds().readReview(v)));
        await this.options.diffs.showPatch(opened);
        return false;
      }),
      action("fetch", (v) => this.options.builds().fetch(v, prompts)),
      // The diff editor's own title bar: the run is named in the document's URI.
      vscode.commands.registerCommand("spine.review.approve", (uri?: vscode.Uri) => this.guarded(() => this.decideFromEditor(uri, true))),
      vscode.commands.registerCommand("spine.review.reject", (uri?: vscode.Uri) => this.guarded(() => this.decideFromEditor(uri, false))),
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
      this.announce(listed.views);
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
      review: async (runId: string) => {
        const opened = await this.openReview(await this.viewOf(runId));
        return {
          files: opened.sides.map((s) => ({ path: s.change.path, status: s.change.status, left: s.left.toString(), right: s.right.toString() })),
          patch: opened.patch.toString(),
        };
      },
      approveReview: async (runId: string, note: string) => this.decideReview(await this.viewOf(runId), true, yes(note)),
      fetch: async (runId: string) => this.options.builds().fetch(await this.viewOf(runId), yes("")),
    };
  }

  /** Read a review park, draw its diff, and offer the decision beside it. */
  private async openReview(view: RunView): Promise<Opened> {
    const opened = await this.options.diffs.read(await this.options.builds().readReview(view));
    await this.options.diffs.show(opened);
    const { row } = opened.review.view;
    void vscode.window
      .showInformationMessage(`Spine: reviewing ${row.intent_id || row.run_id}, ${opened.changes.length} files. Decide when you have read it.`, "Approve…", "Reject…", "Open patch")
      .then((choice) => {
        if (choice === "Open patch") void this.options.diffs.showPatch(opened);
        else if (choice) void this.guarded(async () => void ((await this.decideReview(opened.review.view, choice === "Approve…")) && this.refresh()));
      });
    return opened;
  }

  /** Decide the review that was shown here; one nobody opened is opened first, to be read. */
  private async decideReview(view: RunView, approve: boolean, ask: BuildPrompts = prompts): Promise<boolean> {
    const opened = this.options.diffs.opened(view.row.run_id, view.waiting?.approval_id);
    if (!opened) {
      await this.openReview(view);
      void vscode.window.showInformationMessage("Spine: the diff is open. Read it, then decide.");
      return false;
    }
    const builds = this.options.builds();
    try {
      return approve ? await builds.approveReview(opened.review, opened.changes.length, ask) : await builds.rejectReview(opened.review, ask);
    } catch (err) {
      if (!(err instanceof PlanMovedError)) throw err;
      void vscode.window.showWarningMessage("Spine: the diff changed since it was read, so that decision was not recorded. Here is the new one: read it, then decide.");
      await this.openReview(view);
      return false;
    }
  }

  private async decideFromEditor(uri: vscode.Uri | undefined, approve: boolean): Promise<void> {
    const runId = new URLSearchParams((uri ?? vscode.window.activeTextEditor?.document.uri)?.query ?? "").get("run");
    if (!runId) return void vscode.window.showInformationMessage("Spine: open a build's review first (Runs view → Review).");
    if (await this.decideReview(await this.viewOf(runId), approve)) this.refresh();
  }

  private async viewOf(runId: string): Promise<RunView> {
    this.refresh();
    await this.getChildren();
    const found = this.views.find((v) => v.row.run_id === runId);
    if (!found) throw new Error(`run ${runId} is not in this checkout's Runs view`);
    return found;
  }

  /** D101: with the view hidden, look at a live editor build every 30 s and announce its review. */
  private async watch(): Promise<void> {
    if (!shouldWatch(this.views, this.view.visible) || this.options.unavailable()) return;
    try {
      this.views = (await this.options.builds().list({ poll: true })).views;
      this.announce(this.views);
    } catch {
      // Shown when the view is next opened; a background check stays quiet.
    }
  }

  private announce(views: RunView[]): void {
    const seen = new Set(this.options.state.get<string[]>(ANNOUNCED, []));
    const fresh = reviewsToAnnounce(views, seen);
    if (!fresh.length) return;
    for (const v of fresh) {
      seen.add(v.waiting!.approval_id);
      void vscode.window.showInformationMessage(`Spine: the build of ${v.row.intent_id || v.row.run_id} is waiting for your review.`, "Review").then((choice) => {
        if (choice) void this.guarded(async () => void (await this.openReview(v)));
      });
    }
    void this.options.state.update(ANNOUNCED, [...seen].slice(-200));
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
