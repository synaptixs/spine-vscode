/**
 * The diff review in the editor (SSPN-245, D96): a review park's change in VS Code's diff view,
 * every file of the run's own worktree read-only, plus the patch Spine bound the approval to.
 *
 * - Left is the worktree's `HEAD`, right is the worktree file, both served from a content provider,
 *   so neither can be edited from here. The files come from `git status` there (src/diffs.ts); the
 *   extension only reads the worktree.
 * - Every URI carries the approval id, so a diff reopened after Spine asks again is read afresh, not
 *   served from VS Code's cache of the earlier one.
 * - What was opened is remembered per run: a decision is sent with the digest of the review that
 *   was shown, never of one read later (src/builds.ts).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import type { GitRun, Review } from "./builds";
import { type Change, parseStatus } from "./diffs";

export const DIFF_SCHEME = "spine-diff";
export const PATCH_SCHEME = "spine-patch";

/** One review as it was shown: what Spine bound, and the files the diff editor listed. */
export interface Opened {
  review: Review;
  changes: Change[];
  /** For each file: its left and right documents. */
  sides: { change: Change; left: vscode.Uri; right: vscode.Uri }[];
  patch: vscode.Uri;
}

export class ReviewDiffs implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly patches = new Map<string, string>();
  private readonly shown = new Map<string, Opened>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(private readonly git: GitRun) {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, this),
      vscode.workspace.registerTextDocumentContentProvider(PATCH_SCHEME, this),
    ];
  }

  dispose(): void {
    for (const s of this.subscriptions) s.dispose();
  }

  /** The review last shown for this run, if it is still the approval the run waits on. */
  opened(runId: string, approvalId: string | undefined): Opened | undefined {
    const o = this.shown.get(runId);
    return o && o.review.view.waiting?.approval_id === approvalId ? o : undefined;
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const q = new URLSearchParams(uri.query);
    if (uri.scheme === PATCH_SCHEME) return this.patches.get(q.get("approval") ?? "") ?? "";
    const worktree = q.get("wt") ?? "";
    const file = q.get("file") ?? "";
    if (!file) return "";
    if (q.get("side") === "head") {
      const shown = await this.git(worktree, ["show", `HEAD:${file}`]);
      return shown.ok ? shown.out : "";
    }
    try {
      return await fs.readFile(path.join(worktree, file), "utf8");
    } catch {
      return "";
    }
  }

  /** Read the worktree's files and remember them with the review; nothing is drawn yet. */
  async read(review: Review): Promise<Opened> {
    const { row, waiting } = review.view;
    const approval = waiting?.approval_id ?? "";
    const status = await this.git(row.worktree, ["status", "--porcelain=v1", "-z", "-uall"]);
    if (!status.ok) throw new Error(`cannot read the worktree ${row.worktree}: ${status.out}`);
    const changes = parseStatus(status.out);
    const uri = (side: "head" | "worktree", shown: string, file: string) =>
      vscode.Uri.from({
        scheme: DIFF_SCHEME,
        path: `/${row.run_id}/${side}/${shown}`,
        query: new URLSearchParams({ run: row.run_id, approval, wt: row.worktree, side, file }).toString(),
      });
    const sides = changes.map((change) => ({
      change,
      left: uri("head", change.from ?? change.path, change.status === "added" ? "" : (change.from ?? change.path)),
      right: uri("worktree", change.path, change.status === "deleted" ? "" : change.path),
    }));
    this.patches.set(approval, review.patch);
    const patch = vscode.Uri.from({ scheme: PATCH_SCHEME, path: `/${row.run_id}/review.diff`, query: new URLSearchParams({ run: row.run_id, approval }).toString() });
    const opened = { review, changes, sides, patch };
    this.shown.set(row.run_id, opened);
    return opened;
  }

  /** Draw a review that was read: one multi-file diff editor, or one diff per file where VS Code has none. */
  async show(opened: Opened): Promise<void> {
    const { row } = opened.review.view;
    const title = `Spine review: ${row.intent_id || row.run_id}`;
    if (!opened.sides.length) {
      void vscode.window.showInformationMessage(`Spine: ${title} changes no file in its worktree; Open patch shows what Spine bound.`);
      return;
    }
    try {
      const resources = opened.sides.map((s) => [vscode.Uri.file(path.join(row.worktree, s.change.path)), s.left, s.right]);
      await vscode.commands.executeCommand("vscode.changes", title, resources);
    } catch {
      for (const s of opened.sides) await vscode.commands.executeCommand("vscode.diff", s.left, s.right, `${s.change.path} (${title})`, { preview: false });
    }
  }

  async showPatch(opened: Opened): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(opened.patch);
    await vscode.languages.setTextDocumentLanguage(doc, "diff");
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}
