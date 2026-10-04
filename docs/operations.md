# Operator Guide for Backend & MCP Server

This guide provides operational instructions for running, administering, and monitoring the YouTube Workspace backend and Model Context Protocol (MCP) server.

> [!NOTE]
> Phases 0–3, including the Web UI and browser-facing BFF, are implemented. Phase 3 CI and hosted Keycloak end-to-end checks passed in [PR #7](https://github.com/mirceanton/youtube-workspace/pull/7); see the [acceptance report](acceptance.md) and [Phase 3 traceability](traceability/phase3.md). This documents implementation and CI validation, not production deployment. Phase 4 PWA and offline support remain deferred. Operators and agents can continue to use the Admin CLI and MCP server.

---

## 1. System Architecture

```mermaid
flowchart TD
    subgraph Agents["AI Agents & Automation"]
        Claude["Claude Desktop / Cursor"]
        ScriptAgent["Script Writing Agent"]
        AnalyticsAgent["Analytics Agent"]
    end

    subgraph Operator["Operator / Admin"]
        AdminCLI["Admin CLI (ytw-admin)"]
    end

    subgraph MCPService["MCP Server (Fastify HTTP)"]
        StreamableHTTP["Streamable HTTP (/mcp)"]
        FileEndpoints["File Routes (/files/scripts/...)"]
        HealthMetrics["/healthz · /readyz · /metrics"]
        AuthLayer["Token Auth & Rate Limiter (@ytw/tokens)"]
        PolicyLayer["Policy Engine (@ytw/policy)"]
        ToolRegistry["Tool Registry (Write / Read / SQL)"]
    end

    subgraph Database["PostgreSQL 16 Cluster"]
        direction TB
        subgraph Roles["Application Roles (Least Privilege)"]
            RoleMCP["ytw_mcp (EXECUTE on business functions)"]
            RoleWeb["ytw_web (EXECUTE on admin/web functions)"]
            RoleRO["ytw_readonly (SELECT views/tables, read-only pool)"]
        end
        subgraph Storage["Database Schema"]
            PublicTables["public (ideas, scripts, videos, experiments, notes, events)"]
            PrivateTables["ytw_private (api_tokens, permissions, sessions)"]
            Views["views (ideas_pipeline, video_performance_summary, ...)"]
            SecDefFunctions["SECURITY DEFINER functions (pinned search_path)"]
        end
    end

    Claude -->|"Streamable HTTP (Bearer token)"| StreamableHTTP
    ScriptAgent -->|"GET/PUT Markdown"| FileEndpoints
    AnalyticsAgent -->|"query_sql (Read-only)"| StreamableHTTP
    AdminCLI -->|"DATABASE_URL (ytw_web)"| SecDefFunctions

    StreamableHTTP --> AuthLayer --> PolicyLayer --> ToolRegistry
    FileEndpoints --> AuthLayer --> PolicyLayer

    ToolRegistry -->|"Pool (ytw_mcp)"| SecDefFunctions
    ToolRegistry -->|"Pool (ytw_readonly)"| Views
    FileEndpoints -->|"Pool (ytw_mcp)"| SecDefFunctions

    SecDefFunctions --> PublicTables
    SecDefFunctions --> PrivateTables
    SecDefFunctions -->|"Audit append"| PublicTables
```

### Component Roles & Boundaries

| Component | Role | Security Boundary |
| --- | --- | --- |
| **PostgreSQL 16** | Single source of truth. Enforces data integrity, state transitions, version concurrency, and audit logs. | Application roles have **zero direct DML** (`INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`) on any table. All mutations run through `SECURITY DEFINER` functions with fixed `search_path = pg_catalog, pg_temp`. |
| **MCP Server (`apps/mcp`)** | Headless agent interface implementing the Model Context Protocol over Fastify Streamable HTTP. | Stateless authentication per request via Bearer API tokens. Enforces token object permissions and owner privilege ceilings via `@ytw/policy`. |
| **Admin CLI (`@ytw/admin-cli`)** | Operator tooling (`ytw-admin`) for bootstrapping initial users, modifying access levels, and generating agent tokens without a browser. | Connects as `ytw_web` role. Mutations invoke admin-only database functions requiring an acting admin username (`--as <admin>`). |
| **Observability (`@ytw/observability`)** | Structured JSON logging, secret redaction, and Prometheus metrics. | Automatically redacts API tokens, secrets, cookies, and authorization headers from logs. |

---

## 2. Prerequisites & Environment

- **Node.js:** `>= 22.12.0` (v24.x recommended, pinned via `.mise.toml`).
- **Package Manager:** `pnpm 12.8.1`.
- **Database:** PostgreSQL 16.
- **Tooling:** Docker / Docker Compose (for containerized local dev or production) or `mise`.

### Toolchain Setup with mise
```bash
mise install
pnpm install
```

---

## 3. Database Administration & Migrations

### Database Roles & Privileges

The database uses three fixed application roles created during migration:
- `ytw_web`: Role used by administrative tooling and the web backend. Has `SELECT` on users/permissions and `EXECUTE` on user administration routines.
- `ytw_mcp`: Role used by the MCP server. Has `SELECT` on business tables/views and `EXECUTE` on workspace tools.
- `ytw_readonly`: Role strictly limited to read-only queries with `default_transaction_read_only = on`. Used exclusively by the `query_sql` MCP tool with an enforced `statement_timeout = '10s'`.

### Running Migrations

Migrations require a privileged superuser connection string (`MIGRATION_DATABASE_URL`):

```bash
# Example against local Docker Postgres
MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/youtube_workspace" \
  pnpm migrate
```

Key migration properties:
1. **Cluster-wide Advisory Lock:** Migrations obtain `pg_advisory_lock(714209142)` to ensure concurrent workers or container restarts never race.
2. **Idempotent:** Safe to run repeatedly against an existing database.
3. **Role Password Management:** In development, default passwords match `.env.example`. In production, roles are assigned passwords via `YTW_WEB_PASSWORD`, `YTW_MCP_PASSWORD`, and `YTW_READONLY_PASSWORD`.

---

## 4. MCP Server Configuration

Configuration is loaded from environment variables and strictly validated at process start using Zod. The table below is rendered directly from `envSchema` in `apps/mcp/src/env.ts`:

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

## 5. Quickstart: Empty Database to Running Agent

Follow these steps to bootstrap the system from scratch:

### Step 1: Start PostgreSQL
```bash
docker compose up -d postgres
# Wait for healthy state
docker compose ps
```

### Step 2: Apply Migrations
```bash
MIGRATION_DATABASE_URL="postgres://postgres:postgres@localhost:5432/youtube_workspace" \
  pnpm migrate
```

### Step 3: Bootstrap First Administrator
In any empty database, the very first user created automatically becomes an administrator with full write access to all workspace objects (PRD 7):

```bash
DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
  pnpm ytw-admin user create \
    --username owner \
    --email owner@channel.local \
    --display-name "Channel Owner"
```

### Step 4: Issue an API Token for an AI Agent
Generate a scoped token for an agent. In this example, the agent is granted write access to ideas and scripts, and read access to videos and notes:

```bash
DATABASE_URL="postgres://ytw_web:ytw-web-dev-password@localhost:5432/youtube_workspace" \
  pnpm ytw-admin token create \
    --owner owner \
    --name "writer-agent" \
    --grant ideas=write,scripts=write,videos=read,notes=read \
    --expires-in 90d
```

> [!IMPORTANT]
> The secret (e.g. `ytw_abc123...`) is printed **only once**. Store it securely. The database only stores a SHA-256 hash and a prefix for identification.

### Step 5: Start the MCP Server
```bash
DATABASE_URL="postgres://ytw_mcp:ytw-mcp-dev-password@localhost:5432/youtube_workspace" \
READONLY_DATABASE_URL="postgres://ytw_readonly:ytw-readonly-dev-password@localhost:5432/youtube_workspace" \
PORT=3001 \
  pnpm --filter @ytw/mcp run dev
```

### Step 6: Verify Server Health
```bash
curl http://localhost:3001/healthz
# Response: {"status":"ok","service":"mcp","version":"0.0.0-dev","commit":"unknown"}

curl http://localhost:3001/readyz
# Response: {"status":"ready","database":"connected","migrations":"current"}
```

---

## 6. Connecting AI Agents

### Claude Desktop Configuration
Add the server to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "youtube-workspace": {
      "url": "http://localhost:3001/mcp",
      "headers": {
        "Authorization": "Bearer ytw_YOUR_TOKEN_SECRET_HERE"
      }
    }
  }
}
```

### Cursor Configuration
In Cursor Settings -> Features -> MCP Servers:
- **Name:** `youtube-workspace`
- **Type:** `command` or `sse/http`
- **URL:** `http://localhost:3001/mcp`
- **Headers:** `Authorization: Bearer ytw_YOUR_TOKEN_SECRET_HERE`

### Agent Self-Discovery
Agents can call the `whoami` tool to verify their active identity, token name, token ID, owner, and effective permissions across all resources.

---

## 7. Script File Export & Import Recipe

Agents can collaborate on scripts either through structured MCP tools or as local markdown files via HTTP endpoints.

### Workflow:
1. **Export / Download:**
   - MCP Tool: Call `export_script({ idea_id: "...", kind: "script" })`.
   - HTTP Route: `GET /files/scripts/:idea_id/:kind?version=N` with `Authorization: Bearer <token>`.
   - The returned document contains canonical YAML front matter:
     ```markdown
     ---
     idea_id: 01a10214-cee3-74c2-9922-aa65ca267bfa
     kind: script
     version: 3
     status: draft
     ---
     # Video Hook
     Welcome to the video...
     ```
2. **Local Editing:**
   - The agent edits the markdown body locally.
3. **Import / Upload:**
   - MCP Tool: `save_script_version({ idea_id: "...", kind: "script", base_version: 3, body_md: "..." })`.
   - HTTP Route: `PUT /files/scripts/:idea_id/:kind?base_version=3` with `Content-Type: text/markdown`.
4. **Conflict Resolution:**
   - If another revision was saved in the meantime, the server rejects the upload with `409 Conflict` (or an MCP tool error) returning `{ latest_version: 4 }`.
   - The agent re-downloads the latest version, merges changes, and retries with `base_version=4`.

---

## 8. Query SQL Safety & Rules

The `query_sql` tool enables agents to perform custom analytics while strictly preserving isolation and security:
- **Permission Requirement:** Offered only to tokens with `read` on **every** workspace object (`ideas`, `scripts`, `videos`, `experiments`, `notes`, `activity`).
- **Transaction Safety:** Executes under `BEGIN READ ONLY` on the dedicated `ytw_readonly` connection pool.
- **Statement Timeout:** Hard 10-second timeout (`SET LOCAL statement_timeout = '10s'`).
- **Row & Byte Caps:** Results are capped at 500 rows (`truncated: true` when exceeded) and 1 MB maximum output payload.
- **Isolation:** Multi-statement queries are rejected. System catalog tables, session tables, and private schemas are inaccessible.

---

## 9. Security & Operational Hardening

1. **Secret Redaction:** Pino logs use redacting formatters from `@ytw/observability`. Authorization headers, session cookies, and API token strings are automatically scrubbed from log streams.
2. **Rate Limiting:** In-memory rate limiting throttles failed authentication attempts both per client IP and per token prefix. Repeated bad attempts return `429 Too Many Requests` with a `Retry-After` header.
3. **Payload Limits:** 1 MB hard limit on HTTP request bodies prevents resource exhaustion.
4. **Audit Trail Completeness:** Every mutating database function and MCP tool invocation writes an audit record to the append-only `events` table recording the actor (token name, ID, and owner), action, and payload.
5. **TLS Termination:** In production, place a TLS-terminating reverse proxy (e.g. Traefik, NGINX, Cloudflare) in front of the Fastify server.
6. **Metrics Access Control:** Protect `/metrics` by configuring `METRICS_TOKEN` whenever the port is exposed beyond an internal private network.

---

## 10. Adding a New Object Type to the Policy Matrix

The permission model is centralized in `@ytw/policy` and `@ytw/shared`:
1. Add the new resource name to `RESOURCES` in `packages/shared/src/constants.ts`.
2. Add the corresponding table/views in database migrations.
3. The TypeScript compiler (`tsc -b`) will typecheck all resource maps, tool definitions, and CLI parsers.
4. Refer to [policy.md](policy.md) for detailed step-by-step guidance and testing patterns.

---

## 11. Stack Deviations & Architecture Decisions

For full context on stack selections and trade-offs, consult [ADR 0001: Technology Stack](adr/0001-stack.md). Key decisions include:
- **TypeScript MCP SDK over MCP Toolbox (YAML):** Static YAML tool definitions cannot execute dynamic, database-backed RBAC checks on every call.
- **SECURITY DEFINER Functions over Query Builders:** Postgres stored procedures enforce optimistic locking, stage transition invariants, and immutable audit logs inside the database transaction boundary, eliminating client-side race conditions.
