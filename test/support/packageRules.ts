/**
 * What a packaged `.vsix` may hold (SSPN-275, plan D69). The package is what a user installs, so
 * nothing that exists only to build or test the extension goes in: no sources, no tests, no
 * fixtures, no Keycloak realm, no source maps, no notes for agents. And no single file over 1 MB,
 * which would mean something was swept in by mistake.
 *
 * Paths are as `vsce` writes them inside the zip: `extension/<path in the repo>`.
 */
export interface PackageEntry {
  path: string;
  size: number;
}

export const MAX_FILE_BYTES = 1024 * 1024;

const ENTRY_POINT = "extension/out/src/extension.js";

const FORBIDDEN: [RegExp, string][] = [
  [/^extension\/src\//, "TypeScript sources"],
  [/^extension\/test\//, "tests and fixtures"],
  [/^extension\/out\/test\//, "compiled tests"],
  [/\.map$/, "a source map"],
  [/^extension\/\.vscode-test\//, "the downloaded test VS Code"],
  [/^extension\/\.github\//, "CI configuration"],
  [/^extension\/\.devcontainer\//, "the dev container"],
  [/^extension\/(CLAUDE|CONTRIBUTING)\.md$/, "notes for contributors"],
  [/^extension\/(tsconfig\.json|eslint\.config\.mjs)$/, "build configuration"],
  [/\.vsix$/, "another package"],
];

export function packageProblems(entries: PackageEntry[]): string[] {
  const problems: string[] = [];
  for (const { path, size } of entries) {
    const forbidden = FORBIDDEN.find(([shape]) => shape.test(path));
    if (forbidden) problems.push(`${path}: ${forbidden[1]} must not ship`);
    else if (size > MAX_FILE_BYTES) problems.push(`${path}: ${size} bytes, over the ${MAX_FILE_BYTES}-byte limit`);
  }
  if (!entries.some((e) => e.path === ENTRY_POINT)) problems.push(`${ENTRY_POINT} is missing: compile before packaging`);
  return problems;
}
