# CLAUDE.md

Conventions for coding agents (and humans) working in this repository. Read this before changing
anything; it is short on purpose and every rule here exists because parallel workers depend on it.

## What this is

A Postgres-backed workspace for one YouTube channel. AI agents read and write ideas, scripts,
packaging experiments, videos and metrics through an MCP server; the channel owner uses an
authenticated, installable web app. Both go through the same database functions, so business rules,
versioning and the audit log apply equally to humans and agents.

- Requirements: [`docs/PRD.md`](docs/PRD.md). The PRD wins over everything else on behaviour.
- Build plan, task cards and file ownership: [`docs/orchestration/PLAN.md`](docs/orchestration/PLAN.md);
  worker rules: [`docs/orchestration/PROTOCOL.md`](docs/orchestration/PROTOCOL.md).
- Architecture decisions: [`docs/adr/`](docs/adr/). Local setup for humans: [`docs/development.md`](docs/development.md).

## Commands

Run everything from the repository root unless noted.

```bash
pnpm install                     # pnpm switches itself to the version in package.json "packageManager"
pnpm dev                         # web-server :3000, mcp :3001, web-ui :5173 (watch mode, all three)
pnpm test                        # every vitest project, max 2 workers
pnpm lint                        # tsc -b (typechecks every package, tests included) + oxlint
pnpm format                      # prettier --write (format:check in CI)
pnpm build                       # tsc -b per package + vite build of the web UI
pnpm migrate                     # database migrations via @ytw/db (MIGRATION_DATABASE_URL)

pnpm --filter @ytw/db test       # one package: test | lint | build
pnpm --filter @ytw/shared exec vitest run test/idea-stages.test.ts   # one file

scripts/pg-local.sh start        # local Postgres 16 without Docker; prints the admin URL
docker compose up -d             # the same Postgres with Docker
```

`.mise.toml` pins Node 24 and pnpm and defines `mise run dev|test|lint|format|migrate|build`, each a
thin wrapper over the pnpm script of the same name. mise is not available in the agent sandbox:
run the pnpm scripts directly, and never put logic in a mise task that the pnpm script lacks.

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `packages/shared` | `@ytw/shared` | Domain constants (resources, levels, idea stages and transitions, status enums, limits) and their zod schemas; zod-free `@ytw/shared/constants`; per-feature API schemas under `src/api/<feature>.ts` |
| `packages/db` | `@ytw/db` | SQL migrations and runner, test harness, typed wrappers around the database functions |
| `packages/policy` | `@ytw/policy` | Pure permission logic shared by both services |
| `packages/tokens` | `@ytw/tokens` | API token service and bearer authentication |
| `packages/script-md` | `@ytw/script-md` | Script markdown file format (front matter + body) |
| `packages/observability` | `@ytw/observability` | Logger with redaction, metrics, health/readiness helpers, env loading |
| `apps/mcp` | `@ytw/mcp` | MCP server (Fastify) and the script file endpoints |
| `apps/web-server` | `@ytw/web-server` | Fastify backend-for-frontend: OIDC, sessions, `/api/*`, serves the built SPA |
| `apps/web-ui` | `@ytw/web-ui` | Vite + React + Tailwind 4 single-page app / PWA |
| `e2e/` | `@ytw/e2e` | Playwright end-to-end tests |
| `tests/` | `@ytw/tests` | Cross-cutting vitest suites (`tests/security/`, `tests/perf/`, `tests/workspace/`); depends on every library package |
| `scripts/` | | `pg-local.sh` and other dev scripts |
| `docs/` | | PRD, plan, ADRs, one `docs/<area>.md` per area |

Which task owns which path is in PLAN.md section 1. Stay inside the paths your task owns.

## TypeScript and packages

- ESM everywhere (`"type": "module"`). Node packages use `NodeNext` resolution, so relative imports
  end in `.js` (`import { x } from "./x.js"`). The web UI uses bundler resolution and imports
  `.ts`/`.tsx` files with their real extension.
- Strict compiler settings live in `tsconfig.base.json` (`noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`: use `import type` for types, `noUnused*`). Do not loosen them per package.
- Every package has one `tsconfig.json` with `include: ["src", "test"]` and `outDir: "dist"`, so the
  compiled entry point is `dist/src/index.js`. The root `tsconfig.json` references every package;
  `tsc -b` at the root typechecks and builds all of them, tests included.
- Depending on another workspace package takes two edits in your own package: add
  `"@ytw/x": "workspace:*"` to `package.json` and `{ "path": "../../packages/x" }` to `tsconfig.json`
  `references`. Never reach into another package with a relative path.
- Each package's `exports` map lists the `@ytw/source` condition first, pointing at the TypeScript
  source. Vitest, tsx and Vite resolve that condition, so tests and dev servers never need a build;
  plain `node dist/...` ignores it and uses the compiled output. Copy the `exports` block from an
  existing package when you create one. Per-feature API schemas are a subpath:
  `import { ... } from "@ytw/shared/api/ideas"`.
- Dependencies: tooling (`typescript`, `vitest`, `oxlint`, `prettier`, `tsx`, `@types/node`) is
  installed once at the root. Runtime dependencies go in the package that imports them. A dependency
  used by two or more packages goes in the `catalog:` section of `pnpm-workspace.yaml` and is
  referenced as `"catalog:"`. Check current versions with `npm view <pkg> version`; packages
  published less than 24 h ago are refused (`minimumReleaseAge`). A dependency that needs an install
  script must be listed under `allowBuilds`.
- Lockfile conflicts: take the incoming `pnpm-lock.yaml`, then run `pnpm install`. Never hand-merge it.
- Style: prettier (print width 100, double quotes) for code, JSON, YAML and CSS; markdown is
  hand-formatted. oxlint runs the correctness and suspicious categories as errors, bans `any`,
  `.only` and `.skip`, and accepts assertion helpers named `expect*` or `assert*` in tests. Run
  `pnpm format` and `pnpm lint` before committing.

## Domain constants

`@ytw/shared` is the single source for `RESOURCES`, `LEVELS`, `GRANTABLE_LEVELS` (activity is read at
most), `IDEA_STAGES` and the `IDEA_STAGE_TRANSITIONS` table, the status/type enums and the PRD
limits (`SCRIPT_BODY_MAX_BYTES` and friends). Import them; never repeat the literals. Where the
database mirrors one of them in a CHECK constraint or function, a test must assert they match.
The transition helpers exist for menus and error messages; the database function is the only place
that decides whether a stage move is allowed.

Bundle size: the `@ytw/shared` barrel also exports the zod schemas, so importing it pulls zod into
a bundle. The web UI shell (anything loaded before a feature route) imports values from
`@ytw/shared/constants`, which has no zod. Import zod schemas (the barrel or
`@ytw/shared/api/<feature>`) only from code-split feature code that needs them.

## Configuration

- Every setting is an environment variable; the shared names are fixed in PLAN.md section 0. Each
  app validates its environment with zod at startup (`src/env.ts`) and exits with a message listing
  every bad variable. An empty value counts as unset.
- Adding a variable: extend the app's schema and document it in `.env.example`. Any task may do
  this: append your variables at the END of the file under a `# --- <area> ---` header, without
  touching other sections. If another task appended at the same time, the rebase conflicts at the
  end of the file: keep both sides.
- `pnpm dev` starts the web server and the MCP server with the root `.env` loaded, then
  `apps/<app>/.env` on top; per-process values (`PORT`, `DATABASE_URL`) belong in the app-level
  file. The servers' dev scripts strip `MIGRATION_DATABASE_URL`, and it must never be put in `.env`.
  The Vite dev server reads only `WEB_UI_PORT` and `WEB_SERVER_URL` (from the shell or root `.env`).
- Ports: web-server 3000, mcp 3001, web-ui dev server 5173 (`WEB_UI_PORT`; proxies `/api` and
  `/auth` to `WEB_SERVER_URL`, default `http://127.0.0.1:3000`), Postgres 5432, Keycloak 8080.

## Database

- Plain SQL migrations in `packages/db/migrations/NNNN_name.sql`, applied in lexicographic order and
  checksum-immutable once merged: fix forward with a new file. Each task has its own number range
  and never uses a number outside it: T10 `0001-0009`, T11 `0010-0029`, T12 `0030-0039`,
  T13 `0040-0049`, T14 `0050-0059`, T15 `0060-0069`, T16 `0070-0099`, T61 `0100-0119`,
  T60 `0120-0139`, later work `0200+` (ask the orchestrator). PLAN.md section 3 is authoritative.
- Applications never get table-level INSERT/UPDATE/DELETE. Every mutation is a `SECURITY DEFINER`
  function (pinned `search_path`, `EXECUTE` revoked from PUBLIC and granted per role, actor
  parameters first, calls `ytw_set_actor`). Details: `docs/database.md`.
- Parameterized SQL only. Roles: `ytw_web`, `ytw_mcp`, `ytw_readonly`.

## Extension points

Adding a feature never edits a shared file:

- Web server routes: `apps/web-server/src/routes/<feature>/index.ts` (auto-loaded).
- SPA pages: `apps/web-ui/src/features/<feature>/routes.tsx` (discovered with `import.meta.glob`;
  declares its nav item and required `{ resource, level }`).
- MCP tools: `apps/mcp/src/tools/<group>.ts` exporting `register()` (auto-discovered).
- API request/response schemas: `packages/shared/src/api/<feature>.ts`.
- Database wrappers: `packages/db/src/<area>.ts` (pre-created and re-exported by `index.ts`).

The web contract between the web server and the SPA (`GET /api/me`, 401 handling, CSRF header,
409 on version conflicts) is in PLAN.md section 3.

## Testing

- Vitest everywhere. A test file is named `*.test.ts` or `*.test.tsx` and lives either in
  `<package>/test/` or next to the code it covers under `<package>/src/` (for example
  `apps/web-server/src/routes/ideas/ideas.test.ts`). Each package has a `vitest.config.ts` that
  merges `vitest.shared.ts` (source condition, include pattern, 2 workers); the root
  `vitest.config.ts` runs every `packages/*`, `apps/*`, `e2e` and `tests` project.
- Cross-cutting suites go in the root `tests/` project (`tests/security/`, `tests/perf/`), where any
  `*.test.ts` below `tests/` runs in `pnpm test`. It can import every library package
  (`@ytw/shared`, `@ytw/db`, ...). Suites too slow for every run use another suffix (for example
  `*.perf.ts`) plus their own script. Playwright specs in `e2e/` are `*.spec.ts`, which vitest ignores.
- A new package needs its own `vitest.config.ts` (copy one) and a root `tsconfig.json` reference;
  `tests/workspace/workspace.test.ts` fails when either is missing.
- Integration tests use a real Postgres through the `@ytw/db` test harness: every test file creates
  its own uniquely named database and drops it afterwards. No database mocks.
- UI tests: vitest + jsdom + Testing Library (no globals: import from `vitest`, call `cleanup` in
  `afterEach`). Browser flows: Playwright in `e2e/`.
- No skipped, focused or disabled tests, and no `TODO` stubs in shipped code.

## Security rules

Parameterized SQL only. Never log or echo secrets, tokens, cookies or `Authorization` headers. No
secrets in the repository (`.env*` is ignored except `.env.example`). Sanitize anything rendered from
agent-written markdown. Every mutating path goes through the database functions.

## Agent sandbox notes

- Node 22 and pnpm are on PATH; the code must run on Node >= 22.12 (production images use Node 24).
- mise, Docker daemons, Keycloak images and GitHub release downloads are unavailable. Keycloak flows
  are tested against an in-process mock OIDC provider here and against real Keycloak in GitHub Actions.
- Postgres: `scripts/pg-local.sh start` runs one Postgres 16 cluster (data in
  `/var/tmp/ytw-postgres-16`) shared by every worktree. Admin URL:
  `postgres://postgres:postgres@localhost:5432/postgres`. Never stop or reset it, and never drop a
  database you did not create.
- Stop every dev server or background process you start before you finish.
