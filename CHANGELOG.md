# Changelog

## Unreleased

- Packaged as a private `.vsix`, version 0.1.0 (SSPN-275): `npm run package` builds it with the
  repository's pinned `vsce`, and the README's Install section says how to add it to VS Code. A
  check (`npm run test:package`) builds the real package and refuses sources, tests, fixtures,
  source maps, contributor notes or any file over 1 MB. An integration run installs it into a
  fresh profile and checks the lenses and the plan list there, and that the test hooks are absent.
- Plan review (SSPN-243): **Spine: Open plan…** lists a folder's build documents and opens one
  read-only beside its Markdown preview; Approve and Reject in its title bar, enabled only when
  Spine says you may decide, with the reason on the status line otherwise; a rejection needs a
  note. Every decision sends the digest of the text shown (`expected_digest`), so a plan edited
  after it was read is refused and reopened. Locally the approver is `git config user.name`,
  confirmed before the call. Needs Spine 3.66.0 (`sdlc_plan_document`).
- `spine.level` (`pkg`/`plan`/`build`, default `plan`) sets `ORCHESTRATOR_MCP_LEVEL` for the local
  server. It reaches VS Code's chat too: chat moves from Spine's `pkg` default to `plan`, 4 more tools.
- `spine.server` sends plan review to a server in VS Code's MCP configuration, through VS Code's own
  sign-in; the extension holds no token. `spine.serverRepo` names the repository's path on that
  server. A remote approval is a signed record, not a gate, and the message after it names who the
  server recorded. While `spine.server` is set, the extension offers VS Code no local Spine server,
  and it refuses when two servers offer the plan tools or the answering server changes mid-review.
- Company sign-in proven locally (SSPN-243 step E): a throwaway Keycloak (`test/keycloak/`, pinned by
  digest, no password in the repo) and a `company` run by name that drives the extension through
  VS Code's own sign-in. A planner's approval is recorded under their email, a reader cannot approve
  and a forced call is refused by the server, and a no-token check scans what the run leaves. Not in
  CI: a person signs in.
- The integration hooks are also exposed in Development mode (an extension loaded from source),
  still never to an installed extension: VS Code shows no dialog in a test window, so the sign-in
  run happens in a normal one.
- The pin moves to Spine 3.66.0, the first release with `sdlc_plan_document` and
  `sdlc_approve(expected_digest)`.

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
