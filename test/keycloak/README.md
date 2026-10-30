# Company sign-in, locally (SSPN-243 step E)

A throwaway Keycloak stands in for a company identity provider, so the extension can be run
against a Spine that checks real sign-ins. This is evidence, not a test gate: a person signs in,
so it never runs in CI.

- `up.sh` starts Keycloak 26.8.1 (pinned by digest) on `localhost:8180` with the realm in
  `realm-spine-test.json`. It makes random passwords for `planner` and `reader` and writes them
  to `$TMPDIR/spine-keycloak/credentials` (0600). No password is in this repo. `up.sh down`
  removes it all.
- The realm has one public client, `spine-vscode` (PKCE, no client secret). Anonymous client
  registration is refused, and `up.sh` checks that. The groups `spine-readers` and
  `spine-planners` come out as a `roles` claim, which Spine maps to its scopes.

## Running it

```bash
test/keycloak/up.sh
SPINE_SERVER_PATH=/path/to/orchestrator-mcp node out/test/integration/run.js company planner
SPINE_SERVER_PATH=/path/to/orchestrator-mcp node out/test/integration/run.js company reader
```

`SPINE_SERVER_PATH` must be a Spine with the plan tools (3.66.0 or later). Each run starts Spine
over HTTP on `127.0.0.1:8765`. VS Code knows Spine only through its own `mcp.json`, with
`"oauth": {"clientId": "spine-vscode"}`.

**Each run is one VS Code window.** VS Code shows no dialog while it runs extension tests,
and keeps no sign-in there, so the suite runs in a normal window instead, driven by a small
extension that run.ts writes next to the evidence (`test/integration/companyDriver.ts`). All you
do is:

1. When VS Code asks whether `company-spine` may sign in to `localhost:8180`, click **Allow**.
2. Log in in the browser as `planner` (or `reader`), with the password from the credentials
   file, and let the browser hand back to VS Code.

Then nothing else. The checks run, and the window closes by itself. It waits up to 10 minutes for the sign-in.

Afterwards the no-token check scans the profile, Spine's log and the extension host's
environment. Everything lands in `/tmp/svx-<role>-…/`: `findings.json`, `approval.json` (planner),
`spine.log`, `no-token.txt`, and the VS Code profile in `v/`.

## Another provider (the live Entra run)

The same run works against any OIDC provider. Its settings are given at run time, so no tenant or
client name is written into this repo:

```bash
NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" \
SPINE_COMPANY_ENV=/path/to/provider.env \
SPINE_COMPANY_URL=https://<spine-host>/mcp \
SPINE_COMPANY_CLIENT_ID=<public client id> \
SPINE_COMPANY_EMAIL=<the planner's sign-in name> \
SPINE_SERVER_PATH=/path/to/orchestrator-mcp node out/test/integration/run.js company planner
```

`provider.env` holds the `ORCHESTRATOR_MCP_*` lines for the provider, which are laid over the
Keycloak ones. `SPINE_COMPANY_URL` is a TLS proxy in front of `127.0.0.1:8765`. Two things learned
on Entra:

- **Register `http://localhost` (no port) as a "Mobile and desktop" redirect.** For a
  Microsoft-hosted sign-in, VS Code uses its built-in Microsoft provider. It still uses the
  configured `oauth.clientId`, but it listens on a random localhost port, so `127.0.0.1:33418` alone
  fails with AADSTS50011.
- **The proxy must send `Host: 127.0.0.1:8765`.** Spine listening on 127.0.0.1 refuses any other
  Host with 421 "Invalid Host header". A call with no token is refused (401) before that check
  runs, so a no-token preflight does not show the problem.
