# Database (`@ytw/db`)

Postgres 16 is the system of record (PRD 4). This page is the contract for everyone who adds
tables, database functions or typed wrappers (T11-T16), and for the services that call them (T21,
T23, T30-T34, T40+). The rules marked **enforced** are checked by the migration runner or by tests,
so breaking them fails the build rather than a review.

| What | Where |
| --- | --- |
| Migrations (plain SQL, one transaction each) | `packages/db/migrations/NNNN_name.sql` |
| Runner and `pnpm migrate` | `packages/db/src/migrate.ts`, `packages/db/src/bin/migrate.ts` |
| One-time superuser setup for production | `packages/db/sql/superuser-bootstrap.sql` |
| Pools, `sql` template, `withActor`, `queryReadOnly` | `packages/db/src/client.ts` |
| SQLSTATE catalogue, typed errors, `toClientError` | `packages/db/src/errors.ts`, `ytw_error_codes()` in SQL |
| Typed wrappers, one module per area | `packages/db/src/<area>.ts` (owners: PLAN.md section 3) |
| Test harness | `@ytw/db/testing` (`packages/db/src/testing.ts`) |
| Catalog, audit, runner, read-only and harness tests | `packages/db/test/*.test.ts` |

T10 owns migrations `0001-0009`: `0001_roles` (roles and their settings, database and schema
privileges, default privileges, schema `ytw_private`, restricted built-in functions),
`0002_catalog_guard` (`ytw_catalog_violations()` and its allowlist), `0003_core_functions`
(`uuid_generate_v7()`, `ytw_error_codes()`, `ytw_raise()`) and `0004_audit` (`events`,
`ytw_set_actor()`, `ytw_current_actor()`, `ytw_audit()`, `ytw_log_event()`, `ytw_append_only()`).
T11 owns `0010-0029`: the tables of PRD 4 plus `web_sessions` (see "Schema"). T12 owns `0030-0039`
(ideas, scripts, notes; see "Ideas, scripts and notes") and T13 `0040-0049` (videos, metrics,
experiments; see "Videos, metrics and experiments"). T14 owns `0050-0059`: `0050_identity_helpers`,
`0051_identity`, `0052_permissions`, `0053_api_tokens`, `0054_web_sessions`, and the review fixes
`0055_identity_lock_discipline`, `0056_access_revocation`, `0057_access_revocation_functions`,
`0058_token_owner_revocation` (see "Identity, permissions, tokens, sessions").

T15 owns `0060-0069`: `0060_ideas_pipeline`, `0061_video_performance`, `0062_experiment_results`,
`0063_search`, `0064_activity` (see "Views, search and activity (T15)").

## Running migrations

```bash
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/youtube_workspace pnpm migrate
```

`pnpm migrate` also reads the root `.env` (never put `MIGRATION_DATABASE_URL` there; see
`.env.example`). Deployments run the compiled entry point with the same variables:
`node packages/db/dist/src/bin/migrate.js` (the `migrations/` directory must ship next to `dist/`).

| Variable | Meaning |
| --- | --- |
| `MIGRATION_DATABASE_URL` | Required. Connection to the target database as the migration owner (see "Production setup"). |
| `YTW_WEB_PASSWORD`, `YTW_MCP_PASSWORD`, `YTW_READONLY_PASSWORD` | Optional. 16-256 printable ASCII characters without spaces (`openssl rand -hex 24`). Unset: the role keeps its password. |
| `MIGRATION_LOCK_DATABASE_URL` | Optional. A database every concurrent runner of the cluster also locks (see "Locking"). |

What a run does, in order:

1. Reads `migrations/*.sql`. Every `.sql` file must be named `NNNN_lower_snake_case.sql` with a
   unique number; other files are ignored. A file containing transaction control is rejected here,
   before anything runs (see "Writing a migration"). The checksum is SHA-256 of the file with CRLF
   turned into LF and a leading byte-order mark removed.
2. Takes the locks, creates `schema_migrations` if missing and compares it with the files. It
   **refuses to run** (and applies nothing) when an applied file was edited, renamed or deleted, or
   when a pending file is numbered below the newest applied one (see "Out-of-order files").
3. Restores the application roles' stored settings (`ytw_enforce_role_settings()`, see "What keeps
   `query_sql` read-only") and runs the catalog guard: a database that already breaks a privilege
   rule is not migrated any further.
4. Applies each pending file in its own transaction together with its `schema_migrations` row.
   Before committing it checks that the file did not end that transaction, then calls
   `ytw_catalog_violations()` in the same transaction; any row rolls the file back (**enforced**,
   see "Privilege rules").
5. Sets each role password it was given, unless the stored one already matches, as a
   SCRAM-SHA-256 verifier computed in Node, so the plain text never reaches the server. Passwords
   are never logged.

A second run applies nothing and changes no schema (CI runs it twice). The only writes it can still
make are repairs: role settings that drifted, and passwords that differ. Comparing a password reads
`pg_authid`, which only a superuser may do, so a run as a non-superuser owner sets every password
it is given again (same password, new salt; open connections are not affected). Exit codes: 0
done, 1 failed, 2 `MIGRATION_DATABASE_URL` unset. A failed file reports its name, line, SQLSTATE,
detail and hint.

**Out-of-order files.** Every task numbers its files inside its own range (PLAN.md section 3), and
the runner applies files strictly in number order: a pending file numbered below the newest applied
one is refused, and there is no override. Applying it late would give that database a different
history than a fresh one (a later file may already depend on, or replace, what the earlier one
creates), and the checksums could no longer show that every database went through the same steps.

- In development, a database that applied a higher-numbered file from another branch must be
  recreated (`dropdb`/`createdb`, or a new database name, then `pnpm migrate`). Test databases are
  new on every run and never hit this.
- Once a database that matters has been migrated (the first deployment), new files are numbered
  above every merged file (`0200+`, ask the orchestrator), never in an older task's unused range.

**Locking.** Roles are cluster-wide but advisory locks are per database, so a run holds up to two
session advisory locks: first `CLUSTER_LOCK_KEY` in the shared lock database
(`MIGRATION_LOCK_DATABASE_URL`, `lockDatabaseUrl` in code; the test harness uses the database of
`TEST_DATABASE_URL`, normally `postgres`), then `MIGRATION_LOCK_KEY` in the target database. They
are always taken in that order and the holder of the target lock waits for nothing else, so runs
cannot deadlock. Without a lock database only the target is locked, which is enough for one
application database per cluster. Waiting longer than 5 minutes for a lock fails the run.

**Readiness.** `migrationStatus(pool)` compares `schema_migrations` with the files on disk without
changing anything (`upToDate`, `pending`, `changed`, `unknown`). `ytw_web` and `ytw_mcp` may read
`schema_migrations` for this.

## Production setup

Every `SECURITY DEFINER` function is owned by, and runs as, the role that ran the migration that
created it, and that must always be the same role (**enforced** by `definer_owner`).

- **Development and CI** migrate as the superuser `postgres`. There every `SECURITY DEFINER`
  function runs as a superuser, so a mistake inside one (careless dynamic SQL, say) has no
  privilege boundary behind it. Review such functions with that in mind.
- **Production** should migrate as the role that owns the application database, with `CREATEROLE`
  (Postgres 16 gives it `ADMIN OPTION` on the roles it creates; grant it `ADMIN OPTION` on roles
  that already exist). Taking the large-object and advisory-lock functions away from `PUBLIC` needs
  a superuser, so once per database, before the first `pnpm migrate`, a superuser runs:

  ```bash
  psql "postgres://<superuser>@<host>/<database>" -f packages/db/sql/superuser-bootstrap.sql
  ```

  The script is idempotent and gives the database owner `EXECUTE` on the advisory-lock functions
  back (the runner and the functions the owner creates use them). Without it `0001_roles` stops
  with a hint naming the script. `test/owner.test.ts` runs every migration this way, so a migration
  that silently needs a superuser fails CI.
- `ALTER DEFAULT PRIVILEGES` in `0001` covers only objects created by the role that ran it.
  Functions created by any other role are executable by `PUBLIC` again, which the guard reports
  (`function_public_execute`). Migrate as one role, and still write `REVOKE ALL ON FUNCTION ...
  FROM PUBLIC` for every function.
- `0001` revokes `PUBLIC`'s `CONNECT` and `TEMPORARY` on the application database only. Every
  other database of the cluster (`postgres`, `template1`, other applications') keeps the Postgres
  defaults, so the application roles can connect there, read those catalogs and create temporary
  tables. On a shared cluster, lock them out: `REVOKE CONNECT, TEMPORARY ON DATABASE <name> FROM
  PUBLIC` for each other database, or restrict the three roles to the application database in
  `pg_hba.conf`.
- The roles are shared by every database in the cluster: run one deployment per cluster, or give
  concurrent runners the same `MIGRATION_LOCK_DATABASE_URL`.

## Writing a migration

- Use only your task's number range (PLAN.md section 3). Merged files are immutable; fix forward.
- A file runs once per database, inside one transaction that the runner opens and commits.
  **Enforced:** a file whose top level contains `BEGIN`, `START`, `COMMIT`, `END`, `ROLLBACK`,
  `ABORT`, `SAVEPOINT`, `RELEASE` or `PREPARE TRANSACTION` is rejected before anything runs. The
  scanner skips comments, string literals, quoted identifiers and dollar-quoted text, so
  `BEGIN ... END` inside a `$$` body is fine; SQL-standard bodies (`BEGIN ATOMIC ... END`) are
  rejected because they cannot be told apart, so quote function bodies with `$$`. Statements that
  cannot run inside a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`) fail anyway. Should a
  file still end the transaction, the runner notices and fails, warning that part of the file may
  have been committed.
- Cluster-wide statements (roles) must be idempotent because other databases of the cluster run
  the same file; nothing after T10 should need them. Never `ALTER ROLE` an application role: their
  stored settings are data in `ytw_expected_role_settings()` (replace that function in a new file
  and change `roleConnectionOptions` in `client.ts` with it).
- Schema-qualify what you create (`public.ideas`, `ytw_private.api_tokens`).
- Grant explicitly, per object, to the roles that need it. There are no default grants, and every
  function gets an explicit `REVOKE ... FROM PUBLIC` (see "Production setup"):

  ```sql
  GRANT SELECT ON public.ideas TO ytw_web, ytw_mcp, ytw_readonly;
  REVOKE ALL ON FUNCTION public.create_idea(text, text, uuid, text, text, text, text[]) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.create_idea(text, text, uuid, text, text, text, text[]) TO ytw_web, ytw_mcp;
  ```

- Secret-bearing tables (`api_tokens` and `web_sessions`, plus anything holding a hash, secret
  or encrypted blob) go in schema **`ytw_private`** (**enforced** for those two names). No
  application role has `USAGE` on it, so only `SECURITY DEFINER` functions reach those tables;
  even a stray `GRANT SELECT` does not open them. `api_token_permissions` holds no secret, but it
  lives there too: no application role needs to read it directly (T14's functions return a token
  together with its levels), and `query_sql` should not reveal which agent holds which access.
- A view runs with its owner's privileges, so a view outside `ytw_private` that reads a
  `ytw_private` table would hand its rows to every role that may select from the view. The guard
  reports such views and materialized views, also through other views (`private_data_exposure`),
  unless the allowlist names them.
- Primary keys: `id uuid PRIMARY KEY DEFAULT public.uuid_generate_v7()`. Audit columns:
  `created_by text NOT NULL DEFAULT public.ytw_current_actor()` (fails loudly when no actor is set).

## Roles and privileges

Created by `0001_roles`, never superuser, never members of another role, owning nothing
(**enforced**). Passwords come from the environment at migrate time.

| Role | Used by | May |
| --- | --- | --- |
| `ytw_web` | web server (`DATABASE_URL`) | connect; `SELECT` on what it reads; `EXECUTE` on the functions it calls |
| `ytw_mcp` | MCP server (`DATABASE_URL`) | the same, for the MCP tools |
| `ytw_readonly` | MCP `query_sql` only (`READONLY_DATABASE_URL`) | connect; `SELECT` on readable tables and views; `EXECUTE` on the application's own functions only when allowlisted, never on a `SECURITY DEFINER` one (**enforced**); built-in functions as usual, except large objects and advisory locks |

No application role can create objects or temporary tables, and none holds `INSERT`, `UPDATE`,
`DELETE`, `TRUNCATE`, `REFERENCES` or `TRIGGER` on anything, or `USAGE`/`UPDATE` on a sequence:
every write is a `SECURITY DEFINER` function. New functions are not executable by `PUBLIC`
(default privileges revoke it), and neither are the large-object and advisory-lock built-ins
(`ytw_restricted_builtins()`): large objects would store data outside every table and grant, and
an advisory lock held by an application role could block a function or the runner that uses the
same key.

### What keeps `query_sql` read-only

Several layers; only the first is a guarantee on its own.

1. **Privileges.** `ytw_readonly` holds `SELECT` only, cannot see `ytw_private`, cannot execute a
   `SECURITY DEFINER` function or a restricted built-in, and cannot create anything. Even in a
   read-write transaction it can change no data (**enforced** by the guard; `test/readonly.test.ts`
   tries the ways around it).
2. **`queryReadOnly(pool, sql)`** (`client.ts`), the only way `query_sql` may run a statement: one
   statement through the extended protocol (a second one is a syntax error), inside
   `BEGIN READ ONLY` with `SET LOCAL statement_timeout`. The transaction's snapshot is taken before
   the statement runs, so `SET TRANSACTION READ WRITE` is refused. Then `ROLLBACK`, and the
   connection is closed instead of going back to the pool, so session state (settings, advisory
   locks, prepared statements, `LISTEN`) never reaches the next call.
3. **Pinned connection settings.** `createPool({ role: "ytw_readonly", ... })` sends
   `default_transaction_read_only=on` and `statement_timeout=10000` (`QUERY_SQL_TIMEOUT_MS`) in the
   startup packet of every connection, which overrides whatever is stored for the role.
4. **Stored role settings,** the same two, for any other client. Postgres lets every role change
   its own stored settings (`ALTER ROLE ytw_readonly SET ...`, from outside a read-only
   transaction) and its own password, and nothing can forbid that. So the expected settings are
   data (`ytw_expected_role_settings()`), every `pnpm migrate` restores them, and the guard
   reports drift (`app_role_settings`). A changed password only locks `query_sql` out until a
   migrate run with `YTW_READONLY_PASSWORD` sets it back.

`ytw_web` and `ytw_mcp` have no stored settings.

### Privilege rules (`ytw_catalog_violations()`)

The runner calls the guard before applying anything and after every file, inside that file's
transaction; `test/catalog.test.ts` calls it on the full schema and proves that each rule fires. It
must return no rows.

| Rule | Reported when |
| --- | --- |
| `app_role_attributes` | an application role is superuser or has CREATEROLE, CREATEDB, REPLICATION or BYPASSRLS |
| `app_role_membership` | an application role is a member of any role (e.g. `pg_read_all_data`) |
| `app_role_owns_object` | an application role owns a table, view, sequence, function, schema or the database |
| `app_role_settings` | an application role's stored settings differ from `ytw_expected_role_settings()`, or it has settings for this database |
| `table_write_privilege` | an application role has a write privilege (table- or column-level) on a table, view, materialized view or foreign table |
| `sequence_privilege` | an application role has `USAGE` or `UPDATE` on a sequence |
| `database_privilege` | an application role has `CREATE` or `TEMPORARY` on the database |
| `schema_create` | an application role has `CREATE` on a schema |
| `private_schema_access` | an application role has `USAGE` on `ytw_private` or `SELECT` on anything in it |
| `secret_table_location` | a table named `api_tokens` or `web_sessions` exists outside `ytw_private` |
| `private_data_exposure` | an application role may select from a view or materialized view outside `ytw_private` that reads a `ytw_private` relation, directly or through other views (allowlist possible) |
| `function_public_execute` | a function (outside extensions) is executable by `PUBLIC` |
| `definer_search_path` | a `SECURITY DEFINER` function does not `SET search_path = pg_catalog, public, pg_temp` |
| `definer_owner` | a `SECURITY DEFINER` function is not owned by the migration owner (the owner of `schema_migrations`) |
| `readonly_function_execute` | `ytw_readonly` may execute a `SECURITY DEFINER` function, or any other function outside the system schemas and extensions that the allowlist does not name |
| `builtin_function_access` | an application role may execute a large-object or advisory-lock built-in |

**Allowlist.** Two rules accept reviewed exceptions. Only migrations add them (no application
role can see the table), each with a reason:

```sql
INSERT INTO ytw_private.catalog_allowlist (rule, object, reason) VALUES
  ('readonly_function_execute', 'public.idea_age_days(timestamp with time zone)',
   'pure helper that query_sql may call; reads nothing');
```

`object` is spelled exactly as the guard reports it, as a failed run prints it: `schema.name` for
a view, `schema.name(argument types)` for a function. A `SECURITY DEFINER` function cannot be
allowlisted for `ytw_readonly`.

**Self-test.** Each time the runner calls the guard, it first creates three canary objects in a
savepoint that is always rolled back (a table with a write grant, a view over `ytw_private`, a
`SECURITY DEFINER` function that `ytw_readonly` may execute) and requires the guard to report all
three. A migration that drops the guard, empties it or removes one of those rules fails the run
(**enforced**).

**Extending the rules** (T16 or later): `CREATE OR REPLACE FUNCTION public.ytw_catalog_violations()`
in your own range, keeping every existing rule, plus a test in `test/catalog.test.ts` that proves
the new rule fires. Never drop the function.

## Database function convention

Every mutating function looks like this (all of it is required; the guard enforces the starred
lines):

```sql
CREATE FUNCTION public.create_idea(
  p_actor text, p_actor_type text, p_token_id uuid,       -- always first, in this order
  p_title text, p_pitch text, p_source text, p_tags text[]
)
RETURNS public.ideas                                       -- or TABLE (...) / jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER                                           -- *
SET search_path = pg_catalog, public, pg_temp              -- * exactly this value
AS $$
DECLARE
  v_row public.ideas;
BEGIN
  PERFORM public.ytw_set_actor(p_actor, p_actor_type, p_token_id);   -- first statement
  IF p_title IS NULL OR btrim(p_title) = '' THEN
    PERFORM public.ytw_raise('validation', 'title is required',
                             jsonb_build_object('field', 'title'));
  END IF;
  INSERT INTO public.ideas (title, pitch, source, tags)
  VALUES (p_title, p_pitch, p_source, coalesce(p_tags, '{}'))
  RETURNING * INTO v_row;
  RETURN v_row;
END
$$;

REVOKE ALL ON FUNCTION public.create_idea(text, text, uuid, text, text, text, text[]) FROM PUBLIC;  -- *
GRANT EXECUTE ON FUNCTION public.create_idea(text, text, uuid, text, text, text, text[]) TO ytw_web, ytw_mcp;
```

- `ytw_set_actor(actor, actor_type, token_id)` validates the actor (non-empty, at most 200
  characters, no control characters; type `human` or `agent`; humans never carry a token id) and
  stores it in transaction-local settings that the audit trigger reads. Call it before any write.
- Qualify `ytw_private` tables; `search_path` deliberately does not include that schema.
- Validate arguments first and raise catalogue errors with readable messages (see "Errors");
  never let a CHECK violation be the user-facing error.
- Optimistic concurrency: `UPDATE ... WHERE id = p_id AND version = p_expected_version`, and when
  no row matched, raise `not_found` or `version_conflict` with `latest_version`. Serialize racing
  writers with `SELECT ... FOR UPDATE` on the parent row or `pg_advisory_xact_lock` (never a
  session lock). Advisory locks work inside `SECURITY DEFINER` functions, which run as the owner;
  the application roles cannot call them directly.
- Never change the owner of a `SECURITY DEFINER` function (**enforced**, `definer_owner`).
- Functions that read `ytw_private` are `SECURITY DEFINER` and therefore for `ytw_web` and
  `ytw_mcp` only. A function that `query_sql` may call is `SECURITY INVOKER` (so it sees only what
  `ytw_readonly` sees), has a `catalog_allowlist` row (both **enforced**) and should be `STABLE` or
  `IMMUTABLE`.
- Do not reuse a name that another wrapper module already exports in TypeScript (see below).

## Schema

Migrations `0010-0018` (T11); `test/schema.test.ts` covers every rule below.

| Table | Schema | Rows | Key rules |
| --- | --- | --- | --- |
| `ideas` | public | mutable, `version`, archived (`archived_at`) | stage in `status` (`IDEA_STAGES`, default `inbox`), `status_changed_at`, `score` 0-100, `source`, `tags` |
| `scripts` | public | **append-only** except `status` | unique `(idea_id, kind, version)`; `body_md` at most `SCRIPT_BODY_MAX_BYTES` bytes; `status` default `draft` |
| `videos` | public | mutable, `version`, archived | `youtube_id` unique, 11 characters; `idea_id` optional |
| `video_metrics` | public | **append-only** | unique `(video_id, captured_at)`; at least one metric per row |
| `experiments` | public | mutable, `version` | `status` default `planned`; winner must be its own variant |
| `experiment_variants` | public | mutable | unique `(experiment_id, label)`; at most one `is_control` per experiment |
| `notes` | public | **append-only** | `entity_type` in `NOTE_ENTITY_TYPES`; the entity must exist; `author`, `actor_type` |
| `users` | public | mutable | unique `(oidc_issuer, oidc_sub)`; `access_revoked_at` set while the person has no access (0056) |
| `user_permissions` | public | mutable | unique `(user_id, resource)`; `activity` never `write` |
| `api_tokens` | ytw_private | mutable, never deleted (`revoked_at`) | `token_hash` = SHA-256 as 64 lower-case hex digits, unique |
| `api_token_permissions` | ytw_private | mutable | unique `(token_id, resource)`; `activity` never `write` |
| `web_sessions` | ytw_private | mutable, **not audited** | `id` is the random session handle; `expires_at <= absolute_expires_at` |
| `events` | public | **append-only** | T10 |

**Grants.** `SELECT` on the seven content tables (`ideas` to `notes` above) for all three
roles; `users` and `user_permissions` for `ytw_web` only (identities and the access matrix are not
an object a Read level covers, and the matrix is admin-only); nothing in `ytw_private`. No other
privilege, as everywhere.

**Bookkeeping belongs to the database.** `ytw_touch()` runs `BEFORE UPDATE` on every table with
`updated_at` and overwrites whatever an UPDATE writes into these columns:

- `updated_at := now()`, `updated_by :=` the current actor;
- `version := OLD.version + 1` on `ideas`, `videos`, `experiments` (so `UPDATE ... WHERE id = $1
  AND version = $2 RETURNING version` returns the new version; `SET version = version + 1` is
  harmless but unnecessary);
- `ideas.status_changed_at := now()` when `status` changes, otherwise kept (age in stage);
- an UPDATE that changes nothing else (or only `api_tokens.last_used_at`) keeps all of them, the
  version included, so a no-op save does not invalidate other clients' versions;
- `id`, `created_at` and `created_by` cannot change (`immutable`).

INSERTs are left to the column defaults (`created_by`/`updated_by` = the actor, timestamps =
`now()`, `version` = 1, `status_changed_at` = `now()`), so test fixtures may insert backdated rows.
Every write needs an actor (`ytw_set_actor`), or the defaults and triggers raise `missing_actor`.
Data changes inside a migration (a backfill) set one first:
`SELECT public.ytw_set_actor('migration 0200_example', 'human', NULL);`.

**Append-only.** `scripts`: an UPDATE that changes anything but `status` raises `immutable` and
names the columns; DELETE and TRUNCATE raise `immutable`. `video_metrics` and `notes` (comments,
as the `/api/notes` contract says): UPDATE, DELETE and TRUNCATE raise `immutable`. Nothing is
deleted anywhere else either (every foreign key is `ON DELETE RESTRICT`): archive ideas and
videos, revoke tokens.

**Constraint names** (for error mapping and for `docs/policy.md` "add an object type"). CHECKs are
named `<table>_<column>_check` (`ideas_status_check`, `scripts_kind_check`,
`scripts_status_check`, `experiments_type_check`, `experiments_status_check`,
`notes_entity_type_check`, `notes_actor_type_check`, `user_permissions_resource_check`,
`user_permissions_level_check`,
`api_token_permissions_resource_check`, ...), plus `user_permissions_read_only_check` and
`api_token_permissions_read_only_check` (objects that are never `write`),
`scripts_body_md_size_check`, `notes_body_md_size_check`, `video_metrics_any_metric_check`,
`experiments_period_check`, `experiments_winner_concluded_check`, `web_sessions_expiry_check`.
Uniques: `scripts_idea_kind_version_key`, `video_metrics_video_captured_key`,
`videos_youtube_id_key`, `users_oidc_identity_key`, `user_permissions_user_resource_key`,
`api_token_permissions_token_resource_key`, `api_tokens_token_hash_key`,
`experiment_variants_label_key`, index `experiment_variants_one_control_idx`. The test compares
the enum CHECKs with `@ytw/shared` (and the permission tables with `RESOURCES` and
`GRANTABLE_LEVELS`, by catalog and by inserting every pair), so a new object or status fails it
until a migration replaces the constraint.

**Rules the functions must know.** A violated CHECK is a bare SQLSTATE `23514`, so functions
validate first and raise catalogue errors; the limits are:

| Column | Accepted |
| --- | --- |
| `ideas.title`, `videos.title` | 1-500 characters, not blank |
| `ideas.pitch`, `experiments.hypothesis`, `experiments.conclusion`, `experiment_variants.content` | at most 20 000 characters |
| `ideas.source` | 1-200 characters, not blank; `NULL` allowed |
| `ideas.score` | integer 0-100 (higher is better); `NULL` = not scored |
| `ideas.tags` | at most 50 distinct tags of 1-64 characters, trimmed, no control characters |
| `scripts.body_md` | at most `SCRIPT_BODY_MAX_BYTES` (1 MiB) of UTF-8; may be empty |
| `notes.body_md` | at most `NOTE_BODY_MAX_BYTES` (64 KiB, `@ytw/shared/api/notes`) of UTF-8; not blank |
| `videos.youtube_id` | `^[A-Za-z0-9_-]{11}$` (the id, not a URL) |
| `videos.thumbnail_url` | at most 2048 characters, no whitespace, an `http(s)://` URL or a path without a scheme |
| `video_metrics` | `views`, `impressions`, `avg_view_duration_s` (seconds), `watch_time_min` (minutes) >= 0; `ctr` percent 0-100; `avg_view_pct` percent >= 0 (can exceed 100); `subs_gained` net (may be negative); `retention` a JSON array <= 64 KiB; exact `numeric`, returned as strings |
| `experiment_variants` | `label` 1-200 characters; `impressions` >= 0; `ctr` percent 0-100 |
| `api_tokens.name` | 1-100 characters, trimmed, no control characters (it is the audit actor) |
| `api_tokens.token_prefix` | `^[A-Za-z0-9_-]{4,16}$` |
| `users.username` | 1-200 characters, trimmed, no control characters (the audit actor) |

- `experiments_winner_variant_fkey` is `(id, winner_variant_id) -> experiment_variants
  (experiment_id, id)`, `DEFERRABLE INITIALLY DEFERRED`: a variant of another experiment fails
  only at COMMIT (23503), so `conclude_experiment` checks ownership first. A winner requires
  `status = 'concluded'` in the same UPDATE.
- `notes`: a trigger raises `validation` (with `allowed`) for an unknown `entity_type` and
  `not_found` (`entity`, `id`) for a missing target; `add_note` may rely on it. `author` is
  generated from `created_by` and `actor_type` defaults to the actor's type, so a note row maps
  onto the `/api/notes` `noteSchema` without renaming.
- Full-text: `ideas.search_vector` (title weight A, pitch B) and `scripts.search_vector` use the
  `english` configuration; query them with `websearch_to_tsquery('english', $1)`. A `tsvector` is
  limited to 1 MB, which a 1 MiB body of unrelated words (or pasted base64) exceeds; for such a
  body `ytw_body_tsvector()` indexes the first 100 000 characters instead of failing the insert.
  Ordinary prose is always indexed in full.
- `web_sessions.id` is a random (v4) UUID because it is the session handle; the table has no
  `created_by` and no audit trigger, so the handle never reaches `events`. Logins and logouts are
  logged with `ytw_log_event`.

## Audit log

`events` (PRD 4) is append-only: no role holds UPDATE/DELETE/TRUNCATE, and triggers raise
`immutable` even for the owner (**tested**). All application roles may `SELECT` it, `query_sql`
included, so no secret may ever enter it.

| Column | Content |
| --- | --- |
| `id`, `created_at` | UUIDv7; transaction time |
| `actor`, `actor_type` | username (human) or API token name (agent); `human` or `agent` (equals `ACTOR_TYPES`, tested) |
| `token_id` | the API token for agent actions, NULL for humans. The token's owner is reached through `api_tokens.user_id`; tokens are never deleted, so the link is permanent (no foreign key yet: `test/audit.test.ts` logs events for token ids that do not exist) |
| `action` | row changes: `insert`, `update`, `delete`; other events: dotted names such as `tool.call` |
| `entity_type`, `entity_id` | e.g. `idea` and the row's `id` |
| `payload` | JSON object (shapes below) |

**Row changes** come from the generic trigger, attached by T11 to every business table:

```sql
CREATE TRIGGER ideas_audit AFTER INSERT OR UPDATE ON public.ideas
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('idea', '-search_vector', '-updated_by');
CREATE TRIGGER api_tokens_audit AFTER INSERT OR UPDATE ON ytw_private.api_tokens
  FOR EACH ROW EXECUTE FUNCTION public.ytw_audit('api_token', 'token_hash', '-updated_by', '+id');
```

- Arguments: the `entity_type`, then column names. `col` keeps the column with its value replaced
  by `"[redacted]"`; `-col` leaves it out (generated `tsvector` columns and other derived data);
  `+col` shows its value where it would otherwise be redacted.
- Redacted without being named: every column whose name looks secret (`ytw_is_secret_key()`:
  ending in `token`, `secret`, `password`, `hash`, `blob`, `cookie`, `authorization`,
  `credential`, `api_key`, `private_key`, `ciphertext` or `encrypted`, or containing `password`,
  `secret`, `refresh_token`, `access_token`, `id_token`, `session_token` or `bearer`, in any case;
  `web_sessions.refresh_token_encrypted` and `id_token_hint` match by name alone). Inside JSON
  values, keys that look secret are redacted at any depth, and nesting deeper than 32 levels
  becomes `"[omitted: nested too deeply]"`. Values larger than 8 KiB become
  `{"omitted": "too_large", "bytes": n}` (script bodies).
- Tables in `ytw_private` are **default-deny**: every column is redacted unless named as `+col`,
  and `events.entity_id` is recorded only with `+id` (a private table's id can itself be a
  credential, like a session handle).
- Payloads: insert `{"new": row}`; update `{"old": {changed}, "new": {changed}}` where
  `updated_at` and omitted columns never count as changes; delete `{"old": row}`.
- An update whose only change is `last_used_at` is not logged (API token use, T14).
- A write without an actor raises `missing_actor`; a transaction that rolls back leaves no event.
- It must be an `AFTER ... FOR EACH ROW` trigger; anything else raises.
- `ytw_append_only()` is the reusable guard for append-only tables:
  `BEFORE UPDATE OR DELETE ... FOR EACH ROW` plus `BEFORE TRUNCATE ... FOR EACH STATEMENT`.

**Other events** use `ytw_log_event(p_actor, p_actor_type, p_token_id, p_action, p_entity_type,
p_entity_id, p_payload) RETURNS uuid` (`ytw_web`, `ytw_mcp`). `p_action` must contain a dot
(`tool.call`, `auth.login`, `auth.login_denied`, `auth.logout`), `p_payload` is a JSON object of at
most 64 KiB (`EVENT_PAYLOAD_MAX_BYTES`), stored as given: summarise large arguments (a script body
as its byte count) and never include tokens, cookies or secrets. Suggested tool-call payload (T30):
`{"tool": "create_idea", "outcome": "ok" | "error" | "denied", "error": "<kind>", "token_owner": "<username>"}`.

## Errors

Functions raise with `ytw_raise(kind, message, detail jsonb, hint)`. The MESSAGE is the sentence a
person or an LLM reads: what failed, plus the valid values or the latest version. DETAIL is a JSON
object with the same facts for programs.

| Kind | SQLSTATE | TS class | HTTP | When |
| --- | --- | --- | --- | --- |
| `validation` | `YT001` | `ValidationError` | 400 | argument missing, malformed or not an allowed value |
| `not_found` | `YT002` | `NotFoundError` | 404 | referenced record does not exist |
| `forbidden` | `YT003` | `ForbiddenError` | 403 | actor may not do this (not admin, above the owner's level, last admin) |
| `version_conflict` | `YT004` | `VersionConflictError` | 409 | expected/base version is not the latest |
| `invalid_transition` | `YT005` | `InvalidTransitionError` | 422 | status or stage change the state machine forbids |
| `duplicate` | `YT006` | `DuplicateError` | 422 | natural key already exists and it is not an idempotent replay |
| `immutable` | `YT007` | `ImmutableError` | 422 | change to append-only data |
| `missing_actor` | `YT008` | `MissingActorError` | 500 | a write without `ytw_set_actor` (a bug) |

409 is reserved for version conflicts because the web UI turns every 409 into its
reload-or-merge dialog (PLAN.md section 3). The TypeScript list and `ytw_error_codes()` are kept
equal by a test; add a kind to both, in a new migration.

Conventional DETAIL keys, read by the typed getters: `field`, `value`, `allowed` (string array),
`entity`, `id`, `latest_version`, `expected_version`, `from`, `to`, `existing_id`, `reason`.
Example: `ytw_raise('version_conflict', format('idea %s changed since version %s; the latest version
is %s: reload it and apply your edit again', p_id, p_expected, v_latest), jsonb_build_object('entity',
'idea', 'id', p_id, 'expected_version', p_expected, 'latest_version', v_latest))`.

**`latest_version` and `latest`.** DETAIL keys are snake_case and the database layer keeps them
(`VersionConflictError.latestVersion` reads `details.latest_version`). The web contract answers a
conflict with `409 {"error": "version_conflict", "latest": n}` (PLAN.md section 3): the HTTP and
MCP layers name it `latest`, taking the value from `err.latestVersion`.

In TypeScript, `toDbError(err)` turns a driver error with a catalogue SQLSTATE into its class
(message verbatim, `details`, `hint`, `status`, `toJSON()`); other errors pass through unchanged.
`withActor` and `ActorTx.query` already apply it. `formatDbError(err)` renders the text an MCP tool
returns; `formatAllowed(values)` lists values the way SQL messages do (`"a", "b"`). Checks done in
TypeScript throw the same classes, e.g. `new ValidationError(message, { field, allowed })`.

**What a client may see: `toClientError(err)`.** Driver messages name tables, columns, constraints
and values, so routes and tools never send them. `toClientError` maps any error from the database
layer to `{ error, message, status, retryable, hint?, details? }`; log the original on the server
(without secrets) and send this:

| Error | `error` | HTTP | `retryable` |
| --- | --- | --- | --- |
| catalogue error with status below 500 | its kind (message, hint and details kept) | its status | no |
| `missing_actor`, anything unrecognised | `internal` | 500 | no |
| 23505 (unique) | `duplicate` | 422 | no |
| 23503 (foreign key) | `invalid_reference` | 422 | no |
| other 22xxx, 23xxx (bad value, CHECK, NOT NULL) | `validation` | 400 | no |
| 40001, 40P01 (serialization failure, deadlock) | `retry` | 503 | yes |
| 57014, 55P03 (statement or lock timeout) | `timeout` | 503 | yes |
| 42501, 25006 (no privilege, read-only transaction) | `forbidden` | 403 | no |
| other 42xxx (syntax, unknown object) | `invalid_query` | 400 | no |
| 08xxx, 53xxx, 57P0x, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EPIPE` | `unavailable` | 503 | yes |

Outside the catalogue the `message` is a fixed sentence that names nothing.

## Ideas, scripts and notes (T12)

Migrations `0030-0033`; `test/ideas.test.ts`, `test/scripts.test.ts` and `test/notes.test.ts` cover
every rule below. The seven functions follow the convention above, are executable by exactly
`ytw_web` and `ytw_mcp` (tested: no `ytw_readonly`, no `PUBLIC`), and need no `ytw_log_event`: the
audit triggers of T11 write one `events` row per inserted or changed row, with the actor, actor
type and token id passed as the first three arguments.

| Function (wrapper) | Arguments after the actor | Returns | Audit rows |
| --- | --- | --- | --- |
| `create_idea` (`createIdea`) | `title`, `pitch`, `source`, `tags`, `score` (all but `title` optional) | the idea, in `inbox` at version 1 | `idea` insert |
| `update_idea` (`updateIdea`) | `id`, `expected_version`, `fields jsonb` | the idea | `idea` update (none when nothing changes) |
| `archive_idea` (`archiveIdea`) | `id`, `expected_version` (optional) | the idea | `idea` update (none when already archived) |
| `advance_idea` (`advanceIdea`) | `id`, `new_status`, `note` (optional), `expected_version` (optional) | `(idea, note_id)` | `idea` update, and `note` insert when a note was given |
| `save_script_version` (`saveScriptVersion`) | `idea_id`, `kind`, `base_version`, `body_md` | the new revision (a `draft`) | `script` insert |
| `set_script_status` (`setScriptStatus`) | `script_id`, `status` | the revision | `script` update (none when unchanged) |
| `add_note` (`addNote`) | `entity_type`, `entity_id`, `body_md` | the note | `note` insert |

**Ideas.**

- Fields follow the limits of "Schema". Every limit is validated first, so the error is a
  `ValidationError` whose `field` names the argument and whose message says what is allowed; a CHECK
  violation never reaches the caller. `update_idea` takes `fields` as a JSON object: a key that is
  present is set (`null` clears `pitch`, `source` or `score`; `tags` replaces the whole list), an
  absent key is left alone, `status` is refused with a pointer to `advance_idea`, and any other key
  is refused with the list of editable fields. An update that changes nothing returns the stored
  row: no new version, no audit row.
- **Concurrency.** The functions lock the idea row (`FOR NO KEY UPDATE`), check the version they
  read, and name that version in the `UPDATE` itself, so a stale `expected_version` fails with
  `version_conflict` (`latest_version` in DETAIL, `err.latestVersion` in TypeScript) and two racing
  callers cannot both win, even if the lock were bypassed (tested with lock-free copies of the
  functions). `expected_version` is required by `update_idea` and optional for `advance_idea` and
  `archive_idea` (PRD 5 gives agents no version for `advance_idea`).
- **Archived ideas are frozen.** `update_idea`, `advance_idea` and `save_script_version` raise
  `invalid_transition` with `reason: "archived"`. Archiving twice is a no-op. `set_script_status`
  and `add_note` still work on an archived idea's scripts and on the idea. There is no unarchive
  function yet.
- **Stage machine.** The rules are `IDEA_STAGE_TRANSITIONS` of `@ytw/shared`: forward one stage,
  back one stage with a note, any stage to `dropped`, `dropped` to `inbox`. SQL cannot import the
  TypeScript table, so `ytw_idea_stage_transitions()` repeats it row by row, and the test drives
  `advance_idea` through all 49 (from, to) pairs and compares the function with the shared table
  (note requirement included). A rejected move raises `invalid_transition` with the valid next
  stages in the message and in `details.allowed` (`err.allowed`); moving to the stage the idea is in
  is such a move too. A move back without a note (empty and blank notes count as none) raises
  `validation` with `field: "note"`. A note given with any move is saved as a note on the idea in
  the same call, so the move and its note commit or roll back together; `note_id` returns it.
  A stale `expected_version` is reported before an invalid move.

**Scripts.**

- `save_script_version` appends version `latest + 1` of `(idea_id, kind)` when `base_version`
  equals the latest (0 when none exists), always as `draft`, with the body stored exactly as given
  (`@ytw/script-md` has normalised it). Otherwise it raises `version_conflict` carrying the latest
  version (0 when nothing is saved yet): *"base_version 1 is not the latest script version of idea
  ...: the latest is version 2; fetch version 2, merge your changes into it and save again with
  base_version 2"*. Writers of one idea queue on its row lock, so of two racing saves with the same
  base exactly one wins and the other reads the winner's version; the unique key
  `(idea_id, kind, version)` is mapped to the same error as a last line of defence. The idea must
  exist (`not_found`) and not be archived (`invalid_transition`); `kind` is `script` or
  `packaging`; `body_md` may be empty and at most `SCRIPT_BODY_MAX_BYTES` bytes of UTF-8
  (`validation`, with `bytes` and `max_bytes`; the body is never echoed).
- `set_script_status` sets `draft`, `review` or `approved` on one revision (its own id, not the
  idea's), in any order; the append-only guard of T11 allows nothing else to change.

**Notes.** `add_note` relies on the notes trigger of T11 for the target (`not_found` for a missing
idea, script revision, video or experiment) and validates the body: not blank, at most
`NOTE_BODY_MAX_BYTES` bytes (`validation`, `field: "body_md"`; `"note"` when `advance_idea` writes
it). `entity_type` is also pre-checked so that a hostile value is not echoed back in full. A note
on a script belongs to the revision (`scripts.id`).

**Internal helpers** are not executable by any application role (tested), so only the functions
above reach them: `ytw_fmt_value(text)`, `ytw_fmt_list(text[])`, `ytw_raise_not_found(entity, id)`,
`ytw_raise_version_conflict(entity, id, expected, latest)` (0030, free for later migrations to
call, so messages stay alike), `ytw_raise_idea_archived`, `ytw_raise_script_conflict`,
`ytw_idea_stages`, `ytw_idea_stage_transitions`, `ytw_check_idea_field` and `ytw_insert_note`
(taken names: do not define functions with them). Messages echo caller values JSON-quoted and cut
after 60 characters.

**TypeScript** (`src/ideas.ts`, `src/scripts.ts`, `src/notes.ts`): `createIdea`, `updateIdea`,
`archiveIdea`, `advanceIdea` (returns `{ idea, noteId }`), `saveScriptVersion`, `setScriptStatus`
and `addNote` take the `ActorTx` of `withActor`; `getIdea`, `getScriptVersion` (latest unless
`version` is given; includes the body) and `listNotes` (oldest first) take any `Queryable`. Results
are camelCase records (`IdeaRecord`, `ScriptRecord`, `NoteRecord`) with real `Date`s; a saved
revision comes back without its body but with `sizeBytes`. Arguments that could not reach the
database at all (a malformed UUID, a fractional version, a NUL character) are refused in
TypeScript with a `ValidationError` naming the field instead of a bare driver error.

## Videos, metrics and experiments (T13)

Migrations `0040-0043`; `test/videos.test.ts`, `test/metrics.test.ts` and `test/experiments.test.ts`
cover every rule below. The eight functions follow the convention above, are executable by exactly
`ytw_web` and `ytw_mcp` (tested: no `ytw_readonly`, no `PUBLIC`), and need no `ytw_log_event`: the
audit triggers of T11 write one `events` row per inserted or changed row, with the actor, actor type
and token id passed as the first three arguments. A call that changes nothing (a repeat, a no-op
save) writes no row; the tool-call event of the service (T30) records that the call happened.

| Function (wrapper) | Arguments after the actor | Returns | Audit rows |
| --- | --- | --- | --- |
| `register_video` (`registerVideo`) | `idea_id` (nullable), `youtube_id`, `title`, `published_at`, `thumbnail_url` (both optional) | the video at version 1 | `video` insert |
| `update_video` (`updateVideo`) | `id`, `expected_version`, `fields jsonb` | the video | `video` update (none when nothing changes) |
| `archive_video` (`archiveVideo`) | `id`, `expected_version` (optional) | the video | `video` update (none when already archived) |
| `log_metrics` (`logMetrics`) | `video_id`, `captured_at`, `metrics jsonb` | `(snapshot, created)` | `video_metric` insert (none for a repeat) |
| `create_experiment` (`createExperiment`) | `video_id`, `type`, `hypothesis`, `variants jsonb` | the experiment, `planned`, version 1 (the wrapper adds its variants) | `experiment` insert, one `experiment_variant` insert per variant |
| `update_experiment_status` (`updateExperimentStatus`) | `id`, `expected_version`, `new_status` | the experiment | `experiment` update |
| `record_variant_stats` (`recordVariantStats`) | `variant_id`, `impressions`, `ctr` (both optional, one needed) | the variant | `experiment_variant` update (none when unchanged) |
| `conclude_experiment` (`concludeExperiment`) | `id`, `expected_version`, `winner_variant_id` (nullable), `conclusion` | the experiment | `experiment` update |

**Videos.**

- `youtube_id` is the 11-character id, not a URL (a URL gets an error that says so). Registering one
  that exists raises `duplicate` with `existing_id` (`err.existingId`) and a message that names the
  existing video and says when it is archived; two racing registrations of one id give exactly one
  winner and the same error to the others, never a bare 23505. `idea_id` is optional; when given the
  idea must exist (`not_found`) and may be archived. **Registering a video never moves its idea**:
  `advance_idea` is the only way to change a stage.
- `published_at` is a time with a zone, NULL while the video is not scheduled; `captured_at` of a
  snapshot likewise. A time must be finite and from 2005 on, so one mistyped year cannot sort a video or a
  snapshot above every real one in the "latest" views; `published_at` may lie up to 2 years ahead
  (scheduled videos), `captured_at` at most 1 day (clock and time zone differences). The wrappers
  refuse a string without a zone (`2026-10-01T12:00:00`), which the server would read in its own zone.
- `thumbnail_url`: an `http(s)` URL or a path without a scheme, at most 2048 characters, no spaces or
  control characters (`javascript:`, `data:` and `ftp:` are refused with the scheme named).
- `update_video` takes `fields` as in `update_idea` (a present key is set, `null` clears
  `published_at`, `thumbnail_url` and `idea_id`, an absent key is left alone). Editable: `title`,
  `published_at`, `thumbnail_url`, `idea_id` (link or unlink the originating idea). **`youtube_id`
  cannot be changed** (metrics and experiments belong to that real video): archive the video and
  register the right id. Stale `expected_version`: `version_conflict` with `latest_version`.
- **Archived videos are frozen**, as archived ideas are: `update_video`, `log_metrics` (a *new*
  snapshot) and `create_experiment` raise `invalid_transition` with `reason: "archived"`. Archiving
  twice is a no-op. Still allowed: `add_note` on the video, a *repeat* of a stored snapshot (it
  creates nothing), and every function on the video's **existing experiments**, so that none is left
  running for good. There is no unarchive function yet; the `youtube_id` of an archived video stays
  taken.

**Metrics.**

- A snapshot is the row `(video_id, captured_at)`. `log_metrics` is **idempotent on that key**: the
  same numbers again return the stored row with `created = false` and write nothing; other numbers
  for the key raise `duplicate` (HTTP 422, `err.existingId` is the stored snapshot) with both sets
  in the message and in DETAIL (`stored`, `submitted`, `differing`), for example: *"video ... already
  has a snapshot captured at 2026-09-29T08:30:00Z with different numbers, so nothing was saved
  (stored: views=1000, ctr=5; submitted: views=1200, ctr=5): a snapshot never changes; log the new
  numbers with a later captured_at, or resend exactly the stored numbers to repeat the earlier
  call"*. "The same numbers" compares by value (`4.5` equals `"4.50"`, key order and the spelling of
  the instant do not matter), treats `null` like an absent metric, and counts a metric that one side
  sets and the other leaves out as different. Concurrent callers for one video queue on the video's
  row lock: of N identical calls one is `created`, the others read its row (no errors); of N different
  payloads one wins and the others get the `duplicate` error. Without the lock `ON CONFLICT DO
  NOTHING` still holds (tested with a lock-free copy).
- `metrics` is a JSON object with at least one of the keys below (anything else is refused with the
  list); `null` means "not measured". A value is a JSON number or a decimal string (`"9007199254740993"`
  keeps what a double cannot; the database returns `bigint` and `numeric` as strings). NaN, infinity,
  more than 20 decimal places and the ranges below are refused with the field named (`metrics.ctr`),
  so no CHECK violation (23514) reaches a caller:

  | Key | Accepted |
  | --- | --- |
  | `views`, `impressions` | whole number 0 to 9223372036854775807 |
  | `ctr` | 0 to 100 (percent: 4.5 means 4.5 %) |
  | `avg_view_duration_s`, `watch_time_min` | 0 to 10^15 |
  | `avg_view_pct` | 0 to 10 000 (percent of the video; **above 100 is normal** when viewers rewatch, the schema allows it) |
  | `subs_gained` | whole number, -2147483648 to 2147483647 (negative when more were lost) |
  | `retention` | 1 to 1000 points `{"t": seconds from the start, "pct": percent still watching}`, strictly increasing `t` (0 to 10^7), `pct` 0 to 10 000, at most 64 KiB as `jsonb` text |

  The whole `metrics` object may not exceed 100 000 bytes. The retention shape is this task's
  definition (T11 left it open): chart code can plot the points as they are.

**Experiments.**

- `create_experiment`: `type` in `EXPERIMENT_TYPES`; `hypothesis` optional, not blank, at most 20 000
  characters; `variants` is a list of **2 to 10** objects `{label, content, is_control?}`: **exactly
  one control**, labels unique (compared ignoring case and surrounding spaces, at most 200
  characters), `content` not blank (title or description text, or the thumbnail's URL or path, at most
  20 000 characters). The experiment and its variants are written in one call, so none exists
  without the other; variants cannot be added or removed later. The video must exist and not be
  archived. Variants read back control first, then by label.
- **Status machine** (`ytw_experiment_status_transitions()`, repeated row by row in the test, which
  drives `update_experiment_status` through all 16 pairs):

  | From | To | Through |
  | --- | --- | --- |
  | `planned` | `running` | `update_experiment_status` (sets `starts_at`) |
  | `planned` | `cancelled` | `update_experiment_status` (no period: it never ran) |
  | `running` | `concluded` | `conclude_experiment` (sets `ends_at`) |
  | `running` | `cancelled` | `update_experiment_status` (sets `ends_at`) |

  `concluded` and `cancelled` are final. Any other move, including to the current status, raises
  `invalid_transition` with the valid next statuses in the message and in `err.allowed` (empty for a
  final status, with `reason: "terminal"`). Asking `update_experiment_status` for `concluded` is a
  `validation` error that points to `conclude_experiment`. `expected_version` is required, and a
  stale one is reported before an invalid move. `starts_at` and `ends_at` bound the period in which the
  test ran (the CTR chart of T45 marks them).
- `record_variant_stats` sets `impressions` and/or `ctr` (percent) of one variant; a value left out
  keeps the stored one, at least one is needed. Allowed while the experiment is `planned` or
  `running`; on a concluded or cancelled one it raises `invalid_transition` (`reason: "terminal"`):
  the numbers a conclusion rests on do not change afterwards. Variants carry no version, so the last
  writer wins; the experiment row is locked first, so a stats call cannot slip in between a
  conclusion's status check and its commit (tested with a held-open transaction). It does not change
  the experiment's `version`.
- `conclude_experiment`: `running` only (`planned`: start it first; `cancelled` and already
  `concluded`: `invalid_transition`, a conclusion is final). `conclusion` is required (not blank, at
  most 20 000 characters). **The winner is one of the experiment's own variants, or NULL when no
  variant won** (YouTube's tests often end without a clear winner). A variant of another experiment
  or an unknown id raises `validation` (`field: "winner_variant_id"`, `err.allowed` the valid ids,
  the message lists them with their labels) **before anything is written**: the foreign key
  `experiments_winner_variant_fkey` is `DEFERRABLE INITIALLY DEFERRED` and would only fail at COMMIT
  with a bare 23503 (the test shows that this is what an unchecked foreign winner does).
- The PRD signature of `conclude_experiment` has no version; the function requires
  `expected_version` like every other write on a versioned row. A service that only knows the id
  reads the experiment first (`getExperiment`) and passes its version, which turns a concurrent
  change into a `version_conflict` instead of an overwrite.

**Internal helpers** are not executable by any application role (tested), so only the functions
above reach them (taken names: do not define functions with them): `ytw_metric_fmt_ts`,
`ytw_raise_video_archived`, `ytw_check_video_time`, `ytw_check_video_field`, `ytw_metric_number`,
`ytw_check_retention` (0040); `ytw_metric_keys`, `ytw_metric_summary`, `ytw_metric_summary_text`,
`ytw_raise_metric_conflict` (0042); `ytw_experiment_types`, `ytw_experiment_statuses`,
`ytw_experiment_status_transitions`, `ytw_experiment_next_text`, `ytw_raise_experiment_move`,
`ytw_raise_experiment_final`, `ytw_check_variants` (0043). `ytw_raise_not_found` and
`ytw_raise_version_conflict` of 0030 are reused.

**TypeScript** (`src/videos.ts`, `src/metrics.ts`, `src/experiments.ts`): `registerVideo`,
`updateVideo`, `archiveVideo`, `logMetrics` (returns `{ snapshot, created }`), `createExperiment`
(returns the experiment with its `variants`), `updateExperimentStatus`, `recordVariantStats` and
`concludeExperiment` take the `ActorTx` of `withActor`; `getVideo`, `listMetricSnapshots` (newest
first) and `getExperiment` (with variants) take any `Queryable`. Results are camelCase records
(`VideoRecord`, `MetricSnapshot`, `ExperimentRecord`, `VariantRecord`) with real `Date`s; `bigint`
and `numeric` columns (`views`, `impressions`, `ctr`, `avgViewDurationS`, `avgViewPct`,
`watchTimeMin`, variant `impressions` and `ctr`) are **strings**, `subsGained` a number. Inputs take
numbers or decimal strings (`DecimalInput`) and times as `Date` or ISO text with a zone. Arguments
that could not reach the database intact (a malformed UUID, NaN or infinity, a time without a zone, a
NUL character, a decimal that is not a decimal) are refused in TypeScript with a `ValidationError`
naming the field (`src/value-args.ts` next to `src/args.ts`); every domain rule stays in the function.

## Views, search and activity (T15)

Migrations `0060-0064`; `test/views.test.ts`, `test/search.test.ts`, `test/activity.test.ts` and
`test/seed.test.ts` cover every rule below, and `test/seed.ts` is the seed helper. Nothing here
writes: the objects only read, so none takes an actor or logs an event.

| Object (wrapper in `src/`) | Kind | Executable / selectable by | Migration |
| --- | --- | --- | --- |
| `ideas_pipeline`, `ideas_pipeline_all` (`listIdeaPipeline`, `views.ts`) | views | `ytw_web`, `ytw_mcp`, `ytw_readonly` | `0060_ideas_pipeline` |
| `video_performance_summary` (`listVideoPerformance`) | view | the same three | `0061_video_performance` |
| `experiment_results` (`listExperimentResults`) | view | the same three | `0062_experiment_results` |
| `search_all(query, limit, resources)` (`searchAll`, `search.ts`) | function | `ytw_web`, `ytw_mcp` | `0063_search` |
| `list_events(...)` (`listEvents`, `activity.ts`) | function | `ytw_web`, `ytw_mcp` | `0064_activity` |

### The views

**Rules shared by all four** (each is tested):

- `security_invoker = true`: a view reads its tables with the privileges of whoever selects from it,
  so it can never show more than that role could select from the tables (the test revokes `SELECT`
  on a table and watches the view fail with 42501).
- They read only `ideas`, `scripts`, `videos`, `video_metrics`, `experiments`, `experiment_variants`
  (and `ideas_pipeline` reads `ideas_pipeline_all`): never `users`, `user_permissions` or anything in
  `ytw_private`, and no column holds identity or secret data (the test walks `pg_depend` and the
  column names). They use built-in functions only, so `ytw_readonly` needs no function grant and
  the migrations add no allowlist row; the guard is clean.
- `SELECT` for `ytw_web`, `ytw_mcp` and `ytw_readonly`, nothing else, not even to `PUBLIC`. Each view
  and its main columns carry a comment (`obj_description`, `col_description`) for `query_sql` agents.
- A view has no order of its own; the wrappers order their rows (below).

**`ideas_pipeline` / `ideas_pipeline_all`**: one row per idea. A view cannot take a parameter, so
"archived ideas only when asked for" is two views over one definition: `ideas_pipeline` leaves
archived ideas out, `ideas_pipeline_all` keeps them (`listIdeaPipeline(db, { includeArchived })`
chooses). Columns: every `ideas` column except `search_vector`, with the same names and types
(`status` is the stage); `age_in_stage` (an `interval`, `greatest(now() - status_changed_at, 0)`:
never negative) and `days_in_stage` (whole days); and for each script kind the latest revision:
`latest_script_id|version|status|at` and `latest_packaging_id|version|status|at`, NULL when the idea
has no revision of that kind. The latest is the highest version (touching an old revision's status
changes nothing); `status` is that revision's review status and `at` when it was saved. The stage
clock is `status_changed_at`, which only a stage change moves (T11). A test checks the columns
against `SCRIPT_KINDS`. The wrapper returns `IdeaRecord` plus `ageInStageSeconds`, `daysInStage`,
`latestScript` and `latestPackaging` (`{ id, version, status, savedAt }` or `null`), most recently
moved first, optionally only some `stages`, at most `limit` rows (1 to 1000, default 500).

**`video_performance_summary`**: one row per video that is not archived: `id`, `idea_id`,
`youtube_id`, `title`, `published_at`, `thumbnail_url`; the latest snapshot (`snapshot_id`,
`captured_at`, `views`, `impressions`, `ctr`, `avg_view_duration_s`, `avg_view_pct`,
`watch_time_min`, `subs_gained`; no `retention`, read it with `listMetricSnapshots`); then for each
of the seven metrics `median_<metric>` and `<metric>_vs_median`, plus `median_sample_size`.

- *Latest snapshot* = the greatest `captured_at` of the video, **as stored**: a metric that snapshot
  did not measure is NULL even if an older snapshot had it.
- *Channel median* = `percentile_cont(0.5)` of that metric over the latest snapshots of all videos
  that are not archived and measured it, **the video itself included**. An even count interpolates
  between the two middle values; ties are fine. `percentile_cont` works in double precision and the
  result is cast back to `numeric`, so a median of values beyond 2^53 is approximate; the per-video
  values stay exact. `<metric>_vs_median` = value minus median, `numeric`, NULL when either is NULL.
  `ctr` is a percentage, so its difference is in percentage points.
- A video **without a snapshot** keeps its row with NULL metrics and differences. A **channel with one
  measured video** has that video's own values as medians (every difference is 0); with **no snapshot
  at all** the medians are NULL and `median_sample_size` is 0. `median_sample_size` counts the videos
  that have a snapshot (a metric's own population can be smaller).
- **Archived videos** are out of the rows and out of the medians: they are frozen and would skew the
  baseline of the live ones (the PRD does not say; see "Deviations from PLAN.md").
- Cost: every query computes the medians over all live videos, even for one video (about 30 ms at
  10 000 videos). The wrapper returns `{ latest, median: { sampleSize, ... }, vsMedian }` with
  decimal strings, newest `published_at` first (unscheduled videos last), optionally one `videoId`.

**`experiment_results`**: one row per variant, the experiment's columns repeated on each of its rows
(`experiment_id`, `video_id`, `video_title`, `type`, `status`, `hypothesis`, `starts_at`, `ends_at`,
`conclusion`, `winner_variant_id`, `experiment_created_at`), then the variant (`variant_id`, `label`,
`content`, `is_control`, `impressions`, `ctr`) and the comparison: `control_variant_id`,
`control_ctr`, `ctr_vs_control` (the variant's ctr minus the control's, in percentage points; 0 for
the control itself), `ctr_lift_pct` (that as a percentage of the control's ctr, rounded to 4
decimals: control 4.0, variant 5.0 gives 25) and `is_winner`. Both comparisons are NULL when a ctr is
not recorded yet, and the lift also when the control's ctr is 0. `is_winner` is true only for the
variant `conclude_experiment` named, never inferred from the numbers. Experiments of archived videos
are included (they can still be concluded). An experiment without a control (impossible through the
functions) keeps its rows with NULL comparisons. The wrapper groups the rows into experiments, newest
first, each with its `variants` (control first, then by label); its `limit` counts experiments, and it
filters by `experimentId`, `videoId` and `statuses`.

### Search: `search_all(query, limit, resources)`

Returns `entity_type` (`idea` or `script`), `id` (the idea, or the script revision), `idea_id`,
`kind` and `version` (script hits only), `title`, `rank` and `snippet`.

- **What is searched**: the title (weight A) and pitch (B) of ideas that are not archived, via the
  stored `search_vector` of T11, and the **latest revision of each (idea, kind)** of those ideas'
  scripts (body, weight D). Old revisions are never searched, so a document is one hit however often
  it was saved and text that was removed from the latest revision cannot be found. The query goes
  through `websearch_to_tsquery('english', ...)` (quoted phrases, `or`, `-exclusion`).
- **What the caller may read**: the function cannot know the token's levels, so the service passes
  the searchable resources it may read (`SEARCH_RESOURCES`: `ideas`, `scripts`) and exactly those are
  searched. There is no default: NULL, an unknown name, a wrong case or a NULL element is a
  `validation` error (`field: "resources"`, `allowed`), an empty list finds nothing. A script hit
  carries the idea's title only when `ideas` is in the list (a title is idea data), else `title` is
  NULL.
- **Never an error for query text**: empty, NULL, only stop words, operator soup, unbalanced quotes,
  SQL, emoji, 10 MB of noise all answer with rows or none (`websearch_to_tsquery` accepts any text; a
  query without a searchable word finds nothing; only the first 1000 characters are used,
  `SEARCH_QUERY_MAX_CHARS`). The TypeScript wrapper refuses only what the driver cannot carry (a NUL
  character, a non-string).
- **Limit**: 1 to 50 (`SEARCH_LIMIT_MAX`), NULL means 20 (`SEARCH_LIMIT_DEFAULT`); anything else is a
  `validation` error naming the range (a clamp would hide an agent's mistake).
- **Rank** is `ts_rank` scaled into [0, 1) (`rank / (rank + 1)`, no length normalisation): the field
  weights decide, so a title match outranks a pitch match, which outranks any number of matches in a
  script body; within a field more occurrences rank higher. Ties are ordered by entity type, then id,
  so the order is the same every time (also at the limit). Ranks are only comparable within one result.
- **Snippet** (`ts_headline`, at most `SEARCH_SNIPPET_MAX_CHARS` = 400 characters): plain text, the
  matched words wrapped in **U+27E6 (start) and U+27E7 (stop)**, exported as
  `SEARCH_HIGHLIGHT_START` and `SEARCH_HIGHLIGHT_STOP`. Rules for UIs and agents:
  1. Those two characters are removed from the author's text before highlighting, so every marker in a
     snippet was put there by the database and markers always come in pairs without nesting (a cut at
     400 characters inside a highlight appends the missing stop marker).
  2. Everything else is the author's text from agent-written markdown: it can contain `<`, `&`,
     quotes or markdown, so it must be escaped before it is shown as HTML. `snippetSegments(snippet)`
     splits a snippet into `{ text, highlight }` pieces: render each `text` as a text node (or
     escape it) and wrap the `highlight` ones in `<mark>`; never insert the snippet as HTML. (The
     parser behind `ts_headline` drops HTML-looking tags, which is not a guarantee to rely on.)
  3. Whitespace and control characters are collapsed to single spaces: a snippet is one line.
  4. A script body is highlighted only up to its first 100 000 characters (`ts_headline` costs time
     in proportion to the text it parses, about 130 ms for 1 MiB): a match further in is still found
     and ranked, but its snippet is the start of the body without markers. An idea's snippet is its
     title and pitch.
- **Rights**: `SECURITY INVOKER` (with pinned `search_path`), `STABLE`, executable by `ytw_web` and
  `ytw_mcp` only; it reads `ideas` and `scripts` with the caller's own privileges.
- **Cost**: ranking is proportional to the number of matching documents (the GIN indexes of T11 find
  them), `ts_headline` runs only for the returned hits: 5 to 90 ms on the 10 000-idea seed, the slowest
  for a word that occurs in every one of 20 000 script bodies (a 1000-character query that ORs forty
  common words took 0.2 to 0.3 s, which is the bound the query cap gives).

### Activity feed: `list_events(...)`

`list_events(p_actor, p_actor_type, p_entity_type, p_entity_id, p_action_prefix, p_from, p_to,
p_limit, p_cursor)`, every argument optional (`DEFAULT NULL`), returns `id`, `created_at`, `actor`,
`actor_type`, `token_id`, `action`, `entity_type`, `entity_id`, `payload` and `next_cursor`. The
payload is returned **as stored**: the audit layer redacted it when it wrote it (a test shows a
user's e-mail as `[redacted]`). The service checks the `activity` level before calling; the function
cannot, like `search_all`.

- **Filters**, combined with AND: `actor` (exact name, case-sensitive), `actor_type` (`human` or
  `agent`, else `validation`), `entity_type` (exact), `entity_id`, `action_prefix` (`starts_with`: a
  plain prefix, `%` and `_` mean themselves, so `tool.` finds `tool.call` and not `tools.list`; `''` is no
  filter), and a time range on `created_at` that **includes `from` and excludes `to`** (`from` after
  `to` is a `validation` error, equal bounds an empty range; the wrappers take a `Date` or ISO text with
  a time zone, the session's `TimeZone` never matters). Values nothing matches answer an empty page.
- **Order and cursor**: newest first by `(created_at DESC, id DESC)`, a total order (the index of T10
  serves it). `next_cursor` is NULL on the last page (no empty trailing page: the function reads
  one row beyond the limit), else an **opaque string** (base64url of the page's last position, exact to
  the microsecond; a JavaScript `Date` is not, which is why the database makes it) to pass as
  `p_cursor` with the same filters (other filters continue from the same position). `NULL` or `''`
  starts at the top. A cursor that does not decode (any garbage, a wrong date, 100 000 characters) is a
  `validation` error with `field: "cursor"`, never a driver error; a well-formed one that someone made up
  just continues from that position.
- **Stable under inserts**: new events carry a later `created_at` than every cursor, so they sort in
  front of it: pages already read neither repeat nor skip rows when events arrive, and a walk never
  shifts. One limit is inherent in ordering by commit time: `created_at` is the *start* of the writing
  transaction (`now()`), so an event of a transaction that started before the cursor's position and
  commits after a running walk has passed that position is missed by that walk (a new walk sees it);
  if the walk has not reached the position yet, the event simply appears in its place (tested).
- **Limit**: 1 to 100 (`EVENTS_LIMIT_MAX`), NULL means 50 (`EVENTS_LIMIT_DEFAULT`); a payload can be
  64 KiB, so the page is capped.
- **Rights**: `SECURITY INVOKER`, `STABLE`, `plan_cache_mode = force_custom_plan` (a generic plan for
  `(arg IS NULL OR column = arg)` cannot use the right index), executable by `ytw_web` and `ytw_mcp`
  only. On the 10 000-row seed (40 000 events) a page takes 2 to 5 ms, any filter combination about
  the same, and a walk of all 400 pages 0.7 s.

**Errors.** Both functions are `SECURITY INVOKER`, so they cannot call the internal `ytw_raise`
(application roles may not execute it): they `RAISE` the catalogue SQLSTATE `YT001` (validation)
directly with the same MESSAGE and DETAIL shape (`field`, `allowed`, `min`, `max`, `value`), which
`toDbError` maps to `ValidationError`. The wrappers check the same rules first and throw the same
errors, and map any driver error with `toDbError`.

### TypeScript and the seed helper

`listIdeaPipeline`, `listVideoPerformance`, `listExperimentResults` (limits `VIEW_LIST_LIMIT_DEFAULT`
and `VIEW_LIST_LIMIT_MAX`), `searchAll` with `SEARCH_*` constants and `snippetSegments`, and
`listEvents` with `EVENTS_LIMIT_*` take any `Queryable` (a pool or a transaction) and return camelCase
records: numbers that are `bigint` or `numeric` in the database are strings, dates are `Date`s, ids
are validated before the query. A test compares each constant with the database (the limits through the
DETAIL of the error, the markers and the snippet cap through real hits).

`test/seed.ts` builds data for tests and later performance work: `seedSmall(db)` (documented
records, backdated stage clocks, scripts, videos with snapshots, experiments, a few real audit events
of a person and two agents, built through the real functions where time does not matter) and
`seedLarge(db, { ideas, videos, snapshotsPerVideo, events })`, defaulting to 10 000 ideas and
videos, about 20 000 scripts, 27 000 snapshots, 1 000 experiments and 40 000 events in about 4 s: one
transaction of `INSERT ... SELECT generate_series(...)` as the superuser with the row triggers and
foreign key checks off (`session_replication_role = replica`; the rows are consistent by
construction, the events synthetic) and an `ANALYZE` afterwards. Fixed ids (`seedUuid`), fixed
vocabulary (`SEED_WORDS`), so `zq77` finds idea 77 alone. `test/seed.test.ts` asserts each view and
function answers in under 2 s on it (measured 2 to 90 ms; the whole walk of the events 0.7 s).

## TypeScript API

```ts
import { createPool, assertPoolRole, withActor, sql, toClientError } from "@ytw/db";

const pool = createPool({ role: "ytw_web", connectionString: env.DATABASE_URL });
await assertPoolRole(pool, "ytw_web");        // at startup: wrong role or a superuser stops the process

const idea = await withActor(pool, { name: user.username, type: "human" }, (tx) =>
  createIdea(tx, { title, pitch, source, tags }),
);
```

- `createPool({ role, connectionString, max?, applicationName?, onError? })`: one pool per process
  for its own role (`application_name` `ytw-web` etc., idle errors reported instead of crashing).
  For `ytw_readonly` every connection also pins `default_transaction_read_only` and
  `statement_timeout` (`roleConnectionOptions(role)`).
- `withActor(pool, actor, fn)`: one transaction (BEGIN, `ytw_set_actor`, `fn`, COMMIT or
  ROLLBACK). `actor` is `{ name, type: "human" | "agent", tokenId? }`. The callback's `tx` has
  `tx.actor` (normalised, `tokenId` null for humans) and `tx.query`, which throws typed errors.
- `queryReadOnly(pool, statement, { timeoutMs? })`: runs one untrusted statement on a
  `ytw_readonly` pool as described in "What keeps `query_sql` read-only" (any other pool is
  refused; `timeoutMs` at most `QUERY_SQL_TIMEOUT_MS`). Errors are the driver's, with the SQLSTATE
  in `code`: 25006 a write, 42501 a missing privilege, 57014 the timeout, 42601 a syntax error or
  more than one statement, 25001 an attempt to make the transaction writable. The caller caps rows
  and output size.
- `toClientError(err)`: see "Errors".
- `sql\`...${value}...\`` turns every interpolation into a bind parameter. There is no way to
  interpolate identifiers or SQL text; write those literally. Parameterized SQL only.
- `Queryable` is anything with `query` (a pool, a pooled client, an `ActorTx`).

**Wrapper modules** (`src/<area>.ts`, re-exported by `index.ts`; delete the `*_WRAPPERS_OWNER`
placeholder when you add the first export):

- Writes take the transaction first: `createIdea(tx: ActorTx, input): Promise<Idea>`, calling the
  function with `tx.actor.name, tx.actor.type, tx.actor.tokenId` as the first three arguments.
  Callers compose several writes in one `withActor` when they must be atomic.
- Reads take any `Queryable`: `listIdeas(db: Queryable, filter)`.
- Return typed objects (camelCase), not raw rows. Node-postgres returns `timestamptz` as `Date`,
  `jsonb` parsed, `uuid` as string, and `bigint`/`numeric` as **strings**: cast counts to `int` in
  SQL or convert explicitly.
- Exported names must be unique across all wrapper modules (`export *` would make a clash a
  compile error in `index.ts`).

`@ytw/db` uses `pg` (node-postgres) with the `sql` template and no query builder (ADR 0001): every
write is a function call and the reads are views or functions, so the SQL stays the only source of
truth, with no mirrored schema to keep in step.

## Test harness (`@ytw/db/testing`)

```ts
import { createTestDb, type TestDb } from "@ytw/db/testing";

let db: TestDb;
beforeAll(async () => { db = await createTestDb(); });   // unique database, fully migrated
afterAll(async () => { await db.drop(); });               // ends the pools, drops the database
```

| Member | Use |
| --- | --- |
| `db.name` | `ytw_test_<time>_<random>` |
| `db.pool(role)` | pool logged in as `ytw_web`, `ytw_mcp` or `ytw_readonly`, made by `createPool` (lazy, max 4): use it for the code under test |
| `db.admin` | superuser pool on the test database: fixtures and assertions only |
| `db.url(role \| "admin")` | connection string, e.g. a server under test's `DATABASE_URL` |
| `db.drop()` | idempotent |
| `createTestDb({ migrate: false, migrationsDir })` | empty database / other migrations (runner tests) |

- Server: `TEST_DATABASE_URL`, a superuser connection, default
  `postgres://postgres:postgres@localhost:5432/postgres` (what `scripts/pg-local.sh url` prints;
  docker compose uses the same). `MIGRATION_DATABASE_URL` is never used, so a shell that just
  migrated a real database cannot point the tests at it. CI sets `TEST_DATABASE_URL` explicitly.
- The server must be on this machine (`localhost`, `127.x.x.x`, `::1` or a Unix socket). Anything
  else is refused unless `YTW_DISPOSABLE_TEST_SERVER=1` declares the server disposable.
- Role passwords: `YTW_*_PASSWORD` when set, else the dev values of `.env.example`. The harness
  sets a role's password only when the role has none; when it has a different one, `createTestDb`
  fails with instructions instead of changing it (unless the server is disposable). So running
  tests never changes the passwords a local dev server uses.
- The database of `TEST_DATABASE_URL` (normally `postgres`) is the shared lock database: the
  migrations of all test databases on a cluster are serialized (roles are shared), so setup may
  wait. Set `hookTimeout: 120_000` in your package's `vitest.config.ts` as `packages/db` does.
- Never mock the database. Create fixtures through the real functions where they exist, or with
  `db.admin` when testing a mechanism (as `test/audit.test.ts` does with a fixture table).
- A crashed run can leave a `ytw_test_*` database behind; drop only databases you created.

## Identity, permissions, tokens, sessions

Migrations `0050-0058` (T14; `0055-0058` are the fix-forward of the security review, the earlier files
stay as they were merged). Tests: `test/identity.test.ts`, `permissions.test.ts`, `tokens.test.ts`,
`sessions.test.ts`, `access-revocation.test.ts`, `identity-locking.test.ts`,
`identity-privileges.test.ts`, `identity-arguments.test.ts`. The rules of PRD 7 live in these
functions, not in the callers; `@ytw/policy` is the same rules for code that already holds the
levels, and the tests compare the two.

| Function | Wrapper | Roles | Does |
| --- | --- | --- | --- |
| `upsert_user_on_login` | `upsertUserOnLogin` | web | Sign a person in: create or update the user of an OIDC identity (issuer + `sub`). The first user ever becomes admin. Lifts a revoked access, so call it only after the access group check passed |
| `mark_user_outside_access_group` | `markUserOutsideAccessGroup` | web | The identity provider says a person is outside the access group: revoke their access, end every session. Never creates a user |
| `get_user_access` | `getUserAccess` | web | A user with the levels they hold now (read on every request, never cache) |
| `set_user_permission` | `setUserPermission` | web | Admin: set one cell of the access matrix |
| `set_user_admin` | `setUserAdmin` | web | Admin: promote or demote; the last active admin stays |
| `set_user_access_revoked` | `setUserAccessRevoked` | web | Admin: lock a person out or restore them (manual offboarding) |
| `list_users_with_levels` | `listUserAccess` | web | Admin: the access matrix, revoked people included |
| `create_api_token` | `createApiToken` | web | A person creates a token for themselves; every level at most the owner's current level |
| `update_token_permissions`, `rotate_api_token`, `revoke_api_token` | same names, camel case | web | The owner edits, replaces the secret of, or revokes a token |
| `list_api_tokens`, `get_api_token` | `listApiTokens`, `getApiToken` | web | The owner's tokens with own and effective levels, last use, expiry. Never a hash |
| `lookup_token_by_hash` | `lookupTokenByHash`, `toTokenPrincipal` | **mcp** | Authenticate: token, owner and both level sets; `active`, `revoked`, `expired`, `owner_revoked` or unknown |
| `touch_token_last_used` | `touchTokenLastUsed` | **mcp** | Record a use of an active token (`last_used_at` only, no event) |
| `create_web_session`, `touch_web_session`, `get_web_session`, `update_web_session_tokens`, `delete_web_session`, `purge_expired_web_sessions` | `createWebSession`, ... | web | Browser sessions: idle and absolute expiry, opaque refresh-token ciphertext |

Nothing here is executable by `ytw_readonly`, and the helpers (`ytw_resources()`,
`ytw_user_effective_levels()`, `ytw_acting_user()`, `ytw_lock_users()`, ...) by nobody: they run
inside the functions above (`test/identity-privileges.test.ts` pins every grant and fails when a
function is added without being listed). Token authentication belongs to the MCP role alone: the web
server never authenticates a token (a token is never a browser login; settings use the list and get
functions), so `ytw_web` cannot execute `lookup_token_by_hash` or `touch_token_last_used`.

**Who may call.** Everything that manages users, access or tokens needs a signed-in *person*:
`actor_type` `human`, the actor name equal to the `username` of the acting user the caller passes
(`actingUserId`), access that is not revoked, and for access management `is_admin`. The audit log
therefore names the person who was allowed to make the change; a mismatch or an unknown acting user is
refused. API tokens are refused (`forbidden`, `reason: not_human`) even when their owner is an admin,
so a stolen token cannot mint, widen or rotate tokens. Tokens are managed by their owner only, an
admin included (someone else's token is `not_found`); an admin who wants a token to stop lowers the
user's levels or locks the user out, which lowers every token they own at once. The check proves that
the actor name belongs to that user id; it does not prove who the caller is. That is acceptable
because only the trusted processes (the web server, the admin CLI) hold the `ytw_web` role: the
database checks consistency, not authentication.

**Levels.** `levels` in every result is the *effective* level per object: admins hold the maximum
(`write`, the activity log `read`) whatever rows are stored, everyone else their stored level, `none`
without a row, and nobody anything while their access is revoked (below). `isAdmin` is the effective
flag too (an admin whose access is revoked is not one), so it is safe to pass `{ isAdmin, levels }` to
every `@ytw/policy` function: `userLevels` would otherwise give a revoked admin full access. The object
list and the maximum per object are two SQL functions, `ytw_resources()` and `ytw_max_level()`;
`test/permissions.test.ts` compares them with `RESOURCES` and `GRANTABLE_LEVELS`, and
[`policy.md`](policy.md) says how to add an object. Level maps list every object the database knows;
the wrappers read them as `@ytw/policy` reads stored rows (`parseResourceLevels`): an object this
build does not know is ignored, so a migration may run before the services are redeployed, one the
database does not list yet is `none`, and only a value that is not a level throws a plain `Error`.

**First and last admin.** `ytw_lock_users()` takes `pg_advisory_xact_lock(0x59545721, 1)` inside the
`SECURITY DEFINER` functions (the application roles cannot call advisory-lock functions themselves,
so nobody can hold it to stall logins). `upsert_user_on_login` and `set_user_admin` take it first, so
whoever finds no user at all becomes the one admin however many first logins race, and the last
admin cannot be demoted however many demotions race (`forbidden`, `reason: last_admin`). Only an admin
whose access is **active** counts: demoting or locking out the last active admin is refused even when
admins with revoked access exist, and demoting a revoked admin never is. A user's row is share-locked
while an access change runs, so a concurrent promotion or demotion waits for it. Tests: 20 parallel
first logins (3 rounds), six admins demoting themselves at once (exactly five succeed), rings and
pairs of admins demoting each other, two admins locking each other out.

**Isolation level and lock order** (`0055`, `test/identity-locking.test.ts`). The checks "is there an
admin?" run after the lock was granted, which is sound only when each statement reads fresh data:
under `REPEATABLE READ` the snapshot is taken by the first statement of the transaction (for
`withActor` that is `ytw_set_actor`), before the lock, so two requests could both pass. So
`ytw_lock_users()` refuses a `REPEATABLE READ` transaction (`validation`, `reason: isolation_level`,
with a hint) before it takes the lock, and everything that takes it inherits the refusal. `READ
COMMITTED` (what `withActor` uses) and `SERIALIZABLE` work: under `SERIALIZABLE` Postgres aborts one of
two conflicting transactions with `40001`, which `toClientError` already maps to a retryable
`retry`. The same lock comes first, before any user row is locked, in every function that writes
users, permission rows or revocations (`upsert_user_on_login`, `set_user_admin`,
`set_user_permission`, `mark_user_outside_access_group`, `set_user_access_revoked`), so they all lock in
one order (advisory lock, then rows) and cannot deadlock with each other, also not inside a
transaction that calls several of them. The token functions only share-lock their owner's row and
never wait for the advisory lock, so they cannot be part of a cycle; a transaction that mixes them
with the functions above should call the user-writing ones first. A `40P01` (deadlock) would still be
reported as `retry`. Keep a transaction that takes the lock short: it serialises every login, access
change and revocation until it ends.

**Admin rows.** Promoting raises the user's stored rows to the maximum in the same transaction;
`set_user_permission` never lowers an admin's level (`forbidden`, `reason: target_is_admin`; asking
for the level they already hold is a no-op). Demoting resets the user to `none` on every object unless
`keepLevels` is true, so a demotion lowers the person and their tokens at once; the admin then grants
back what the person should keep. A UI that offers the demotion must say so in its confirmation
(the person and every token they own lose their access, not just the admin flag) and offer
`keepLevels` as the explicit alternative.

**Login.** The audit actor of a login is the person signing in (actor = `preferred_username`, type
`human`, which must equal the `username` argument); `lastLoginAt` is an audited change, so every login
leaves an `update` event on the user. Profile fields mirror the identity provider's latest claims;
an `email` or `display_name` that cannot be stored (blank, too long, whitespace) is dropped instead of
failing the login, while a missing issuer, `sub` or username is a `validation` error. `username` is
not unique: the identity is (issuer, `sub`), and `ytw_acting_user()` looks users up by id. Every user
has one row per object; a login restores missing rows (and raises an admin's lowered ones). A login
also lifts a revoked access (below): call it only after the access group check passed.

**Revoking access** (`0056-0058`, `test/access-revocation.test.ts`). PRD 7: the access group check is
repeated on every token refresh, "so removing someone from the group in Keycloak ends their access",
and a token's level is the lower of its own and its owner's *current* level. `users.access_revoked_at`
is how the database knows. While it is set:

- the person's effective levels are `none` on every object, admins included, and `isAdmin` is false
  everywhere it is returned (`get_user_access`, `list_users_with_levels`, `lookup_token_by_hash`);
- every token they own is dead: `lookup_token_by_hash` reports the status `owner_revoked` (after
  `revoked` and `expired`, which are facts about the token itself), with all-none `effectiveLevels`,
  the owner's effective flag and levels, and `touch_token_last_used` leaves it alone;
- they cannot manage anything (`ytw_acting_user` refuses them: `forbidden`, `reason: access_revoked`)
  and no session can start for them (`create_web_session` refuses, and locks their row so a session
  cannot slip in between a revocation and the deletion of the sessions);
- they do not count as an admin for the last-admin guard.

Their stored levels, admin flag and tokens are kept, so restoring the access restores exactly what was
there. Two ways in, one way out:

- `mark_user_outside_access_group(actor, 'human', token_id, issuer, sub)`: the web server calls it when
  the identity provider says the person is outside the group (at sign-in and on every token refresh).
  It sets the flag, deletes **every** browser session of the person on every device and logs
  `user.access_revoked`. It never creates a user (PRD 7: "no user record is created" for someone
  without the group): an unknown identity returns no row and writes nothing. A person who is already
  revoked changes nothing and writes no event (a retrying outsider cannot flood the log). It is not
  subject to the last-admin guard: the identity provider outranks it, otherwise the one admin removed
  from the group would keep their tokens and sessions. The workspace may then have no admin whose
  access is active (the event says `no_active_admin`); the person signs in again once they are back in
  the group, or someone with the database owner's rights repairs it.
- `set_user_access_revoked(actor, 'human', token_id, acting_user_id, user_id, revoked)`: an admin whose
  access is active locks a person out or restores them. The last admin whose access is active cannot be
  locked out (`forbidden`, `reason: last_admin`). Locking out ends the sessions too. Logged as
  `user.access_revoked` / `user.access_restored` (`via: admin`).
- Out: `upsert_user_on_login` (the person signed in and passed the group check; logged as
  `user.access_restored`, `via: sign_in`) or an admin's `set_user_access_revoked(..., false)`. An admin's
  lock-out therefore holds only until the person signs in again while still in the group: to keep
  someone out for good, remove them from the group as well.

*The remaining gap.* The group check runs when the person's session refreshes, so a person who never
comes back to the web app is never re-checked against the Keycloak group and their API tokens keep
working. Until the PRD decides otherwise (a periodic check against the identity provider's admin API,
or a token lifetime), offboarding means an admin calls `set_user_access_revoked`; the admin CLI will
expose it. Two smaller consequences: a returning person gets their tokens back unchanged (revoke the
tokens first if that is not wanted), and a sign-in racing with a group check that fails resolves in
whichever order the two transactions commit, so the web server should not run both for one person at
once.

**Tokens.** The caller generates the secret, hashes it (SHA-256, 64 lower-case hex digits) and passes
the hash and the prefix (`ytw_` plus at most 11 characters). Error messages and events never contain
the hash, the secret or the prefix: a malformed hash is reported without echoing it, so a secret passed
by mistake is not copied into a log. Rules:

- Every requested level is at most the owner's *current* effective level and an object's maximum;
  the error lists every problem and the values that would be accepted, in the words of
  `grantViolations` (`forbidden` when only the ceiling is exceeded, `validation` for unknown objects
  or levels and `write` on the activity log). Objects left out get `none`. An owner with no access to
  any object cannot create tokens (PRD 7).
- `expires_at` is empty (never) or in the future. Rotation replaces hash and prefix at once (the old
  secret is unknown from the next statement on), keeps id, name and levels, starts `last_used_at`
  over, and keeps the expiry unless one is passed; an expired token must be given a new one.
  Revoked tokens cannot be changed or rotated; revoking twice changes nothing.
- `lookup_token_by_hash` (MCP role only) reads the token and its owner in one statement, so lowering a
  user (or demoting an admin, or revoking their access) lowers the result at once. `status` is
  `revoked` (wins), `expired`, `owner_revoked` or `active`, and only `active` may act; an unknown hash
  returns no row (`{ status: "unknown" }`); a hash that is not 64 lower-case hex digits is a
  `validation` error. `levels` are the token's own, `owner.levels` and `owner.isAdmin` the owner's
  *effective* levels and admin flag, `effectiveLevels` the per-object minimum and all `none` unless
  the token is active. `toTokenPrincipal(found)` builds the `TokenPrincipal` of `@ytw/policy` and
  **throws** for any other status: a principal built from a dead token would carry the token's own
  levels, and `principalLevels` would grant them. `principalLevels` of an active token's principal
  equals `effectiveLevels` (tested for owners and tokens at every level). A caller must answer 401 for
  every status but `active` without saying which failure it was.
- `touch_token_last_used(actor = token name, 'agent', token id)` (MCP role only) changes only
  `last_used_at`: the audit trigger and `updated_at` skip it, so there is no event spam. It touches an
  active token only (not revoked, not expired, owner's access not revoked). The name must match the
  token's too, but that is defence in depth, not authentication: a token's id and name both appear in
  the readable audit log (`token.created`), so knowing them proves nothing. What keeps a stranger from
  calling it is that only the MCP role may. Throttle it in the caller (T21) if the statement per call
  matters.

**Sessions** (web only, deliberately not audited and without an actor parameter: the session id is
the bearer handle behind the cookie and must never reach `events`; no message here repeats one). Idle
expiry `expires_at` = last activity + idle timeout, moved by `touch_web_session`; absolute expiry
`absolute_expires_at` = login + absolute timeout, never moved; `expires_at <= absolute_expires_at`.
Both are measured against the clock of the call that checks them. A session is alive only while both
lie in the future; `get_web_session` reports `active`, `idle_expired` or `absolute_expired` (absolute
wins) and returns the refresh-token ciphertext only while active; `touch_web_session` and
`update_web_session_tokens` never revive a dead session; `purge_expired_web_sessions()` deletes the
dead ones. Timeouts are whole seconds between 60 and 31 622 400, the ciphertext 1-16 384 bytes. The
ciphertext is made and read by the caller; the database stores it as given. `create_web_session`
refuses a person whose access is revoked. The id is the secret: the web server signs the cookie that
carries it (`SESSION_SECRET`) and should key every other server-side record of a session (logs, caches,
rate limits) by `SHA-256(session id)`, never by the raw value, so nothing it keeps beyond this table is
a usable handle.

**Events.** The audit triggers of 0011-0013 log every row change; their payloads for the two
`ytw_private` tables carry column names and the entity id only (default-deny), so each management call
also logs one readable event with `ytw_log_event` (never a secret):

| `action` | `entity_type` / id | Payload |
| --- | --- | --- |
| `user.permission_changed` | `user` / the user changed | `user`, `resource`, `from`, `to` |
| `user.admin_granted`, `user.admin_revoked` | `user` / the user | `user` (and `levels_reset` when revoked) |
| `user.access_revoked` | `user` / the user | `user`, `via` (`identity_provider` or `admin`), `sessions_ended` (and `no_active_admin` for the identity provider) |
| `user.access_restored` | `user` / the user | `user`, `via` (`sign_in` or `admin`) |
| `token.created` | `api_token` / the token | `token_name`, `owner`, `expires_at`, `levels` |
| `token.permissions_changed` | `api_token` / the token | `token_name`, `owner`, `changes: [{ resource, from, to }]` |
| `token.rotated` | `api_token` / the token | `token_name`, `owner`, `expires_at` |
| `token.revoked` | `api_token` / the token | `token_name`, `owner` |

A call that changes nothing (same level, same admin state, a second revocation, a second lock-out)
writes nothing. Actor, `actor_type` and `token_id` of every event are the caller's (the person;
`token_id` is NULL). The identity of the person (`sub`, email) is never in a payload.

**Errors.** `validation` (malformed or unknown value, a `REPEATABLE READ` transaction), `forbidden`
(not a person, not the acting user, not an admin, access revoked, last admin, an admin's levels, above
the owner's level, no access to any object), `not_found` (unknown user; a token that is not the
caller's), `invalid_transition` (changing or rotating a revoked token), `duplicate` (a token hash in
use). The `reason` in the details of a `forbidden` tells them apart: `not_human`, `actor_mismatch`,
`not_admin`, `access_revoked`, `last_admin`, `target_is_admin`, `no_access`. Wrappers throw the typed
classes of `errors.ts`; reads on a plain pool map catalogue errors too. A NULL where a value is
required is a `validation` error that names the argument (`test/identity-arguments.test.ts` calls
every function once per argument with exactly that argument NULL); a message repeats at most 60
characters of a caller's value (`ytw_fmt_value`, `ytw_fmt_json`) and a permission map with a flood of
keys is refused before it is described; the wrappers reject malformed UUIDs and NUL characters
(`args.ts`) before the driver sees them.

**From the services.**

```ts
// MCP (T21/T30): authenticate, then act as the token. Only the MCP role may call these two.
const found = await lookupTokenByHash(mcpPool, sha256Hex(secret));
if (found.status !== "active") return unauthorized();   // never tell the client which failure
const principal: TokenPrincipal = toTokenPrincipal(found); // throws for any other status
void touchTokenLastUsed(mcpPool, found).catch(log);       // after the call is authorised

// Web (T40): per request, then per page.
const session = await touchWebSession(pool, sessionId, idleSeconds);   // null = signed out
const me = session && (await getUserAccess(pool, session.userId));     // levels read now
await withActor(pool, { name: me.username, type: "human" }, (tx) =>
  setUserPermission(tx, { actingUserId: me.id, userId, resource, level }));

// Web (T40): at sign-in and on every token refresh, after the identity provider's group check.
await withActor(pool, { name: claims.preferred_username, type: "human" }, (tx) =>
  groupCheckPassed
    ? upsertUserOnLogin(tx, { issuer, sub, username, email, displayName })  // lifts a revocation
    : markUserOutsideAccessGroup(tx, { issuer, sub }));                      // null = never signed in
```

The access functions added by the review round, with their results:

```ts
markUserOutsideAccessGroup(tx, { issuer, sub }): Promise<AccessRevocation | null>   // web; null = unknown identity
setUserAccessRevoked(tx, { actingUserId, userId, revoked }): Promise<AccessRevocation> // web; admin, access active
// AccessRevocation = { userId, username, accessRevokedAt: Date | null, changed, sessionsEnded }
// SQL: mark_user_outside_access_group(actor, actor_type, token_id, issuer, sub)
//      set_user_access_revoked(actor, actor_type, token_id, acting_user_id, user_id, revoked)
//        -> (user_id, username, access_revoked_at, changed, sessions_ended)
// UserAccess (getUserAccess, listUserAccess, login) gained accessRevokedAt: Date | null; isAdmin and
// levels are effective. ApiTokenStatus gained "owner_revoked".
```

Not covered by the database, for the services to know: the web server's session store is the table
above and the group check is the web server's (the database never talks to Keycloak), so a person
removed from the group stays in until their session refreshes or an admin calls
`set_user_access_revoked` (see "The remaining gap" above).

## Notes for specific tasks

- **T11** (done, see "Schema"): every business table carries `ytw_audit('<entity>', ...)` with
  `-search_vector`, `-updated_by` (and `-author` on notes) omitted, `token_hash`, `users.email` and
  `users.oidc_sub` redacted. Entity types: `idea`, `script`, `video`, `video_metric`, `experiment`,
  `experiment_variant`, `note`, `user`, `user_permission`, `api_token`, `api_token_permission`.
  The two `ytw_private` tables are audited default-deny and record `+id` only (T10 adjusted `0012`
  for that before anything was deployed).
- **T12-T15**: besides the rules above, the guard now rolls back a migration that grants
  `ytw_readonly` a `SECURITY DEFINER` function or a function without an allowlist row, lets an
  application role read a view over `ytw_private`, or leaves a `SECURITY DEFINER` function with
  another owner; the loader rejects files with transaction control or `BEGIN ATOMIC` bodies; the
  application roles cannot call advisory-lock functions, so take locks inside `SECURITY DEFINER`
  functions only.
- **T14** (done, see "Identity, permissions, tokens, sessions"): the row-level audit triggers of
  `api_tokens` and `api_token_permissions` stay default-deny as T10 left them; the readable record of
  a token change is the `token.*` event of the function that made it. Functions reading
  `ytw_private` are `SECURITY DEFINER`, granted to `ytw_web` and/or `ytw_mcp` only.
- **T15** (done, see "Views, search and activity (T15)"): the views are `security_invoker`, read no
  `ytw_private`, `users` or `user_permissions` object and are granted to all three roles, so
  `query_sql` agents can use them; a function that `query_sql` may call would need `SECURITY INVOKER`
  and an allowlist row (none does). The functions only the services call (`search_all`, `list_events`)
  are `SECURITY INVOKER` and granted to `ytw_web` and `ytw_mcp`; the caller passes what the token may
  read (`search_all`) or has checked the `activity` level (`list_events`).
- **T21, T30-T34**: send `toClientError(err)` to clients and log the original; answer version
  conflicts with `409 {"error": "version_conflict", "latest": err.latestVersion}`.
- **T23**: `/readyz` can call `migrationStatus(pool)`; `upToDate` false means not ready.
- **T30**: log every tool call with `ytw_log_event` (payload above).
- **T33** (`query_sql`): `createPool({ role: "ytw_readonly", connectionString:
  env.READONLY_DATABASE_URL })` and `queryReadOnly(pool, sql)` for every statement, nothing else.
  It runs exactly one statement; cap rows and output size in the tool. For errors use
  `toClientError`; the driver's message of an error in classes 22 and 42 describes the agent's own
  statement and may be returned as well.

## Deviations from PLAN.md

- `search_path` for `SECURITY DEFINER` functions is `pg_catalog, public, pg_temp`, not
  `pg_catalog, public`: without an explicit `pg_temp` Postgres searches temporary tables first, so a
  caller able to create one could shadow a table the function uses. Application roles also lack
  `TEMPORARY`, so this is defence in depth.
- Secret-bearing tables live in schema `ytw_private` instead of relying only on per-table grants.
- `ytw_readonly` may execute only allowlisted functions and never a `SECURITY DEFINER` one (PLAN.md
  asked only for `STABLE` read functions), and the large-object and advisory-lock built-ins are
  closed to every application role. A non-superuser migration owner therefore needs
  `sql/superuser-bootstrap.sql` run once by a superuser.
- `ytw_set_actor` is `SECURITY DEFINER` (it must be able to raise catalogue errors when an
  application role calls it directly); it touches no table.
- `@ytw/db` uses `pg` with the `sql` template instead of Drizzle (ADR 0001 records why).
- The test harness reads `TEST_DATABASE_URL` only (never `MIGRATION_DATABASE_URL`) and refuses
  servers on other machines unless they are declared disposable.
- `events` has no `updated_at`/`created_by` (rows never change; `actor` is the creator).
- `video_metrics` has no `updated_at`/`updated_by` either (append-only, like `events`), and
  `web_sessions` has exactly the columns PLAN.md lists (`last_seen_at` instead of `updated_at`, no
  `created_by`; the user is in `user_id`).
- `web_sessions.id` defaults to `gen_random_uuid()` (v4), not `uuid_generate_v7()`: it is a bearer
  handle, so it should carry 122 random bits and not reveal when the session started.
- `ytw_touch()` maintains `updated_at`, `updated_by`, `version` and `ideas.status_changed_at` in the
  database instead of leaving them to each function (PLAN.md lists only the columns).
- `notes` are append-only and limited to `NOTE_BODY_MAX_BYTES`, matching the `/api/notes` contract
  (PRD 4 names only `scripts` and `video_metrics` as append-only and sets no note limit).
- The session functions take no actor and write no event (the one exception to the function
  convention: a session id is a bearer handle and must not reach `events`); the functions that manage
  users, access and tokens add a readable `user.*` / `token.*` event to the row-level ones and require a
  signed-in person whose username is the audit actor (PLAN.md asks only for the actor parameters).
- Demoting an admin resets their levels to none unless asked otherwise (PRD 7 does not say; the
  alternative leaves a demoted admin with Write on everything and leaves their tokens as strong as
  before, which contradicts "lowering a user's levels immediately lowers their tokens"). Rotating a
  token can set a new expiry, and `update_web_session_tokens` exists, because a silent refresh needs
  it (PLAN.md lists create/touch/get/delete/purge).
- `@ytw/policy` is a dev dependency of `@ytw/db`, for the tests that compare the SQL with it.
- `users.access_revoked_at`, `mark_user_outside_access_group`, `set_user_access_revoked` and the
  token status `owner_revoked` are not in PLAN.md: the security review asked for them because PRD 7
  says leaving the Keycloak group "ends their access" and a token is at most its owner's current
  level. `lookup_token_by_hash` and `touch_token_last_used` are granted to `ytw_mcp` only (PLAN.md
  also named the web role): the web server never authenticates a token.
- T15 adds `ideas_pipeline_all` next to the three views of PRD 4: a view takes no parameter, so
  "archived ideas only when asked for" needs a second view. `video_performance_summary` leaves archived
  videos out of its rows and its medians (PRD 4 does not say; they are frozen and would skew the
  baseline).
- `search_all` takes the resources the caller may read as a required argument (the function cannot
  know the token's levels; PLAN.md says "restricted to the resources the caller may read") and
  `search_all` and `list_events` refuse an out-of-range limit instead of clamping it, so an agent
  learns the valid range. Their snippet markers are U+27E6 and U+27E7 rather than `<b>`, so that no
  markup is ever produced by the database and a UI cannot mistake the author's `<b>` for a highlight.
- The two read functions are `SECURITY INVOKER` and raise `YT001` directly instead of calling
  `ytw_raise` (application roles may not execute the internal helper); `list_events` returns its
  `next_cursor` as a column on every row of the page.
