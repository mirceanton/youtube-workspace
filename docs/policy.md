# Policy layer (`@ytw/policy`)

PRD 7 asks for "one reusable policy layer, shared with the MCP server, with unit tests for None,
Read and Write on every object, for both users and tokens". This package is that layer. It is pure
TypeScript with no I/O: the web server and the MCP server load the user or token from the database
on every request, hand it to these functions, and act on the answer. Nothing is cached here, so a
level changed in settings applies to the next request.

The objects and levels are not listed in this package. `RESOURCES`, `LEVELS`, `GRANTABLE_LEVELS`
and `RESOURCE_LABELS` come from `@ytw/shared` (`packages/shared/src/resources.ts`); every function
and every generated test iterates them.

## The rules and where they live

| PRD 7 rule | Functions |
| --- | --- |
| Levels are None < Read < Write; Write includes Read | `levelRank`, `compareLevels`, `satisfies`, `minLevel` |
| The activity log is None or Read only | `maxLevelFor`, `capLevel`; every computed level is capped; `validateRequirement` rejects "write on activity" |
| Admins have Write on everything | `userLevels`: the admin flag yields `FULL_ACCESS` whatever rows are stored |
| A token's effective level is the lower of its own and its owner's *current* level | `effectiveLevel`, `effectiveLevels`, `principalLevels`, `levelOn` |
| A token can be given at most its owner's level, never Write on activity | `canGrant`, `grantViolations`, `grantCeiling`, `grantOptions` |
| Users with Read or Write on at least one object can create tokens | `canCreateTokens` (tokens never can) |
| None on every object means "access not granted" | `hasAnyAccess` |
| `query_sql` only for tokens with Read on every object | `hasReadOnEverything` |
| Read tools and search return only what the caller can Read | `readableResources` |
| Only admins manage access; tokens never act as admins | `isAdmin`, the `"admin"` access rule |
| Checked server-side on every route and tool, with a clear message | `authorize`, `assertAccess`, `can` |
| Settings shows a permission summary | `summarizeLevels`, `describeLevels` |

## Principals

```ts
import { levelsFromRows, type TokenPrincipal, type UserPrincipal } from "@ytw/policy";

const user: UserPrincipal = {
  kind: "user",
  userId: row.id,
  username: row.username, // preferred_username, also the audit actor
  isAdmin: row.is_admin,
  levels: levelsFromRows(permissionRows), // [{ resource, level }] from user_permissions
};

const token: TokenPrincipal = {
  kind: "token",
  tokenId: t.id,
  tokenName: t.name, // the audit actor for MCP calls
  levels: levelsFromRows(tokenPermissionRows), // api_token_permissions
  owner: { userId, username, isAdmin, levels: levelsFromRows(ownerPermissionRows) },
};
```

The owner's levels must be read in the same request as the token, never cached: that is what makes
"lowering a user's levels immediately lowers their tokens" true. `levelsFromRecord` does the same
for a jsonb object such as `{ "ideas": "write" }`.

## Using it

**Web server.** Every route declares an `AccessRule`: `"public"`, `"authenticated"`, `"admin"` or
a `Requirement` `{ resource, level }`. Validate requirements when the route is registered, then
decide per request:

```ts
validateRequirement(rule); // at registration: an impossible rule fails at startup
const decision = authorize(principal, rule); // principal is undefined when nobody is signed in
if (!decision.allowed) {
  return reply.code(DENIAL_HTTP_STATUS[decision.reason]).send({ error: decision.message });
}
```

`GET /api/me` returns `levels: principalLevels(user)`. A user for whom `hasAnyAccess` is false gets
the "access not granted" page.

**MCP server.** `defineTool({ requires })` takes a `Requirement`; call `validateRequirement` when the
tool is registered and `authorize(principal, tool.requires)` on every call. A denial's `message` is
written for an LLM: what was needed, what the token has, the token's own level and its owner's, and
who can fix it, for example:

> Permission denied: this needs write access on scripts, but token "editor-bot" (owner "alice") has
> read. The token's own level is write and its owner's current level is read; a token never exceeds
> its owner. An admin must raise the owner's level in settings.

`query_sql` is offered only when `hasReadOnEverything(principal)` holds. `search` passes
`readableResources(principal)` to the database.

**Settings.** The token form offers `grantOptions(userLevels(owner))` per object. The server
rejects a request when `grantViolations(userLevels(owner), requested)` is not empty and returns the
messages, which name the valid values (for example `write on scripts is above the owner's own level
(read); a token never exceeds its owner; choose one of: none, read`). Requests may be partial; an
unknown object or level is reported, not thrown. The token list shows
`describeLevels(effectiveLevels(userLevels(owner), token.levels))`, so a lowered owner shows
lowered tokens. Only principals for which `isAdmin` holds may use the access matrix.

**SPA.** Feature routes declare a `Requirement` for their nav item. Anything the browser decides is
cosmetic; the servers decide.

## Failing closed

- An unknown level, object or principal kind throws `PolicyError`. That always means a bug or
  corrupt data, so let it propagate: the request fails rather than being compared or guessed.
- An object with no stored row is None. A stored row for an object this code does not know is
  ignored (see "deploy order" below). Two rows for one object, or an unknown level, throw.
- When a token map is given, every object must be in it; a missing entry throws instead of falling
  back to the owner's level. `effectiveLevel(owner)` means "no token" only when the argument is
  omitted, not when `undefined` is passed.
- Only a literal `true` admin flag counts.
- `can(principal, resource, "none")` throws: requiring None would allow everyone.
- `can(principal, "activity", "write")` is `false`; declaring that as a route or tool requirement
  throws, because no one can ever satisfy it.

## Tests and coverage

```bash
pnpm --filter @ytw/policy test     # vitest run --coverage; fails below 100 % on any metric
pnpm --filter @ytw/policy lint     # tsc -b + oxlint
```

The thresholds (statements, branches, functions and lines at 100 %) are in
`packages/policy/vitest.config.ts`. The root `pnpm test` runs the same tests as one project among
many; vitest reads coverage settings only from the root config, so the package-scoped command above
is the coverage gate.

`test/matrix.test.ts` is the PRD 7 matrix: None/Read/Write on every object for a user (with the
other objects at None and at Write), for an admin, for a token at every token level x owner level,
for a token owned by an admin, and for a token whose owner was lowered after the token was created
(including an admin owner who is demoted). For each case it checks `levelOn`, `principalLevels`,
`can` and `authorize` for both Read and Write. Expected values come from a small oracle in
`test/fixtures.ts` (`READ_ONLY`, `oracleMax`) and literal tables in the matrix test (`LOWER`,
`MEETS`), written from the PRD text rather than from the implementation. The cases are generated
from `RESOURCES`, so a new object is covered automatically.

## How to add a new object type to the permission matrix

The example adds `sponsors`. Steps 1 and 2 are required for every object; the rest depends on
what the object is.

1. **Declare it in `@ytw/shared`** (`packages/shared/src/resources.ts`):
   - append `"sponsors"` to `RESOURCES` (the order is the display order in settings and summaries,
     so appending keeps existing screens stable);
   - add `sponsors: LEVELS` to `GRANTABLE_LEVELS`, or `sponsors: ["none", "read"]` if it is
     read-only like the activity log;
   - add `sponsors: "Sponsors"` to `RESOURCE_LABELS`.

   Run `pnpm lint`. TypeScript reports every other `Record<Resource, ...>` that now lacks an entry
   (for example the `allRead` fixture in `packages/shared/test/resources.test.ts`); add the missing
   entries, and add the object to the literal list that test pins. Zod schemas built on
   `resourceLevelsSchema` now require the new key, which is intended: a level map is always
   complete.

2. **Write a migration** `packages/db/migrations/NNNN_resource_sponsors.sql`, using the next free
   number in your task's range (`0200+` for later work, from the orchestrator). Applied migrations
   are immutable, so everything below goes in the new file:
   - **Accept the value.** Replace the `resource` CHECK constraint on `user_permissions` and on
     `api_token_permissions` with one that also lists `'sponsors'` (`\d user_permissions` in psql
     shows the constraint names). If the column uses an enum type instead, run
     `ALTER TYPE ... ADD VALUE 'sponsors'` in a migration of its own: a new enum value cannot be
     used in the transaction that adds it, and each migration file is one transaction.
   - **Read-only object?** Extend the CHECK that forbids `write` on the activity log so it also
     covers `'sponsors'`.
   - **Backfill a row for every existing user and token.** Admins get the maximum (`write`, or
     `read` for a read-only object) so stored rows agree with the policy rule that admins hold the
     maximum everywhere. Everyone else gets `none`, and so does every existing token: access to a
     new object is always granted deliberately, never inherited.

     ```sql
     INSERT INTO user_permissions (user_id, resource, level)
     SELECT id, 'sponsors', CASE WHEN is_admin THEN 'write' ELSE 'none' END FROM users
     ON CONFLICT (user_id, resource) DO NOTHING;

     INSERT INTO api_token_permissions (token_id, resource, level)
     SELECT id, 'sponsors', 'none' FROM api_tokens
     ON CONFLICT (token_id, resource) DO NOTHING;
     ```

     Fill any other required columns those tables define, and set the audit actor for data
     changes the way `docs/database.md` prescribes for migrations.
   - **Update the functions that spell out the object list.** Find them with
     `grep -rn "'activity'" packages/db/migrations` (every list contains the activity log). Expect
     at least `upsert_user_on_login` (rows for new users, Write everywhere for the first admin), the
     permission and token functions (`set_user_permission`, `create_api_token`,
     `update_token_permissions`, `lookup_token_by_hash`) and, if the object is searchable,
     `search_all`. Redefine each with `CREATE OR REPLACE FUNCTION` in the new migration, keeping
     the conventions in `docs/database.md` (SECURITY DEFINER, pinned `search_path`, grants).
   - **New tables** for the object follow `docs/database.md` too: mutations only through SECURITY
     DEFINER functions, no table-level DML for app roles, the `ytw_audit()` trigger, and `SELECT`
     for `ytw_readonly` unless the table holds secrets.
   - Run `pnpm migrate` twice (the second run must be a no-op) and `pnpm --filter @ytw/db test`.
     The test that compares the database's object list with `RESOURCES` must pass.

3. **Policy** (`packages/policy`): no source change. Run `pnpm --filter @ytw/policy test`; the
   matrix, grant and summary tests now include the new object and coverage stays at 100 %. If the
   object is read-only, also add it to `READ_ONLY` in `packages/policy/test/fixtures.ts`: the
   "oracle agrees with @ytw/shared" test fails until both lists match, so the rule is confirmed in
   two independent places. (Checked by simulation: adding a write-capable object needs no policy
   change at all; adding a read-only one fails until `READ_ONLY` is updated, then passes.)

4. **Guard every new entry point** with the new object:
   - MCP tools in `apps/mcp/src/tools/<group>.ts` declare
     `requires: { resource: "sponsors", level: "read" }` (reads) or `level: "write"` (writes);
   - web routes in `apps/web-server/src/routes/sponsors/index.ts` declare the same requirements;
   - the SPA feature `apps/web-ui/src/features/sponsors/routes.tsx` declares
     `{ resource: "sponsors", level: "read" }` for its nav item;
   - if notes can be attached to it, add its entity type to `NOTE_ENTITY_TYPES` in `@ytw/shared`
     and to the notes `entity_type` CHECK in the same migration.

   `query_sql` is offered only to tokens with Read on every object, so existing tokens lose it
   until their owners grant Read on `sponsors`. That is intended: raw SQL could read the new
   tables. Tell agent owners when you ship.

5. **Settings UI**: no change expected. The profile, the token form (`grantOptions`), the token
   summaries (`describeLevels`) and the admin access matrix are built from `RESOURCES` and
   `RESOURCE_LABELS`, so the new object appears as a new row, including on the phone screens. Run
   `pnpm --filter @ytw/web-ui test` to confirm.

6. **Verify and ship**: `pnpm lint && pnpm test && pnpm build`. Deploy order: run `pnpm migrate`
   first, then roll out the services. A process that does not know the object ignores its rows; a
   process that knows it treats a missing row as None. At no point does anyone gain access by
   accident. Afterwards admins already have the new object; grant it to other users in the access
   matrix, and owners widen their tokens in settings.

Renaming or removing an object is not covered by this guide: it needs a data migration of existing
rows and a check of every token that referenced it.

## Interpretation notes

- **Admins.** PRD 7 says admins "have Write on everything". `userLevels` therefore gives an admin
  the maximum on every object whatever rows are stored, and a token owned by an admin is limited
  only by the token's own levels. The database is expected to store matching rows (Write
  everywhere for the first admin, and for anyone promoted later) so that database-side checks
  agree; if a stored row is lower, the database side is stricter, never looser. Demoting an admin
  takes effect on the next request, for the user and for every token they own.
- **Impossible requirements.** A route or tool that requires a level its object can never have
  (Write on the activity log) or requires None is a programming error and throws at registration
  (`validateRequirement`) instead of silently denying or allowing everyone.
