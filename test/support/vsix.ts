/**
 * Builds the `.vsix` the way a release does (`npm run package`, the repo's own pinned `vsce`) and
 * lists what is inside it, so the checks look at the real package, not at a guess of what
 * `.vscodeignore` lets through.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { PackageEntry } from "./packageRules";

export const ROOT = path.resolve(__dirname, "../../..");

export function packageVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

/** Packages into `outDir` and returns the `.vsix` path. */
export function buildVsix(outDir: string): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `spine-vscode-${packageVersion()}.vsix`);
  execFileSync("npm", ["run", "--silent", "package", "--", "--out", file], { cwd: ROOT, stdio: "inherit" });
  if (!fs.existsSync(file)) throw new Error(`npm run package wrote no ${file}`);
  return file;
}

/** Every file in the zip with its uncompressed size (`unzip -l`: length, date, time, name). */
export function listVsix(file: string): PackageEntry[] {
  const out = execFileSync("unzip", ["-l", file], { encoding: "utf8" });
  const entries: PackageEntry[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line);
    if (m && !m[2].endsWith("/") && m[2] !== "Name") entries.push({ path: m[2], size: Number(m[1]) });
  }
  if (!entries.length) throw new Error(`no files listed in ${file}`);
  return entries;
}
