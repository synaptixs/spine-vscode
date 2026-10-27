# spine-vscode — working on this repo

Read [CONTRIBUTING.md](CONTRIBUTING.md) first; it is the rule set. Plans and design records live
outside this checkout (the extension plan is `~/plans/vscode-extension-roadmap.md`, Epic SSPN-238).

- `src/client.ts` never imports `vscode`, so the contract test drives exactly that code against the
  real server. Keep editor code in `src/extension.ts` and friends.
- The trust guard sits in `SpineClient.connected()`, the only place a process starts. Keep it there.
- `runTests` from `@vscode/test-electron` always passes `--disable-workspace-trust`; that is why
  `test/integration/run.ts` spawns VS Code itself.
- A Spine tool can answer `{"error": …, "hint": …}` as a normal result (e.g. `registry_runs` with no
  registry). Surfaces must treat a top-level `error` as a failure.
