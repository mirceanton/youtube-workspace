# OIDC and Phase 3 end-to-end stories

The Playwright scenario covers in-group sign-in, the first-user admin rule, outsider denial before
user creation, a new user's initial no-access state, admin permission grants, group-removal
revocation at refresh, RP logout, and using a token created in the UI against the MCP endpoint.

The same runner discovers `stories/**/*.spec.ts`: idea-board dragging, phone script reading and
comments, experiment comparison, MCP Markdown revision round trip and stale-upload rejection,
token creation/revocation, the admin access matrix, two-session conflicts, human/agent activity,
restricted search and activity visibility, and changes visible in an already-open phone reader
within 15 seconds. A route matrix probes every feature API method/path with None, Read and Write,
plus unauthenticated requests. See [Phase 3 traceability](../docs/traceability/phase3.md).

The local default uses a small in-process OIDC provider, so Keycloak is not needed:

```sh
E2E_IDP=mock TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  pnpm --filter @ytw/e2e test:e2e
```

Install Chromium first with `pnpm --filter @ytw/e2e exec playwright install chromium`. The test
creates and drops its own unique database through `@ytw/db/testing`. `TEST_DATABASE_URL` must point
to a local Postgres superuser; the shared dev server is supported and the helper refuses to replace
an existing application-role password. Keep ports 3000, 3001, 4100, and 5173 free while it runs.

To exercise a real Keycloak realm, start the project's dev Keycloak and run:

```sh
E2E_IDP=keycloak \
KEYCLOAK_URL=http://localhost:8080 \
KEYCLOAK_ADMIN_USERNAME=admin \
KEYCLOAK_ADMIN_PASSWORD=admin \
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  pnpm --filter @ytw/e2e test:e2e
```

The Keycloak realm must contain the `youtube-workspace` client and
`youtube-workspace-users` group from `dev/keycloak`. The test ensures the owner is in that group,
the outsider is out, and the collaborator exists in-group. It temporarily sets the realm's
access-token lifespan to 15 seconds and restores the original lifespan and group memberships after
the scenario; it removes the collaborator if the test created it. CI uses its own Compose project
and removes only that project's containers and volume after the run.

Keycloak preparation also surrounds the entire runner, preserving the collaborator's OIDC subject
between story files. Each file restores its group changes; only the outer runner removes a
collaborator it created. Mock mode restores default fixture groups before each story file through
the mock provider's authenticated test API. No application database rows are reset between stories.
