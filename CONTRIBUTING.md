# Contributing

- **One branch per change**, cut from `origin/develop`; open a PR into `develop`. `main` moves only by a
  `develop → main` promotion. Never commit to `develop` or `main` directly.
- **Tests first.** A new behaviour gets a failing test before the code; guard logic (workspace
  trust, the pinned launch line) gets a mutation check: break it on purpose and watch a test fail.
- **The gate**, all green before a PR: `npm run lint`, `npm run typecheck`, `npm run test:unit`,
  `npm run test:package`, `npm run test:contract`, `npm run test:integration`, then
  `node out/test/integration/run.js installed` (the `.vsix` in a fresh profile). CI runs the same three jobs,
  the integration job on VS Code 1.142.0 and 1.128.0. **Cursor is not in CI:** a change that touches
  activation, the MCP definition, remote review or packaging also runs `npm run test:cursor` on a
  machine with Cursor, and the PR carries its output (SSPN-284, D120).
- **Dependencies:** exact versions, each published at least two weeks before it is added
  (`npm install --before=<date>`), and `npm audit` at 0. When the two collide, pin the oldest
  version that is outside the advisory with `overrides`, as `@azure/msal-node` is (only `vsce
  publish` uses it).
- **Company sign-in is evidence, not a gate.** `node out/test/integration/run.js company planner|reader`
  needs Keycloak up and a person to sign in: see `test/keycloak/README.md`. Run it when the remote
  path changes, and before a release that touches it.
- **Spine is a pinned contract.** `src/launch.ts` names one Spine version. A Spine release bumps it
  in the same PR as the contract test run against that release; the unit test copies the line by
  hand so drift fails loudly.
- **Use the engine's real tool names** (`blast_radius`, `regression_gaps`, `explain_symbol`,
  `docs_for`). There is no `impact_of`.
- **No secrets** in settings, logs, tests or the repo. Remote sign-in belongs to VS Code's MCP
  configuration, not to an extension setting.
- **Fixtures live under a dot-directory** (`test/fixture/.repo/`): Spine's walkers skip dot-dirs, so
  running Spine on this repo does not pull fixture symbols into its graph.
