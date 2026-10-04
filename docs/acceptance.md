# Acceptance QA Report

This document provides the final acceptance quality assurance and requirements-to-evidence traceability matrix for YouTube Workspace.

> [!NOTE]
> **Scope & Delivery Status:** Phases 0–3, including the Web UI and browser BFF, are implemented. Phase 3 passed CI and hosted Keycloak end-to-end validation in [PR #7](https://github.com/mirceanton/youtube-workspace/pull/7); this validates the merged code, not a production deployment. Phase 4 PWA and offline requirements remain deferred. See the [Phase 3 evidence](traceability/phase3.md).

---

## 1. Traceability Matrix: Goals & User Stories

| ID | Description | Scope | Status | Verification Evidence / Implementation |
| --- | --- | --- | --- | --- |
| **G1** | Single schema covering ideas, scripts, packaging experiments, published videos and metric snapshots | Phase 1 | **PASS** | `packages/db/migrations/0014_ideas.sql` – `0017_experiments.sql`, `packages/db/test/schema.test.ts` |
| **G2** | Agents read and write only through a constrained MCP interface, using API tokens with per-object permissions | Phase 2 | **PASS** | `apps/mcp/src/registry.ts`, `apps/mcp/src/tools/**`, `apps/mcp/test/write-tools-*.test.ts`, `apps/mcp/test/read-tools-and-sql.test.ts`, `apps/mcp/test/gate/permissions-matrix.test.ts` |
| **G3** | Every write is attributable to an agent or human via an audit log | Phase 1–2 | **PASS** | `packages/db/migrations/0004_audit.sql`, `packages/db/src/client.ts` (`withActor`), `packages/db/test/audit.test.ts`, `apps/mcp/test/gate/audit-logging.test.ts` |
| **G4** | Web UI to browse and manage all of it, with OIDC login, simple per-user access levels and PWA support on a phone | Phase 3–4 | **Phase 3 PASS; Phase 4 DEFERRED** | Web UI and OIDC validated in [Phase 3 CI and hosted Keycloak checks](traceability/phase3.md); PWA and offline support remain Phase 4 work |
| **G5** | Agents can download a script as markdown, edit it locally and upload it back as a new revision without race conditions | Phase 1–2 | **PASS** | `packages/script-md/src/**`, `apps/mcp/src/tools/export.ts`, `apps/mcp/src/files/routes.ts`, `apps/mcp/test/file-export-import.test.ts` |
| **US1** | Owner drags ideas on board and moves through stages | Phase 3 | **PASS** | Browser story and implementation evidence in [Phase 3 traceability](traceability/phase3.md) |
| **US2** | Owner opens script on phone, reads and leaves comments | Phase 3 | **PASS** | Responsive reader and comment browser story in [Phase 3 traceability](traceability/phase3.md); PWA installation/offline support remains Phase 4 |
| **US3** | Owner compares experiment variants, impressions and CTR | Phase 3 | **PASS** | Browser story and implementation evidence in [Phase 3 traceability](traceability/phase3.md) |
| **US4** | Agent downloads script .md, edits locally, uploads new revision safely | Phase 2 | **PASS** | `apps/mcp/test/file-export-import.test.ts` (test: full download, edit, upload, conflict re-download, merge, retry) |
| **US5** | Owner generates API token in settings, sets levels up to own, revokes any time | Phase 2 | **PASS** | `@ytw/admin-cli` (`pnpm ytw-admin token create/rotate/revoke`), `packages/tokens/test/**`, `apps/mcp/test/gate/token-lifecycle.test.ts` |
| **US6** | Owner sets what each user can do per object from settings | Phase 2 | **PASS** | `@ytw/admin-cli` (`pnpm ytw-admin user set-level --as <admin>`), `packages/db/test/permissions.test.ts` |
| **US7** | Owner sees which agent or user changed anything, and when | Phase 1–2 | **PASS** | `packages/db/test/activity.test.ts` (`list_events` keyset pagination), `apps/mcp/src/tools/read.ts` (`search` / audit queries) |

---

## 2. Traceability Matrix: PRD Section 4 (Data Model & Integrity Rules)

| Rule / Invariant | Status | Verification Evidence / Test Suite |
| --- | --- | --- |
| Primary keys use UUIDv7 (134-bit time-ordered UUIDs) | **PASS** | `packages/db/src/uuid.ts`, `packages/db/test/uuid.test.ts` |
| `scripts` is append-only: unique on `(idea_id, kind, version)`, new versions inserted, never updated in place | **PASS** | `packages/db/migrations/0015_scripts.sql`, `packages/db/test/scripts.test.ts` |
| `video_metrics` is append-only: unique on `(video_id, captured_at)`, idempotent insertion | **PASS** | `packages/db/migrations/0016_videos.sql`, `packages/db/test/metrics.test.ts`, `apps/mcp/test/write-tools-videos-experiments.test.ts` |
| Mutable rows (`ideas`, `experiments`, `videos`) carry `version int` with optimistic concurrency enforcement | **PASS** | `packages/db/test/ideas.test.ts`, `packages/db/test/videos.test.ts`, `packages/db/test/experiments.test.ts`, `packages/db/test/gate/concurrency-races.test.ts` |
| Strict ENUMs and CHECK constraints for all statuses, stages, and types | **PASS** | `packages/db/test/schema.test.ts` (asserts domain constraints on all columns) |
| `events` audit table allows `INSERT` and `SELECT` only; immutable | **PASS** | `packages/db/test/catalog.test.ts`, `packages/db/test/gate/direct-dml.test.ts` |
| `ON DELETE RESTRICT` on foreign keys; soft deletion (`archived_at`) for ideas and videos | **PASS** | `packages/db/test/schema.test.ts`, `packages/db/test/ideas.test.ts` |
| Idea pipeline stage state machine: forward 1 stage, backward 1 stage with note, any to dropped, dropped to inbox | **PASS** | `packages/db/migrations/0031_idea_functions.sql`, `packages/db/test/ideas.test.ts`, `packages/db/test/gate/stage-machine-fuzzing.test.ts` |
| Pipeline views: `ideas_pipeline`, `video_performance_summary`, `experiment_results` | **PASS** | `packages/db/migrations/0060_ideas_pipeline.sql` – `0062_experiment_results.sql`, `packages/db/test/views.test.ts` |
| Full-text search over ideas and scripts (`tsvector` + rank + headline) | **PASS** | `packages/db/migrations/0063_search.sql`, `packages/db/test/search.test.ts` |
| Activity feed: keyset pagination, actor/entity/date filters | **PASS** | `packages/db/migrations/0064_activity.sql`, `packages/db/test/activity.test.ts` |

---

## 3. Traceability Matrix: PRD Section 5 (MCP Server & Tools)

| Tool / Contract Specification | Required Level | Status | Verification Evidence / Test Suite |
| --- | --- | --- | --- |
| Fastify Streamable HTTP transport, stateless Bearer token auth per request | N/A | **PASS** | `apps/mcp/src/app.ts`, `apps/mcp/test/app.test.ts` |
| `whoami`: returns token name, ID, owner, and effective permission map | None | **PASS** | `apps/mcp/src/tools/whoami.ts`, `apps/mcp/test/app.test.ts` |
| `create_idea(title, pitch, source, tags)` | Write on ideas | **PASS** | `apps/mcp/src/tools/ideas.ts`, `apps/mcp/test/write-tools-ideas-scripts-notes.test.ts` |
| `update_idea(id, expected_version, fields)` | Write on ideas | **PASS** | `apps/mcp/src/tools/ideas.ts`, `apps/mcp/test/write-tools-ideas-scripts-notes.test.ts` |
| `advance_idea(id, new_status, note)` | Write on ideas | **PASS** | `apps/mcp/src/tools/ideas.ts`, `apps/mcp/test/write-tools-ideas-scripts-notes.test.ts` |
| `save_script_version(idea_id, kind, base_version, body_md)` | Write on scripts | **PASS** | `apps/mcp/src/tools/scripts.ts`, `apps/mcp/test/write-tools-ideas-scripts-notes.test.ts` |
| `set_script_status(script_id, status)` | Write on scripts | **PASS** | `apps/mcp/src/tools/scripts.ts`, `apps/mcp/test/write-tools-ideas-scripts-notes.test.ts` |
| `export_script(idea_id, kind, version?)` | Read on scripts | **PASS** | `apps/mcp/src/tools/export.ts`, `apps/mcp/test/file-export-import.test.ts` |
| `register_video(idea_id, youtube_id, title, published_at)` | Write on videos | **PASS** | `apps/mcp/src/tools/videos.ts`, `apps/mcp/test/write-tools-videos-experiments.test.ts` |
| `log_metrics(video_id, captured_at, metrics)` | Write on videos | **PASS** | `apps/mcp/src/tools/videos.ts`, `apps/mcp/test/write-tools-videos-experiments.test.ts` |
| `create_experiment(video_id, type, hypothesis, variants)` | Write on experiments | **PASS** | `apps/mcp/src/tools/experiments.ts`, `apps/mcp/test/write-tools-videos-experiments.test.ts` |
| `record_variant_stats(variant_id, impressions, ctr)` | Write on experiments | **PASS** | `apps/mcp/src/tools/experiments.ts`, `apps/mcp/test/write-tools-videos-experiments.test.ts` |
| `conclude_experiment(id, winner_variant_id, conclusion)` | Write on experiments | **PASS** | `apps/mcp/src/tools/experiments.ts`, `apps/mcp/test/write-tools-videos-experiments.test.ts` |
| `add_note(entity_type, entity_id, body_md)` | Write on notes | **PASS** | `apps/mcp/src/tools/notes.ts`, `apps/mcp/test/write-tools-ideas-scripts-notes.test.ts` |
| `list_ideas`, `get_idea`, `get_script` | Read on respective | **PASS** | `apps/mcp/src/tools/read.ts`, `apps/mcp/test/read-tools-and-sql.test.ts` |
| `list_videos`, `get_video_performance` | Read on videos | **PASS** | `apps/mcp/src/tools/read.ts`, `apps/mcp/test/read-tools-and-sql.test.ts` |
| `list_experiments`, `get_experiment_results` | Read on experiments | **PASS** | `apps/mcp/src/tools/read.ts`, `apps/mcp/test/read-tools-and-sql.test.ts` |
| `list_notes(entity)` | Read on notes | **PASS** | `apps/mcp/src/tools/read.ts`, `apps/mcp/test/read-tools-and-sql.test.ts` |
| `search(query, resources?)` | Dynamic per resource | **PASS** | `apps/mcp/src/tools/read.ts`, `apps/mcp/test/read-tools-and-sql.test.ts` |
| `query_sql(sql)`: Read on ALL, readonly pool, 10s timeout, 500-row cap, 1 MB cap | Read on EVERYTHING | **PASS** | `apps/mcp/src/tools/sql.ts`, `apps/mcp/test/read-tools-and-sql.test.ts` |
| `GET /files/scripts/:idea_id/:kind`: returns markdown with front matter | Read on scripts | **PASS** | `apps/mcp/src/files/routes.ts`, `apps/mcp/test/file-export-import.test.ts` |
| `PUT /files/scripts/:idea_id/:kind`: accepts markdown, 409 conflict detection | Write on scripts | **PASS** | `apps/mcp/src/files/routes.ts`, `apps/mcp/test/file-export-import.test.ts` |
| Database roles: `ytw_web`, `ytw_mcp`, `ytw_readonly`; zero table-level DML | Least privilege | **PASS** | `packages/db/migrations/0001_roles.sql`, `packages/db/test/catalog.test.ts`, `packages/db/test/gate/direct-dml.test.ts` |
| Every tool call logs an `events` row (success, failure, or permission denied) | All calls | **PASS** | `apps/mcp/src/registry.ts`, `apps/mcp/test/gate/audit-logging.test.ts` |

---

## 4. Traceability Matrix: PRD Section 6 (Web UI)

| Screen / Feature | Status | Notes |
| --- | --- | --- |
| Dashboard (pipeline counts, running experiments, headline metrics, recent activity) | **PASS** | Implemented and CI validated; see [Phase 3 traceability](traceability/phase3.md) |
| Ideas Kanban board and table view | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |
| Scripts reader, version diff, download/upload UI | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |
| Experiments list, detail, and CTR chart | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |
| Videos performance table and time-series metrics | **PASS** | Implemented and CI validated; see [Phase 3 traceability](traceability/phase3.md) |
| Activity filterable audit feed | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |
| Global full-text search UI | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |
| Settings UI (profile, token manager, access matrix) | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |
| Real-time polling (15s), conflict reload/merge dialog | **PASS** | Implemented and browser-story validated; see [Phase 3 traceability](traceability/phase3.md) |

---

## 5. Traceability Matrix: PRD Section 7 (Authentication & RBAC)

| Requirement | Scope | Status | Verification Evidence / Implementation |
| --- | --- | --- | --- |
| Keycloak OIDC BFF flow, PKCE, secure session cookie | Phase 3 | **PASS** | Validated in hosted Keycloak end-to-end checks; see [Phase 3 traceability](traceability/phase3.md) |
| Access model: `none`, `read`, `write` per object; `activity` allows `none` or `read` | Phase 1 | **PASS** | `packages/policy/src/**`, `packages/policy/test/**` (100% branch coverage) |
| First user in database automatically becomes admin with write on all resources | Phase 1–2 | **PASS** | `packages/db/migrations/0051_identity.sql`, `packages/db/test/identity.test.ts`, `apps/admin-cli/test/cli.test.ts` |
| Last admin cannot be demoted or removed | Phase 1 | **PASS** | `packages/db/migrations/0056_access_revocation.sql`, `packages/db/test/access-revocation.test.ts` |
| Token level <= owner's level; lowering owner immediately lowers token | Phase 1–2 | **PASS** | `packages/policy/src/effective.ts`, `packages/tokens/test/**`, `apps/mcp/test/gate/permissions-matrix.test.ts` |
| API token secrets shown once, stored only as prefix + SHA-256 hash | Phase 1–2 | **PASS** | `packages/tokens/src/service.ts`, `packages/db/test/tokens.test.ts`, `apps/admin-cli/test/cli.test.ts` |
| Token revocation, expiration, and rotation take effect immediately on next call | Phase 2 | **PASS** | `apps/mcp/test/gate/token-lifecycle.test.ts` |
| Rate limiting on token authentication failures (per IP and per prefix) | Phase 2 | **PASS** | `packages/tokens/src/limiter.ts`, `packages/tokens/test/limiter.test.ts`, `apps/mcp/test/app.test.ts` |
| Audit entries record actor = token name + id + owner | Phase 1–2 | **PASS** | `apps/mcp/src/registry.ts`, `apps/mcp/test/gate/audit-logging.test.ts` |

---

## 6. Traceability Matrix: PRD Section 8 (Mobile & PWA - Deferred)

| Requirement | Scope | Status | Notes |
| --- | --- | --- | --- |
| PWA manifest (`display: standalone`, icons, theme) | Phase 4 | **DEFERRED** | Deferred with Web UI |
| Service worker precaching app shell | Phase 4 | **DEFERRED** | Deferred with Web UI |
| Read-through offline script caching | Phase 4 | **DEFERRED** | Deferred with Web UI |
| Touch targets >= 44 px, WCAG 2.1 AA accessibility | Phase 4 | **DEFERRED** | Deferred with Web UI |

---

## 7. Traceability Matrix: PRD Section 9 (Non-Functional & Security)

| Requirement | Status | Verification Evidence / Implementation |
| --- | --- | --- |
| Connects to existing Postgres via `DATABASE_URL`; no DB provisioning | **PASS** | Standard connection pooling in `@ytw/db/src/client.ts` |
| Repeatable migrations via `MIGRATION_DATABASE_URL` with advisory lock | **PASS** | `packages/db/src/migrate.ts`, `packages/db/test/migrate.test.ts` |
| Configuration from environment variables; fail-fast validation | **PASS** | `packages/observability/src/env.ts`, `apps/mcp/src/env.ts`, `apps/mcp/test/env.test.ts` |
| Mise toolchain (`.mise.toml`) pinning Node 24 and pnpm | **PASS** | `.mise.toml` |
| Parameterized queries only; no raw string interpolation in SQL | **PASS** | `packages/db/src/client.ts` (`sql` template tag), `packages/db/test/gate/sql-injection.test.ts` |
| Structured JSON logs with automated secret redaction | **PASS** | `packages/observability/src/logger.ts`, `packages/observability/test/logger.test.ts` |
| Prometheus metrics endpoint (`/metrics`) with tool call counters | **PASS** | `packages/observability/src/metrics.ts`, `apps/mcp/test/app.test.ts` |
| Health probes (`/healthz`, `/readyz`) reporting DB and migration status | **PASS** | `packages/observability/src/health.ts`, `apps/mcp/test/app.test.ts` |
| Input payload limits (1 MB on Fastify HTTP body and script upload) | **PASS** | `apps/mcp/src/app.ts`, `apps/mcp/test/file-export-import.test.ts` |
| Automated integration testing against real Postgres without DB mocks | **PASS** | `@ytw/db/testing` test harness (`packages/db/src/testing.ts`), all test suites |

---

## 8. Sandbox & Verification Boundaries

The automated test suites execute against a live PostgreSQL 16 container in the local development sandbox. The following items require external environment configuration in a production deployment:

1. **Production Keycloak Instance:** Hosted CI validated the dev realm and OIDC flow. A production deployment still requires configuring the client against the organization's Keycloak server.
2. **TLS Reverse Proxy:** In production, SSL/TLS certificates and termination must be provided by a fronting load balancer (NGINX, Caddy, or Kubernetes Ingress).
3. **Real Mobile Devices:** PWA home screen installation on iOS Safari or Android Chrome requires a deployed HTTPS domain.
