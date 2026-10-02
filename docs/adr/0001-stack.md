# ADR 0001: Technology stack

- Status: accepted
- Date: 2026-10-01

## Context

PRD section 3 recommends a stack and allows the implementation to deviate "with a short written
justification". The build is split across many parallel workers, so the stack, the shared names and
the repository mechanics have to be fixed before any feature work starts. The owner's existing
project `model-hub` (Fastify + Vite/React + openid-client, pnpm monorepo, mise, oxlint, vitest)
is the reference for conventions.

## Decision

| Topic | Decision | PRD 3 default | Why |
| --- | --- | --- | --- |
| Monorepo | pnpm workspaces, TypeScript ESM, package scope `@ytw/*`, `tsc -b` project references; no turbo/nx | TypeScript monorepo | Same as `model-hub`; ten small packages do not need a task runner |
| Web | **Fastify 5 backend-for-frontend + Vite/React single-page app** | Next.js or SvelteKit | One HTTP stack for the web server and the MCP server (shared logging, metrics, auth plumbing); reuses `model-hub`'s openid-client BFF pattern; the SPA is a static bundle the BFF serves, which keeps the PWA service worker simple |
| PWA | vite-plugin-pwa (Workbox) | PWA plugin or Workbox | Matches the PRD |
| Styling, data fetching | Tailwind CSS 4, TanStack Query with 15 s polling | Tailwind | The PRD accepts polling for live updates |
| OIDC | `openid-client` (confidential client, Authorization Code + PKCE, tokens server-side) | Auth.js or openid-client | Works with Keycloak; used in `model-hub` |
| Database access | Hand-written SQL migrations; `pg` (node-postgres) with a `sql` template that binds every value; writes are SQL functions, reads are SQL views and functions; no query builder | Drizzle or Kysely + plain SQL migrations | Every write is a `SECURITY DEFINER` function and the reads are views or functions, so a query builder would only mirror the SQL schema in TypeScript (revised by T10; `docs/database.md`) |
| MCP | Official TypeScript MCP SDK, Streamable HTTP, stateless (authenticate every request), mounted on Fastify | MCP Toolbox (YAML) or the TypeScript SDK | Per-call, database-backed permission checks rule out static YAML tool definitions (PRD 5 says the same) |
| Charts | uPlot, wrapped once | Recharts or uPlot | Smallest bundle for the PRD 8 load budget |
| Lint, format, tests | `tsc -b` typecheck, oxlint, prettier; Vitest; Playwright | Vitest, Playwright | Same as `model-hub` |
| Toolchain | `.mise.toml` pins Node 24 and pnpm; tasks `dev test lint format migrate build` wrap the pnpm scripts; code also runs on Node >= 22.12 | `mise.toml` with those tasks | PRD 9; mise reads `.mise.toml` and `mise.toml` identically, and the dotfile matches `model-hub` |
| Sessions | Server-side sessions in Postgres (`web_sessions`, a table beyond PRD 4) | not specified | Tokens stay server-side (PRD 7) and 7-day PWA sessions survive restarts |

Names fixed for every worker: environment variables `DATABASE_URL` (the process's own role),
`MIGRATION_DATABASE_URL`, `READONLY_DATABASE_URL`, `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI`, `OIDC_GROUPS_CLAIM_PATH`, `OIDC_REQUIRED_GROUP`,
`SESSION_SECRET`, `SESSION_IDLE_TIMEOUT`, `SESSION_ABSOLUTE_TIMEOUT`, `PORT`, `LOG_LEVEL` (plus
`HOST`, `APP_VERSION`, `GIT_SHA` added by the scaffold); database roles `ytw_web`, `ytw_mcp`,
`ytw_readonly`; images `ghcr.io/mirceanton/youtube-workspace-web` and `-mcp`; routes `/auth/*`,
`/api/*` and the SPA fallback on the web server, `/mcp` and `/files/scripts/{idea_id}/{kind}` on the
MCP server, and `/healthz`, `/readyz`, `/metrics` on both.

## Shared domain decisions

- **Note targets.** `NOTE_ENTITY_TYPES` in `@ytw/shared` is `idea, script, video, experiment`.
  PRD 4 allows notes on "any entity"; these four are the entities that exist. A later task may
  extend the list by editing `@ytw/shared` and the `notes.entity_type` CHECK constraint together,
  with the test that asserts they match.
- **Bundle size.** The `@ytw/shared` barrel exports the zod schemas next to the constants, so
  importing it pulls zod (about 70 kB minified) into a bundle. `@ytw/shared/constants` exposes the
  same values, types and helpers without zod, and a test keeps it zod-free. The web UI shell imports
  only from that entry point; zod schemas are imported only by code-split feature code that
  validates data. This took the hello page from 293 kB (89 kB gzip) to 221 kB (69 kB gzip).

## Repository mechanics

- Each package compiles `src` and `test` with one `tsconfig.json` into `dist/`, and the root
  `tsconfig.json` references every package, so a single `tsc -b` typechecks the whole repository,
  tests included.
- Package `exports` maps start with a custom `@ytw/source` condition that points at the TypeScript
  source. Vitest, tsx and Vite enable it, so tests and dev servers run without building
  dependencies first, while `node dist/...` in production resolves the compiled JavaScript.
- Build and test tooling is installed once at the root; runtime dependencies shared by several
  packages are pinned through the pnpm `catalog:`. pnpm refuses packages younger than 24 hours and
  runs install scripts only for allow-listed packages (`minimumReleaseAge`, `allowBuilds`, as in
  `model-hub`).
- Vitest runs every package as a project of one root run, capped at two workers, because several
  agents share a 4-CPU machine and one Postgres cluster. Tests may sit in `test/` or next to the
  code in `src/`; cross-cutting suites live in the root `tests/` project.

## Consequences

- One server framework, one logger and one metrics stack for both processes; the web UI is a static
  bundle with no server rendering. SEO and server components are irrelevant for a private app.
- Business rules live in Postgres functions, so the web server and the MCP server cannot drift.
- There is no Next.js-style file router: the web server and the SPA use explicit, auto-discovered
  extension points (`src/routes/<feature>/`, `src/features/<feature>/`) instead.
- Migrations are hand-written SQL and TypeScript calls functions and views through the `sql`
  template, so schema review happens in SQL only; there is no TypeScript schema to keep in step.

## Alternatives considered

- **Next.js or SvelteKit**: one framework for UI and BFF, but a second HTTP stack next to the MCP
  server, and server rendering the app does not need.
- **MCP Toolbox with YAML tools**: cannot express per-token, per-object permission checks.
- **Drizzle or Kysely for typed reads** (the PRD 3 default, and the first version of this ADR):
  with every write a function and the reads views or functions, a query builder adds a second,
  mirrored schema without removing any SQL. A later task can still wrap the same `pg` pool with
  `drizzle-orm/node-postgres` if typed ad-hoc reads become common.
- **Recharts**: richer API, several times the bundle size of uPlot.
