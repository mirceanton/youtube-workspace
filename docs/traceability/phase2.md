# Phase 2 Gate: MCP Conformance Traceability Matrix

**Task:** T35 — Phase 2 Gate: MCP Conformance  
**Target Specification:** [PRD Section 5: "Agent interface (MCP)"](../PRD.md#5-agent-interface-mcp), [PRD Section 7: "Authentication and RBAC"](../PRD.md#7-authentication-and-rbac)  
**Status:** **100% Conformance Verified (12 Test Suites, 178 Passing Tests)**  
**Verification Date:** 2026-10-03  

---

## 1. Overview & Verification Summary

This document establishes the bidirectional traceability matrix between the specifications in **PRD Section 5 ("Agent interface (MCP)")**, the Phase 2 MCP server implementation (`apps/mcp`), and the automated regression and conformance test suites (`apps/mcp/test/**`).

All 23 registered MCP tools, file export/import HTTP routes, security controls, RBAC policies, concurrency handling, and audit trail mechanisms have been verified against running PostgreSQL instances using the official Model Context Protocol TypeScript SDK.

```
========================================================================================
Test Suite                                         Tests   Result   Execution Time
========================================================================================
apps/mcp/test/gate/permissions-matrix.test.ts         84    PASS    ~2.4s
apps/mcp/test/gate/audit-logging.test.ts               9    PASS    ~0.6s
apps/mcp/test/gate/token-lifecycle.test.ts             5    PASS    ~0.6s
apps/mcp/test/gate/actionable-errors.test.ts           9    PASS    ~0.6s
apps/mcp/test/gate/concurrency.test.ts                 3    PASS    ~0.5s
apps/mcp/test/file-export-import.test.ts              15    PASS    ~0.7s
apps/mcp/test/read-tools-and-sql.test.ts              16    PASS    ~11.0s (inc. timeout)
apps/mcp/test/write-tools-videos-experiments.test.ts  10    PASS    ~0.8s
apps/mcp/test/write-tools-ideas-scripts-notes.test.ts 11    PASS    ~0.8s
apps/mcp/test/foundation.test.ts                       8    PASS    ~0.6s
apps/mcp/test/app.test.ts                              3    PASS    ~0.05s
apps/mcp/test/env.test.ts                              5    PASS    ~0.01s
========================================================================================
Total: 12 Test Files                                 178    PASS    100% Success
========================================================================================
```

---

## 2. Server Architecture, Transport & Authentication

| PRD Section 5 Requirement | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **Custom MCP Server**: TypeScript MCP SDK server, database-backed permission check on every call. | `apps/mcp/src/server.ts` (`createMcpServer`), `apps/mcp/src/tools.ts` | `test/foundation.test.ts`<br>`test/app.test.ts` | **PASS** |
| **Streamable HTTP Transport**: Fastify SSE & POST transport exposed at `/mcp`. | `apps/mcp/src/app.ts` (`buildApp`), Fastify handler | `test/foundation.test.ts`<br>`test/gate/token-lifecycle.test.ts` | **PASS** |
| **Stateless Bearer Authentication**: Token sent via `Authorization: Bearer <secret>`, looked up by SHA-256 hash. | `packages/tokens/src/authenticate.ts`, `apps/mcp/src/app.ts` | `test/foundation.test.ts`<br>`test/gate/token-lifecycle.test.ts` | **PASS** |
| **No-Leak 401 Responses**: Missing, malformed, revoked, expired, unknown tokens return identical 401 Unauthorized. | `packages/tokens/src/authenticate.ts`, `apps/mcp/src/app.ts` | `test/foundation.test.ts`<br>`test/gate/token-lifecycle.test.ts` | **PASS** |
| **Auth Failure Rate Limiting**: Bounded sliding window tracking failures by IP and token prefix, returning 429 with `Retry-After`. | `packages/tokens/src/limiter.ts`, `apps/mcp/src/app.ts` | `test/foundation.test.ts` | **PASS** |
| **Immediate Revocation**: Calling with revoked token or owner revoked fails immediately with 401 on next call. | `packages/tokens/src/authenticate.ts`, `packages/db/src/tokens.ts` | `test/gate/token-lifecycle.test.ts` | **PASS** |
| **Immediate Expiration**: Calling with expired token fails immediately with 401 on next call. | `packages/tokens/src/authenticate.ts` | `test/gate/token-lifecycle.test.ts` | **PASS** |
| **Token Rotation**: Old secret invalidated immediately; new secret works immediately. | `packages/tokens/src/service.ts`, `packages/db/src/tokens.ts` | `test/gate/token-lifecycle.test.ts` | **PASS** |
| **Throttled `last_used_at` Updates**: Updated on tool call, throttled to at most once per minute per token. | `packages/tokens/src/authenticate.ts` (`touchTokenLastUsed`) | `test/gate/token-lifecycle.test.ts` | **PASS** |

---

## 3. Write Tools (v1) Specification Matrix

| Tool | Required Level | Specified Behavior | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `create_idea(title, pitch, source, tags, score)` | Write on `ideas` | Inserts an idea in `inbox` stage with version 1. | `apps/mcp/src/tools/ideas.ts`<br>`packages/db/src/ideas.ts` | `test/write-tools-ideas-scripts-notes.test.ts`<br>`test/gate/permissions-matrix.test.ts`<br>`test/gate/audit-logging.test.ts` | **PASS** |
| `update_idea(id, expected_version, fields)` | Write on `ideas` | Edits non-status fields; fails with 409 version conflict on version mismatch. | `apps/mcp/src/tools/ideas.ts`<br>`packages/db/src/ideas.ts` | `test/write-tools-ideas-scripts-notes.test.ts`<br>`test/gate/concurrency.test.ts`<br>`test/gate/actionable-errors.test.ts` | **PASS** |
| `advance_idea(id, new_status, note)` | Write on `ideas` | Validates stage transition rules: forward 1, backward 1 (requires note), any to dropped, dropped to inbox. | `apps/mcp/src/tools/ideas.ts`<br>`packages/db/src/ideas.ts` | `test/write-tools-ideas-scripts-notes.test.ts`<br>`test/gate/actionable-errors.test.ts`<br>`test/gate/audit-logging.test.ts` | **PASS** |
| `save_script_version(idea_id, kind, base_version, body_md)` | Write on `scripts` | Appends next revision only if `base_version` is latest; otherwise fails and returns `latest_version`. Body capped at 1 MiB. | `apps/mcp/src/tools/scripts.ts`<br>`packages/db/src/scripts.ts` | `test/write-tools-ideas-scripts-notes.test.ts`<br>`test/gate/concurrency.test.ts`<br>`test/gate/actionable-errors.test.ts` | **PASS** |
| `set_script_status(script_id, status)` | Write on `scripts` | Updates status to `draft`, `review`, or `approved`. | `apps/mcp/src/tools/scripts.ts`<br>`packages/db/src/scripts.ts` | `test/write-tools-ideas-scripts-notes.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `register_video(idea_id, youtube_id, title, published_at)` | Write on `videos` | Creates video record; validates 11-char YouTube ID format. | `apps/mcp/src/tools/videos.ts`<br>`packages/db/src/videos.ts` | `test/write-tools-videos-experiments.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `log_metrics(video_id, captured_at, metrics)` | Write on `videos` | Appends metrics snapshot; idempotent on `(video_id, captured_at)`. | `apps/mcp/src/tools/videos.ts`<br>`packages/db/src/metrics.ts` | `test/write-tools-videos-experiments.test.ts`<br>`test/gate/concurrency.test.ts` | **PASS** |
| `create_experiment(video_id, type, hypothesis, variants)` | Write on `experiments` | Creates experiment with 2-10 variants, exactly one designated control. | `apps/mcp/src/tools/experiments.ts`<br>`packages/db/src/experiments.ts` | `test/write-tools-videos-experiments.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `record_variant_stats(variant_id, impressions, ctr)` | Write on `experiments` | Updates variant results while experiment is planned or running. | `apps/mcp/src/tools/experiments.ts`<br>`packages/db/src/experiments.ts` | `test/write-tools-videos-experiments.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `conclude_experiment(id, winner_variant_id, conclusion)` | Write on `experiments` | Closes running experiment, sets winner variant and learnings. | `apps/mcp/src/tools/experiments.ts`<br>`packages/db/src/experiments.ts` | `test/write-tools-videos-experiments.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `add_note(entity_type, entity_id, body_md)` | Write on `notes` | Adds markdown comment (up to 64 KiB) to idea, script, video, or experiment. | `apps/mcp/src/tools/notes.ts`<br>`packages/db/src/notes.ts` | `test/write-tools-ideas-scripts-notes.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |

---

## 4. Structured Read Tools & `query_sql` Constraints

| Tool | Required Level | Specified Behavior | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `list_ideas(status, stages, include_archived, limit)` | Read on `ideas` | Lists ideas pipeline with age in stage and latest script revisions. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/pipeline.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `get_idea(id)` | Read on `ideas` | Gets single idea by ID. Fails with 404 when not found. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/ideas.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `get_script(idea_id, kind, version?)` | Read on `scripts` | Gets script revision by idea and kind. Returns latest revision unless specified. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/scripts.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `list_videos(limit)` | Read on `videos` | Lists videos with headline metrics and channel median comparisons. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/video-summary.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `get_video_performance(video_id)` | Read on `videos` | Detailed performance record and channel medians for a video. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/video-summary.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `list_experiments(video_id?, status?, limit)` | Read on `experiments` | Lists packaging experiments with variant summaries. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/experiments.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `get_experiment_results(experiment_id)` | Read on `experiments` | Side-by-side variants with CTR differences vs control and declared winner. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/experiments.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `list_notes(entity_type, entity_id)` | Read on `notes` | Lists notes attached to an entity, ordered chronologically. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/notes.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `search(query, resources?, limit?)` | Read on `ideas` or `scripts` | Full-text search across ideas and scripts; filters results to readable resources. | `apps/mcp/src/tools/read.ts`<br>`packages/db/src/search.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `query_sql(sql)` — Permissions | Read on **ALL** resources | Offed only to tokens with Read on ideas, scripts, videos, experiments, notes, activity. | `apps/mcp/src/tools/sql.ts`<br>`packages/policy/src/authorize.ts` | `test/read-tools-and-sql.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| `query_sql(sql)` — Engine Security | Read-Only Role (`ytw_readonly`) | Enforces `default_transaction_read_only = on`; blocks DML and mutations. | `apps/mcp/src/tools/sql.ts`<br>`packages/db/src/readonly.ts` | `test/read-tools-and-sql.test.ts` | **PASS** |
| `query_sql(sql)` — Single Statement | Single query only | Multi-statement injection attempts (semicolons separating queries) rejected. | `apps/mcp/src/tools/sql.ts` (`isSingleStatement`) | `test/read-tools-and-sql.test.ts` | **PASS** |
| `query_sql(sql)` — Timeout | 10s Statement Timeout | Enforces PostgreSQL `statement_timeout = 10000`. | `packages/db/src/readonly.ts` | `test/read-tools-and-sql.test.ts` | **PASS** |
| `query_sql(sql)` — Row Cap | 500 Row Limit | Queries returning > 500 rows truncated with `truncated: true`. | `apps/mcp/src/tools/sql.ts` | `test/read-tools-and-sql.test.ts` | **PASS** |
| `query_sql(sql)` — Byte Limit | 1 MB Output Cap | Results exceeding 1,000,000 bytes rejected with actionable validation error. | `apps/mcp/src/tools/sql.ts` | `test/read-tools-and-sql.test.ts` | **PASS** |
| `query_sql(sql)` — Isolation | System Schemas Blocked | Direct access to `ytw_private` and administrative/unsafe functions blocked. | PostgreSQL grant model, migration 0002/0004 | `test/read-tools-and-sql.test.ts` | **PASS** |

---

## 5. Script Markdown File Export & Import Round-Trip

| PRD Section 5 Rule | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **Download Tool**: `export_script` returns markdown with YAML front matter (`idea_id`, `kind`, `version`, `status`) + body. | `apps/mcp/src/tools/export.ts`<br>`packages/script-md` | `test/file-export-import.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| **Download HTTP Route**: `GET /files/scripts/{idea_id}/{kind}` with bearer token serves identical markdown file. | `apps/mcp/src/files/routes.ts` | `test/file-export-import.test.ts` | **PASS** |
| **Upload Tool & HTTP Route**: `save_script_version` and `PUT /files/scripts/{idea_id}/{kind}?base_version=N` create new revision as `draft`. | `apps/mcp/src/tools/scripts.ts`<br>`apps/mcp/src/files/routes.ts` | `test/file-export-import.test.ts`<br>`test/gate/concurrency.test.ts` | **PASS** |
| **Optimistic Concurrency**: If `base_version` is not latest, call fails (HTTP 409) and returns `latest_version`. | `packages/db/src/scripts.ts`<br>`apps/mcp/src/files/routes.ts` | `test/file-export-import.test.ts`<br>`test/gate/concurrency.test.ts`<br>`test/gate/actionable-errors.test.ts` | **PASS** |
| **Front Matter Stripping & Validation**: Front matter stripped before save; mismatches on `idea_id` or `kind` return 400 validation error. | `apps/mcp/src/files/routes.ts`<br>`packages/script-md` | `test/file-export-import.test.ts` | **PASS** |
| **Service Parity**: HTTP file routes use same API tokens, permission checks, and service functions as MCP tools. | `apps/mcp/src/files/routes.ts` | `test/file-export-import.test.ts` | **PASS** |

---

## 6. RBAC, Security & Tool Design Rules

| PRD Section 5 & 7 Rule | Implementation | Verifying Test(s) | Status |
| :--- | :--- | :--- | :--- |
| **Fixed Postgres Roles**: Database roles created by migration (`ytw_web`, `ytw_mcp`, `ytw_readonly`). | `packages/db/migrations/0001_roles.sql` | `packages/db/test/catalog.test.ts` | **PASS** |
| **Owner Ceiling Enforcement**: Token permissions can never exceed owner user levels. Lowering owner immediately lowers token effective level. | `packages/policy/src/principal.ts`<br>`apps/mcp/src/server.ts` | `test/gate/permissions-matrix.test.ts`<br>`test/read-tools-and-sql.test.ts` | **PASS** |
| **Security Definer Isolation**: Application writes execute through `SECURITY DEFINER` functions; no table-level INSERT/UPDATE granted. | Migration 0004/0010-0018 | `packages/db/test/owner.test.ts` | **PASS** |
| **Audit Actor Fidelity**: Functions take actor name as parameter; audit row records token name as actor, token ID, and owner username. | `apps/mcp/src/audit.ts`<br>`public.ytw_log_event()` | `test/gate/audit-logging.test.ts`<br>`test/foundation.test.ts` | **PASS** |
| **Denied Call Auditing**: Calls rejected for permission denial record `outcome: "denied"` with actor information preserved. | `apps/mcp/src/server.ts` | `test/gate/audit-logging.test.ts`<br>`test/gate/permissions-matrix.test.ts` | **PASS** |
| **Tool Failure Auditing**: Internal errors and domain exceptions record `outcome: "error"` with error details. | `apps/mcp/src/server.ts` | `test/gate/audit-logging.test.ts` | **PASS** |
| **Audit Immutability**: `events` table is append-only; UPDATE and DELETE triggers reject alterations. | `public.ytw_append_only()` | `test/gate/audit-logging.test.ts` | **PASS** |
| **Actionable LLM-Readable Errors**: Errors state what failed and list valid values (stage transitions, notes, versions, enums). | `packages/db/src/errors.ts`<br>`apps/mcp/src/server.ts` | `test/gate/actionable-errors.test.ts` | **PASS** |
| **No Delete Operations**: No MCP tool exposes data deletion functionality. | `apps/mcp/src/tools/*.ts` | `apps/mcp/scripts/generate-docs.ts`<br>`docs/mcp.md` | **PASS** |
| **Tool Documentation Generator**: `pnpm docs:mcp` introspects tool registry and updates documentation. | `apps/mcp/scripts/generate-docs.ts` | `pnpm docs:mcp` command execution | **PASS** |

---

## 7. Gate Conformance Verification Suites (T35)

The gate test suites under `apps/mcp/test/gate/` provide dedicated conformance verification for Phase 2:

1. **`permissions-matrix.test.ts` (84 tests)**:
   - Exhaustive Cartesian verification across all 23 tools.
   - Evaluates `none` rejection, `read` vs `write` requirements, and dynamic owner ceiling downgrades.
   - Validates multi-resource requirement for `query_sql` across all 6 resources.
   - Validates resource-scoped search permissions and open access for `whoami`.
2. **`token-lifecycle.test.ts` (5 tests)**:
   - Validates immediate revocation (token level and owner level).
   - Validates immediate expiration against database timestamp constraints.
   - Validates rotation invalidation of old secrets and activation of new secrets.
   - Validates `last_used_at` timestamp capture and <= 1/minute write throttling.
3. **`audit-logging.test.ts` (9 tests)**:
   - Verifies audit row insertion on write tools, read tools, system tools, and SQL queries.
   - Verifies actor preservation (`token.name`, `token.id`, `token_owner`) on permission denials.
   - Verifies error details preservation on validation errors and version conflicts.
   - Asserts append-only immutability of the `events` audit table.
4. **`actionable-errors.test.ts` (9 tests)**:
   - Verifies actionable error payloads for invalid stage transitions (listing valid transitions).
   - Verifies requirement of explanatory notes for backward transitions.
   - Verifies script version conflict reports with `latest_version`.
   - Verifies idea optimistic concurrency conflict reports with `expected_version`.
   - Verifies Zod schema validation errors enumerating valid options across all enums.
5. **`concurrency.test.ts` (3 tests)**:
   - Validates race condition resolution in concurrent `save_script_version` calls (1 success, 1 conflict).
   - Validates optimistic locking in concurrent `update_idea` calls (1 success, 1 conflict).
   - Validates idempotency of concurrent `log_metrics` snapshot inserts.

---

## 8. Verification Instructions

To execute the full MCP test suite and verify Phase 2 conformance:

```bash
# 1. Generate live documentation
pnpm docs:mcp

# 2. Run all MCP server tests
pnpm --filter @ytw/mcp test
```
