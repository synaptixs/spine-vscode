# Changelog

## 0.4.0 — 2026-11-25

Fixes from a field report, on Spine 3.71.0 (the pin was 3.68.0). Discard, Open test output, the
stale-plan warning and the site and checkout on a refusal use the fields 3.71.0 adds.

- The right folder (SSPN-404): with several folders open, Spine used to read the first one, and
  that folder's `.env`, whatever you were working in, so planning from a Jira ticket failed. It
  now reads the folder of the file in front, or the one you choose with **Spine: Choose folder…**
  (also the Spine item in the status bar), and asks when it cannot tell. Each folder gets its own
  Spine process, so each reads its own `.env`; every call about a folder goes to that folder's
  process. A plan opened in one folder is not decided or built from another, a saved spec re-plans
  in its own folder, a requirement file is planned into its own folder, and "Spine planned …" names
  the folder. VS Code's chat follows the folder in use, and with several folders open and none in
  use it is offered no Spine server rather than one started in a folder nobody chose.
- Why a build failed (SSPN-399): a failed build's row reads "failed at <stage>", and its tooltip
  gives Spine's reason. A passed stage shows a check again (it showed a hollow circle). One run whose
  stages cannot be read no longer blanks the Runs view.
- Editing a plan (SSPN-406): the plan opens as `<id>-build.md`, and its tooltip names the file in
  `.spine/plans/`. **Edit spec…** opens the spec the plan is made from. Saving it plans again for
  $0, with no model. An approval of the old text then no longer holds, and you decide again. A spec
  whose `intent_id` was deleted stays this plan's.
  **Reveal plan file** shows the plan's file in the Explorer.
- A way out of a dead run (SSPN-405): a running or parked run whose process is gone now offers
  **Discard run…** beside Resume (a failed run is left as it ended: build its plan again). A build the plan gate refused used to offer only Resume,
  and it blocked every new build of its plan. Discard rejects what it waits on, marks it abandoned,
  and keeps its branch and worktree. On an older Spine it says it needs Spine 3.71.
- Which tests failed (SSPN-407): a failed build's tooltip carries Spine's reason, which now names the
  failing tests. **Open test output** opens the last test run's full output, on a failed run and on
a dead run parked on its own failing tests. Spine now keeps run
  logs where a restart does not clear them.
- A plan from another commit (SSPN-408): Approve and Build ask Spine again, then warn when the plan
  was derived at another commit (the build would refuse that approval and park) or on a tree with
  uncommitted changes (a build uses only committed code). They offer **Re-plan ($0)**, except on a
  dirty tree, where re-planning cannot help: commit or stash first. Approve anyway still names who is
  approving. The status tooltip says so too.
- Spine pinned to 3.71.0. Spine now keeps runs under `$XDG_STATE_HOME/spine/runs` (else
  `~/.local/state/spine/runs`), so the extension also passes `XDG_STATE_HOME` to its server: the
  Runs view and `orchestrator sdlc runs` in a terminal still read one store.
- "Spine planned …" names the Jira or Confluence site. A refusal names the checkout Spine planned
  in, and for a Jira or Confluence source whether its `.env` names a site (SSPN-404).

## 0.3.0 — 2026-10-31

Runs in Cursor as well as VS Code, on the same Spine 3.68.0.

- Cursor (SSPN-284): the `.vsix` installs and runs in Cursor 3.27, which is VS Code 1.128
  underneath. `engines.vscode` is now `^1.128.0`, and CI runs every suite on VS Code 1.128.0 as
  well as 1.142.0. Lenses, hovers, plan review, builds, diff review and planning from a requirement
  work there as in VS Code. Cursor's agent does not take MCP servers from extensions, so the
  extension says once to add Spine as Spine's guide shows. Remote plan review is refused there
  with the reason and the way out, rather than failing with "command not found". **Spine: Doctor**
  names what is off. `npm run test:cursor` runs the installed suite in a fresh Cursor profile.

## 0.2.0 — 2026-10-31

Builds, diff review and planning from a requirement, all in the editor, on Spine 3.68.0.

- Plan from requirement (SSPN-246): **Spine: Plan from requirement…** in the Command Palette picks
  a Markdown file in the folder or takes a pasted ticket or URL, and **Spine: Plan this
  requirement** sits on a Markdown file's Explorer and editor context menus. Spine derives the
  requirement's spec as `orchestrator sdlc plan --source` does and the plan opens in the plan
  review. A spec already derived plans for $0 with no question; deriving one asks first (it spends
  tokens on the checkout's own key) and says what it spent. A requirement with several intents
  asks which one. On this machine only: with a remote `spine.server` the command says to use
  `local`.
- Spine pinned to 3.68.0, whose `sdlc_plan` plans from a `source`.
- The extension now also passes its Spine server `ORCHESTRATOR_INTAKE_CACHE_DIR`, so a
  requirement whose spec was derived in a terminal is reused here rather than derived again.
- A call that waits on Spine's intake model now waits up to 15 minutes; the MCP SDK's own limit
  is 60 seconds.

- Diff review (SSPN-245): a build waiting for a review offers **Review diff**, which opens every
  changed file of the build's worktree read-only in one diff editor, plus **Open patch** for the
  exact diff Spine asks about. **Approve diff…** and **Reject diff…** decide it under the git name,
  bound to the diff that was read; a diff that changed since is refused and reopened. A rejection
  needs a note and ends the build. A finished build offers **Fetch into my checkout…**, which
  creates its branch locally and never overwrites one. While a build started from the editor runs,
  it is checked every 30 s even with the Runs view closed, and a waiting review is announced once.
- Spine pinned to 3.67.1. Dropping a budget or "build anyway?" stop whose process has gone now
  ends the build (`abandoned`), so its plan can be built again; before, the plan stayed blocked.
  Builds started with `orchestrator sdlc autorun` in a terminal are now shown read-only in the
  Runs view, since Spine says which builds the editor started (`from_editor`).
- Builds from the editor (SSPN-244), at `spine.level=build` on the local server: **Build** in an
  approved plan's title bar starts a safe build in the background from the current branch's last
  commit, after a dialog saying what is built and where the key and budget come from (the
  checkout's `.env`). A **Runs** view in a new Spine sidebar lists this checkout's builds with their
  stages; it polls every 5 s only while visible and a build is alive. Budget and "build anyway?"
  stops are decided there with a note under the git name (**Raise cap and resume…**, **Approve…**,
  **Drop…**); **Cancel** keeps the branch and worktree; a build whose process has gone offers
  **Resume…**. A review of a build's diff is shown as waiting, and decided in a later version.
- The extension now passes its Spine server `TMPDIR`, `SPINE_RUN_STATE` and `SPINE_RUN_ARTIFACTS`
  (and nothing else beyond the level): the MCP SDK hands a server only `HOME`, `LOGNAME`, `PATH`,
  `SHELL`, `TERM` and `USER`, so Spine kept the extension's runs under `/tmp`, apart from
  `orchestrator sdlc runs` in a terminal.
- Builds use Spine's build tools `sdlc_build`, `sdlc_builds` and `sdlc_build_decide` (new in 3.67.0).
- The installed `.vsix` is now checked for every command it contributes, its Runs view, and a
  requirement planned from the installed copy; in CI it is the package the check job built, installed
  on another runner (SSPN-247).
- Dev tooling only: `npm audit` reports 13 moderate advisories in `glob` and `minimatch` under
  `eslint`, `mocha` and `@vscode/vsce`, none of which ships in the `.vsix` (`npm audit --omit=dev`
  is clean). npm's only fixes are downgrades; they are taken when upstream releases one.

## 0.1.0 — 2026-10-30

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
