# Spine for VS Code

Spine's Product Knowledge Graph in the editor: who calls a function, what a change reaches, which
of it no test covers, and the docs that mention it. The extension talks to Spine over MCP only; it
spends nothing and needs no API key.

**Status:** private preview, not on the Marketplace.

## What you see

- **Above each function and class**, a lens such as `2 callers (at least) · 1 untested in reach · 1 possible untraced call`.
  Callers are the ones the graph can type, so the count is a floor. "Untested in reach" counts the
  production code a change could reach that no test does. Untraced calls are same-named calls Spine
  could not type: tracked for Python, and the lens says "not tracked" for other languages rather than
  implying none. Click a lens to peek at the callers.
- **On hover**, what the symbol is, who calls it, what it calls and the docs that describe it (top 5 of N).
- One Spine call per open file (`file_insights`), refreshed when a file is saved or changes on disk,
  never per keystroke. At most 30 lenses per file; a first-line lens says "showing 30 of N".
  While Spine is still counting, the file shows `Spine: counting…` and the editor carries on.

## Requirements

- VS Code 1.140 or newer (tested on 1.142.0).
- [`uv`](https://docs.astral.sh/uv/). The extension starts Spine with one pinned line, so Spine itself does not need to be installed:

  ```
  uvx --python '>=3.12' --from 'synaptixs-spine[mcp,docs,c,cpp,csharp,go,java,kotlin,perl,php,sql,typescript]==3.64.0' orchestrator-mcp
  ```

  `--python '>=3.12'` lets uv fetch a suitable Python where the system one is older (Debian 12, Ubuntu 22.04).
  To use an installed Spine instead, set **`spine.serverPath`** to its `orchestrator-mcp`.

## Restricted Mode

In a folder you have not trusted, Spine starts no process and calls no tool; a notice offers to
trust the folder. `spine.serverPath` is ignored in a workspace's own settings until the folder is
trusted, so a checkout cannot choose the program the extension runs.

## Remote Spine servers

Add the server to VS Code's own MCP configuration (`MCP: Open User Configuration`). VS Code runs the
sign-in and keeps the session; the extension holds no token. A self-hosted server with a shared
token takes it as a header there, preferably through an `inputs` password prompt.

## Remote workspaces

The extension runs where the code is (SSH, WSL, Dev Containers, Codespaces), so that environment
needs `uv`. `.devcontainer/` is a working example.

## Development

```
npm ci
npm run lint && npm run typecheck
npm run test:unit
npm run test:contract       # the real pinned Spine; needs uv
npm run test:integration    # a real VS Code: untrusted, sentinel and real-server suites
```

`VSCODE_PATH` points the integration suites at an installed VS Code instead of downloading 1.142.0.
`SPINE_SERVER_PATH` points the contract and lens suites at an unreleased Spine build's `orchestrator-mcp`.
`node out/test/integration/run.js probe` records how MCP tools reach the extension through VS Code
(evidence for the sign-in route, not a gate).

See [CONTRIBUTING.md](CONTRIBUTING.md).
