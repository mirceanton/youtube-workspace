# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Postgres-backed workspace for one YouTube channel: ideas, scripts, packaging experiments, videos,
metrics, notes and an audit log. AI agents use it through an MCP server; the channel owner uses a web
app. Both go through the same database functions, so business rules, versioning and the audit log
apply equally to humans and agents. `README.md` has the user-facing description, the configuration
table and the deployment notes; read it before changing configuration.

pnpm workspace monorepo, one deployable (a single container):

- `apps/server` (`@ytw/server`): one Fastify process. Web group (`/api/*`, `/auth/*`: session cookie
  and CSRF header), agent group (`/mcp` and the script file endpoints `/files/scripts/...`: bearer
  token), shared `/healthz`, `/readyz`, `/metrics`. Serves the built SPA when `STATIC_WEB_DIR` is set.
- `apps/web` (`@ytw/web`): Vite + React + Tailwind single-page app.
- `packages/shared` (`@ytw/shared`): domain constants (resources, levels, idea stages and their
  transitions, status enums, limits) and zod schemas. `@ytw/shared/constants` is the zod-free entry.
- `packages/db` (`@ytw/db`): the SQL migration, migrator, typed wrappers around the database
  functions, and the test harness (`@ytw/db/testing`).
- `packages/policy` (`@ytw/policy`): pure permission logic (none/read/write per object).
- `packages/script-md` (`@ytw/script-md`): the script markdown file format (front matter + body).

## Commands

```bash
pnpm install
pnpm dev                 # server :3000 (tsx watch) + web :5173 (Vite, proxies /api and /auth)
pnpm build               # tsc -b per package + vite build of the web app
pnpm lint                # tsc -b (typechecks everything, tests included) + oxlint --deny-warnings
pnpm test                # vitest, every project, max 2 workers; needs Postgres (see Tests)
pnpm format              # prettier --write (format:check in CI)
pnpm migrate             # apply migrations to DATABASE_URL (the server also does it on boot)

pnpm --filter @ytw/db test                                  # one package: test | lint | build
pnpm --filter @ytw/shared exec vitest run test/idea-stages.test.ts   # one file

docker compose up -d postgres          # local Postgres 18 on 127.0.0.1:5432
docker compose --profile app up -d     # also build and run the image on :3000
```

`.mise.toml` pins Node, pnpm and actionlint; it defines no tasks. `pnpm dev` loads the root `.env`,
then `apps/server/.env` (copy `apps/server/.env.example`). Never commit `.env` files.

## Architecture

**Boot order** (`apps/server/src/index.ts`): validate the environment with zod (exit with every bad
variable listed), create the pool, run the migrations, reconcile the seeded MCP token, register the
routes, listen. A failed migration or seed aborts startup. Never print the token.

**Auth modes.** OIDC (`OIDC_*` + `SESSION_SECRET`, all-or-nothing) or single-user mode: with no
`OIDC_*` every `/api/*` request is the built-in local owner (a real `users` row, admin) and the
server logs a warning, because there is no login at all. `/mcp` and the file endpoints always
require a bearer token. The rest of the code never branches on the auth mode.

**MCP token seeding, "env wins".** `MCP_BOOTSTRAP_TOKEN` (+ `_NAME`, `_PERMISSIONS`) is reconciled on
every boot by `seedApiToken` in `@ytw/db`: created, unchanged, updated, or, for a different secret
or an unset variable, revoked (and replaced). Only the one token marked as seeded is ever touched;
tokens made in the UI are not. It is owned by a hidden system user, never expires, and only its
SHA-256 is stored.

**Permissions.** Each user and each token has none/read/write per resource; `activity` is read at
most. A token's effective level is the lower of its own and its owner's current level. `query_sql` is
offered only to tokens with read on every object and runs one statement through `queryReadOnly`.

## Database

- One pre-provisioned Postgres role (`DATABASE_URL`), which owns the database. The app never creates
  roles, sets passwords or needs a superuser; migrations run as the same role on boot. No `CREATE
  ROLE`, no `GRANT`/`REVOKE` aimed at application roles, no extensions that need a superuser.
- Migrations are plain SQL in `packages/db/migrations/NNNN_name.sql`, applied in order and
  checksum-recorded: once merged, fix forward with a new file. The baseline is `0001_init.sql`.
- Every mutation goes through a `SECURITY DEFINER` function (pinned `search_path`), so audit events,
  versioning and rules apply to humans and agents alike. The TypeScript wrappers in `packages/db/src`
  call them; there is no ad-hoc `INSERT`/`UPDATE`/`DELETE` in application code. This is a
  convention, not a privilege boundary.
- Parameterized SQL only.
- **No secret that works as a credential may be stored in Postgres.** `query_sql` runs as the same
  role as everything else and can read every table. API tokens and web session ids are stored as
  SHA-256 hashes, refresh tokens as ciphertext, and the audit log (`events`) never holds a secret.
- Where the database mirrors a shared constant (CHECK constraints, the idea stage transitions), a
  test must assert they match. The transition helpers in `@ytw/shared` only serve menus and error
  messages; the database function decides.

## Dependencies

- Tooling (`typescript`, `vitest`, `oxlint`, `prettier`, `tsx`, `@types/node`) lives at the root.
  Runtime dependencies go in the package that imports them; a dependency used by two or more
  packages goes in the `catalog:` section of `pnpm-workspace.yaml` and is referenced as `"catalog:"`.
- Depending on another workspace package takes two edits: `"@ytw/x": "workspace:*"` in
  `package.json` and a `{ "path": "../../packages/x" }` entry in `tsconfig.json` `references`.
- Packages published less than 24 h ago are refused (`minimumReleaseAge`). A dependency that needs an
  install script must be listed under `allowBuilds`.
- Lockfile conflicts: take the incoming `pnpm-lock.yaml`, then run `pnpm install`. Never hand-merge it.

## TypeScript and style

- ESM everywhere. Node packages use `NodeNext` resolution, so relative imports end in `.js`; the web
  app uses bundler resolution and imports `.ts`/`.tsx` with their real extension.
- Strict settings live in `tsconfig.base.json` (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`:
  use `import type`; `noUnused*`). Do not loosen them per package. Every package has one
  `tsconfig.json` with `include: ["src", "test"]` and `outDir: "dist"`, so the compiled entry point is
  `dist/src/index.js`; the root `tsconfig.json` references every package.
- Each package's `exports` lists the `@ytw/source` condition first (the TypeScript source). Vitest,
  tsx and Vite resolve it, so tests and dev servers never need a build; plain `node dist/...` does not.
- Import domain constants from `@ytw/shared` (`RESOURCES`, `LEVELS`, `IDEA_STAGES`, ...); never repeat
  the literals. The web shell (anything loaded before a feature route) imports from
  `@ytw/shared/constants` so zod stays out of the main bundle.
- prettier (width 100, double quotes) for code, JSON, YAML and CSS; markdown is hand-formatted.
  oxlint runs the correctness and suspicious categories as errors and bans `any`, `.only` and `.skip`.
  Run `pnpm format` and `pnpm lint` before committing.
- Comments explain why. Write code that reads like the code around it.

## Tests

Thin on purpose: a fast safety net, not a specification.

- Pure-logic unit tests for the parts with real edge cases (idea stage transitions, policy levels,
  script-md round trip, token shape, env parsing, bearer parsing, the seed-token permission parser).
- A few integration tests against a real Postgres through `createTestDb()` from `@ytw/db/testing`:
  each test file gets its own uniquely named, fully migrated database and drops it afterwards. No
  database mocks. Cover migrations, one happy path plus the key rule per business area, seed-token
  semantics, the session lifecycle and a handful of server tests (boot, bearer auth on `/mcp`, the
  web auth guard).
- A handful of web tests for the pieces that carry logic (API client, CSRF/401 handling, a form or
  hook). Not one test per component.
- No gate, fuzz, privilege, equivalence, bundle-size or coverage-threshold suites. No `.skip`,
  `.only` or `TODO` stubs. Tests live in `<package>/test/` or next to the code in `src/` and are
  named after what they prove (`*.test.ts`, `*.test.tsx`).

`createTestDb()` connects to `TEST_DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/postgres`), a superuser connection used only to create
and drop the throwaway databases. In an agent sandbox without Docker, run a local Postgres 16 (it
works with 16 and 18), point `TEST_DATABASE_URL` at it, and never drop a database you did not create.

## Security

Never log or echo secrets, tokens, cookies or `Authorization` headers; the logger redacts them, keep
it that way. No secrets in the repository (`.env*` is ignored except `.env.example`). Sanitize
anything rendered from agent-written markdown. Every mutating path goes through the database
functions.

## CI and releases

Four workflows, copied from the author's other projects: `lint.yaml` (actionlint, `pnpm lint`,
`pnpm format:check`), `test.yaml` (Postgres service container, `pnpm build`, `pnpm test`),
`release.yaml` (conventional commits to a GitHub release) and `docker.yaml` (builds and pushes the
image when a release is published). The `Dockerfile` builds with the same `pnpm` scripts; keep its
Node version in step with `.mise.toml`.
