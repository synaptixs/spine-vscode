# Spine for VS Code

Spine's Product Knowledge Graph in the editor: who calls a function, what a change reaches, which
of it no test covers, and the docs that mention it. The extension talks to Spine over MCP only; it
spends nothing and needs no API key.

**Status:** private preview, not on the Marketplace. Slice 1 (CodeLens and hover) is in progress.

## Requirements

- VS Code 1.140 or newer (tested on 1.142.0).
- [`uv`](https://docs.astral.sh/uv/). The extension starts Spine with one pinned line, so Spine itself does not need to be installed:

  ```
  uvx --python '>=3.12' --from 'synaptixs-spine[mcp,docs,c,cpp,csharp,go,java,kotlin,perl,php,sql,typescript]==3.63.1' orchestrator-mcp
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
`node out/test/integration/run.js probe` records how MCP tools reach the extension through VS Code
(evidence for the sign-in route, not a gate).

See [CONTRIBUTING.md](CONTRIBUTING.md).
