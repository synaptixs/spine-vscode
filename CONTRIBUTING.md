# Contributing

- **One branch per change**, cut from `main`; open a PR into `main`. Never commit to `main` directly.
- **Tests first.** A new behaviour gets a failing test before the code; guard logic (workspace
  trust, the pinned launch line) gets a mutation check: break it on purpose and watch a test fail.
- **The gate**, all green before a PR: `npm run lint`, `npm run typecheck`, `npm run test:unit`,
  `npm run test:contract`, `npm run test:integration`. CI runs the same three jobs.
- **Spine is a pinned contract.** `src/launch.ts` names one Spine version. A Spine release bumps it
  in the same PR as the contract test run against that release; the unit test copies the line by
  hand so drift fails loudly.
- **Use the engine's real tool names** (`blast_radius`, `regression_gaps`, `explain_symbol`,
  `docs_for`). There is no `impact_of`.
- **No secrets** in settings, logs, tests or the repo. Remote sign-in belongs to VS Code's MCP
  configuration, not to an extension setting.
- **Fixtures live under a dot-directory** (`test/fixture/.repo/`): Spine's walkers skip dot-dirs, so
  running Spine on this repo does not pull fixture symbols into its graph.
