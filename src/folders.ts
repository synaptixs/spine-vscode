/**
 * Which workspace folder a Spine request uses (B178, SSPN-404, D123). It used to be always the
 * first folder, so in a window with several folders Spine read the wrong checkout and that
 * checkout's `.env`, and planning from a Jira ticket failed.
 *
 * - One folder open: that folder.
 * - Several: the folder of the file last in front. A document outside every folder (a plan, a
 *   diff, an output panel) keeps the folder you were in. Choosing a folder (Spine: Choose folder…)
 *   wins until a file of another folder comes in front, and is remembered for the window.
 * - Several, nothing in front and nothing chosen: ask. Never fall back to the first folder.
 *
 * This module never imports `vscode`; src/extension.ts feeds it paths, so the unit tests drive it.
 */
import * as path from "node:path";

export type Why = "only" | "active" | "chosen" | "ambiguous" | "none";

export class ChooseFolderError extends Error {
  constructor() {
    super("several folders are open: choose one with Spine: Choose folder… (the Spine item in the status bar), or open a file of that folder");
  }
}

/** The deepest of `folders` holding `file`, or `undefined`. */
export function containing(file: string, folders: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const folder of folders) {
    const rel = path.relative(folder, file);
    const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
    if (inside && (!best || folder.length > best.length)) best = folder;
  }
  return best;
}

export class FolderChoice {
  private latest: { folder: string; why: "active" | "chosen" } | undefined;

  /** `remembered`: the folder chosen in this window before (kept by the editor). */
  constructor(remembered?: string) {
    if (remembered) this.latest = { folder: remembered, why: "chosen" };
  }

  /** A document came in front; `true` when that moved the folder in use. */
  focus(file: string | undefined, folders: readonly string[]): boolean {
    const folder = file ? containing(file, folders) : undefined;
    if (!folder) return false;
    const before = this.current(folders).folder;
    this.latest = { folder, why: "active" };
    return before !== folder;
  }

  /** The person chose a folder. */
  choose(folder: string): void {
    this.latest = { folder, why: "chosen" };
  }

  current(folders: readonly string[]): { folder: string | undefined; why: Why } {
    if (!folders.length) return { folder: undefined, why: "none" };
    if (folders.length === 1) return { folder: folders[0], why: "only" };
    if (this.latest && folders.includes(this.latest.folder)) return { ...this.latest };
    return { folder: undefined, why: "ambiguous" };
  }

  /** The folder to use; `undefined` with no folder open; throws when several are open and none is chosen. */
  require(folders: readonly string[]): string | undefined {
    const { folder, why } = this.current(folders);
    if (why === "ambiguous") throw new ChooseFolderError();
    return folder;
  }
}
