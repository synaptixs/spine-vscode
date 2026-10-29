#!/usr/bin/env bash
# A throwaway company sign-in for the step E run (plan D29, D52-D55): Keycloak pinned by digest,
# dev mode, in memory, on localhost:8180. Not CI. `up.sh down` removes it.
#
# No password is in this repo (D53): the admin's and both users' are made here, at random, and
# written to a 0600 file outside the checkout, printed at the end.
set -euo pipefail

IMAGE="quay.io/keycloak/keycloak:26.8.1@sha256:a78d6b79572168cb25886b80a8b5b8d4ed4390743e3eecb810538683e209dd6b"
NAME=spine-keycloak
PORT=8180
REALM=spine-test
CLIENT=spine-vscode
OUT="${SPINE_KEYCLOAK_DIR:-${TMPDIR:-/tmp}/spine-keycloak}"
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="http://localhost:$PORT"

if [[ "${1:-up}" == down ]]; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$OUT"
  echo "removed $NAME and $OUT"
  exit 0
fi

mkdir -p "$OUT" && chmod 700 "$OUT"
secret() { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }
ADMIN="$(secret)"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:8080" \
  -e KC_BOOTSTRAP_ADMIN_USERNAME=admin -e KC_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN" \
  -e KC_HOSTNAME="$BASE" \
  -v "$HERE/realm-spine-test.json:/opt/keycloak/data/import/realm-spine-test.json:ro" \
  "$IMAGE" start-dev --import-realm >/dev/null

for _ in $(seq 1 90); do
  curl -fsS "$BASE/realms/$REALM/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS "$BASE/realms/$REALM/.well-known/openid-configuration" >/dev/null

kc() { docker exec "$NAME" /opt/keycloak/bin/kcadm.sh "$@"; }
kc config credentials --server http://localhost:8080 --realm master --user admin --password "$ADMIN" >/dev/null 2>&1

# The scopes VS Code asks for (Spine advertises them). Keycloak refuses a scope its client does
# not know, so they exist, as optional scopes. Spine ignores them: with a role map, permissions
# come only from the `roles` claim (Spine plugin/oidc.py, D26).
CID="$(kc get clients -r "$REALM" -q clientId="$CLIENT" --fields id --format csv --noquotes)"
for scope in spine:read spine:plan; do
  SID="$(kc create client-scopes -r "$REALM" -s name="$scope" -s protocol=openid-connect \
    -s 'attributes."include.in.token.scope"=true' -i)"
  kc update "clients/$CID/optional-client-scopes/$SID" -r "$REALM" >/dev/null
done

: >"$OUT/credentials" && chmod 600 "$OUT/credentials"
for user in planner reader; do
  pass="$(secret)"
  kc set-password -r "$REALM" --username "$user" --new-password "$pass" >/dev/null
  echo "$user $pass" >>"$OUT/credentials"
done
echo "admin $ADMIN" >>"$OUT/credentials"

# DCR off (D55): an anonymous client registration must be refused.
dcr="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"redirect_uris":["http://127.0.0.1:1/cb"]}' "$BASE/realms/$REALM/clients-registrations/openid-connect")"
echo "anonymous client registration: HTTP $dcr (expect 403)"
[[ "$dcr" == 403 ]] || { echo "DCR is open: refusing to go on" >&2; exit 1; }

echo "issuer:      $BASE/realms/$REALM"
echo "client:      $CLIENT (public, PKCE S256)"
echo "credentials: $OUT/credentials (0600; planner, reader, admin)"
