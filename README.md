# YouTube Workspace

A self-hosted workspace for one YouTube channel. Ideas, scripts, packaging experiments, published
videos and their metrics live in a single Postgres database. The channel owner works in a web app;
AI agents work through a [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server.
Both go through the same database functions, so stage rules, versioning and the audit log apply to
humans and agents alike.

One container serves everything: the web app, the REST API behind it, the MCP endpoint and the
script file endpoints.

## Features

- **Idea pipeline** — ideas move `inbox → shortlisted → scripting → filming → editing → published`
  (plus `dropped`). Moving backwards needs a note. The rules live in one database function.
- **Scripts and packaging docs** — append-only revisions with optimistic version checks. Agents can
  download a script as markdown, edit it locally and upload it as a new revision
  (`GET` / `PUT /files/scripts/:idea_id/:kind`); a stale upload gets a `409` with the latest version.
- **Videos and metrics** — register published videos, append metric snapshots over time, compare a
  video with the channel medians.
- **Packaging experiments** — title, thumbnail and description variants with impressions and CTR,
  one control, a declared winner.
- **Notes and activity** — comments on any idea, script, video or experiment, and an immutable audit
  log that says which human or which token changed what, and when.
- **Search** — full-text search across idea titles and pitches and the latest script bodies.
- **Per-object permissions** — every user and every API token has `none`, `read` or `write` on
  `ideas`, `scripts`, `experiments`, `videos`, `notes` and `activity` (`activity` is `read` at most).
  A token never exceeds its owner.
- **OIDC login, optional** — any OpenID Connect provider (Authelia, Authentik, Zitadel, ...). Leave
  it unconfigured for single-user mode.
- **MCP token from an environment variable** — the LLM gateway works from the first boot, without
  clicking through the UI.

## Quick start

Needs Node 24 and pnpm (`mise install` sets up both) plus a Postgres. Docker is the easiest way to
get one:

```bash
docker compose up -d postgres                    # Postgres 18 on 127.0.0.1:5432
pnpm install
cp apps/server/.env.example apps/server/.env     # DATABASE_URL already points at the compose database
pnpm dev                                         # server on :3000, web on :5173
```

Open <http://localhost:5173>. With no `OIDC_*` variables set there is no login: you are the local
owner (see [Authentication](#authentication)). The server applies the database migrations when it
starts.

The compose database's `postgres` user is a superuser, and the server then keeps the `query_sql`
MCP tool switched off: it runs SQL written by an agent, which a superuser could use to read files
and start programs on the database host. To try `query_sql` locally, make a plain role the owner
of the database before the first start (or after `docker compose down -v`) and use it in
`DATABASE_URL`:

```bash
docker compose exec postgres psql -U postgres \
  -c "CREATE ROLE ytw LOGIN PASSWORD 'ytw'" \
  -c "ALTER DATABASE youtube_workspace OWNER TO ytw"
# apps/server/.env: DATABASE_URL=postgres://ytw:ytw@localhost:5432/youtube_workspace
```

To run the production image locally instead (built from the `Dockerfile`, served on
<http://localhost:3000>, loopback only):

```bash
docker compose --profile app up -d --build
```

## Configuration

Everything is an environment variable. The server validates them at startup and exits with a list
of every bad variable. An empty value counts as unset. `apps/server/.env.example` is the annotated
list for local development; `pnpm dev` loads the root `.env`, then `apps/server/.env`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | *(required)* | The pre-provisioned Postgres role. It must own the database (migrations run on boot) and should not be a superuser, or `query_sql` is switched off |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `APP_VERSION` / `GIT_SHA` | `0.0.0-dev` / `unknown` | Shown on `/healthz`; the image build sets them |
| `STATIC_WEB_DIR` | *(unset)* | When set, serve the built web app from there with SPA fallback (the image sets it) |
| `METRICS_TOKEN` | *(unset)* | When set (at least 16 characters), `/metrics` requires `Authorization: Bearer <token>`. Set it if `/metrics` is reachable beyond a private network |
| `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | *(unset)* | OIDC login. All four or none |
| `OIDC_GROUPS_CLAIM_PATH`, `OIDC_REQUIRED_GROUP` | `groups`, *(unset)* | Optional group gate: only members of `OIDC_REQUIRED_GROUP` (read from the claim at `OIDC_GROUPS_CLAIM_PATH`) may sign in |
| `SESSION_SECRET` | *(required with OIDC)* | At least 32 characters. Derives the CSRF tokens and encrypts the refresh and ID tokens kept in the database, e.g. `openssl rand -base64 48` |
| `SESSION_IDLE_TIMEOUT`, `SESSION_ABSOLUTE_TIMEOUT` | `28800` (8 h), `604800` (7 d) | Session lifetimes in seconds |
| `MCP_BOOTSTRAP_TOKEN` | *(unset)* | The secret of the seeded MCP token, `ytw_` plus 43 base64url characters. Unset revokes the seeded token. See [Seeding the MCP token](#seeding-the-mcp-token) |
| `MCP_BOOTSTRAP_TOKEN_NAME` | `bootstrap` | Name of the seeded token; the audit log attributes its calls to it |
| `MCP_BOOTSTRAP_TOKEN_PERMISSIONS` | `ideas=write,scripts=write,experiments=write,videos=write,notes=write,activity=read` | The token's levels as `resource=level` pairs; anything unknown or repeated aborts startup |

Development only: the Vite dev server reads `WEB_UI_PORT` (default `5173`) and `WEB_SERVER_URL`
(default `http://127.0.0.1:3000`, where it proxies `/api` and `/auth`) from the shell or the root
`.env`. Tests read `TEST_DATABASE_URL` (default `postgres://postgres:postgres@localhost:5432/postgres`).

## Authentication

**OIDC.** Set `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` and `OIDC_REDIRECT_URI`
(plus `SESSION_SECRET`) and the web app requires a login. Register `OIDC_REDIRECT_URI` as
`https://<host>/auth/callback` with your provider; outside `localhost` both URLs must be HTTPS. The
first user to sign in becomes admin; everyone else starts with `none` everywhere until an admin sets
their levels in **Settings**. Setting only some of the OIDC variables is a startup error.

The provider must issue signed JWT access tokens that carry `sub` and name the client (`azp`,
`client_id` or `aud`). With **Keycloak** (25 or later) `sub` comes from the `basic` client scope: a
client created with an explicit list of default scopes that leaves `basic` out gets access tokens
without it, and sign-in fails with `errorCode: "access_token_subject_missing"` in the log. Add
`basic` to the client's default scopes.

**Single-user mode.** With no `OIDC_*` variables, every web request is the built-in local owner, an
admin with full access (a real user, `owner`, so the audit log still names who acted). The server
logs a warning at startup, and `apps/server/.env.example` makes development listen on the
loopback interface only (`HOST=127.0.0.1`; the image listens on all interfaces).

> [!WARNING]
> Single-user mode has no login at all. Anyone who can reach the web app is the owner. Use it for
> local development, or behind a reverse proxy or VPN that already authenticates people.

`/mcp` and the script file endpoints always need a bearer token, in every mode.

## Deploying with CloudNativePG

The app uses one Postgres role. It never creates roles, never sets passwords and never needs a
superuser: the role owns the database, and the server runs the migrations as that same role every
time it boots. Concurrent boots (several replicas, a rolling update) wait for each other on an
advisory lock. Because `query_sql` can read every table, nothing in the database works as a
credential when read: API tokens and session ids are stored as hashes, refresh and ID tokens
encrypted.

[CloudNativePG](https://cloudnative-pg.io) creates exactly that. Its `app` user owns the database
named in `bootstrap.initdb`, and the operator publishes the connection string in the
`<cluster>-app` secret:

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: youtube-workspace-db
spec:
  instances: 1
  storage:
    size: 5Gi
  bootstrap:
    initdb:
      database: youtube_workspace
      owner: youtube_workspace
```

Then point the Deployment at the `uri` key of that secret:

```yaml
containers:
  - name: youtube-workspace
    image: ghcr.io/mirceanton/youtube-workspace:latest
    ports:
      - containerPort: 3000
    env:
      - name: DATABASE_URL
        valueFrom:
          secretKeyRef:
            name: youtube-workspace-db-app # <cluster>-app
            key: uri
      - name: MCP_BOOTSTRAP_TOKEN
        valueFrom:
          secretKeyRef:
            name: youtube-workspace
            key: mcp-bootstrap-token
      # Remove these for single-user mode behind your own authentication.
      - name: OIDC_ISSUER_URL
        value: https://auth.example.com
      - name: OIDC_CLIENT_ID
        value: youtube-workspace
      - name: OIDC_CLIENT_SECRET
        valueFrom:
          secretKeyRef: { name: youtube-workspace, key: oidc-client-secret }
      - name: OIDC_REDIRECT_URI
        value: https://youtube-workspace.example.com/auth/callback
      - name: SESSION_SECRET
        valueFrom:
          secretKeyRef: { name: youtube-workspace, key: session-secret }
    livenessProbe:
      httpGet: { path: /healthz, port: 3000 }
    readinessProbe:
      httpGet: { path: /readyz, port: 3000 }
```

`/readyz` fails until the database answers and the schema is current. The image runs as
`1000:1000` and needs no writable filesystem.

## Seeding the MCP token

To let an LLM gateway talk to the workspace from the first boot, give the server a token through the
environment instead of creating one in the UI.

1. Generate a secret (`ytw_` plus 43 base64url characters) and keep it in your secret store:

   ```bash
   openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' | sed 's/^/ytw_/'
   ```

2. Set it as `MCP_BOOTSTRAP_TOKEN` on the server. Optionally set `MCP_BOOTSTRAP_TOKEN_NAME` (the
   name the audit log shows for its calls) and `MCP_BOOTSTRAP_TOKEN_PERMISSIONS`, for example
   `ideas=write,scripts=write,videos=read,activity=read`. Resources you leave out get `none`;
   unknown resources or levels abort startup.

3. Point the gateway at `POST /mcp` with the header `Authorization: Bearer ytw_...`. To check that
   the token is accepted (`200`; a wrong token is `401`):

   ```bash
   curl -sS -o /dev/null -w '%{http_code}\n' https://youtube-workspace.example.com/mcp \
     -H "Authorization: Bearer $MCP_BOOTSTRAP_TOKEN" \
     -H 'Content-Type: application/json' \
     -H 'Accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
   ```

   In a client that takes a JSON config, for example Claude Desktop:

   ```json
   {
     "mcpServers": {
       "youtube-workspace": {
         "url": "https://youtube-workspace.example.com/mcp",
         "headers": { "Authorization": "Bearer ytw_YOUR_SECRET" }
       }
     }
   }
   ```

**The environment wins.** The server reconciles the seeded token on every boot:

| Environment | Result |
| --- | --- |
| Token set, none seeded yet | Created |
| Same secret, same name and permissions | Unchanged |
| Same secret, other name or permissions | Updated in place |
| A different secret | The old seeded token is revoked, the new one created: this is how you **rotate** |
| `MCP_BOOTSTRAP_TOKEN` unset or empty | The seeded token is **revoked** |

Only the seeded token is ever touched; tokens created in the UI are unaffected, and the seeded token
is not listed in **Settings**: the environment is the only place that manages it. It never expires
and is owned by a built-in system user that cannot log in, so its own permissions are the only
limit. Only a hash of the secret is stored; the secret itself never reaches the database or the
log.

Tokens for other agents are created in **Settings**, each with its own levels, never above those of
the user who creates it.

## MCP

The endpoint is `POST /mcp` (Streamable HTTP, stateless; `GET` and `DELETE` answer `405` to a valid
token). Every call is checked against the token's effective permission and recorded in the audit
log under the token's name. `query_sql` is only offered at all to tokens with read on every
object, and only when the server's database role is not a superuser.

| Tool | Needs | What it does |
| --- | --- | --- |
| `whoami` | | The token's name, owner and effective permission levels |
| `list_ideas` | read `ideas` | Ideas with age in stage and latest script revisions, filterable by stage |
| `get_idea` | read `ideas` | One idea |
| `create_idea` | write `ideas` | New idea in `inbox` |
| `update_idea` | write `ideas` | Edit non-stage fields; fails on a version conflict |
| `advance_idea` | write `ideas` | Move one stage forward, one back (needs a note), to `dropped`, or restore to `inbox` |
| `get_script` | read `scripts` | A script or packaging revision, latest unless a version is given |
| `export_script` | read `scripts` | The same as markdown with YAML front matter |
| `save_script_version` | write `scripts` | Append a draft revision; fails if `base_version` is not the latest |
| `set_script_status` | write `scripts` | Set a revision to `draft`, `review` or `approved` |
| `register_video` | write `videos` | Register a video that exists on YouTube |
| `log_metrics` | write `videos` | Append a metrics snapshot (idempotent per video and capture time) |
| `list_videos` | read `videos` | Videos with headline metrics against channel medians |
| `get_video_performance` | read `videos` | Detailed metrics for one video |
| `create_experiment` | write `experiments` | An experiment with its variants (exactly one control) |
| `record_variant_stats` | write `experiments` | Impressions and CTR for a variant |
| `conclude_experiment` | write `experiments` | Pick the winner and record the conclusions |
| `list_experiments` | read `experiments` | Experiments, filterable by video or status |
| `get_experiment_results` | read `experiments` | Variants side by side with the declared winner |
| `add_note` | write `notes` | Comment on an idea, script, video or experiment |
| `list_notes` | read `notes` | Comments on one entity, oldest first |
| `search` | | Full-text search across ideas and script bodies, limited to what the token may read |
| `query_sql` | read on **every** object | One read-only SQL statement: `READ ONLY` transaction, 10 s timeout, 500 rows and 1 MB at most |

Script files for editing outside MCP, with the same bearer token:

- `GET /files/scripts/:idea_id/:kind[?version=N]` returns the markdown with front matter
  (`idea_id`, `kind`, `version`, `status`). `kind` is `script` or `packaging`.
- `PUT /files/scripts/:idea_id/:kind?base_version=N` with `Content-Type: text/markdown` saves the
  body as the next draft revision. If someone saved in between, the answer is `409` with the latest
  version.

Operations endpoints, without authentication except `/metrics` when `METRICS_TOKEN` is set:
`GET /healthz` (liveness, version and commit), `GET /readyz` (database reachable, schema current)
and `GET /metrics` (Prometheus).

## Repository layout

```
apps/server        @ytw/server   Fastify: web API (/api, /auth), MCP (/mcp), script files,
                                 health and metrics; serves the built web app
apps/web           @ytw/web      Vite + React + Tailwind single-page app
packages/shared    @ytw/shared   Domain constants (resources, levels, idea stages) and zod schemas
packages/db        @ytw/db       SQL migrations, migrator, typed wrappers, test harness
packages/policy    @ytw/policy   Pure permission logic
packages/script-md @ytw/script-md  The script markdown file format
```

## Development

```bash
pnpm dev            # server and web in watch mode
pnpm test           # vitest; needs Postgres (TEST_DATABASE_URL, see above)
pnpm lint           # tsc -b and oxlint
pnpm format         # prettier
pnpm build          # tsc -b per package and the web build
pnpm migrate        # apply migrations to DATABASE_URL by hand (the server also does it on boot)
```

Tests create and drop their own throwaway databases on the server behind `TEST_DATABASE_URL`, which
therefore needs a superuser. See `CLAUDE.md` for the conventions.

Releases are cut by the `Release` workflow from conventional commits. Publishing a release builds
and pushes `ghcr.io/mirceanton/youtube-workspace` (`linux/amd64` and `linux/arm64`) tagged with the
release version and `latest`.
