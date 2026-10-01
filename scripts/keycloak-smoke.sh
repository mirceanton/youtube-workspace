#!/usr/bin/env bash
# Headless smoke test of the Keycloak dev realm in dev/keycloak against a running Keycloak.
#
#   docker compose up -d --wait keycloak
#   scripts/keycloak-smoke.sh
#
# It acts like the web server's OIDC client, with curl instead of a browser, and checks that:
#   - the discovery document, issuer, JWKS, S256 support and the logout endpoint are there;
#   - `owner` logs in through the authorization code flow with PKCE and the tokens carry the
#     required group in the groups claim, and `outsider` logs in with the claim lacking it;
#   - the client is locked down: PKCE (S256 only), registered redirect URIs and a correct client
#     secret are all required, and the password grant is off;
#   - refreshing a token re-evaluates the group: removing `owner` from the group (admin API) drops
#     the claim on the next refresh, and adding the user back restores it;
#   - RP-initiated logout redirects to a registered post-logout URI and ends the provider session.
#
# Needs bash, curl, jq and openssl. Nothing is written to the repository, and secrets and tokens are
# never printed. Exit status 0 means every check passed; the first failing check stops the run.
#
# Environment (all optional; the defaults match .env.example and the realm export):
#   KEYCLOAK_URL             base URL used to reach Keycloak     (http://localhost:8080)
#   KEYCLOAK_REALM           realm name                          (youtube-workspace)
#   OIDC_ISSUER_URL          expected issuer                     (http://localhost:8080/realms/<realm>)
#   OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI, OIDC_GROUPS_CLAIM_PATH, OIDC_REQUIRED_GROUP
#                            same meaning as for the apps; the claim path may be dotted for nested claims
#   KEYCLOAK_OWNER_PASSWORD, KEYCLOAK_OUTSIDER_PASSWORD   dev passwords from the realm export
#   KEYCLOAK_ADMIN_USER, KEYCLOAK_ADMIN_PASSWORD          master realm admin (dev: admin / admin)
#   SMOKE_SKIP_ADMIN=1       skip the group-removal-on-refresh check (needs the admin API)
#   SMOKE_POST_LOGOUT_URI    registered post-logout URI to test  (http://localhost:5173/)
#   SMOKE_WAIT_SECONDS       how long to wait for Keycloak to answer (120)
set -euo pipefail

KEYCLOAK_URL=${KEYCLOAK_URL:-http://localhost:8080}
REALM=${KEYCLOAK_REALM:-youtube-workspace}
CLIENT_ID=${OIDC_CLIENT_ID:-youtube-workspace}
CLIENT_SECRET=${OIDC_CLIENT_SECRET:-dev-only-secret}
REDIRECT_URI=${OIDC_REDIRECT_URI:-http://localhost:5173/auth/callback}
REQUIRED_GROUP=${OIDC_REQUIRED_GROUP:-youtube-workspace-users}
GROUPS_CLAIM=${OIDC_GROUPS_CLAIM_PATH:-groups}
EXPECTED_ISSUER=${OIDC_ISSUER_URL:-http://localhost:8080/realms/${REALM}}
OWNER_PASSWORD=${KEYCLOAK_OWNER_PASSWORD:-owner-dev-pass}
OUTSIDER_PASSWORD=${KEYCLOAK_OUTSIDER_PASSWORD:-outsider-dev-pass}
ADMIN_USER=${KEYCLOAK_ADMIN_USER:-admin}
ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD:-admin}
POST_LOGOUT_URI=${SMOKE_POST_LOGOUT_URI:-http://localhost:5173/}
WAIT_SECONDS=${SMOKE_WAIT_SECONDS:-120}
SKIP_ADMIN=${SMOKE_SKIP_ADMIN:-0}

for tool in curl jq openssl; do
  command -v "${tool}" >/dev/null || {
    echo "keycloak-smoke: ${tool} is required" >&2
    exit 2
  }
done

tmp=$(mktemp -d)
removed_uid=
removed_gid=

pass() { echo "ok: $*"; }
step() { echo "--- $*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}

cleanup() {
  local status=$?
  # Leave the realm as it was found if the run stopped between removing and restoring membership.
  if [ -n "${removed_uid}" ] && [ -n "${removed_gid}" ]; then
    (admin_call PUT "/admin/realms/${REALM}/users/${removed_uid}/groups/${removed_gid}") >/dev/null 2>&1 || true
  fi
  rm -rf "${tmp}"
  exit "${status}"
}
trap cleanup EXIT

# --- helpers --------------------------------------------------------------------------------------

random_urlsafe() { openssl rand -base64 48 | tr -d '\n=' | tr '+/' '-_'; }

pkce_challenge() {
  printf '%s' "$1" | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '=' | tr '+/' '-_'
}

# jwt_claims <jwt>: the payload as JSON. The signature is not checked here; the apps do that.
jwt_claims() {
  local payload
  payload=$(printf '%s' "$1" | cut -d. -f2 | tr '_-' '/+')
  case $((${#payload} % 4)) in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  printf '%s' "${payload}" | jq -R '@base64d | fromjson'
}

# header_value <name>: the last value of a response header from the most recent request.
header_value() {
  grep -i "^$1:" "${tmp}/headers" | tail -n 1 | sed -E "s/^[^:]*: *//" | tr -d '\r\n' || true
}

# urldecode <percent-encoded string>
urldecode() {
  local value=${1//+/ }
  printf '%b' "${value//%/\\x}"
}

# query_param <url> <name>
query_param() { printf '%s' "$1" | sed -nE "s/.*[?&]$2=([^&#]*).*/\1/p" | head -n 1; }

# login_form_action <html file>: the URL the Keycloak login form posts to.
login_form_action() {
  tr '\n' ' ' <"$1" | grep -oE 'action="[^"]*login-actions/authenticate[^"]*"' | head -n 1 |
    sed -E 's/^action="//; s/"$//; s/&amp;/\&/g'
}

# authorize <cookie jar> <redirect uri> <state> <nonce> [<code challenge> <method>]
# Sends the authorization request, leaves headers and body in ${tmp}, prints the HTTP status.
authorize() {
  local jar=$1 redirect=$2 state=$3 nonce=$4 challenge=${5:-} method=${6:-S256}
  local args=(
    --data-urlencode "response_type=code"
    --data-urlencode "client_id=${CLIENT_ID}"
    --data-urlencode "redirect_uri=${redirect}"
    --data-urlencode "scope=openid profile email"
    --data-urlencode "state=${state}"
    --data-urlencode "nonce=${nonce}"
  )
  if [ -n "${challenge}" ]; then
    args+=(--data-urlencode "code_challenge=${challenge}" --data-urlencode "code_challenge_method=${method}")
  fi
  curl -sS --max-time 30 -G -o "${tmp}/body" -D "${tmp}/headers" -w '%{http_code}' \
    -b "${jar}" -c "${jar}" "${args[@]}" "${authorization_endpoint}"
}

# submit_login <cookie jar> <form action url> <username> <password>: prints the HTTP status.
submit_login() {
  curl -sS --max-time 30 -o "${tmp}/body" -D "${tmp}/headers" -w '%{http_code}' \
    -b "$1" -c "$1" \
    --data-urlencode "username=$3" --data-urlencode "password=$4" --data-urlencode "credentialId=" "$2"
}

# login <username> <password> <code verifier>
# Runs the browser part of the code flow. Sets LOGIN_CODE, LOGIN_NONCE and LOGIN_ISS.
login() {
  local username=$1 password=$2 verifier=$3 jar="${tmp}/jar-$1-$RANDOM" state status action location
  : >"${jar}"
  state=$(random_urlsafe)
  LOGIN_NONCE=$(random_urlsafe)
  status=$(authorize "${jar}" "${REDIRECT_URI}" "${state}" "${LOGIN_NONCE}" "$(pkce_challenge "${verifier}")" S256)
  [ "${status}" = 200 ] || fail "authorization request for ${username} returned HTTP ${status}, expected the login page (200)"
  action=$(login_form_action "${tmp}/body") || action=
  [ -n "${action}" ] || fail "no Keycloak login form found in the authorization response for ${username}"
  status=$(submit_login "${jar}" "${action}" "${username}" "${password}")
  [ "${status}" = 302 ] || fail "login of ${username} returned HTTP ${status}, expected a redirect (302)"
  location=$(header_value location)
  case "${location}" in
    "${REDIRECT_URI}"\?*) ;;
    *) fail "login of ${username} redirected somewhere other than the registered redirect URI" ;;
  esac
  [ "$(query_param "${location}" state)" = "${state}" ] || fail "state not echoed back for ${username}"
  LOGIN_CODE=$(query_param "${location}" code)
  [ -n "${LOGIN_CODE}" ] || fail "no authorization code in the redirect for ${username} ($(query_param "${location}" error))"
  LOGIN_ISS=$(query_param "${location}" iss)
}

# token_request <client secret> <curl --data-urlencode args...>: prints the HTTP status, body in token.json
token_request() {
  local secret=$1
  shift
  curl -sS --max-time 30 -o "${tmp}/token.json" -w '%{http_code}' -u "${CLIENT_ID}:${secret}" "$@" "${token_endpoint}"
}

exchange_code() { # exchange_code <code> <verifier> [client secret]
  token_request "${3:-${CLIENT_SECRET}}" \
    --data-urlencode "grant_type=authorization_code" --data-urlencode "code=$1" \
    --data-urlencode "redirect_uri=${REDIRECT_URI}" --data-urlencode "code_verifier=$2"
}

refresh() { # refresh <refresh token>
  token_request "${CLIENT_SECRET}" --data-urlencode "grant_type=refresh_token" --data-urlencode "refresh_token=$1"
}

# in_group <claims json> prints true when the groups claim lists the required group.
in_group() {
  jq -r --arg claim "${GROUPS_CLAIM}" --arg group "${REQUIRED_GROUP}" \
    '((getpath($claim | split(".")) // []) | index($group)) != null' <<<"$1"
}

# expect_membership <label> <jwt> <true|false>
expect_membership() {
  local label=$1 jwt=$2 expected=$3 claims actual
  claims=$(jwt_claims "${jwt}")
  actual=$(in_group "${claims}")
  [ "${actual}" = "${expected}" ] ||
    fail "${label}: claim '${GROUPS_CLAIM}' is $(jq -c --arg claim "${GROUPS_CLAIM}" 'getpath($claim | split(".")) // "absent"' <<<"${claims}"), group ${REQUIRED_GROUP} expected present=${expected}"
}

admin_token() {
  curl -sS --max-time 30 -d client_id=admin-cli -d grant_type=password \
    --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password=${ADMIN_PASSWORD}" \
    "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" | jq -r '.access_token // empty'
}

# admin_call <method> <path>: prints the response body, fails on an HTTP error. The master realm's
# access tokens live for a minute, so every call gets a fresh one.
admin_call() {
  local token
  token=$(admin_token)
  [ -n "${token}" ] || fail "could not get an admin token for ${ADMIN_USER} (set KEYCLOAK_ADMIN_USER/KEYCLOAK_ADMIN_PASSWORD or SMOKE_SKIP_ADMIN=1)"
  curl -sS --max-time 30 --fail-with-body -X "$1" -H "Authorization: Bearer ${token}" "${KEYCLOAK_URL}$2"
}

# --- discovery ------------------------------------------------------------------------------------

step "Wait for Keycloak at ${KEYCLOAK_URL} (realm ${REALM})"
discovery_url="${KEYCLOAK_URL}/realms/${REALM}/.well-known/openid-configuration"
deadline=$((SECONDS + WAIT_SECONDS))
until curl -fsS --max-time 5 -o "${tmp}/discovery.json" "${discovery_url}" 2>/dev/null; do
  [ "${SECONDS}" -lt "${deadline}" ] || fail "no discovery document at ${discovery_url} after ${WAIT_SECONDS}s (is the realm imported?)"
  sleep 2
done
pass "discovery document served at ${discovery_url}"

step "Discovery document"
jq -e --arg issuer "${EXPECTED_ISSUER}" '.issuer == $issuer' "${tmp}/discovery.json" >/dev/null ||
  fail "issuer is $(jq -r .issuer "${tmp}/discovery.json"), expected ${EXPECTED_ISSUER}"
pass "issuer is ${EXPECTED_ISSUER}"
jq -e '(.response_types_supported | index("code")) != null and (.grant_types_supported | index("authorization_code")) != null and (.grant_types_supported | index("refresh_token")) != null' \
  "${tmp}/discovery.json" >/dev/null || fail "authorization code and refresh token grants are not advertised"
pass "authorization code and refresh token grants are advertised"
jq -e '(.code_challenge_methods_supported | index("S256")) != null' "${tmp}/discovery.json" >/dev/null ||
  fail "PKCE S256 is not advertised"
pass "PKCE S256 is advertised"
authorization_endpoint=$(jq -r .authorization_endpoint "${tmp}/discovery.json")
token_endpoint=$(jq -r .token_endpoint "${tmp}/discovery.json")
end_session_endpoint=$(jq -r '.end_session_endpoint // empty' "${tmp}/discovery.json")
jwks_uri=$(jq -r .jwks_uri "${tmp}/discovery.json")
[ -n "${end_session_endpoint}" ] || fail "no end_session_endpoint (RP-initiated logout) in the discovery document"
pass "end_session_endpoint is advertised"
curl -fsS --max-time 10 "${jwks_uri}" | jq -e '(.keys | length) > 0' >/dev/null || fail "JWKS at ${jwks_uri} has no keys"
pass "JWKS has signing keys"

# --- the code flow for both users -----------------------------------------------------------------

check_login() { # check_login <username> <password> <expect member: true|false>
  local username=$1 password=$2 member=$3 verifier id_token access_token claims
  step "Authorization code flow with PKCE as ${username}"
  verifier=$(random_urlsafe)
  login "${username}" "${password}" "${verifier}"
  pass "login of ${username} redirected to ${REDIRECT_URI} with a code and the original state"
  if [ -n "${LOGIN_ISS}" ]; then
    # RFC 9207 issuer identification; the value is percent-encoded in the redirect.
    [ "$(urldecode "${LOGIN_ISS}")" = "${EXPECTED_ISSUER}" ] ||
      fail "iss in the redirect is $(urldecode "${LOGIN_ISS}"), expected ${EXPECTED_ISSUER}"
  fi
  [ "$(exchange_code "${LOGIN_CODE}" "${verifier}")" = 200 ] ||
    fail "code exchange for ${username} failed: $(jq -r '.error + ": " + (.error_description // "")' "${tmp}/token.json" 2>/dev/null)"
  id_token=$(jq -r '.id_token // empty' "${tmp}/token.json")
  access_token=$(jq -r '.access_token // empty' "${tmp}/token.json")
  [ -n "${id_token}" ] && [ -n "${access_token}" ] && [ -n "$(jq -r '.refresh_token // empty' "${tmp}/token.json")" ] ||
    fail "token response for ${username} lacks id_token, access_token or refresh_token"
  pass "code exchange returned id, access and refresh tokens"

  claims=$(jwt_claims "${id_token}")
  jq -e --arg iss "${EXPECTED_ISSUER}" --arg client "${CLIENT_ID}" --arg user "${username}" --arg nonce "${LOGIN_NONCE}" \
    '.iss == $iss and .preferred_username == $user and .nonce == $nonce and .azp == $client and (([.aud] | flatten | index($client)) != null) and ((.sub // "") != "")' \
    <<<"${claims}" >/dev/null || fail "ID token claims for ${username} are wrong (iss, aud, azp, nonce, sub or preferred_username)"
  pass "ID token: issuer, audience, nonce, subject and preferred_username=${username} are right"
  jq -e '(.email // "") != ""' <<<"${claims}" >/dev/null || fail "ID token for ${username} has no email claim"

  expect_membership "ID token of ${username}" "${id_token}" "${member}"
  expect_membership "access token of ${username}" "${access_token}" "${member}"
  if [ "${member}" = true ]; then
    pass "${username}: claim '${GROUPS_CLAIM}' contains ${REQUIRED_GROUP} in the ID and access tokens"
  else
    pass "${username}: claim '${GROUPS_CLAIM}' does not contain ${REQUIRED_GROUP} in the ID and access tokens"
  fi
  LAST_REFRESH_TOKEN=$(jq -r .refresh_token "${tmp}/token.json")
  LAST_ID_TOKEN=${id_token}
}

check_login owner "${OWNER_PASSWORD}" true
owner_refresh_token=${LAST_REFRESH_TOKEN}
owner_id_token=${LAST_ID_TOKEN}
check_login outsider "${OUTSIDER_PASSWORD}" false

# --- the client is locked down --------------------------------------------------------------------

step "Client restrictions"
jar="${tmp}/jar-negative"
: >"${jar}"
challenge=$(pkce_challenge "$(random_urlsafe)")

status=$(authorize "${jar}" "${REDIRECT_URI}" state nonce)
if [ "${status}" = 200 ] && [ -n "$(login_form_action "${tmp}/body" || true)" ]; then
  fail "an authorization request without a PKCE challenge was given a login form"
fi
pass "authorization request without PKCE is refused (HTTP ${status}, $(query_param "$(header_value location)" error))"

status=$(authorize "${jar}" "${REDIRECT_URI}" state nonce "${challenge}" plain)
if [ "${status}" = 200 ] && [ -n "$(login_form_action "${tmp}/body" || true)" ]; then
  fail "an authorization request with code_challenge_method=plain was given a login form"
fi
pass "authorization request with PKCE method plain is refused (HTTP ${status}, $(query_param "$(header_value location)" error))"

status=$(authorize "${jar}" "http://evil.example/auth/callback" state nonce "${challenge}" S256)
if [ "${status}" = 302 ] && [[ "$(header_value location)" == http://evil.example/* ]]; then
  fail "an unregistered redirect URI was accepted"
fi
if [ "${status}" = 200 ] && [ -n "$(login_form_action "${tmp}/body" || true)" ]; then
  fail "an unregistered redirect URI was given a login form"
fi
pass "unregistered redirect URI is refused (HTTP ${status})"

verifier=$(random_urlsafe)
login owner "${OWNER_PASSWORD}" "${verifier}"
status=$(exchange_code "${LOGIN_CODE}" "${verifier}" "not-the-client-secret")
{ [ "${status}" = 401 ] || [ "${status}" = 400 ]; } && [ "$(jq -r '.access_token // empty' "${tmp}/token.json")" = "" ] ||
  fail "code exchange with a wrong client secret returned HTTP ${status}, expected 401 and no tokens"
pass "wrong client secret is refused (HTTP ${status})"

verifier=$(random_urlsafe)
login owner "${OWNER_PASSWORD}" "${verifier}"
status=$(exchange_code "${LOGIN_CODE}" "$(random_urlsafe)")
{ [ "${status}" = 400 ] && [ "$(jq -r .error "${tmp}/token.json")" = invalid_grant ]; } ||
  fail "code exchange with a wrong PKCE verifier returned HTTP ${status}, expected 400 invalid_grant"
pass "wrong PKCE code verifier is refused (HTTP 400 invalid_grant)"

status=$(token_request "${CLIENT_SECRET}" --data-urlencode "grant_type=password" \
  --data-urlencode "username=owner" --data-urlencode "password=${OWNER_PASSWORD}")
{ [ "${status}" = 400 ] || [ "${status}" = 401 ]; } && [ "$(jq -r '.access_token // empty' "${tmp}/token.json")" = "" ] ||
  fail "the password grant returned HTTP ${status}, expected a refusal"
pass "password grant is disabled for the client (HTTP ${status}, $(jq -r .error "${tmp}/token.json"))"

jar="${tmp}/jar-badpass"
: >"${jar}"
status=$(authorize "${jar}" "${REDIRECT_URI}" state nonce "${challenge}" S256)
[ "${status}" = 200 ] || fail "authorization request returned HTTP ${status}"
action=$(login_form_action "${tmp}/body") || action=
[ -n "${action}" ] || fail "no login form for the wrong-password check"
status=$(submit_login "${jar}" "${action}" owner "wrong-password")
if [ "${status}" = 302 ] && [ -n "$(query_param "$(header_value location)" code)" ]; then
  fail "a wrong password was accepted"
fi
pass "wrong password is refused (HTTP ${status}, no code issued)"

# --- refresh re-evaluates the group ----------------------------------------------------------------

if [ "${SKIP_ADMIN}" = 1 ]; then
  step "Group removal on refresh: skipped (SMOKE_SKIP_ADMIN=1)"
else
  step "Group membership is re-evaluated on refresh"
  [ "$(refresh "${owner_refresh_token}")" = 200 ] || fail "refresh for owner failed: $(jq -r '.error' "${tmp}/token.json")"
  expect_membership "refreshed ID token of owner" "$(jq -r .id_token "${tmp}/token.json")" true
  expect_membership "refreshed access token of owner" "$(jq -r .access_token "${tmp}/token.json")" true
  owner_refresh_token=$(jq -r .refresh_token "${tmp}/token.json")
  pass "refresh keeps the group while the user is a member"

  user_id=$(admin_call GET "/admin/realms/${REALM}/users?username=owner&exact=true" | jq -r '.[0].id // empty')
  group_id=$(admin_call GET "/admin/realms/${REALM}/groups?search=${REQUIRED_GROUP}" |
    jq -r --arg group "${REQUIRED_GROUP}" '[.[] | select(.name == $group)][0].id // empty')
  [ -n "${user_id}" ] && [ -n "${group_id}" ] || fail "could not find user owner or group ${REQUIRED_GROUP} through the admin API"
  admin_call DELETE "/admin/realms/${REALM}/users/${user_id}/groups/${group_id}" >/dev/null
  removed_uid=${user_id}
  removed_gid=${group_id}
  [ "$(refresh "${owner_refresh_token}")" = 200 ] || fail "refresh after removal failed: $(jq -r '.error' "${tmp}/token.json")"
  expect_membership "refreshed ID token after removal" "$(jq -r .id_token "${tmp}/token.json")" false
  expect_membership "refreshed access token after removal" "$(jq -r .access_token "${tmp}/token.json")" false
  owner_refresh_token=$(jq -r .refresh_token "${tmp}/token.json")
  pass "removing owner from ${REQUIRED_GROUP} drops the claim on the next refresh"

  admin_call PUT "/admin/realms/${REALM}/users/${user_id}/groups/${group_id}" >/dev/null
  removed_uid=
  removed_gid=
  [ "$(refresh "${owner_refresh_token}")" = 200 ] || fail "refresh after restore failed: $(jq -r '.error' "${tmp}/token.json")"
  expect_membership "refreshed ID token after restore" "$(jq -r .id_token "${tmp}/token.json")" true
  owner_refresh_token=$(jq -r .refresh_token "${tmp}/token.json")
  pass "adding owner back restores the claim"
fi

# --- RP-initiated logout ---------------------------------------------------------------------------

step "RP-initiated logout"
logout() { # logout <post logout redirect uri>: prints the HTTP status
  curl -sS --max-time 30 -G -o "${tmp}/body" -D "${tmp}/headers" -w '%{http_code}' \
    --data-urlencode "id_token_hint=${owner_id_token}" --data-urlencode "client_id=${CLIENT_ID}" \
    --data-urlencode "post_logout_redirect_uri=$1" --data-urlencode "state=bye" "${end_session_endpoint}"
}
status=$(logout "http://evil.example/")
if [ "${status}" = 302 ] && [[ "$(header_value location)" == http://evil.example/* ]]; then
  fail "logout redirected to an unregistered post-logout URI"
fi
pass "unregistered post-logout redirect URI is refused (HTTP ${status})"
[ "$(refresh "${owner_refresh_token}")" = 200 ] || fail "the failed logout attempt ended the session"
owner_refresh_token=$(jq -r .refresh_token "${tmp}/token.json")
owner_id_token=$(jq -r .id_token "${tmp}/token.json")

status=$(logout "${POST_LOGOUT_URI}")
[ "${status}" = 302 ] && [[ "$(header_value location)" == "${POST_LOGOUT_URI}"* ]] ||
  fail "logout returned HTTP ${status} (Location: $(header_value location)), expected a redirect to ${POST_LOGOUT_URI}"
pass "logout redirects to the registered post-logout URI ${POST_LOGOUT_URI}"
status=$(refresh "${owner_refresh_token}")
{ [ "${status}" = 400 ] && [ "$(jq -r .error "${tmp}/token.json")" = invalid_grant ]; } ||
  fail "the refresh token still works after logout (HTTP ${status})"
pass "the provider session is gone: the refresh token is rejected after logout"

echo "keycloak-smoke: all checks passed"
