# Orchestration plan: YouTube Channel Workspace

Source of truth for requirements: [`docs/PRD.md`](../PRD.md). Worker rules: [`PROTOCOL.md`](PROTOCOL.md).
The orchestrator only dispatches, tracks and unblocks. Workers implement; separate workers review.

## Original scope decision (user, 2026-10-02): deliver phases 0-2 first, defer the web app
At the time, this round delivered Phase 0 (foundations), Phase 1 (data layer) and Phase 2 (MCP server) = the backend plus the MCP
interface, usable by agents without any UI (PRD 10: "agents can collaborate through the database before any UI exists").
The original plan deferred Phase 3 (web BFF, SPA features, OIDC login, settings screens: T40, T41b, T42-T49) until the user asked, and listed Phase 4
(PWA and mobile: T50, T51) and the web-related parts of Phase 5 (T60 security review of the web tier, T61 web performance,
T62 full README) as deferred. T41 (SPA shell) and T02 (Keycloak realm) had already merged and were dormant then. Because the web app is where
users and API tokens are normally created, phase 2 gains **T21b (admin CLI)** and **T36 (operator guide)**, and T63 becomes a
final acceptance check of phases 0-2 only. The original plan also deferred the "disabled user" design gap found in the T14
review (a user removed from the Keycloak group should lose their API tokens too).

This records the original scope decision. Phase 3 was subsequently authorized, implemented, and
merged in [PR #7](https://github.com/mirceanton/youtube-workspace/pull/7); its hosted Keycloak
acceptance evidence is in [`docs/traceability/phase3.md`](../traceability/phase3.md). Phase 4
PWA/mobile (T50–T51) and Phase 5 hardening (T60–T63) remain outstanding. The task descriptions below
preserve the plan as written at the time; they are not current implementation status.

## 0. Decisions fixed up front (cheap to decide now, expensive to change mid-fleet)

PRD section 3 lists defaults and allows deviation with a written justification. These are the deviations/choices
(recorded as an ADR by T00, summarised in the README by T62):

| Topic | Decision | Why |
| --- | --- | --- |
| Monorepo | pnpm workspaces, TypeScript ESM, scope `@ytw/*`, `tsc -b` project references | Same as `model-hub`; no turbo/nx |
| Web | **Fastify 5 BFF + Vite/React SPA** (not Next/SvelteKit) | Same as `model-hub`; reuses its openid-client BFF pattern; one HTTP stack for web and MCP (shared logging/metrics/auth plumbing); PWA via vite-plugin-pwa (Workbox) |
| Styling / data fetching | Tailwind 4, TanStack Query (15 s polling = "live updates") | PRD allows polling |
| OIDC | `openid-client` (confidential client, PKCE, server-side tokens) | PRD 7; works with Keycloak; used in `model-hub` |
| DB access | Plain SQL migrations (hand-written) + `pg` with the `sql` template + SQL functions (writes) and views/functions (reads); no query builder | PRD 4 demands plain SQL migrations; every write is a SECURITY DEFINER function (ADR 0001, `docs/database.md`) |
| MCP | Official TypeScript MCP SDK, Streamable HTTP, **stateless** (auth every request) on Fastify | PRD 5: DB-backed per-call permission checks rule out static YAML tooling |
| Charts | uPlot (wrapped once, in T41) | Smallest bundle; PRD 8 load budget |
| Lint / format | `tsc -b` typecheck + oxlint + prettier; vitest; Playwright | Same as `model-hub` |
| Toolchain | `.mise.toml` pins Node 24 + pnpm, tasks `dev test lint migrate build` wrap pnpm scripts. Code must also run on Node >= 22 (sandbox has 22) | PRD 9 requires mise tasks |
| Sessions | Server-side sessions in Postgres (`web_sessions`, a supporting table beyond PRD 4) | PRD 7: tokens stay server-side, 7-day PWA sessions survive restarts |
| Integration | One branch `claude/ecstatic-knuth-vfy8uh`, no PRs until the user asks | Session rules |

Names fixed here so parallel workers agree: env vars `DATABASE_URL` (the process's own app role), `MIGRATION_DATABASE_URL`,
`READONLY_DATABASE_URL` (MCP `query_sql`), `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`,
`OIDC_GROUPS_CLAIM_PATH`, `OIDC_REQUIRED_GROUP`, `SESSION_SECRET`, `SESSION_IDLE_TIMEOUT`, `SESSION_ABSOLUTE_TIMEOUT`,
`PORT`, `LOG_LEVEL`. DB roles: `ytw_web`, `ytw_mcp`, `ytw_readonly`. Image names: `ghcr.io/mirceanton/youtube-workspace-web|mcp`.
Routes: web `/auth/*`, `/api/*`, SPA fallback; MCP `/mcp`, `/files/scripts/{idea_id}/{kind}`; both `/healthz /readyz /metrics`.

## 1. Package map and ownership (T00 creates every directory as a buildable stub)

| Path | Package | Owner task(s) |
| --- | --- | --- |
| `packages/shared` | `@ytw/shared`: RESOURCES, LEVELS, IDEA_STAGES + transition table, status enums (TS + zod), per-feature API schemas under `src/api/<feature>.ts` | T00 (consts); each feature task owns its `src/api/<feature>.ts` |
| `packages/db` | `@ytw/db`: `migrations/`, runner, test harness, typed wrappers | T10 foundation; then per file, see section 3 |
| `packages/policy` | `@ytw/policy` pure permission logic | T20 |
| `packages/tokens` | `@ytw/tokens` API-token service | T21 |
| `packages/script-md` | `@ytw/script-md` front-matter/markdown file format | T22 |
| `packages/observability` | `@ytw/observability` logger, metrics, health, env loader | T23 |
| `apps/mcp` | `@ytw/mcp` MCP server + file endpoints | T30 foundation; T31-T34 add files under `src/tools/` / `src/files/` |
| `apps/web-server` | `@ytw/web-server` Fastify BFF | T40 foundation; features add `src/routes/<feature>/` |
| `apps/web-ui` | `@ytw/web-ui` Vite/React SPA/PWA | T41 shell; features add `src/features/<feature>/` |
| `e2e/` | Playwright project | T48 |
| `.github/`, `docker/` | CI/CD, Dockerfiles | T01 (+ T02 `keycloak-smoke.yaml`, T48 `e2e.yaml`) |
| `dev/keycloak/`, `docker-compose.yml`, `scripts/` | local dev env | T00 compose+pg script; T02 keycloak |
| `docs/<area>.md` | per-task doc fragments | the owning task |

## 2. Dispatch rules (orchestrator)
- Rolling schedule, **max 3 concurrent workers of any kind** (user decision, to stay inside the account's usage limit; the fleet hit it twice at 5-6 workers). Critical path first: T11 -> T14/T12 -> T21 -> T30, T40. A task starts when all its deps are *merged on the branch* and, for
  deps marked Review tier A, *review-approved*.
- Every task: implementer (worktree) -> report. Tier A tasks then get a fresh reviewer agent (opus). Blocking findings go
  back to the implementer via SendMessage; max 2 fix rounds, then escalate to the user.
- Gate tasks (T16, T35, T49, T63) are independent hardening/verification work cards and replace per-task review for that phase.
- Models (user decision): **every implementer runs on sonnet**. Opus is used only for independent tier A reviewers and the adversarial gate tasks T16, T35, T60; tier B reviews and everything else run on sonnet. (T10 and T11 were started on opus before this decision and finished there.)
- Review budget: the reviews of T11, T12, T13 and T15 are folded into the independent gate T16; T14 (tokens, permissions, sessions) keeps its own tier A review. Same pattern in phase 2: T31, T32, T33 and T34 are covered by gate T35 unless T35 is delayed.
- Status table at the bottom is updated by the orchestrator at each gate.

## 3. Shared conventions every worker follows

**Migrations** (`packages/db/migrations/NNNN_name.sql`, lexicographic, checksum-immutable once merged). Ranges so parallel
workers never collide: T10 `0001-0009`, T11 `0010-0029`, T12 `0030-0039`, T13 `0040-0049`, T14 `0050-0059`, T15 `0060-0069`,
T16 fixes `0070-0099`, T61 indexes `0100-0119`, T60 fixes `0120-0139`, anyone later `0200+` (ask orchestrator).

**DB function convention (defined by T10, followed by T12-T15).** Every mutating function is `SECURITY DEFINER`, has
`SET search_path = pg_catalog, public, pg_temp` (pg_temp LAST, so temp tables cannot hijack the function; see docs/database.md), `REVOKE EXECUTE ... FROM PUBLIC`, `GRANT EXECUTE` only to the roles that need it,
starts with `p_actor text, p_actor_type text, p_token_id uuid` and calls `ytw_set_actor(...)` so the audit trigger can write
`events`. Errors use custom SQLSTATEs (mapped to typed errors in `packages/db/src/errors.ts`): version conflict, invalid
stage transition, forbidden, not found, validation. TS wrappers return typed results and throw typed errors that carry the
LLM-readable message ("what failed + valid values / latest version").

**`packages/db/src` files** (T10 pre-creates `index.ts` re-exporting all of them as stubs, so nobody edits shared files):
`client.ts migrate.ts errors.ts` (T10), `ideas.ts scripts.ts notes.ts` (T12), `videos.ts metrics.ts experiments.ts` (T13),
`identity.ts permissions.ts tokens.ts sessions.ts` (T14), `views.ts search.ts activity.ts` (T15). Tests in `packages/db/test/<area>.test.ts`.

**Server/SPA extension points** (T40/T41 create them): `apps/web-server/src/routes/<feature>/index.ts` is auto-loaded;
`apps/web-ui/src/features/<feature>/routes.tsx` is auto-discovered via `import.meta.glob` and declares nav item +
required `{resource, level}`; `apps/mcp/src/tools/<group>.ts` exports `register()` and is auto-discovered. Adding a feature
therefore never edits a shared file. API request/response zod schemas live in `packages/shared/src/api/<feature>.ts`.

**Web contract between T40 and T41 (so they can run in parallel):** `GET /api/me` -> `{ user: {id, username, displayName, email, isAdmin}, levels: Record<Resource, 'none'|'read'|'write'> }`;
unauthenticated API call -> `401 {error}`; browser navigates to `/auth/login?return_to=` to start login, `/auth/logout` to end it;
mutations require header `X-CSRF-Token` obtained from `/api/me` response header `X-CSRF-Token`; version conflicts return `409 {error, latest}`.

**Web-server core contract (T40 implements it; feature route plugins, T41b and T42-T47, code against it so they do not wait on T40's internals).**
T40 declares it as a Fastify module augmentation in `apps/web-server/src/core/types.ts`:
`app.requireLevel(resource, 'read' | 'write')` returns a `preHandler` (401/403 using `@ytw/policy` `authorize` + `DENIAL_HTTP_STATUS`, current levels read from the DB on every request);
`request.auth = { userId, username, isAdmin, levels }`; `app.db.withActor(request, (client) => ...)` runs a transaction as the `ytw_web` role with the audit actor set from the session (actor = `preferred_username`, type human);
`app.db.pool` for plain reads. A feature plugin is `export default async function (app: FastifyInstance)` in `src/routes/<feature>/index.ts` and must put `requireLevel` on every route (T40's route-authz coverage test enforces it).
Original parallel-worker guidance before T40 merged: feature workers tested their plugin against a small fake core in `apps/web-server/test/helpers/fake-core.ts` that implemented the same augmentation with real `@ytw/policy` and the real `@ytw/db` test harness.
Oxlint's `oxc/no-async-endpoint-handlers` is a known false positive for Fastify; whoever first hits it may disable it in `.oxlintrc.json` with a one-line justification comment.
Any service that starts requiring a new env var at boot must add a placeholder to `docker/smoke.env` (the image smoke test boots the container); a package with its own coverage threshold needs its own step in the `test` job of `.github/workflows/ci.yaml`. CI cost control (T01): docs-only pushes run nothing, normal pushes run the light set (`check`, `test`), and the heavy set (image builds + Trivy, secret scan, CodeQL) runs only when relevant paths change or the **head commit message contains `[ci full]`**; gate tasks and anyone touching Docker, workflows, lockfile or security-relevant code must put `[ci full]` in their last commit and confirm the run on Actions. See `docs/ci-cd.md`.

**Testing**: vitest everywhere; integration tests hit real Postgres through the T10 harness; no mocks for the database.
UI tests: vitest + testing-library; browser flows: Playwright (T48+).

---

## 4. Task cards

Format: **ID title** · phase · model · deps · review. *Owns* = paths you may edit. *PRD* = sections to read. *Done when* = acceptance.

### Phase 0: foundations

**T00 Scaffold, conventions, ADR** · P0 · sonnet · deps: none · Review tier A
*Owns:* everything at repo root not owned elsewhere, all package/app skeletons, `CLAUDE.md`, `docs/adr/`, `scripts/pg-local.sh`, `docker-compose.yml` (postgres only), `.env.example`.
*PRD:* 3, 9 (+ skim all). Study `/home/user/mirceanton/model-hub` (package.json, pnpm-workspace.yaml, tsconfig.base.json, .mise.toml, vitest/oxlint config) and reuse its conventions.
*Do:* create the workspace per section 1 with **every** package/app as a buildable, testable stub (`src/index.ts`, `package.json`, `tsconfig`, one trivial test) wired through root `tsc -b` references; `apps/web-server` and `apps/mcp` boot a Fastify server with zod-validated env and `/healthz`; `apps/web-ui` is a Vite+React+Tailwind 4 hello page. `packages/shared` gets the real constants/enums from PRD 4/7 (resources `ideas scripts experiments videos notes activity`, `activity` max level `read`, idea stages + the allowed-transition table as data). Root scripts `dev test lint format format:check migrate build`; `.mise.toml` (node 24, pnpm, actionlint; tasks wrapping the scripts; no lockfile since mise cannot run here); pnpm-workspace hardening copied from model-hub (`minimumReleaseAge`, `allowBuilds`); `packageManager` field set; vitest limited to 2 workers. `scripts/pg-local.sh start|url|status` (idempotent; runs PG16 from `/usr/lib/postgresql/16/bin` as the `postgres` OS user on 5432; prints the admin URL; NO reset/stop for others to misuse beyond `stop`). `docker-compose.yml` with `postgres:16` + healthcheck. `.env.example` (grouped, commented). `CLAUDE.md` = repo conventions for agents (commands, package map, migration ranges, extension points, testing, sandbox notes). ADR `docs/adr/0001-stack.md` with the section 0 table and justification for deviating from PRD 3. README skeleton with headings only.
*Done when:* clean checkout: `pnpm install --frozen-lockfile && pnpm lint && pnpm test && pnpm build` green; `pnpm dev` boots web-server, mcp and web-ui; `scripts/pg-local.sh start` yields a usable URL; package versions verified with `npm view`; every package builds from root `tsc -b`.

**T01 CI/CD pipelines** · P0 · sonnet · deps: T00 · Review tier A
*Owns:* `.github/**` (except `keycloak-smoke.yaml`, `e2e.yaml`), `docker/**`, `.renovaterc.json`, `.dockerignore`.
*PRD:* 9 (Quality, Security, setup). Base it on `/home/user/mirceanton/model-hub/.github/workflows/*`, its Dockerfile and `.renovaterc.json` (recon summary: SHA-pinned actions with `# vX.Y.Z` comments, `permissions: contents: read`, `jdx/mise-action` + `mise exec --`, release = nightly cron + dispatch(dry-run) + GitHub App token + `mirceanton/action-semver-release`, docker on `release: published`, ghcr, amd64+arm64, gha cache; it has NO security scanning, NO Postgres service, NO build job, one image only; reuse what transfers, close those gaps).
*Do (as built: lint/test/build/security merged into one `ci.yaml` with cost gating; see docs/ci-cd.md):* `lint.yaml` (actionlint, lint, format:check), `test.yaml` (`services: postgres:16` with `pg_isready` healthcheck, `MIGRATION_DATABASE_URL`, run migrations + unit + integration tests, pnpm store cache), `build.yaml` (typecheck/build every package and the SPA on every PR; this is the PRD "lint, tests and a build on every pull request" gate), `security.yaml` (CodeQL JS/TS, dependency-review on PRs, `pnpm audit --audit-level=high`, Trivy fs + image scan, secret scanning step), `docker.yaml` (matrix web/mcp; `docker/web.Dockerfile`, `docker/mcp.Dockerfile`: multi-stage, non-root, `HEALTHCHECK` on `/healthz`, node 24 slim base, `pnpm deploy --prod`, `APP_VERSION`/`GIT_SHA` build args surfaced by the apps (model-hub's version stamp is broken; do not copy that bug), SBOM + provenance, tags via metadata-action; publishes only on `release: published`), `release.yaml` (as model-hub, but gated on CI success; needs repo secrets `BOT_APP_ID`/`BOT_APP_PRIVATE_KEY`, do not enable cron until the user confirms), `.renovaterc.json` extending `github>mirceanton/renovate-config//default.json5`, CODEOWNERS copied from model-hub. All push/PR workflows must also trigger on pushes to `claude/**` and `main` because there is no PR flow yet. Workflows use only SHA-pinned actions; look up current SHAs (reuse model-hub's where the same action).
*Done when:* workflows pass on GitHub Actions for the integration branch (use the `mcp__github__actions_*` tools via ToolSearch to read run results; paste run URLs/conclusions); Docker images build in CI for both targets (no publish); actionlint clean (it runs in CI, since it cannot run locally). Document secrets/settings the user must add in `docs/ci-cd.md`.

**T02 Keycloak dev realm + compose service** · P0 · sonnet · deps: T00 · Review tier B
*Owns:* `dev/keycloak/**`, keycloak service in `docker-compose.yml`, `scripts/keycloak-smoke.sh`, `.github/workflows/keycloak-smoke.yaml`.
*PRD:* 7 (Local development, OIDC), 9.
*Do:* realm export JSON: confidential client with Authorization Code + PKCE (S256), redirect URIs for local ports, a group (default `youtube-workspace-users`, matching `OIDC_REQUIRED_GROUP`), a mapper putting groups into the `groups` claim, user `owner` inside the group and `outsider` outside it (dev passwords documented, dev-only). Compose `keycloak` service (`start-dev --import-realm`, healthcheck, pinned image tag verified current). `mise run dev`/`pnpm dev:stack` brings up postgres + keycloak. Smoke script fetches the discovery document and runs a full code-flow login for both users headlessly, asserting the group claim is present/absent.
*Done when:* JSON validates; smoke workflow passes on GitHub Actions (cannot run in the sandbox, state that and link the run).

### Phase 1: data layer (useful on its own; PRD 10)

**T10 DB foundation** · P1 · sonnet · deps: T00 · Review tier A
*Owns:* `packages/db` except business tables/functions/wrappers; migrations `0001-0009`.
*PRD:* 4 (Integrity), 5 (Database roles, function convention), 9 (migrations, env).
*Do:* idempotent one-command runner (`pnpm migrate`, `MIGRATION_DATABASE_URL`, `schema_migrations` with checksums, per-file transaction, advisory lock around the whole run so parallel test DBs do not race on cluster-level roles; fails if an applied file changed). `uuid_generate_v7()` SQL function. Fixed roles `ytw_web`, `ytw_mcp`, `ytw_readonly` (created idempotently; passwords applied from env at migrate time, never committed; `ytw_readonly` has `default_transaction_read_only = on` and `statement_timeout = 10s`; **no SELECT on secret-bearing tables** `api_tokens`, `web_sessions`; default privileges such that no app role ever gets table-level INSERT/UPDATE/DELETE). Audit infra: `events` table (insert+select only; trigger blocks UPDATE/DELETE/TRUNCATE), `ytw_set_actor(actor, actor_type, token_id)`, generic `ytw_audit()` trigger function (reads `app.actor`, `app.actor_type`, `app.token_id`; skips updates that only touch `last_used_at`), `ytw_log_event(...)` function for non-DML events (tool calls, denied calls, logins). `errors.ts` with the SQLSTATE catalogue + typed errors + LLM-readable message helpers. `client.ts`: pool factory per role and `withActor(pool, actor, fn)`. Test harness `createTestDb()` (unique DB per test file, runs migrations, per-role connections, drop on teardown, safe in parallel). Pre-create stub files listed in section 3 and `index.ts`. Write `docs/database.md` (conventions the later DB tasks follow).
*Done when:* migrate twice = no-op; changed applied file is rejected; 8 parallel harness DBs migrate concurrently without role errors; catalog test proves app roles have no DML privileges and `ytw_readonly` cannot read secret tables; audit trigger test.

**T11 Core + auth schema** · P1 · sonnet · deps: T10 · Review tier A
*Owns:* migrations `0010-0029`, `packages/db/test/schema.test.ts`.
*PRD:* 4 (all tables, integrity rules, views are T15), 7 (access model).
*Do:* all 12 PRD tables + `web_sessions` (id, user_id, encrypted refresh token blob, id-token hint, created_at, last_seen_at, expires_at, absolute_expires_at); `api_tokens`, `api_token_permissions` and `web_sessions` live in schema `ytw_private`, which no app role may use (`docs/database.md`). PKs `uuid` default v7; `created_at/updated_at/created_by`; CHECK/enum for every status/type; `version int` on `ideas experiments videos`; `ideas.status_changed_at` (needed for "age in stage"); `archived_at` on ideas/videos; FKs `ON DELETE RESTRICT`; unique `(idea_id,kind,version)` on scripts, `(video_id,captured_at)` on video_metrics, `youtube_id`, `(oidc_issuer,oidc_sub)`, `(user_id,resource)`, `(token_id,resource)`; triggers making `scripts` and `video_metrics` append-only; CHECK that `activity` permission is never `write`; script body size CHECK (1 MB); `tsvector` generated columns + GIN on idea title/pitch and script body; indexes for the filters in PRD 6 (status, tags GIN, score, source); notes `entity_type` CHECK; circular `winner_variant_id` FK deferrable. Attach `ytw_audit()` to every business table.
*Done when:* constraint tests for each integrity rule (append-only, uniques, RESTRICT, CHECKs, direct DML denied for every app role, audit row emitted per insert/update).

**T12 DB functions: ideas, scripts, notes** · P1 · sonnet · deps: T11 · Review tier A
*Owns:* migrations `0030-0039`, `packages/db/src/{ideas,scripts,notes}.ts`, tests `ideas|scripts|notes.test.ts`.
*PRD:* 4 (stages, integrity), 5 (write tools create_idea, update_idea, advance_idea, save_script_version, set_script_status, add_note).
*Do:* functions `create_idea`, `update_idea(expected_version, fields)`, `advance_idea` (forward one stage; back one stage requires a note, written in the same transaction; any -> `dropped`; `dropped` -> `inbox`; everything else rejected with the valid next stages in the message; transition table must come from `@ytw/shared` data and a test must assert the SQL matches it), `archive_idea`, `save_script_version(idea_id, kind, base_version, body_md)` (next version only if base is latest else error carrying latest; first version has base 0; always inserts `draft`), `set_script_status`, `add_note` (validates the entity exists). Typed TS wrappers + error mapping.
*Done when:* table-driven test over every (from,to) stage pair; concurrent `save_script_version` with the same base -> exactly one wins, other gets the latest version number; stale `expected_version` fails; every call produces an `events` row with the right actor.

**T13 DB functions: videos, metrics, experiments** · P1 · sonnet · deps: T11 · Review tier A
*Owns:* migrations `0040-0049`, `packages/db/src/{videos,metrics,experiments}.ts`, tests.
*PRD:* 4, 5 (register_video, log_metrics, create_experiment, record_variant_stats, conclude_experiment).
*Do:* `register_video` (idea optional, unique youtube_id, clear error on duplicate), `update_video(expected_version)`, `archive_video`, `log_metrics` (append-only, idempotent on `(video_id, captured_at)`: replay of the same snapshot returns the existing row with `created=false`; a conflicting different payload for the same key is rejected with a readable error), `create_experiment` (variants atomic, exactly one control), experiment status machine planned->running->concluded|cancelled, `record_variant_stats`, `conclude_experiment` (winner must belong to the experiment; cannot conclude twice). Typed wrappers.
*Done when:* tests for idempotency, replay with a different payload, winner-ownership, status machine, optimistic concurrency, audit rows.

**T14 DB functions: identity, permissions, tokens, sessions** · P1 · sonnet · deps: T11 · Review tier A
*Owns:* migrations `0050-0059`, `packages/db/src/{identity,permissions,tokens,sessions}.ts`, tests.
*PRD:* 7 (Access model, Enforcement rules, API tokens), 5 (token auth).
*Do:* `upsert_user_on_login` (first user ever becomes admin with Write everywhere **in one transaction, race-free** via advisory lock; later users get `none` rows for every resource), `set_user_permission` (acting user must be admin; `activity` max read), `set_user_admin` (last admin cannot be demoted or removed, enforced in the DB), `create_api_token` (secret hash+prefix supplied by caller; every requested level <= the owner's *current* level, enforced in the DB too), `update_token_permissions`, `rotate_api_token`, `revoke_api_token`, `touch_token_last_used`, `lookup_token_by_hash` (returns token, owner, effective levels = min(token, owner), revoked/expired status), list functions for the settings screens, `web_sessions` create/touch/get/delete/purge-expired. Typed wrappers.
*Done when:* 20 parallel first-logins -> exactly one admin; last-admin guard; ceiling enforced at DB level; lowering the owner's level lowers `lookup_token_by_hash` output immediately; revoked/expired tokens are reported distinctly; session idle/absolute expiry semantics tested.

**T15 Views, search, activity feed** · P1 · sonnet · deps: T11 · Review tier B
*Owns:* migrations `0060-0069`, `packages/db/src/{views,search,activity}.ts`, `packages/db/test/seed.ts` (reusable seed helper), tests.
*PRD:* 4 (Views), 6 (Search, Activity, Dashboard).
*Do:* views `ideas_pipeline` (stage, latest script version per kind, age in stage), `video_performance_summary` (latest metrics + delta vs channel median via `percentile_cont`), `experiment_results` (variants side by side, CTR difference vs control, winner). `search_all(query, limit, resources[])` over idea title/pitch and script bodies (latest revision per idea+kind), returns rank + `ts_headline` snippet, restricted to the resources the caller may read. `list_events(filters, cursor)` with actor/entity_type/date filters and keyset pagination. Grants to the right roles. Typed wrappers.
*Done when:* tests with seeded data for each view, search ranking + permission restriction, event filtering/pagination; `seed.ts` can generate small and large (10k) datasets.

**T16 Phase 1 gate: adversarial DB hardening** · P1 gate · opus · deps: T12, T13, T14, T15 · gate
*Owns:* migrations `0070-0099`, `packages/db/test/gate/**`, `docs/traceability/phase1.md`.
*Do:* independent of the authors. Build a requirement->test traceability table for every PRD 4/5/7 data rule and add missing tests. Try to bypass: direct DML as each role, calling functions without EXECUTE, SQL injection via function args, search_path hijack, stage-machine fuzzing, double-submit races, audit-completeness (every mutation path writes `events`), catalog audit (all SECURITY DEFINER functions pin search_path and revoke PUBLIC; no role has DML), fresh-DB vs incremental migration equivalence. Fix defects with new migrations in `0070-0099`.
*Done when:* all green; traceability doc shows no gap; findings fixed or filed as follow-ups.

**T20 Policy layer** · P1 · sonnet · deps: T00 · Review tier A
*Owns:* `packages/policy/**`.
*PRD:* 7 (Access model, Enforcement rules, API tokens).
*Do:* pure TS, no I/O: `Level` ordering, `effectiveLevel(owner, token?)` = min, `can(principal, resource, level)`, `canGrant(ownerLevels, requestedLevels)` (token level <= owner's, `activity` max read), `hasReadOnEverything` (for `query_sql`), summary helpers, Fastify/MCP adapter *types* only. Resource list comes from `@ytw/shared` so adding an object type is one edit there (document the exact steps in `docs/policy.md`: this is the README's "add a new object type" guide).
*Done when:* table-driven tests of None/Read/Write x every resource x {user, token, token-with-lowered-owner}; 100% branch coverage enforced in vitest config.

**T22 Script markdown file format** · P1 · sonnet · deps: T00 · Review tier B
*Owns:* `packages/script-md/**`.
*PRD:* 5 (File export and import), 6 (Scripts download/upload).
*Do:* serialize/parse YAML front matter (`idea_id kind version status` + body), safe YAML (no custom tags/code), `prepareUpload(md, {ideaId, kind})` strips front matter and returns `{body, baseVersion?}`; mismatched `idea_id`/`kind` -> typed error; 1 MB limit counted in bytes; defined newline/BOM handling; filename helper. Round-trip and malicious-input tests (huge, nested, binary, CRLF, BOM, no front matter).
*Done when:* tests above green; used identically by MCP (T34) and web (T44).

**T23 Observability package** · P1 · sonnet · deps: T00 · Review tier B
*Owns:* `packages/observability/**`.
*PRD:* 9 (Observability, Security: logs/tokens).
*Do:* pino logger factory with redaction (authorization, cookie, set-cookie, tokens, secrets), Fastify request-id plugin (accepts `X-Request-Id`), actor binding in log context, prom-client registry + Fastify plugin (request rate/latency/error), `mcp_tool_calls_total{tool,token}` factory with cardinality guard, `/healthz` `/readyz` (DB ping + migrations current) route helpers, `/metrics` (optional `METRICS_TOKEN`), `loadEnv(zodSchema)` fail-fast with readable errors and a helper that renders the env table for docs (T62 uses it).
*Done when:* tests show redaction really removes secrets from emitted log lines; metrics endpoint output asserted.

### Phase 2: MCP server (useful on its own; PRD 10)

**T21 Token service** · P2 · sonnet · deps: T14, T20 · Review tier A
*Owns:* `packages/tokens/**`.
*PRD:* 7 (API tokens), 5 (Transport and auth), 9 (rate limiting).
*Do:* `generateToken()` (`ytw_` + 32 random bytes base64url; stored prefix + SHA-256 hash; secret returned once), create/rotate/revoke/update services combining `@ytw/policy` ceilings with the T14 functions, `authenticateBearer(header)` -> principal `{tokenId, tokenName, ownerId, ownerUsername, levels}` or a typed failure (missing, malformed, unknown, revoked, expired, owner removed), `touch last_used_at` throttled (<= once/min/token), in-memory failure rate limiter (per IP and per prefix, `Retry-After`), redaction helper. Never logs a secret.
*Done when:* tests for every failure mode, revocation takes effect on the next call, owner-lowering reflected, limiter behaviour, timing-safe comparison where applicable.

**T21b Admin CLI: bootstrap admin, users, tokens** · P2 · sonnet · deps: T21, T14 · Review tier B
*Owns:* new package `apps/admin-cli` (`@ytw/admin-cli`, bin `ytw-admin`, root script `pnpm ytw-admin`), `docs/admin-cli.md`. Creating the package needs its tsconfig reference in the root `tsconfig.json` and a `vitest.config.ts` (CLAUDE.md rules).
*PRD:* 7 (First user becomes admin; API tokens; Settings page equivalents), 5 (token auth), 9 (setup).
*Do:* a small, scriptable CLI that does what the web settings screens would, through the T14 database functions and the T21 token service (never raw SQL writes), connecting with `DATABASE_URL` (the `ytw_web` role): `user create --issuer --sub --username [--email] [--display-name]` (first user becomes admin; defaults issuer `local` and sub = username for a no-OIDC setup, documented), `user list`, `user set-level --as <admin> <user> <resource>=<level>`, `user set-admin`, `token create --owner <user> --name <n> --expires-in 90d|never --grant ideas=write,scripts=read,...` (levels up to the owner's, prints the secret ONCE to stdout, nothing else secret ever printed or logged), `token list|update|rotate|revoke`. Human-readable errors, `--json` output mode, non-zero exit codes. The management functions require an admin acting user: `--as <admin-username>` (document why).
*Done when:* integration tests through the db harness for the whole flow (first admin, second user starts with none, grant levels, create a token above the owner's level fails with the allowed list, rotate invalidates the old secret, revoke), secrets never appear in output besides the one-time secret, `docs/admin-cli.md` shows the exact commands to go from an empty database to a working MCP token.

**T30 MCP foundation** · P2 · sonnet · deps: T21, T23, T20 · Review tier A
*Owns:* `apps/mcp/**` except `src/tools/*.ts` group files and `src/files/**`.
*PRD:* 5 (Server, Transport and auth, Tool design rules, Database roles), 9.
*Do:* Fastify + official MCP SDK Streamable HTTP, stateless, bearer auth per request via `@ytw/tokens`, `ytw_mcp` pool, 1 MB body limit, `/healthz /readyz /metrics`, structured logs. `defineTool({name, description, input(zod), requires:{resource, level}, handler})` wrapper that: resolves principal -> checks effective level with `@ytw/policy` -> runs handler -> writes an `events` row for **every** call (success, failure and denied, with token name + id + owner) -> maps typed DB errors to LLM-readable tool errors (say what failed and the valid values / latest version). Auto-discovery of `src/tools/*.ts`. A `whoami` tool (token name, owner, effective levels). Test helper `startTestServer()` + SDK client + `createTestToken(levels)` used by T31-T35.
*Done when:* integration tests with a real MCP client: missing/invalid/revoked/expired token rejected (401, no leak); denied call returns a clear message and is audited; tool-call metric increments; rate limit on auth failures; graceful shutdown.

**T31 MCP write tools: ideas, scripts, notes** · P2 · sonnet · deps: T30, T12 · Review tier B
*Owns:* `apps/mcp/src/tools/{ideas,scripts,notes}.ts` + tests.
*PRD:* 5 (write tools table rows for ideas, scripts, notes).
*Do:* `create_idea update_idea advance_idea save_script_version set_script_status add_note`, exact signatures from the PRD table, clear descriptions, strict zod schemas, enums listed in errors.
*Done when:* per-tool None/Read/Write matrix tests, owner-lowered case, conflict error returns latest version, audit row per call.

**T32 MCP write tools: videos, experiments** · P2 · sonnet · deps: T30, T13 · Review tier B
*Owns:* `apps/mcp/src/tools/{videos,experiments}.ts` + tests.
*Do:* `register_video log_metrics create_experiment record_variant_stats conclude_experiment`. Same bar as T31 (log_metrics idempotency visible through the tool).

**T33 MCP read tools + query_sql** · P2 · sonnet · deps: T30, T15 · Review tier A
*Owns:* `apps/mcp/src/tools/{read,sql}.ts` + tests.
*PRD:* 5 (Read tools).
*Do:* structured reads, at least `list_ideas(status)`, `get_idea`, `get_script(idea_id, kind, version?)`, `list_videos`, `get_video_performance(video_id)`, `list_experiments`, `get_experiment_results`, `list_notes(entity)`, `search`, each returning only what the token can Read. `query_sql(sql)` only registered/allowed for tokens with Read on **every** object (including activity); runs on the `ytw_readonly` pool in a read-only transaction, 10 s timeout, row cap 500 with an explicit `truncated: true`, single statement, output byte cap.
*Done when:* tests prove: token with one missing Read is refused; `select * from api_tokens` / `web_sessions` fail; attempts at `pg_read_file`, `COPY ... PROGRAM`, `SET ROLE`, `lo_import`, `dblink`, multi-statement, writes and `pg_sleep(30)` all fail or time out; row cap works.

**T34 MCP file export/import** · P2 · sonnet · deps: T30, T12, T22 · Review tier A
*Owns:* `apps/mcp/src/files/**`, `apps/mcp/src/tools/export.ts` + tests.
*PRD:* 5 (File export and import).
*Do:* `export_script(idea_id, kind, version?)` tool and `GET /files/scripts/{idea_id}/{kind}` (+`?version=`) returning markdown with front matter; `PUT .../{kind}?base_version=N` with markdown body (`text/markdown`) creating a `draft` revision; same bearer auth/permission/audit path and the same service function as `save_script_version` (no duplicated logic); front-matter mismatch -> 400; stale base -> 409 with `{latest_version}`; > 1 MB -> 413; Read needed for GET, Write for PUT.
*Done when:* scripted round trip (download, edit, upload, concurrent edit conflict, re-download, merge, upload) passes through both the tool and HTTP routes; path-traversal and malformed-param tests.

**T35 Phase 2 gate: MCP conformance** · P2 gate · opus · deps: T31, T32, T33, T34, T16 · gate
*Owns:* `apps/mcp/test/gate/**`, `docs/mcp.md`, `docs/traceability/phase2.md`.
*Do:* generate the tool reference (`pnpm docs:mcp`) from the registry plus an agent integration guide (client config example, token creation steps, the file round-trip recipe). Exhaustive matrix over **every tool** x {None, Read, Write} x {owner Write, owner lowered}; revoke/expire/rotate take effect on the next call; `last_used_at` updates; audit actor = token name + id + owner; error messages are actionable; concurrency scenarios; the PRD 5 tool contract table is checked tool-by-tool. Fix defects.
*Done when:* all green; traceability shows no gap; phase 1+2 usable without any UI (agents collaborate through MCP).

**T36 Operator guide for the backend and MCP server** · P2 · sonnet · deps: T35, T21b · Review tier B
*Owns:* `README.md`, `docs/operations.md`.
*PRD:* 9 (Quality: README contents), 3 (stack deviation justification), 5.
*Do:* README with what this is, a mermaid architecture diagram (backend + MCP, web app marked as a later phase), prerequisites, local development (`scripts/pg-local.sh` or docker compose), the configuration table generated with `renderEnvTable` from the MCP server's zod env schema, running migrations (roles, passwords, the superuser bootstrap for non-superuser owners, `queryReadOnly` role notes), starting the MCP server, going from an empty database to a working token with the admin CLI, connecting an agent (client configuration example), the script download/edit/upload recipe, `query_sql` rules, security notes (METRICS_TOKEN, TLS termination in front, rate limits, log redaction), deployment (images from `docs/ci-cd.md`, migrate job command), how to add an object type (link `docs/policy.md`), and the stack-deviation justification (from the ADR). Historical instruction from the original Phase 2 scope; current README status is maintained in `README.md`.
*Done when:* a fresh worker follows the README from a clean clone and reaches a running MCP server, creates a token with the CLI and makes a successful tool call (docs-as-tests); every command in the README was executed.

### Phase 3: web UI + authentication (completed; original task plan)

**T40 Web BFF: OIDC, sessions, authz, security** · P3 · sonnet · deps: T14, T20, T23 · Review tier A
*Owns:* `apps/web-server/**` except `src/routes/<feature>/` for features (T41-T47).
*PRD:* 7 (OIDC requirements, Enforcement rules, Settings contract), 9 (Security).
*Do:* openid-client discovery, Authorization Code + PKCE (S256) + state + nonce, confidential client, ID/access token validation; **group gate** from `OIDC_GROUPS_CLAIM_PATH` (nested path, tolerate Keycloak `/group` paths) -> "access denied" page and no user row; session cookie `HttpOnly; Secure; SameSite=Lax` (Secure relaxed only on localhost), sessions in Postgres (T14) with refresh token encrypted at rest (key derived from `SESSION_SECRET`), silent refresh that re-checks the group each time, idle 8 h / absolute 7 d (configurable), RP-initiated logout that ends the provider session, `Clear-Site-Data: "cache","storage"` on logout; user upsert + first-admin via T14; `requireLevel(resource, level)` route guard reading the user's **current** levels from the DB on every request (no caching), unauthenticated -> redirect (pages) / 401 (API), "access not granted" state when every level is none; CSRF protection (Origin check + custom header/token), strict same-origin CORS, security headers (CSP, nosniff, referrer-policy, frame-ancestors, HSTS on https); `withActor` binding actor = `preferred_username`, type human; `/api/me`; static SPA serving with history fallback; auto-load `src/routes/*/index.ts`; route-authz coverage test (enumerates all Fastify routes; each must declare a guard or be on an explicit public allowlist). Tested with an in-process mock OIDC provider (e.g. `oidc-provider`).
*Done when:* tests for gate pass/fail, no user row for outsiders, refresh with group removed ends the session, logout, idle/absolute expiry, CSRF reject, first-user race, level lowered takes effect on the next request.

**T41 SPA shell, UI kit, notes widget** · P3 · sonnet · deps: T00 (original plan integrated with T40 when merged; integration complete) · Review tier B
*Owns:* `apps/web-ui/**` except `src/features/<feature>/`; `packages/shared/src/api/{session,notes}.ts`. (No server code: the `/api/notes` routes moved to T41b because they need T12's `add_note`.)
*PRD:* 6 (Behavior requirements), 8 (Mobile UX), 7 (access states).
*Do:* React 19 + react-router + Tailwind 4 + TanStack Query (15 s refetch default, pause when hidden); layout with bottom nav (phones) / sidebar (desktop), light/dark by system, WCAG AA tokens, >= 44 px targets; feature auto-discovery (nav item + required level from `routes.tsx`); auth bootstrap from `/api/me` per the contract (401 -> `/auth/login`), access-not-granted page; API client (CSRF header, error normalisation incl. 409 -> `ConflictError`); shared components: `EmptyState LoadingState ErrorState ConflictDialog (reload / merge) LastChangedBy MarkdownView (sanitized, no raw HTML, safe links) TimeSeriesChart/Sparkline (uPlot) NotesPanel (list + add; entity-typed) useOnlineStatus WriteGuard`. You define the `/api/notes` contract as zod schemas in `packages/shared/src/api/notes.ts` (`GET /api/notes?entity_type=&entity_id=` -> notes with author, actor type and timestamps; `POST /api/notes {entity_type, entity_id, body_md}` -> created note) and build `NotesPanel` against it with a mocked fetch; T41b now implements the server side. The original SPA-shell workflow developed against a mock of `/api/me` until T40 merged. Use `@ytw/shared/constants` (zod-free) in the SPA shell and import zod schemas only from code-split feature code.
*Done when:* component tests incl. markdown XSS payload corpus, conflict dialog, WriteGuard, NotesPanel against the mocked contract; app builds; integration with T40 complete (see [`docs/traceability/phase3.md`](../traceability/phase3.md)).

**T41b Notes API routes** · P3 · sonnet · deps: T40, T41, T12 · Review tier B
*Owns:* `apps/web-server/src/routes/notes/**`, tests.
*PRD:* 4 (notes), 6, 7.
*Do:* implement the `/api/notes` contract T41 defined using the T12 `add_note` wrapper and a notes read query; `requireLevel('notes', 'read' | 'write')`; entity existence check; author = session actor; the body is stored as raw markdown and rendered sanitised client-side. Runs in parallel with T42-T47.
*Done when:* route tests for authz (None/Read/Write), validation, audit actor, unknown entity.

**T42 Settings: profile, API tokens, access matrix** · P3 · sonnet · deps: T40, T41, T21 · Review tier A (authz-sensitive)
*Owns:* `apps/web-ui/src/features/settings/**`, `apps/web-server/src/routes/{settings,tokens,admin}/**`, `packages/shared/src/api/settings.ts`.
*PRD:* 7 (API tokens, Settings page), 2 (stories).
*Do:* profile + effective levels (read-only); own tokens: list (name, prefix, permission summary, created, last used, expiry), create (name, expiry default 90 d or never, per-object level offering only values <= owner's, activity None/Read only), edit permissions, rotate, revoke, secret shown once in a dialog; admin access matrix (users x objects, None/Read/Write per cell; changes immediate and audited; last-admin protection surfaced); on phones every token and every user opens as its own screen with large None/Read/Write controls.
*Done when:* server rejects over-ceiling grants and non-admin matrix writes (tests); lowering a user shows lowered effective token levels; UI tests for ceiling-restricted options; secret never re-fetchable.

**T43 Ideas** · P3 · sonnet · deps: T40, T41, T12 · Review tier B
*Owns:* `apps/web-ui/src/features/ideas/**`, `apps/web-server/src/routes/ideas/**`, `packages/shared/src/api/ideas.ts`.
*PRD:* 6 (Ideas), 2 (stories 1).
*Do:* kanban by stage (drag and drop on desktop; "Move to stage" menu / stage picker + vertical list on narrow screens), sortable table, filters (stage, tag, score, source), create/edit with optimistic-concurrency conflict UX, stage move through the DB function with a required note when moving backward, detail view (linked scripts, video, notes), archive. Routes call only `@ytw/db` functions (no duplicated rules).
*Done when:* server + UI tests for every transition error message, back-move note requirement, conflict dialog, filters/sort; guards verified (Read vs Write).

**T44 Scripts** · P3 · sonnet · deps: T40, T41, T12, T22 · Review tier B
*Owns:* `apps/web-ui/src/features/scripts/**`, `apps/web-server/src/routes/scripts/**`, `packages/shared/src/api/scripts.ts`.
*PRD:* 6 (Scripts), 5 (UI offers the same two file actions), 2 (stories 2-3).
*Do:* per idea+kind version history; diff between any two versions (side-by-side desktop, unified mobile); phone-optimised reader (comfortable line length, adjustable font size remembered locally, safe-area insets); editor = plain markdown + preview saving a **new version** with `base_version` (conflict dialog with diff, never overwrite); status control; download `.md` and upload new revision using `@ytw/script-md` with the same rules/size limit as MCP; comments via `NotesPanel`.
*Done when:* tests: reader/diff rendering, XSS-safe preview, upload mismatch/oversize/stale-base errors, concurrent edit conflict path.

**T45 Experiments** · P3 · sonnet · deps: T40, T41, T13 · Review tier B
*Owns:* `apps/web-ui/src/features/experiments/**`, `apps/web-server/src/routes/experiments/**`, `packages/shared/src/api/experiments.ts`.
*PRD:* 6 (Experiments), 2 (story 3).
*Do:* list/detail, variants side by side (impressions, CTR, difference vs control, winner badge) from `experiment_results`; CTR-over-time chart from the video's metric snapshots with experiment start/end markers (document this interpretation); create experiment, record variant stats, status changes, mark winner + conclusion.
*Done when:* tests for the winner/conclude flow, authz, empty/loading/error states.

**T46 Videos and metrics** · P3 · sonnet · deps: T40, T41, T13 · Review tier B
*Owns:* `apps/web-ui/src/features/videos/**`, `apps/web-server/src/routes/videos/**`, `packages/shared/src/api/videos.ts`.
*PRD:* 6 (Videos).
*Do:* table with latest metrics and deltas (`video_performance_summary`); detail page with time-series charts (views, CTR, avg view duration) and retention curve from `retention jsonb`; link to originating idea; register/edit video (Write on videos).
*Done when:* chart components tested with sparse/empty/large series; authz and optimistic concurrency covered.

**T47 Dashboard, Activity, Search, live updates** · P3 · sonnet · deps: T40, T41, T15 · Review tier B
*Owns:* `apps/web-ui/src/features/{dashboard,activity,search}/**`, `apps/web-server/src/routes/{dashboard,activity,search}/**`, `packages/shared/src/api/{dashboard,activity,search}.ts`.
*PRD:* 6 (Dashboard, Activity, Search, Behavior: agent changes appear without reload, last changed by).
*Do:* dashboard (ideas per stage, running experiments, latest videos with headline metrics, last 20 events), activity feed filterable by actor/entity type/date showing humans and agents equally (visible only with Read on activity), global search (results respect per-resource levels, snippets sanitized), a `since`-cursor events poll that invalidates the affected query caches within 15 s.
*Done when:* tests for each endpoint's authz, activity visibility rule, search permission filtering, and the live-update invalidation hook.

**T48 E2E harness + OIDC login against Keycloak** · P3 · sonnet · deps: T40, T41, T02, T01 · Review tier B
*Owns:* `e2e/**`, `.github/workflows/e2e.yaml`.
*PRD:* 7 (OIDC), 9 (Quality: "end-to-end test of the OIDC login against the Keycloak dev realm").
*Do:* Playwright project; CI job: compose postgres + keycloak, migrate, start web-server (+SPA) and mcp, run tests. Flows: in-group login succeeds; outsider gets "access denied" and **no `users` row**; first user is admin; second user sees "access not granted" until granted; admin grants levels; group removed in Keycloak (admin API) ends access at next refresh; logout ends the Keycloak session; token created in UI works against the MCP endpoint. `E2E_IDP=mock` mode runs the Keycloak-independent flows in the sandbox.
*Done when:* workflow green on GitHub Actions (link the run), mock mode green locally.

**T49 Phase 3 gate: end-to-end stories + web review** · P3 gate · sonnet · deps: T42-T48 · gate
*Owns:* `e2e/stories/**`, `docs/traceability/phase3.md`.
*Do:* one Playwright story per PRD section 2 user story (board drag to next stage, phone-width script read + comment, experiment compare, agent script round trip via MCP then visible in the UI within 15 s, token creation and revocation, access matrix, audit visibility), conflict UX with two sessions, route-authz coverage (every API route x None/Read/Write), review of the web tier against PRD 6/7. Fix defects across the web tier.
*Done when:* stories green (CI for Keycloak parts), traceability shows no gap.

### Phase 4: PWA and mobile

**T50 PWA** · P4 · sonnet · deps: T41, T43, T44 · Review tier A (cache/data-leak risk)
*Owns:* `apps/web-ui/{vite.config.ts pwa section, public/**, src/pwa/**}`, `scripts/gen-icons.*`.
*PRD:* 8 (Installability, Offline and caching).
*Do:* manifest (name, short_name, 192/512/maskable icons generated from one SVG, standalone, theme/background colours, `start_url` = dashboard, iOS meta + apple-touch-icon, `viewport-fit=cover`); Workbox service worker: precache the app shell, offline fallback + clear offline banner, read-through cache for recently viewed ideas and scripts only (bounded entries/age), cache **namespaced per user** and wiped on logout (SW message + server `Clear-Site-Data`); no other authenticated API caching, never serve user A's data to user B; no mutation queueing; `WriteGuard` disables write controls offline with an explanation.
*Done when:* Playwright tests: previously opened script readable offline; logout clears caches; second user on same browser never sees first user's cache; writes disabled offline; Lighthouse installability passes in CI.

**T51 Mobile UX + accessibility pass** · P4 gate · sonnet · deps: T50, T42-T47 · gate
*Owns:* cross-feature fixes in `apps/web-ui/**` (the one task allowed to), `e2e/a11y/**`, `docs/traceability/phase4.md`.
*PRD:* 6 (Behavior, a11y), 8 (Mobile UX).
*Do:* audit every screen at 360x740, 390x844 and desktop (screenshots), automated checks: touch targets >= 44 px, axe-core zero serious/critical on every route in light and dark, keyboard navigation/focus order, contrast; kanban collapses to stage picker + list; pull-to-refresh on list screens; script reader line length / font size / safe-area; reduced-motion. Fix defects.
*Done when:* automated checks run in CI and are green; remaining manual items (real iPhone Safari install) listed explicitly.

### Phase 5: hardening and release readiness

**T60 Security review and fixes** · P5 · opus · deps: T35, T49 · gate
*Owns:* fixes anywhere (new tests under `tests/security/**`), migrations `0120-0139`, `docs/security.md`.
*PRD:* 9 (Security), 7, 5.
*Do:* verify each security bullet with a test: CSP blocks injected inline script; markdown XSS corpus through every render path; CSRF; CORS; headers; rate limit on token auth failures; secrets absent from logs at debug level (token, cookie, authorization, refresh token); SQL-injection attempts across all tool/route arguments; `query_sql` escapes; `/files` traversal; 1 MB limits on both services; dependency audit gates; container scan triage; re-run catalog privilege audit after all migrations.
*Done when:* every PRD security bullet maps to a passing test or a documented, accepted gap.

**T61 Performance and scale** · P5 · sonnet · deps: T51, T35 · gate
*Owns:* `tests/perf/**`, migrations `0100-0119`, `docs/performance.md`.
*PRD:* 9 (Performance and capacity), 8.
*Do:* seed 10 000 ideas/videos and realistic metrics; measure p95 for list and detail endpoints on both services at 10 concurrent users (autocannon); `EXPLAIN`-driven indexes; N+1 hunt; web bundle budget with route-level code-splitting; Lighthouse mobile profile (4G, throttled CPU) load < 3 s.
*Done when:* p95 < 300 ms and load < 3 s demonstrated with numbers in the doc (or the gap and plan stated); perf smoke added to CI as non-gating.

**T62 Documentation** · P5 · sonnet · deps: T51 (content final), T35 · Review tier B
*Owns:* `README.md`, `docs/**` except other tasks' fragments (link, do not rewrite them).
*PRD:* 9 (Quality: README contents), 3 (stack deviation justification).
*Do:* README with setup, one-command local dev, configuration table generated from the zod env schemas, how to create an API token for a new agent, how to add a new object type to the permission matrix (from `docs/policy.md`), architecture diagram (mermaid), MCP agent guide link, deployment notes (images, env, migration job, roles), stack-deviation justification (from the ADR).
*Done when:* a fresh worker follows the README from a clean clone and reaches a running stack, creates a token and calls the MCP server (docs-as-tests); every command in the README was executed.

**T63 Initial acceptance QA (phases 0-2 only; original Phase 2 scope)** · P5 gate · sonnet · deps: T60, T61, T62 · gate
*Owns:* `docs/acceptance.md`.
*Do:* independent verification. Traceability matrix of **every** PRD requirement (goals G1-G5, stories, section 4 integrity rules, section 5 tools, section 6 rows, section 7 bullets, section 8, section 9) -> evidence (test file/command) or a gap; run the full suite from a clean clone; list what cannot be verified in the sandbox (real Keycloak realm, real iPhone, hosted CI) and what the user must configure.
*Done when:* every row is pass / not-verifiable-with-reason / gap-with-follow-up-task.

---

## 5. Dependency graph (critical path in bold)

```
T00 ─┬─ T01 CI/CD ──────────────────────────────────────────────┐
     ├─ T02 Keycloak ────────────────────────────────┐          │
     ├─ **T10 ─ T11** ─┬─ **T12 ─┐                    │          │
     │                 ├─ T13 ───┼─ T16 ─┐            │          │
     │                 ├─ **T14 ─┤       │            │          │
     │                 └─ T15 ───┘       │            │          │
     ├─ T20 ─┐                           │            │          │
     ├─ T22  │       T14+T20 ─ **T21** ─ **T30** ─ T31 T32 T33 T34 ─ T35
     └─ T23 ─┘                                                    │
   T14+T20+T23 ─ **T40** ─┬─ T42 T43 T44 T45 T46 T47 ─┬─ T48 ─ T49 ─ T50 ─ T51 ─ T60 T61 T62 ─ T63
   T00 ─ T41 ─────────────┘                            └ (T02,T01)
```
Parallel slots: after T00 -> {T01,T02,T10,T20,T22,T23}. After T11 -> {T12,T13,T14,T15}. After T14+T20 -> T21. After T21+T23 -> T30 and (with T14/T20/T23) T40 in parallel with T41. After T30+T12/T13/T15/T22 -> T31-T34. After T40+T41 -> T42-T47.

## 6. Status (updated by the orchestrator at gates)

| Phase | Gate | State |
| --- | --- | --- |
| P0 foundations | T00 + T01 + T02 | complete |
| P1 data layer | T16 | complete; see [`docs/traceability/phase1.md`](../traceability/phase1.md) |
| P2 MCP | T35 | complete; see [`docs/traceability/phase2.md`](../traceability/phase2.md) |
| P3 web | T49 | complete and merged in PR #7; see [`docs/traceability/phase3.md`](../traceability/phase3.md) |
| P4 PWA/mobile | T51 | outstanding (T50–T51) |
| P5 hardening | T63 | outstanding (T60–T63, including T62 full documentation milestone) |

Note: the PRD roadmap diagram (section 10, "5 phases, 5 gates") was an embedded image and was not in the text export; the phase
split above is inferred from the prose ("phases 1 and 2 are useful on their own: agents can collaborate through the database
before any UI exists").
