/**
 * The diff review's pure parts (SSPN-245): which files a review shows, which files a saved patch
 * names, and the one git write the extension makes. This module never imports `vscode`, so the unit
 * tests drive exactly this code.
 *
 * - The files come from the run's own worktree (D96): `git status --porcelain=v1 -z -uall`, read
 *   only. Spine's diff is `git diff HEAD` there after `git add -N`, which writes the index; the
 *   extension never does that, so it lists untracked files from `status` instead.
 * - Fetch into my checkout (D99) creates the local branch only: an explicit refspec with no `+`,
 *   so git refuses rather than move a branch that already exists; no tags; nothing checked out.
 */

export interface Change {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** A rename's old path. */
  from?: string;
}

/** `git status --porcelain=v1 -z -uall`, sorted by path. A rename's old path is the next field. */
export function parseStatus(z: string): Change[] {
  const fields = z.split("\0");
  const out: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy.includes("R")) {
      out.push({ path, status: "renamed", from: fields[++i] });
    } else if (xy.includes("D")) {
      out.push({ path, status: "deleted" });
    } else if (xy === "??" || xy.includes("A") || xy.includes("C")) {
      out.push({ path, status: "added" });
    } else {
      out.push({ path, status: "modified" });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The files a saved patch changes, by their new path, sorted. */
export function patchFiles(patch: string): string[] {
  const files = new Set<string>();
  for (const line of patch.split("\n")) {
    const m = /^diff --git a\/.* b\/(.*)$/.exec(line);
    if (m) files.add(m[1]);
  }
  return [...files].sort();
}

/** `git fetch` of one branch from Spine's worktree into the checkout, as a new local branch only. */
export function fetchArgs(worktree: string, branch: string): string[] {
  const ref = `refs/heads/${branch}`;
  return ["fetch", "--no-tags", worktree, `${ref}:${ref}`];
}
