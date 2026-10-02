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
T11 owns `0010-0029`: the tables of PRD 4 plus `web_sessions` (see "Schema").

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
| `users` | public | mutable | unique `(oidc_issuer, oidc_sub)` |
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
- **T14**: `touch_token_last_used` should update only `last_used_at` (and `updated_at`), so the
  trigger skips it. Functions reading `ytw_private` are `SECURITY DEFINER`, granted to `ytw_web`
  and/or `ytw_mcp` only. To show more of a token in the audit log than its id, recreate the
  trigger in your range with more `+col` arguments (never the hash).
- **T15**: views granted to `ytw_readonly` must not read `ytw_private` (guard), and a function that
  `query_sql` may call needs `SECURITY INVOKER` and an allowlist row. Functions only the services
  call (`search_all`, `list_events`) are granted to `ytw_web` and `ytw_mcp`.
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
