# Keycloak dev realm

The repository ships a Keycloak realm so the whole login flow runs on your machine with one
command, without touching a shared identity provider (PRD sections 7 and 9). This page covers what
the realm contains, how to run it, how to point the apps at it, and how it is tested.

Everything here is **dev only**: the credentials below are public, the realm allows plain HTTP,
and the Keycloak container runs in `start-dev` mode. Never reuse any of it in a real deployment.

## Run it

```bash
cp .env.example .env     # the Keycloak values are already active at the end of the file
docker compose up -d     # Postgres and Keycloak; or: pnpm dev:stack (waits until both are healthy)
pnpm dev                 # web server, MCP server and web UI
```

Keycloak takes 20 to 40 seconds to start the first time. It is healthy once the realm is imported
and `http://localhost:8080/realms/youtube-workspace/.well-known/openid-configuration` answers.
`docker compose up -d keycloak` starts only Keycloak.

| What | Where |
| --- | --- |
| Realm export (imported on start) | `dev/keycloak/youtube-workspace-realm.json` |
| Compose service | `keycloak` in `docker-compose.yml` |
| Realm checks that need no Keycloak | `dev/keycloak/validate-realm.sh` |
| Headless login test against a running Keycloak | `scripts/keycloak-smoke.sh` |
| CI proof | `.github/workflows/keycloak-smoke.yaml` |

The realm is imported from the file each time the container is created, and there is no data
volume, so a recreated container is always in the documented state. Keycloak skips the import when
the realm already exists, so after editing the JSON recreate the container
(`docker compose down` then `up -d`, or `docker compose up -d --force-recreate keycloak`). A plain
`docker compose restart` keeps whatever you changed in the admin console.

## Dev credentials

| Account | Username | Password | Notes |
| --- | --- | --- | --- |
| Group member | `owner` | `owner-dev-pass` | In `youtube-workspace-users`; can sign in. The first user to sign in becomes the app admin. |
| Not in the group | `outsider` | `outsider-dev-pass` | Authenticates at Keycloak, but its tokens carry no matching group, so the app must show "access denied" and create no user record. |
| Keycloak admin (master realm) | `admin` | `admin` | Admin console at http://localhost:8080/admin; set by `KC_BOOTSTRAP_ADMIN_*` in `docker-compose.yml`. |
| OIDC client secret | `youtube-workspace` | `dev-only-secret` | `OIDC_CLIENT_SECRET`. |

Both users have a first name, last name and verified email, so Keycloak does not interrupt the login
with an "update your profile" step, and their passwords are permanent. The realm has no other
users. Tests that need a second member of the group create one through the admin API (recipe
below).

## What the realm contains

- **Realm** `youtube-workspace`, SSL not required (plain HTTP on localhost), registration, password
  reset and "remember me" off. Access tokens live 5 minutes (Keycloak's default), the SSO session
  idles out after 8 hours and ends after 7 days, matching the app's session defaults so Keycloak does
  not end a session before the app would.
- **Client** `youtube-workspace`: a confidential client (client secret authentication) that uses only
  the authorization code flow. Implicit flow, the password grant and service accounts are off.
  PKCE is required and only `S256` is accepted (`pkce.code.challenge.method`).
- **Redirect URIs**, exact matches, for the web server and the Vite dev server on both host names:
  `http://localhost:3000/auth/callback`, `http://127.0.0.1:3000/auth/callback`,
  `http://localhost:5173/auth/callback`, `http://127.0.0.1:5173/auth/callback`.
  If the callback path changes, change it here and in `OIDC_REDIRECT_URI`.
- **Post-logout redirect URIs** (for RP-initiated logout): `http://localhost:3000/*`,
  `http://127.0.0.1:3000/*`, `http://localhost:5173/*`, `http://127.0.0.1:5173/*`.
- **Group** `youtube-workspace-users` (top level), the value of `OIDC_REQUIRED_GROUP`. `owner` is a
  member, `outsider` is not. The group only gates sign-in; it never maps to permissions inside the
  app (PRD 7).
- **Group membership mapper** on the client: adds a `groups` claim to the ID token, the access token
  and the userinfo response, with short group names (`full.path` off), so the claim looks like
  `"groups": ["youtube-workspace-users"]`. A user in no group gets an empty list. With full paths
  turned on it would be `["/youtube-workspace-users"]`; the web server's group check tolerates
  that form, but the realm does not use it.
- The standard client scopes (`profile`, `email`, `roles`, ...) give the ID token `sub`,
  `preferred_username` (the audit actor), `name` and `email`.

## Configuration the apps use

These are the values at the end of `.env.example`, under `# --- keycloak ---`. Copying the file to
`.env` is enough for the apps to log in against the dev realm.

| Variable | Dev value | Meaning |
| --- | --- | --- |
| `OIDC_ISSUER_URL` | `http://localhost:8080/realms/youtube-workspace` | Discovery is `<issuer>/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` | `youtube-workspace` | |
| `OIDC_CLIENT_SECRET` | `dev-only-secret` | Dev only |
| `OIDC_REDIRECT_URI` | `http://localhost:5173/auth/callback` | Browser entry through the Vite dev server; port 3000 works too |
| `OIDC_GROUPS_CLAIM_PATH` | `groups` | Where the group list is in the token claims |
| `OIDC_REQUIRED_GROUP` | `youtube-workspace-users` | The group a user must be in to sign in |

The issuer in every token is fixed to `http://localhost:8080/realms/youtube-workspace`
(`KC_HOSTNAME` in the compose file), whatever host name a request used, so it always matches
`OIDC_ISSUER_URL`. The consequence is that Keycloak must be reachable at `localhost:8080` for
anything that follows the URLs in the discovery document. The apps run on the host in local
development, so this holds; a containerised app would need that host name to resolve to Keycloak.

`.env.example` also keeps the commented OIDC examples from the configuration section above; because
dotenv-style loaders let the last assignment win, the active values at the end take precedence.

### Renaming the group

The group name appears in the realm file (the group, its `path`, and `owner`'s membership) and in
`OIDC_REQUIRED_GROUP`. To change it, edit all of them and recreate the container;
`dev/keycloak/validate-realm.sh` fails if `.env.example` and the realm disagree, and
`scripts/keycloak-smoke.sh` follows `OIDC_REQUIRED_GROUP` from the environment.

### Using another provider

The apps only need the six variables above, so any OIDC provider that can issue a list of group
names in a claim works. Create a confidential client with the authorization code flow and PKCE,
register the callback URL, add a groups claim, and point the variables at it.
`OIDC_GROUPS_CLAIM_PATH` may be a nested path for providers that put groups elsewhere.

## Checking it

### Without Keycloak

```bash
dev/keycloak/validate-realm.sh        # needs bash and jq only
```

Checks that the JSON parses, that the client is confidential with PKCE `S256` and no implicit or
password grant, that all four redirect URIs and post-logout URIs are registered, that the mapper
writes the `groups` claim, that `owner` is in the group and `outsider` is not, and that the realm
agrees with the `OIDC_*` values in `.env.example`. This is all that can run in an environment that
cannot start Keycloak, such as the agent sandbox. It does not prove that Keycloak accepts the file.

### Against a running Keycloak

```bash
docker compose up -d --wait keycloak
scripts/keycloak-smoke.sh
```

The script acts like the web server's OIDC client, with curl instead of a browser. It needs bash,
curl, jq and openssl, never prints tokens, and stops at the first failing check. It verifies:

1. The discovery document (issuer, code and refresh grants, `S256`, JWKS, `end_session_endpoint`).
2. A full authorization code flow with PKCE for `owner`: login form, redirect to the registered URI
   with the original `state`, code exchange with the client secret, then ID token claims (issuer,
   audience, `azp`, nonce, `sub`, `preferred_username`) and the `groups` claim containing
   `youtube-workspace-users` in the ID and access tokens.
3. The same flow for `outsider`, whose tokens must not contain the group.
4. Client restrictions: a request without a PKCE challenge, one with method `plain`, an
   unregistered redirect URI, a wrong client secret, a wrong code verifier, the password grant and a
   wrong password are all refused.
5. Refresh re-evaluates the group: after `owner` is removed from the group through the admin API,
   the next refresh returns tokens without the claim; after being added back, the claim returns.
   The membership is restored even if the script stops early.
6. RP-initiated logout: an unregistered post-logout URI is refused, a registered one gets a
   redirect, and the refresh token no longer works afterwards.

Settings come from the same `OIDC_*` variables as the apps (`set -a; . ./.env; set +a` first if you
want your local values) plus `KEYCLOAK_URL`, `KEYCLOAK_ADMIN_USER`/`KEYCLOAK_ADMIN_PASSWORD`,
`SMOKE_SKIP_ADMIN=1` to skip step 5 and `SMOKE_WAIT_SECONDS`; the header of the script lists them.
The script only decodes tokens; checking their signatures is the job of the apps' OIDC library.

### In CI

`.github/workflows/keycloak-smoke.yaml` runs shellcheck, `validate-realm.sh`, starts the compose
service and runs the smoke script. It triggers on `workflow_dispatch` and on pushes and pull
requests that change the realm, the compose file, `.env.example` or the script, which covers
Renovate bumping the image tag. The end-to-end browser test of the app's login (a later task) uses
the same compose service.

## Image version

The compose file pins `quay.io/keycloak/keycloak` to an exact 26.x tag so Renovate can track it. The
tag was chosen without access to the registry (it is blocked where this was written): the Keycloak
npm packages are released together with the server, and `@keycloak/keycloak-admin-client` listed
26.7.5 as the latest patch release before 26.8.0, which had been published that same day. The
smoke workflow is what proves that the tag pulls and that the realm imports and behaves on it.
Realm export fields used here are long-standing Keycloak representation fields; if a major version
changes the format, re-export the realm from a running instance and merge the differences.

## Recipes

Admin API calls against the dev instance (the master-realm token lives for one minute):

```bash
base=http://localhost:8080
token=$(curl -sS -d client_id=admin-cli -d grant_type=password -d username=admin -d password=admin \
  "$base/realms/master/protocol/openid-connect/token" | jq -r .access_token)
auth="Authorization: Bearer $token"

# Create a second member of the group, with a permanent password
curl -sS -X POST -H "$auth" -H 'Content-Type: application/json' "$base/admin/realms/youtube-workspace/users" -d '{
  "username": "collaborator", "enabled": true, "emailVerified": true, "firstName": "Dev", "lastName": "Collaborator",
  "email": "collaborator@youtube-workspace.test", "groups": ["/youtube-workspace-users"],
  "credentials": [{"type": "password", "value": "collaborator-dev-pass", "temporary": false}]
}'

# Remove a user from the group (their next token refresh then lacks the claim), and add them back
user=$(curl -sS -H "$auth" "$base/admin/realms/youtube-workspace/users?username=owner&exact=true" | jq -r '.[0].id')
group=$(curl -sS -H "$auth" "$base/admin/realms/youtube-workspace/groups?search=youtube-workspace-users" | jq -r '.[0].id')
curl -sS -X DELETE -H "$auth" "$base/admin/realms/youtube-workspace/users/$user/groups/$group"
curl -sS -X PUT -H "$auth" "$base/admin/realms/youtube-workspace/users/$user/groups/$group"
```

To start over from the documented state: `docker compose down` and `docker compose up -d`.
