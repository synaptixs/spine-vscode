# Changelog

## Unreleased

- CodeLens and hover (SSPN-242): counts above every function and class from Spine's
  `file_insights` (callers as a floor, untested reach, possible untraced calls or "not tracked"),
  a peek at the callers on click, and `explain_symbol` on hover. Cached per file until a save or a
  change on disk; at most 30 lenses per file with a "showing 30 of N" lens; never blocks the editor.
  The pin moves to Spine 3.64.0, the first release with `file_insights`.

- Repo skeleton (SSPN-241). Spine is offered to VS Code as an MCP server and started with the
  pinned `uvx` line (every wheel-only language extra, `--python '>=3.12'`); a
  `spine.serverPath` setting points at an installed `orchestrator-mcp` instead.
- `Spine: Doctor` command.
- Restricted Mode: no Spine process starts and no tool is called; a notice asks to trust the folder.
