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
- **Plan review.** **Spine: Open plan…** lists the folder's build documents (written by Spine's
  `sdlc_plan`) and opens one read-only, beside its Markdown preview. The status line shows its state
  (not decided, approved, rejected, or changed since its decision), who decided, a short digest, the
  server and who is approving. **Approve** and **Reject** sit in the document's title bar and are
  greyed out when you may not decide; the status line's tooltip says why. A rejection needs a note.
  A decision covers exactly the text you were shown: if the plan changed since you opened it,
  nothing is recorded and the plan reopens. Locally you approve under `git config user.name`, and
  the extension shows that name before the call.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `spine.serverPath` | empty | An installed `orchestrator-mcp` instead of the pinned `uvx` line. |
| `spine.level` | `plan` | How much of Spine the local server shows, to the extension and to VS Code's chat: `pkg` (graph only), `plan` (adds the build document and its approval), `build` (adds the runs that write code and spend, with your own keys). Approving needs `plan` or `build`. |
| `spine.server` | `local` | Where plans are reviewed: `local`, or the name of a server in VS Code's MCP configuration. Lenses always use the local Spine. |
| `spine.serverRepo` | empty | With `spine.server` set: this repository's path on that server, one of the checkouts its admin listed. |

In Restricted Mode a workspace's own value for any of these is ignored.

## Requirements

- VS Code 1.140 or newer (tested on 1.142.0).
- [`uv`](https://docs.astral.sh/uv/). The extension starts Spine with one pinned line, so Spine itself does not need to be installed:

  ```
  uvx --python '>=3.12' --from 'synaptixs-spine[mcp,docs,c,cpp,csharp,go,java,kotlin,perl,php,sql,typescript]==3.66.0' orchestrator-mcp
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

To review plans there, set `spine.server` to that server's name and `spine.serverRepo` to the
repository's path on the server (a shared server reads only the checkouts its admin listed). The
extension then calls it through VS Code (`vscode.lm.invokeTool`). The server records who approves:
with a company sign-in that is you, and the message after a decision says the name it recorded.
**A remote approval is a signed, audited record of your decision, not a gate on the build:** a
build on your laptop does not check it.

VS Code gives every Spine server's tools the same names, and Spine's answers do not name the
server, so the extension cannot tell two Spine servers apart. While `spine.server` is set it offers
VS Code no local Spine of its own; it refuses when two servers offer the plan tools at once, and
when the server answering changes during a review. **Keep only the one Spine server in VS Code's
MCP configuration** while `spine.server` is set: a second, local one listed alone (for example
while the remote one is not yet started) would be called instead, and the name in the message
after the decision would show it.

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
