# Settings

The authenticated settings feature is implemented by the `settings`, `tokens` and `admin` web-server
route plugins and the `settings` web UI feature. Shared request and response schemas live in
`packages/shared/src/api/settings.ts`.

## Access and profile

`GET /api/settings/profile` returns the current user's read-only identity and effective per-resource
levels. The web-server re-reads the user's access from PostgreSQL for each request. An account with
no read access to any resource is denied, consistent with the app's access gate.

`GET /api/settings/tokens` and the token mutations require Read on at least one resource. The core
`app.requireAnyLevel("read")` guard checks all grantable resources using the same policy evaluator
and is marked for route-authz coverage. It exists because a token owner may have access to a
resource other than the route's domain; binding token management to one resource would incorrectly
deny those users. Admin matrix routes also check current admin status, and the database management
functions enforce the admin and last-admin rules again.

## API tokens

The token API supports list, create, permission updates, rotate and revoke for the signed-in
owner's own tokens. Creation defaults to 90 days; `expires_at: null` means no expiry. Permission
fields omitted at creation are stored as None. Both the service and database reject grants above
the owner's current levels. The response to create or rotate contains the secret exactly once; list,
edit and revoke responses never include it. The UI holds that response only for its one-time copy
dialog, then clears it. A token's effective levels continue to be capped by the owner's current
levels, even before an explicit token edit.

## User access matrix

Admins can read the users matrix and set a user's level for an individual resource, or promote and
demote admins. Activity remains None/Read only. Admins inherit Write on all resources; demote an
admin before editing their individual levels. Demotion clears levels unless `keep_levels` is true.
The database refuses to demote the last active admin. Changes use `app.db.withActor` and are audited
by the existing identity/permission database functions.

The desktop matrix is horizontally scrollable; on narrow screens each user has a dedicated detail
screen with large permission controls. Each token likewise has a dedicated phone-friendly detail
screen for permission changes, rotation and revocation.

## Verification

Run `pnpm --filter @ytw/web-server lint`, `pnpm --filter @ytw/web-server test` and
`pnpm --filter @ytw/web-server build`, plus the same scoped commands for `@ytw/web-ui`. Route tests
use the real PostgreSQL test harness; UI tests exercise the permission ceiling and ensure secrets
are not fetched again after creation.
