# Phase 1 Gate: Adversarial DB Hardening Traceability Matrix

**Task:** T16 — Phase 1 Gate: Adversarial DB Hardening  
**Target Specification:** [PRD Section 4: "Data model"](../PRD.md#4-data-model), [PRD Section 5: "Agent interface (MCP)"](../PRD.md#5-agent-interface-mcp), [PRD Section 7: "Authentication and RBAC"](../PRD.md#7-authentication-and-rbac), [PRD Section 9: "Migrations and operational safety"](../PRD.md)  
**Status:** **100% Conformance Verified (40 Test Suites, 1,964 Passing Tests)**  
**Verification Date:** 2026-10-03  

---

## 1. Overview & Verification Summary

This document establishes the bidirectional traceability matrix between the specifications in **PRD Section 4 ("Data model")**, **PRD Section 5 ("Agent interface (MCP)" — database aspects)**, **PRD Section 7 ("Authentication and RBAC" — data and privilege layer)**, and the PostgreSQL database package implementation (`packages/db`).

The Phase 1 gate subjects the database package to extensive adversarial testing:
- **Zero Table-Level Write Access:** Exhaustive DML attempts across all roles (`ytw_web`, `ytw_mcp`, `ytw_readonly`) on all public and private tables fail with SQLSTATE `42501`.
- **Role Separation & Least Privilege:** Enforces strict execution boundaries between `ytw_web` and `ytw_mcp`, denies mutating functions to `ytw_readonly`, and blocks direct calls to internal helper functions.
- **SQL Injection & Payload Fuzzing:** Verifies parameter sanitization and injection immunity across all database functions and domain fields.
- **Search-Path Hijack Resilience:** Verifies that all `SECURITY DEFINER` functions pin `search_path = pg_catalog, public, pg_temp`, preventing schema spoofing and shadow-function hijacking.
- **Stage Machine Fuzzing:** Exhaustively verifies all 49 pairwise state transitions of the 7 idea stages, enforcing forward, backward-with-note, drop, undrop, and illegal-transition invariants.
- **Concurrency & Race Conditions:** Validates optimistic locking, deduplication, and atomic isolation under concurrent load.
- **Audit Completeness & Immutability:** Verifies that every business mutation logs an audit event, and that the `events` table cannot be updated, deleted, or truncated even by superusers.
- **Migration Equivalence:** Verifies that migrating a fresh database in one run yields a catalog identical to migrating file-by-file incrementally, and that migrations are strictly idempotent.

```
========================================================================================
Test Suite                                         Tests   Result   Execution Time
========================================================================================
packages/db/test/gate/direct-dml.test.ts             267    PASS    ~0.7s
packages/db/test/gate/function-privileges.test.ts     89    PASS    ~0.5s
packages/db/test/gate/stage-machine-fuzzing.test.ts   90    PASS    ~0.9s
packages/db/test/gate/audit-completeness.test.ts      19    PASS    ~0.6s
packages/db/test/gate/sql-injection.test.ts           14    PASS    ~0.7s
packages/db/test/gate/concurrency-races.test.ts        7    PASS    ~1.5s
packages/db/test/gate/migration-equivalence.test.ts    5    PASS    ~3.5s
packages/db/test/gate/search-path-hijack.test.ts       3    PASS    ~0.6s
packages/db/test/*.test.ts (32 baseline suites)     1470    PASS    ~34.0s
========================================================================================
Total: 40 Test Files                                1964    PASS    100% Success
========================================================================================
```

---

## 2. PRD Section 4: Data Model & Storage Integrity

| PRD Section 4 Requirement | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **UUID Primary Keys**: All tables use UUID PKs (UUIDv7 preferred). | `uuid_generate_v7()` default on all primary keys | `test/uuid.test.ts`<br>`test/schema.test.ts` | **PASS** |
| **Timestamps & Actor Attribution**: `created_at`/`updated_at` timestamptz, `created_by` / actor recorded on all entities. | `public.ytw_touch()` trigger, migration 0003/0004 | `test/schema.test.ts`<br>`test/gate/audit-completeness.test.ts` | **PASS** |
| **Ideas Pipeline Table**: `ideas` with `title`, `pitch`, `status`, `score`, `source`, `tags text[]`. | Migration 0010, `public.ideas` | `test/ideas.test.ts`<br>`test/gate/direct-dml.test.ts` | **PASS** |
| **Scripts Table Revisions**: `scripts` append-only with `idea_id`, `kind` (`script`, `packaging`), `version`, `body_md`, `status`. Unique on `(idea_id, kind, version)`. | Migration 0011, `public.scripts` | `test/scripts.test.ts`<br>`test/gate/concurrency-races.test.ts` | **PASS** |
| **Videos Table**: `videos` with `idea_id`, `youtube_id` (unique, 11-char), `title`, `published_at`, `thumbnail_url`. | Migration 0013, `public.videos` | `test/videos.test.ts`<br>`test/gate/concurrency-races.test.ts` | **PASS** |
| **Video Metrics Table**: `video_metrics` append-only snapshots; unique on `(video_id, captured_at)`. | Migration 0013, `public.video_metrics` | `test/metrics.test.ts`<br>`test/gate/concurrency-races.test.ts` | **PASS** |
| **Experiments Table**: `experiments` with `video_id`, `type`, `hypothesis`, `status`, `starts_at`, `ends_at`, `winner_variant_id`, `conclusion`. | Migration 0014, `public.experiments` | `test/experiments.test.ts`<br>`test/gate/concurrency-races.test.ts` | **PASS** |
| **Experiment Variants Table**: `experiment_variants` with `experiment_id`, `label`, `content`, `is_control`, `impressions`, `ctr`. Exactly one control per experiment. | Migration 0014, `public.experiment_variants` | `test/experiments.test.ts`<br>`test/gate/concurrency-races.test.ts` | **PASS** |
| **Notes Table**: `notes` comments on any entity (`idea`, `script`, `video`, `experiment`); author and markdown body (up to 64 KiB). | Migration 0015, `public.notes` | `test/notes.test.ts`<br>`test/gate/audit-completeness.test.ts` | **PASS** |
| **Events Table**: Immutable audit log with `actor`, `actor_type`, `token_id`, `action`, `entity_type`, `entity_id`, `payload`, `created_at`. | Migration 0004, `public.events` | `test/audit.test.ts`<br>`test/gate/audit-completeness.test.ts` | **PASS** |
| **Idea Stages & Transitions**: `inbox → shortlisted → scripting → filming → editing → published`, plus `dropped`. Forward 1, backward 1 with note, any to dropped, dropped to inbox. | Migration 0010, `public.advance_idea()` | `test/ideas.test.ts`<br>`test/gate/stage-machine-fuzzing.test.ts` | **PASS** |
| **Optimistic Concurrency**: Mutable tables (`ideas`, `experiments`, `videos`) carry `version` int; updates require `expectedVersion` and fail on mismatch with `VersionConflictError`. | `public.update_idea()`, `public.update_video()`, `public.update_experiment_status()`, `public.conclude_experiment()` | `test/gate/concurrency-races.test.ts`<br>`test/ideas.test.ts` | **PASS** |
| **Views**: `ideas_pipeline`, `video_performance_summary`, `experiment_results`. | Migration 0016, 0017, 0018 | `test/views.test.ts`<br>`test/gate/function-privileges.test.ts` | **PASS** |
| **Soft Deletes**: Deletion is soft (`archived_at`) for ideas and videos; foreign keys enforce `ON DELETE RESTRICT`. | Migration 0010, 0013, `archive_idea()`, `archive_video()` | `test/ideas.test.ts`<br>`test/videos.test.ts` | **PASS** |

---

## 3. PRD Section 5: Agent Interface (Database Security & RBAC)

| PRD Section 5 Requirement | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **Fixed Postgres Roles**: Created by migration: `ytw_web`, `ytw_mcp`, `ytw_readonly`. | Migration 0001, `0001_roles.sql` | `test/catalog.test.ts`<br>`test/client.test.ts` | **PASS** |
| **Direct DML Denial**: Zero table-level INSERT, UPDATE, DELETE, TRUNCATE granted to application roles. Direct attempts fail with SQLSTATE 42501. | Migration 0002, 0004, 0010-0018 | `test/gate/direct-dml.test.ts`<br>`test/owner.test.ts` | **PASS** |
| **Security Definer Isolation**: All application mutations execute exclusively through `SECURITY DEFINER` functions. | Functions in migrations 0010-0057 | `test/owner.test.ts`<br>`test/gate/function-privileges.test.ts` | **PASS** |
| **Role Privilege Separation**: `ytw_mcp` cannot execute administrative/web functions (`setUserPermission`, `setUserAdmin`, `createApiToken`, session functions). | Execution grants in migration 0052, 0053, 0057 | `test/gate/function-privileges.test.ts` | **PASS** |
| **Read-Only Role Isolation**: `ytw_readonly` holds `default_transaction_read_only = on` and has 0 execute privileges on mutating functions. | Migration 0001, `packages/db/src/readonly.ts` | `test/gate/function-privileges.test.ts`<br>`test/readonly.test.ts` | **PASS** |
| **Search-Path Hijack Immunity**: 100% of `SECURITY DEFINER` functions pin `search_path = pg_catalog, public, pg_temp`, preventing schema hijacking. | Migration functions specification | `test/gate/search-path-hijack.test.ts` | **PASS** |
| **SQL Injection Immunity**: All functions use parameterized SQL and typed arguments, immune to injection and drop/sleep attacks. | Typed queries across `packages/db/src/*.ts` | `test/gate/sql-injection.test.ts` | **PASS** |
| **Audit Actor Fidelity**: Functions require actor name and type as parameters; actor is recorded in `events`. | `public.ytw_set_actor()`, `public.ytw_log_event()` | `test/gate/audit-completeness.test.ts`<br>`test/audit.test.ts` | **PASS** |

---

## 4. PRD Section 7: Authentication & RBAC Storage

| PRD Section 7 Requirement | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **Users Table**: Linked to Keycloak identities via unique pair `(oidc_issuer, oidc_sub)`. | Migration 0002, `public.users` | `test/identity.test.ts`<br>`test/gate/audit-completeness.test.ts` | **PASS** |
| **First-User Admin Bootstrap**: Very first user to log in automatically becomes admin with Write on all resources; subsequent users start with None on all resources. | Migration 0052, `public.upsert_user_on_login()` | `test/identity.test.ts`<br>`test/gate/concurrency-races.test.ts` | **PASS** |
| **First-User Race Resolution**: Concurrent first logins resolve via advisory locking: exactly 1 user becomes admin, remaining users get None. | Migration 0055, `0055_identity_lock_discipline.sql` | `test/gate/concurrency-races.test.ts`<br>`test/identity-locking.test.ts` | **PASS** |
| **Last-Admin Demotion Safeguard**: An admin cannot be demoted or locked out if they are the last active admin. | Migration 0052, 0056, `public.set_user_admin()` | `test/permissions.test.ts`<br>`test/access-revocation.test.ts` | **PASS** |
| **Access Revocation & Session Eviction**: `set_user_access_revoked` locks out user, revokes access, and deletes all active web sessions. | Migration 0057, `public.set_user_access_revoked()` | `test/access-revocation.test.ts`<br>`test/sessions.test.ts` | **PASS** |
| **API Tokens Storage**: Tokens stored by SHA-256 hash, token prefix index, owner link, expiry, and revocation timestamp. | Migration 0053, `ytw_private.api_tokens` | `test/tokens.test.ts`<br>`test/gate/audit-completeness.test.ts` | **PASS** |
| **Token Owner Ceiling Enforcement**: Token permissions cannot exceed owner user levels; checked dynamically on token creation and updates. | Migration 0053, `public.create_api_token()`, `public.update_token_permissions()` | `test/tokens.test.ts`<br>`test/permissions.test.ts` | **PASS** |

---

## 5. Audit Completeness & Immutability Matrix

| Requirement | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **Ideas Mutations Audited**: `createIdea`, `updateIdea`, `advanceIdea`, `archiveIdea` write `events` rows. | Triggers & `ytw_log_event()` | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Scripts Mutations Audited**: `saveScriptVersion`, `setScriptStatus` write `events` rows. | Triggers & `ytw_log_event()` | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Videos & Metrics Audited**: `registerVideo`, `updateVideo`, `archiveVideo`, `logMetrics` write `events` rows. | Triggers & `ytw_log_event()` | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Experiments Mutations Audited**: `createExperiment`, `recordVariantStats`, `updateExperimentStatus`, `concludeExperiment` write `events` rows. | Triggers & `ytw_log_event()` | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Notes Mutations Audited**: `addNote` writes `events` rows. | Triggers & `ytw_log_event()` | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Identity & Token Mutations Audited**: Login, permission grants, admin changes, token issuance, rotation, and revocation write `events` rows. | Triggers & `ytw_log_event()` | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Events Table Immutability (Roles)**: `ytw_web`, `ytw_mcp`, `ytw_readonly` denied UPDATE, DELETE, TRUNCATE with SQLSTATE 42501. | Migration 0004 table grants | `test/gate/audit-completeness.test.ts` | **PASS** |
| **Events Table Immutability (Superuser)**: Superuser UPDATE, DELETE, TRUNCATE blocked by `ytw_append_only()` trigger raising `ImmutableError` (YT007). | Migration 0004 append-only trigger | `test/gate/audit-completeness.test.ts` | **PASS** |

---

## 6. PRD Section 9: Migrations & Catalog Reproducibility

| PRD Section 9 Requirement | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **One-Command Migration**: `migrate()` applies all pending migrations in order and registers SHA-256 checksums in `schema_migrations`. | `packages/db/src/migrate.ts` | `test/migrate.test.ts`<br>`test/gate/migration-equivalence.test.ts` | **PASS** |
| **Strict Idempotency**: Running `migrate()` repeatedly makes 0 modifications to `schema_migrations` or database catalog. | `packages/db/src/migrate.ts` | `test/migrate.test.ts`<br>`test/gate/migration-equivalence.test.ts` | **PASS** |
| **One-Go vs Incremental Equivalence**: Migrating in a single run produces a catalog (tables, columns, constraints, indexes, triggers, functions, privileges) 100% identical to file-by-file incremental migrations. | Database migration runner | `test/gate/migration-equivalence.test.ts` | **PASS** |
| **Intermediate Schema State**: Migrating partially (e.g. up to 0004) leaves database in valid, functional intermediate state with subsequent upgrades completing seamlessly. | Database migration runner | `test/gate/migration-equivalence.test.ts` | **PASS** |
| **Migration Tampering Safeguards**: Editing an applied migration file or modifying checksums halts execution with `MigrationError`. | `packages/db/src/migrate.ts` | `test/migrate.test.ts`<br>`test/gate/migration-equivalence.test.ts` | **PASS** |

---

## 7. Gate Conformance Verification Suites (T16)

The 8 gate test suites under `packages/db/test/gate/` provide dedicated adversarial verification for Phase 1:

1. **`direct-dml.test.ts` (267 tests)**:
   - Exhaustive Cartesian product of operations (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `ALTER TABLE`, `DROP TABLE`) against all 11 public and 3 private tables across all 3 application roles (`ytw_web`, `ytw_mcp`, `ytw_readonly`).
   - Asserts SQLSTATE `42501` (insufficient privilege) on 100% of attempts.
2. **`function-privileges.test.ts` (89 tests)**:
   - Asserts execution denial for `ytw_readonly` across all mutating functions (42501).
   - Enforces role separation: `ytw_mcp` cannot execute administrative/web functions (42501).
   - Blocks direct execution of internal helper functions (`ytw_*`) from application roles.
   - Audits catalog to verify PUBLIC and `ytw_readonly` hold 0 execution privileges.
3. **`stage-machine-fuzzing.test.ts` (90 tests)**:
   - Exhaustive testing of all 49 pairwise combinations of the 7 idea stages.
   - Validates valid forward moves (5), backward moves with note (5), backward without note (rejected with `ValidationError`), drop moves (6), undrop moves (1).
   - Rejects same-stage transitions (7) and invalid skips/jumps (25) with `InvalidTransitionError`.
   - Fuzzes malformed stage strings, whitespace variations, SQL injection attempts, and null bytes.
4. **`audit-completeness.test.ts` (19 tests)**:
   - Verifies that every mutating business function writes an `events` row with valid actor, action, and payload.
   - Enforces table immutability: application roles cannot UPDATE/DELETE/TRUNCATE (42501).
   - Enforces superuser immutability via append-only triggers raising `ImmutableError` (YT007).
5. **`sql-injection.test.ts` (14 tests)**:
   - Injects adversarial payloads (table drops, sleep injections, quote/comment soup, null bytes, unicode escapes) across all 16 database functions.
   - Asserts parameter isolation, query parameterization, and database integrity.
6. **`concurrency-races.test.ts` (7 tests)**:
   - Tests concurrent `update_idea` double-submits (optimistic locking: 1 succeeds, others fail with `VersionConflictError`).
   - Tests concurrent `save_script_version` race (1 succeeds, others fail with `VersionConflictError` returning latest version).
   - Tests concurrent `register_video` duplicate rejection.
   - Tests concurrent `log_metrics` idempotency.
   - Tests concurrent first-user creation race (race to claim admin: exactly 1 becomes admin, others get None).
   - Tests concurrent experiment status and conclusion races.
7. **`migration-equivalence.test.ts` (5 tests)**:
   - Fresh DB migration in one go applies all 35 migrations with verified checksums.
   - Repeated `migrate()` runs are strictly idempotent.
   - Bit-for-bit catalog equivalence between one-go migration and step-by-step incremental migration across all catalog dimensions.
   - Intermediate state compatibility validation.
   - Post-apply migration immutability enforcement.
8. **`search-path-hijack.test.ts` (3 tests)**:
   - Sets up malicious `evil` schema containing shadow functions and tables.
   - Verifies `SECURITY DEFINER` functions ignore hijacked `search_path` and never touch shadow objects.
   - Audits PostgreSQL catalog to verify 100% of `SECURITY DEFINER` functions pin `search_path = pg_catalog, public, pg_temp`.

---

## 8. Verification Instructions

To execute the full database test suite and verify Phase 1 gate conformance:

```bash
# 1. Run all gate hardening tests (8 test suites, 494 tests)
pnpm --filter @ytw/db test test/gate/

# 2. Run all database tests (40 test suites, 1,964 tests)
pnpm --filter @ytw/db test
```
