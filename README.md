# YouTube Workspace

Headless content operations workspace and Model Context Protocol (MCP) server for a YouTube channel, built for autonomous AI agents collaborating with human channel operators.

> [!NOTE]
> **Phases 0–2 Delivered:** The core database layer, integrity constraints, audit subsystem, RBAC policy engine, token service, Admin CLI, and full MCP server (Phases 0–2) are implemented and verified. The Web UI and browser-facing BFF (Phases 3–4) are deferred by architectural decision; human operators manage access and tokens via the Admin CLI, while agents collaborate via MCP.

---

## Features

- **Autonomous Agent Collaboration via MCP:** Fastify-based Model Context Protocol server over Streamable HTTP with stateless Bearer token authentication per request.
- **Strict Role-Based Access Control:** Fine-grained `none`, `read`, or `write` permissions across workspace objects (`ideas`, `scripts`, `experiments`, `videos`, `notes`, `activity`), enforced by `@ytw/policy` with token owner privilege ceilings.
- **Database-Level Integrity & Invariants:** PostgreSQL 16 `SECURITY DEFINER` functions enforce idea stage state machines (`inbox → shortlisted → scripting → filming → editing → published`), optimistic version concurrency, and append-only constraints for scripts and video metrics.
- **Immutable Audit Trail:** Every mutating action and tool invocation writes an immutable record to the `events` table with actor identity, action type, entity ID, and payload.
- **Script File Export & Import:** Bidirectional synchronization between MCP tools and HTTP file routes (`GET/PUT /files/scripts/:idea_id/:kind`) using canonical YAML front matter markdown with conflict detection.
- **Safe SQL Analytics:** Read-only `query_sql` MCP tool running on a dedicated transaction-isolated role with a 10-second hard statement timeout, 500-row cap, and 1 MB payload limit.
- **Operator Admin CLI:** Headless management CLI (`ytw-admin`) for bootstrapping initial administrators, granting collaborator privileges, and issuing/rotating agent API tokens.
- **Production Observability:** Pino structured JSON logging with automatic secret redaction (bearer tokens, session cookies), `/healthz` and `/readyz` probes, and Prometheus `/metrics`.

---

## Architecture

```mermaid
flowchart TD
    subgraph Agents["AI Agents & Tools"]
        Claude["Claude Desktop / Cursor"]
        ScriptBot["Script Generation Agent"]
        AnalyticsBot["Analytics Agent"]
    end

    subgraph Operator["Operator Tooling"]
        AdminCLI["Admin CLI (ytw-admin)"]
    end

    subgraph MCPService["MCP Server (:3001)"]
        StreamableHTTP["Streamable HTTP (/mcp)"]
        FileRoutes["File Routes (/files/scripts/...)"]
        HealthMetrics["/healthz · /readyz · /metrics"]
        AuthRateLimit["Bearer Auth & Rate Limiter (@ytw/tokens)"]
        PolicyCheck["Policy Check (@ytw/policy)"]
        Tools["Tool Registry (Write / Read / query_sql)"]
    end

    subgraph FuturePhase["Deferred (Phases 3–4)"]
        WebBFF["Fastify Web BFF (:3000)"]
        WebSPA["React Single Page App (:5173)"]
    end

    subgraph Database["PostgreSQL 16 Cluster"]
        subgraph Roles["Least-Privilege Roles"]
            ytw_mcp["ytw_mcp"]
            ytw_web["ytw_web"]
            ytw_readonly["ytw_readonly"]
        end
        subgraph Storage["Storage & Logic"]
            Tables["public (ideas, scripts, videos, experiments, notes, events)"]
            PrivateTables["ytw_private (api_tokens, permissions, sessions)"]
            SecDef["SECURITY DEFINER Functions (Pinned search_path)"]
            Views["Views (ideas_pipeline, video_performance_summary, ...)"]
        end
    end

    Claude -->|"Streamable HTTP (Bearer token)"| StreamableHTTP
    ScriptBot -->|"GET / PUT Markdown"| FileRoutes
    AnalyticsBot -->|"query_sql (Read-only)"| StreamableHTTP
    AdminCLI -->|"DATABASE_URL (ytw_web)"| SecDef

    StreamableHTTP --> AuthRateLimit --> PolicyCheck --> Tools
    FileRoutes --> AuthRateLimit --> PolicyCheck

    Tools -->|"Pool (ytw_mcp)"| SecDef
    Tools -->|"Pool (ytw_readonly)"| Views
    FileRoutes -->|"Pool (ytw_mcp)"| SecDef

    SecDef --> Tables
    SecDef --> PrivateTables
    SecDef -->|"Audit event"| Tables
```

---

## Getting Started

### Prerequisites

- **Node.js:** `>= 22.12.0` (v24.x recommended, pinned via `.mise.toml`).
- **pnpm:** `12.8.1` (declared via `packageManager`).
- **PostgreSQL 16:** Local binaries or Docker container.
- **mise (optional):** For toolchain version management (`mise install`).

### Local Development Setup

1. **Clone and install dependencies:**
   ```bash
   pnpm install
   ```

2. **Start PostgreSQL:**
   You can run PostgreSQL via Docker Compose:
   ```bash
   docker compose up -d postgres
   ```
   Or use the local script (if PostgreSQL 16 binaries are installed locally):
   ```bash
   scripts/pg-local.sh start
   ```

3. **Run database migrations:**
   ```bash
   MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/youtube_workspace" \
     pnpm migrate
   ```

4. **Bootstrap the administrator and create an agent token:**
   ```bash
   # Bootstrap first user (automatically becomes admin)
   DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
     pnpm ytw-admin user create --username owner --email owner@channel.local

   # Generate an API token for an AI agent
   DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
     pnpm ytw-admin token create \
       --owner owner \
       --name "my-agent" \
       --grant ideas=write,scripts=write,videos=read,notes=write \
       --expires-in 90d
   ```
   *Note: Save the token secret displayed in stdout (e.g. `ytw_abc...`).*

5. **Start the MCP Server:**
   ```bash
   DATABASE_URL="postgres://ytw_mcp:ytw-mcp-dev-password@localhost:5432/youtube_workspace" \
   READONLY_DATABASE_URL="postgres://ytw_readonly:ytw-readonly-dev-password@localhost:5432/youtube_workspace" \
   PORT=3001 \
     pnpm --filter @ytw/mcp run dev
   ```

6. **Verify server health:**
   ```bash
   curl http://localhost:3001/healthz
   curl http://localhost:3001/readyz
   ```

---

## Configuration

All configuration is supplied via environment variables and validated at runtime with Zod schemas.

### MCP Server Environment Variables

The table below is generated from `envSchema` in [`apps/mcp/src/env.ts`](apps/mcp/src/env.ts):

| Variable | Required | Default | Values | Description |
| --- | --- | --- | --- | --- |
| `HOST` | no | `0.0.0.0` | string | Interface to listen on. |
| `PORT` | no | `3001` | integer 0 to 65535 | Port to listen on. |
| `LOG_LEVEL` | no | `info` | one of fatal, error, warn, info, debug, trace, silent | Minimum level written to the log. |
| `APP_VERSION` | no | `0.0.0-dev` | string | Release version shown on /healthz; container builds set it. |
| `GIT_SHA` | no | `unknown` | string | Git commit shown on /healthz; container builds set it. |
| `METRICS_TOKEN` | no |  | string, at least 16 characters | When set, GET /metrics requires `Authorization: Bearer <token>`. Set it whenever /metrics is reachable beyond a private network: unset, the endpoint is open. |
| `DATABASE_URL` | no | `postgres://ytw_mcp:ytw_mcp@localhost:5432/youtube_workspace` | URL | PostgreSQL connection string for the ytw_mcp application role. |
| `READONLY_DATABASE_URL` | no |  | URL | PostgreSQL connection string for the ytw_readonly role (used by query_sql). |

---

## Database and Migrations

### Roles & Security Model

The database enforces strict least privilege:
- `ytw_web`: Used by the web backend and Admin CLI. Has `SELECT` on users and permissions, and `EXECUTE` on identity management functions.
- `ytw_mcp`: Used by the MCP server for workspace operations. Has `SELECT` on workspace views/tables and `EXECUTE` on tool business functions.
- `ytw_readonly`: Dedicated read-only role with `default_transaction_read_only = on` and execution limited to read queries.
- **Zero Table DML:** No application role has `INSERT`, `UPDATE`, `DELETE`, or `TRUNCATE` privileges on any table. All writes occur inside `SECURITY DEFINER` functions that pin `search_path = pg_catalog, pg_temp`.

### Migrations

Migrations are stored in [`packages/db/migrations/`](packages/db/migrations/) and managed by the `@ytw/db` runner.
```bash
MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/youtube_workspace" \
  pnpm migrate
```
The migration runner:
- Acquires an exclusive cluster advisory lock (`pg_advisory_lock(714209142)`).
- Provisions roles and executes sequential migration scripts inside transactions.
- Records executed migrations in `schema_migrations`.
- Verifies catalog integrity via `ytw_catalog_violations()`.

---

## Agents (MCP)

### Connecting AI Clients

#### Claude Desktop
Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "youtube-workspace": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer ytw_YOUR_TOKEN_SECRET"
      }
    }
  }
}
```

#### Cursor
In Cursor Settings -> Features -> MCP Servers:
- **Type:** `command` or `sse/http`
- **URL:** `http://localhost:3001/mcp`
- **Headers:** `Authorization: Bearer ytw_YOUR_TOKEN_SECRET`

### Script Markdown Export & Import

Agents can edit scripts as local files:
- **Export:** Call the `export_script` tool or `GET /files/scripts/:idea_id/:kind` to receive markdown with canonical front matter:
  ```markdown
  ---
  idea_id: 01a10214-cee3-74c2-9922-aa65ca267bfa
  kind: script
  version: 2
  status: draft
  ---
  # Script Body
  ...
  ```
- **Import:** Call `save_script_version` or `PUT /files/scripts/:idea_id/:kind?base_version=2` with the edited markdown.
- **Conflict Handling:** If another edit succeeded in the meantime, the server rejects the request with HTTP `409 Conflict` (or an MCP tool error) returning `{ latest_version: 3 }`, enabling the agent to re-fetch, merge, and retry.

### Safe SQL Analytics (`query_sql`)

The `query_sql` tool provides read-only SQL querying under strict constraints:
- Available only to tokens holding `read` permission on **every** workspace resource.
- Runs exclusively on the `ytw_readonly` connection pool.
- Enforces `BEGIN READ ONLY` and `SET LOCAL statement_timeout = '10s'`.
- Hard output row cap (500 rows with `truncated: true`) and 1 MB payload limit.
- Multi-statement execution and access to private tables are blocked.

---

## Access Control

### Permission Matrix

Every user and API token has an access level of `none`, `read`, or `write` per resource:
- `ideas` (inbox, pipeline, pitch)
- `scripts` (script and packaging markdown versions)
- `experiments` (A/B titles, thumbnails, hypotheses, variants, results)
- `videos` (published videos and time-series metrics)
- `notes` (comments on ideas, scripts, videos, experiments)
- `activity` (immutable audit feed; allows `none` or `read` only)

A token's effective access is always the minimum of its granted level and its owner's current access level (`effectiveLevel(owner, token)`). Lowering an owner's access immediately lowers all their tokens.

### Adding a New Object Type

To add a new object type to the workspace:
1. Update `RESOURCES` in [`packages/shared/src/constants.ts`](packages/shared/src/constants.ts).
2. Create a database migration adding the table and permission checks.
3. The TypeScript compiler (`tsc -b`) will enforce updates across all policy checks, tool definitions, and CLI arguments.
4. See [`docs/policy.md`](docs/policy.md) for full instructions.

---

## Web App (Deferred)

The Web UI (React single-page application) and Web BFF (OIDC authentication, cookie sessions) are defined in PRD Section 6 and 7, but are **explicitly deferred** to subsequent development phases.

In the current release, all administration is handled via the Admin CLI, and all agent tasks run via the MCP server.

---

## Testing

The workspace enforces complete end-to-end and integration testing against real PostgreSQL databases without database mocks:
- `pnpm test`: Runs Vitest across all workspace packages and gate test suites.
- `pnpm lint`: Runs `tsc -b` and `oxlint --deny-warnings`.
- `pnpm format:check`: Validates formatting with Prettier.

---

## Deployment

Container images are built and pushed to GitHub Container Registry:
- `ghcr.io/mirceanton/youtube-workspace-mcp`: Headless MCP Server.

### Running Migrations in Production
Run the database migration as a one-shot container or pre-deploy job:
```bash
docker run --rm \
  -e MIGRATION_DATABASE_URL="postgres://postgres:${PG_SUPERUSER_PASSWORD}@postgres:5432/youtube_workspace" \
  ghcr.io/mirceanton/youtube-workspace-mcp:latest \
  pnpm migrate
```

---

## Stack and Design Decisions

Key deviations from PRD Section 3 defaults are documented with written justifications in [ADR 0001: Technology Stack](docs/adr/0001-stack.md):
- **Fastify 5 over Next.js/SvelteKit:** Provides a unified HTTP stack for the MCP server and web server with shared logging, metrics, and authentication primitives.
- **Official TypeScript MCP SDK over Static YAML:** Dynamic, database-backed RBAC checks on every call require programmatic handler execution rather than static definitions.
- **Database Functions over Query Builders:** Concurrency invariants (optimistic locks, stage transition validation, immutable audit logs) are enforced atomically within Postgres `SECURITY DEFINER` transactions.

---

## License

Private repository. All rights reserved.
