#!/usr/bin/env bash
# Structural validation of the Keycloak dev realm export. Needs only bash and jq, so it runs in the
# agent sandbox (where Keycloak itself cannot), on a laptop and as the first step of the
# keycloak-smoke workflow.
#
#   dev/keycloak/validate-realm.sh [realm.json] [.env.example]
#
# It checks that the file is valid JSON, that the client, group, users and token mappers have the
# shape docs/keycloak.md promises, and that the realm agrees with the OIDC_* values in .env.example.
# It cannot prove that Keycloak accepts the file or behaves as described; scripts/keycloak-smoke.sh
# does that against a running server.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "${here}/../.." && pwd)
realm_file=${1:-${here}/youtube-workspace-realm.json}
env_file=${2:-${repo}/.env.example}

command -v jq >/dev/null || {
  echo "validate-realm: jq is required" >&2
  exit 2
}

failures=0
fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}
pass() { echo "ok: $*"; }

# check <description> <jq filter that must print true>
check() {
  local description=$1 filter=$2 result
  if result=$(jq -r "${filter}" "${realm_file}" 2>&1) && [ "${result}" = "true" ]; then
    pass "${description}"
  else
    fail "${description} (jq said: ${result})"
  fi
}

# env_value <name>: value of NAME=... in the env file, commented-out lines included; the last one wins.
env_value() {
  grep -E "^#? ?$1=" "${env_file}" | tail -n 1 | sed -E "s/^#? ?$1=//" || true
}

jq -e . "${realm_file}" >/dev/null || {
  echo "FAIL: ${realm_file} is not valid JSON" >&2
  exit 1
}
pass "valid JSON: ${realm_file}"

client='.clients[] | select(.clientId == "youtube-workspace")'

check "realm is named youtube-workspace and enabled" '.realm == "youtube-workspace" and .enabled == true'
check "exactly one client with id youtube-workspace" '[.clients[] | select(.clientId == "youtube-workspace")] | length == 1'
check "client is confidential (client secret, not public, not bearer-only)" \
  "${client} | .publicClient == false and .bearerOnly == false and .clientAuthenticatorType == \"client-secret\" and (.secret | type == \"string\" and length > 0)"
check "client uses the authorization code flow only (no implicit, no password grant, no service account)" \
  "${client} | .standardFlowEnabled == true and .implicitFlowEnabled == false and .directAccessGrantsEnabled == false and .serviceAccountsEnabled == false"
check "client requires PKCE with S256" "${client} | .attributes.\"pkce.code.challenge.method\" == \"S256\""

for origin in http://localhost:3000 http://127.0.0.1:3000 http://localhost:5173 http://127.0.0.1:5173; do
  check "redirect URI ${origin}/auth/callback is registered" \
    "${client} | .redirectUris | index(\"${origin}/auth/callback\") != null"
  check "post-logout redirect URIs cover ${origin}" \
    "${client} | .attributes.\"post.logout.redirect.uris\" | split(\"##\") | index(\"${origin}/*\") != null"
done
check "no redirect URI is a bare wildcard" "${client} | [.redirectUris[] | select(. == \"*\" or endswith(\"://*\"))] | length == 0"

check "a group membership mapper puts the groups into the groups claim (short names, ID + access token + userinfo)" \
  "${client} | [.protocolMappers[] | select(.protocolMapper == \"oidc-group-membership-mapper\" and .config.\"claim.name\" == \"groups\" and .config.\"full.path\" == \"false\" and .config.\"id.token.claim\" == \"true\" and .config.\"access.token.claim\" == \"true\" and .config.\"userinfo.token.claim\" == \"true\")] | length == 1"
check "the access-token audience mapper includes the web client but not the ID token" \
  "${client} | [.protocolMappers[] | select(.protocolMapper == \"oidc-audience-mapper\" and .config.\"included.client.audience\" == \"youtube-workspace\" and .config.\"access.token.claim\" == \"true\" and .config.\"id.token.claim\" == \"false\")] | length == 1"

group=$(env_value OIDC_REQUIRED_GROUP)
if [ -z "${group}" ]; then
  fail "OIDC_REQUIRED_GROUP not found in ${env_file}"
  group=youtube-workspace-users
fi
check "group ${group} exists at the top level" "[.groups[] | select(.name == \"${group}\" and .path == \"/${group}\")] | length == 1"

user() { echo ".users[] | select(.username == \"$1\")"; }
check "user owner is enabled, complete and a member of /${group}" \
  "$(user owner) | .enabled == true and .emailVerified == true and (.firstName | length > 0) and (.lastName | length > 0) and (.email | length > 0) and (.groups | index(\"/${group}\") != null)"
check "user outsider is enabled, complete and in no group" \
  "$(user outsider) | .enabled == true and .emailVerified == true and (.firstName | length > 0) and (.lastName | length > 0) and (.email | length > 0) and ((.groups // []) | length == 0)"
check "both users have a permanent password and no pending required action" \
  "[.users[] | select(.username == \"owner\" or .username == \"outsider\") | select((.credentials | length == 1) and .credentials[0].type == \"password\" and .credentials[0].temporary == false and (.credentials[0].value | length > 0) and ((.requiredActions // []) | length == 0))] | length == 2"
check "exactly two users: owner and outsider" '[.users[].username] | sort == ["outsider", "owner"]'

# The realm must agree with the configuration the apps are told to use.
env_issuer=$(env_value OIDC_ISSUER_URL)
env_client_id=$(env_value OIDC_CLIENT_ID)
env_client_secret=$(env_value OIDC_CLIENT_SECRET)
env_redirect=$(env_value OIDC_REDIRECT_URI)
env_claim=$(env_value OIDC_GROUPS_CLAIM_PATH)

if [ "${env_issuer}" = "http://localhost:8080/realms/youtube-workspace" ]; then
  pass "OIDC_ISSUER_URL in ${env_file} points at the dev realm"
else
  fail "OIDC_ISSUER_URL in ${env_file} is '${env_issuer}', expected http://localhost:8080/realms/youtube-workspace"
fi
check "OIDC_CLIENT_ID in ${env_file} ('${env_client_id}') is the realm's client" "[${client}] | length == 1 and .[0].clientId == \"${env_client_id}\""
check "OIDC_CLIENT_SECRET in ${env_file} matches the realm's client secret" "${client} | .secret == \"${env_client_secret}\""
check "OIDC_REDIRECT_URI in ${env_file} ('${env_redirect}') is a registered redirect URI" "${client} | .redirectUris | index(\"${env_redirect}\") != null"
check "OIDC_GROUPS_CLAIM_PATH in ${env_file} ('${env_claim}') is the claim the mapper writes" \
  "${client} | [.protocolMappers[] | select(.config.\"claim.name\" == \"${env_claim}\")] | length == 1"

if [ "${failures}" -gt 0 ]; then
  echo "validate-realm: ${failures} check(s) failed" >&2
  exit 1
fi
echo "validate-realm: all checks passed"
