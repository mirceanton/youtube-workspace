# Local development

How the workspace is put together and how to run it on your machine. Agent-specific conventions
are in [`CLAUDE.md`](../CLAUDE.md); the stack rationale is in [ADR 0001](adr/0001-stack.md).

## Prerequisites

- [mise](https://mise.jdx.dev), which installs the pinned Node 24 and pnpm from `.mise.toml`
  (`mise install`). Without mise: Node >= 22.12 and any recent pnpm; pnpm switches itself to the
  version in `package.json` `packageManager`.
- Postgres 16: either Docker (`docker compose up -d`) or local binaries (`scripts/pg-local.sh`).

## First run

```bash
mise install                 # optional: pinned Node and pnpm
pnpm install
cp .env.example .env         # local settings; see the comments in the file
docker compose up -d         # or: scripts/pg-local.sh start
pnpm dev
```

`pnpm dev` starts three processes in watch mode with prefixed output:

| Process | URL | Notes |
| --- | --- | --- |
| web server (`apps/web-server`) | http://localhost:3000 | `GET /healthz` |
| MCP server (`apps/mcp`) | http://localhost:3001 | `GET /healthz` |
| web UI (`apps/web-ui`) | http://localhost:5173 | Vite dev server; proxies `/api` and `/auth` to the web server |

Each server reads the root `.env` and then `apps/<app>/.env`, so settings that differ per process
(`PORT`, `DATABASE_URL`) go in the app-level file. A missing or malformed variable stops the process
at startup with a message naming it.

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm test` | All test suites (vitest projects for every package), at most two workers |
| `pnpm lint` | `tsc -b` over every package (tests included), then oxlint |
| `pnpm format` / `pnpm format:check` | prettier for code, JSON, YAML and CSS (markdown is excluded) |
| `pnpm build` | Compile every package to `dist/` and bundle the web UI |
| `pnpm migrate` | Apply database migrations with `MIGRATION_DATABASE_URL` |
| `pnpm --filter @ytw/<package> <script>` | Run `test`, `lint` or `build` for one package |

`mise run dev|test|lint|format|migrate|build` runs the same pnpm scripts.

## Postgres without Docker

`scripts/pg-local.sh` runs Postgres 16 from `/usr/lib/postgresql/16/bin` (override with `PG_BIN`)
on `localhost:5432` with the same dev credentials as `docker-compose.yml`:

```bash
scripts/pg-local.sh start    # initialise on first use, start if stopped; prints the admin URL
scripts/pg-local.sh url      # postgres://postgres:postgres@localhost:5432/postgres
scripts/pg-local.sh status   # exit 0 when running, 3 when not
scripts/pg-local.sh stop
```

`start` is idempotent and safe to call from several terminals at once. The cluster lives in
`/var/tmp/ytw-postgres-16` (`PG_LOCAL_DIR`), is shared by every checkout on the machine, and trades
durability for speed (`fsync=off`), so keep only throwaway data in it. When run as root the server
runs as the `postgres` OS user, because Postgres refuses to run as root. It also creates the
`youtube_workspace` database that `.env.example` points at.

## How packages fit together

- Every package compiles `src/` and `test/` with its own `tsconfig.json` into `dist/`; the root
  `tsconfig.json` references them all, so `tsc -b` at the root checks the whole repository.
- Workspace packages import each other by name (`@ytw/shared`). The `@ytw/source` export condition
  lets vitest, tsx and Vite load the TypeScript source directly, so you never need to build a
  dependency before testing or running in dev. Production (`node dist/src/index.js`) uses the
  compiled output.
- To add a package: copy an existing one under `packages/` (package.json with its `exports` block,
  tsconfig.json, vitest.config.ts, `src/index.ts`, `test/`), then add it to the root
  `tsconfig.json` references. The root vitest config and pnpm workspace pick it up automatically.
