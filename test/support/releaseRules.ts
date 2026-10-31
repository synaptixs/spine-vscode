/**
 * What a release of the extension must say about itself (SSPN-247): the CHANGELOG has a section for
 * the version in package.json, and every `.vsix` the README names is that version's. A README still
 * telling users to install the last release is the stale page nothing else catches.
 */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What is wrong with `changelog` and `readme` for a release of `version`; empty when nothing is. */
export function releaseProblems(version: string, changelog: string, readme: string): string[] {
  const problems: string[] = [];
  if (!new RegExp(`^## ${escape(version)}(?: |$)`, "m").test(changelog)) {
    problems.push(`CHANGELOG.md has no "## ${version}" section`);
  }
  const named = [...readme.matchAll(/spine-vscode-(\d+\.\d+\.\d+[^\s`]*?)\.vsix/g)].map((m) => m[1]);
  if (!named.length) problems.push("README.md names no spine-vscode-<version>.vsix to install");
  for (const other of new Set(named.filter((v) => v !== version))) {
    problems.push(`README.md names spine-vscode-${other}.vsix, not ${version}`);
  }
  return problems;
}
