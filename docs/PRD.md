# PRD: YouTube Channel Workspace (Postgres + MCP + Web UI)

Oct 1, 2026 · @Mircea

## 1. Overview

Build one Postgres-backed workspace where AI agents and the channel owner manage every video from idea to post-publish analytics. Agents reach it through MCP tools; the owner reaches it through an authenticated, installable web app.

**Problem.** Ideas, scripts, experiments and metrics currently live in scattered files and chat history. Several agents (YouTube assistant, video editor, analytics) need a shared, structured source of truth they can read and write without overwriting each other.

**Goals**

- G1: A single schema covering ideas, scripts, packaging experiments, published videos and metric snapshots.
- G2: Agents read and write only through a constrained MCP interface, using API tokens with per-object permissions.
- G3: Every write is attributable to an agent or human via an audit log.
- G4: A web UI to browse and manage all of it, with OIDC login, simple per-user access levels and PWA support on a phone.
- G5: Agents can download a script as markdown, edit it locally and upload it back as a new revision.

**Non-goals (v1)**

- No video or thumbnail file storage; the DB holds paths or URLs only.
- No direct YouTube upload or publishing from this system.
- No multi-tenant or public-facing use; one channel, a few trusted users.
- No native mobile app; PWA only.

## 2. Users, agents and roles

Two kinds of principals use the system: humans (via the web UI) and agents (via MCP). Both are first-class actors in the audit log.

| Principal | Type | Access |
| --- | --- | --- |
| User | Human, signs in through Keycloak | A level of None, Read or Write per object, set by an admin |
| Admin | Human with the admin flag (the first user to sign in) | Write on everything, plus management of other users' access in settings |
| Agent | Machine, authenticates with an API token | Each token has its own level per object, never above its owner's level |

Agents are not defined in code or configuration. Adding an agent means generating a token in settings and choosing its permissions, with no deployment.

**Key user stories**

- As the owner, I see every idea and its stage on a board and drag it to the next stage.
- As the owner, I open a script from my phone, read it and leave a comment for an agent.
- As the owner, I compare experiment variants and see which one won, with CTR and impressions.
- As an agent with Write on scripts, I download a script as markdown, edit it locally and upload it as a new revision, without any risk of overwriting someone else's work.
- As the owner, I generate an API token in settings, set None, Read or Write per object up to my own level, and revoke it at any time.
- As the owner, I set what each user can do per object from one settings screen.
- As the owner, I can see which agent or user changed anything, and when.

## 3. Architecture and tech stack

&#91;embedded content: system architecture · 2 services, 1 database, 1 identity provider\]

The web app and the MCP server are separate services. Both write through the same database functions, so stage rules, versioning and audit logging apply equally to humans and agents.

**Recommended stack.** These are defaults; the coding agent may deviate with a short written justification in the README.

- Language: TypeScript end to end, in one monorepo with the web app, the MCP server and a shared database package.
- Web: a full-stack framework with server routes for the backend-for-frontend (Next.js or SvelteKit), Tailwind CSS and a PWA plugin or Workbox.
- OIDC: a maintained library (Auth.js or openid-client), not a hand-rolled flow.
- Database access: a typed query builder (Drizzle or Kysely) plus plain SQL migrations checked into the repo.
- MCP: Google's MCP Toolbox with YAML tool definitions, or the official TypeScript MCP SDK.
- Charts: a lightweight library such as Recharts or uPlot.
- Tests: Vitest for unit and integration, Playwright for end-to-end.

## 4. Data model

Postgres 16+ is the system of record. All tables use `uuid` primary keys (UUIDv7 preferred), `created_at`/`updated_at` timestamptz, and `created_by` referencing an actor name. Schema changes ship as versioned migrations in the repo, never as manual DDL.

| Table | Purpose | Key columns |
| --- | --- | --- |
| ideas | Video ideas moving through the pipeline | title, pitch, status (enum), score, source, tags text\[\] |
| scripts | Append-only revisions of scripts and packaging docs | idea\_id, kind (script or packaging), version int, body\_md, status (draft, review, approved) |
| videos | Published (or scheduled) videos | idea\_id (nullable), youtube\_id (unique), title, published\_at, thumbnail\_url |
| video\_metrics | Append-only metric snapshots over time | video\_id, captured\_at, views, impressions, ctr, avg\_view\_duration\_s, avg\_view\_pct, watch\_time\_min, subs\_gained, retention jsonb |
| experiments | A/B tests on a video's packaging | video\_id, type (title, thumbnail, description), hypothesis, status (planned, running, concluded, cancelled), starts\_at, ends\_at, winner\_variant\_id, conclusion |
| experiment\_variants | Variants within an experiment | experiment\_id, label, content, is\_control, impressions, ctr |
| notes | Human or agent comments on any entity | entity\_type, entity\_id, author, body\_md |
| events | Immutable audit log | actor, actor\_type (human or agent), token\_id (nullable), action, entity\_type, entity\_id, payload jsonb, created\_at |
| users | App users linked to Keycloak identities | oidc\_issuer, oidc\_sub (unique together), username, email, display\_name, is\_admin, created\_at, last\_login\_at |
| user\_permissions | Access level per user and object | user\_id, resource, level (none, read, write); unique on (user\_id, resource) |
| api\_tokens | API tokens for agents, created in settings | user\_id (owner), name, token\_prefix, token\_hash, created\_at, expires\_at (null means never), last\_used\_at, revoked\_at |
| api\_token\_permissions | Access level per token and object | token\_id, resource, level (none, read, write); unique on (token\_id, resource) |

**Idea stages.** `inbox → shortlisted → scripting → filming → editing → published`, plus `dropped`. Allowed moves: forward one stage; back one stage with a required note; any stage to `dropped`; `dropped` back to `inbox`. Enforced in a database function so no client can bypass it.

**Integrity rules**

- `scripts` is append-only: unique on (idea\_id, kind, version); new versions are inserted, never updated in place.
- `video_metrics` is append-only: unique on (video\_id, captured\_at).
- Mutable rows (`ideas`, `experiments`, `videos`) carry a `version` integer; updates must pass the expected version and fail on mismatch (optimistic concurrency).
- Enums or CHECK constraints for every status and type column.
- A trigger or function wrapper writes an `events` row for every insert and update on the tables above; `events` allows insert and select only.
- `ON DELETE RESTRICT` on foreign keys; deletion is soft (`archived_at`) for ideas and videos.

**Views for agents and the UI**

- `ideas_pipeline`: ideas with stage, latest script version and age in stage.
- `video_performance_summary`: each video with latest metrics and deltas versus channel median.
- `experiment_results`: variants side by side with CTR difference and winner.

## 5. Agent interface (MCP)

Agents never get raw database access. They use typed MCP tools, authenticated with an API token that the owner generates on the web app's settings page. Each token carries its own None, Read or Write level per object, and the MCP server enforces it on every call.

**Server.** A small custom MCP server (FastMCP or the official TypeScript MCP SDK), because every call needs a database-backed permission check. Tools defined statically in YAML, as in MCP Toolbox, are a poor fit. The coding agent should justify the final choice in the README; the tool contract below is what matters.

**Transport and auth.** Streamable HTTP with the API token sent as a bearer token. The server looks the token up by its hash, rejects it if it is revoked or expired, updates `last_used_at`, and uses the token's name as the `actor` in the audit log.

**Write tools (v1)**

| Tool | Requires | Behavior |
| --- | --- | --- |
| create\_idea(title, pitch, source, tags) | Write on ideas | Inserts an idea in `inbox` |
| update\_idea(id, expected\_version, fields) | Write on ideas | Edits non-status fields; fails on version mismatch |
| advance\_idea(id, new\_status, note) | Write on ideas | Validates the stage transition rules |
| save\_script\_version(idea\_id, kind, base\_version, body\_md) | Write on scripts | Inserts the next version only if base\_version is the latest; otherwise fails and returns the latest version number |
| set\_script\_status(script\_id, status) | Write on scripts | draft, review or approved |
| register\_video(idea\_id, youtube\_id, title, published\_at) | Write on videos | Creates the video record |
| log\_metrics(video\_id, captured\_at, metrics) | Write on videos | Appends a snapshot; idempotent on (video\_id, captured\_at) |
| create\_experiment(video\_id, type, hypothesis, variants) | Write on experiments | Creates an experiment with its variants |
| record\_variant\_stats(variant\_id, impressions, ctr) | Write on experiments | Updates variant results |
| conclude\_experiment(id, winner\_variant\_id, conclusion) | Write on experiments | Closes the experiment |
| add\_note(entity\_type, entity\_id, body\_md) | Write on notes | Adds a comment |

**Read tools.** Structured tools such as `list_ideas(status)`, `get_script(idea_id, kind)` and `get_video_performance(video_id)` return only objects the token can Read. `query_sql(sql)` is offered only to tokens with Read on every object, because raw SQL cannot be filtered per object; it runs on a read-only role with `statement_timeout` of 10 seconds and a row cap of 500.

**File export and import (scripts and packaging docs).** Agents can work on script markdown as local files.

- Download: `export_script(idea_id, kind, version?)` returns the markdown file, the latest version unless one is given. It starts with YAML front matter (`idea_id`, `kind`, `version`, `status`) followed by the body. The same file is served by `GET /files/scripts/{idea_id}/{kind}` with the bearer token, for agents that work with files on disk. Requires Read on scripts.
- Edit the file locally in the agent's own workspace.
- Upload: call `save_script_version` with the `base_version` from the front matter, or `PUT /files/scripts/{idea_id}/{kind}?base_version=N` with the markdown as the request body. This creates a new revision as `draft` and never changes older versions. Requires Write on scripts.
- Conflicts: if `base_version` is no longer the latest, the call fails and returns the latest version number, so the agent can re-download, merge and retry.
- Front matter is stripped on upload; if its `idea_id` or `kind` disagree with the target, the call fails.
- The HTTP file endpoints are served by the MCP service, use the same API tokens and permission checks, and call the same service functions as the tools.
- The web UI offers the same two actions on the script screen (download as `.md`, upload a new revision) under the same rules and size limit.

**Database roles**

- A small, fixed set of Postgres roles created by migration: one for the web app, one for the MCP server's writes, and one read-only role used only by `query_sql` (`default_transaction_read_only = on`).
- Per-token permissions are enforced in the MCP server, not by Postgres roles, because tokens are created at runtime.
- Writes run through `SECURITY DEFINER` functions; no application role gets table-level `INSERT` or `UPDATE`.
- The functions take the actor name as a parameter and write it to `events`.

**Tool design rules.** Every tool has a clear description and typed schema; errors are readable by an LLM (say what failed and what valid values are); a call without the required permission fails with a clear message and is logged; no tool deletes data; every call writes an `events` row.

## 6. Web UI requirements

The web app is the human window into the same data agents use. It must apply the same business rules (stage transitions, versioning, optimistic concurrency) by calling the same database functions, never by duplicating logic in the frontend. Phone use is a primary scenario, so every screen is designed mobile-first.

| Area | Requirements |
| --- | --- |
| Dashboard | Ideas per stage, running experiments, latest published videos with headline metrics, last 20 activity events |
| Ideas | Kanban board by stage plus a sortable table view; filter by stage, tag, score, source; create and edit; move stage with transition validation and a note when going backward; detail view with linked scripts, video and notes |
| Scripts | Per idea and kind (script or packaging); version history with diff between any two versions; rendered markdown reader optimized for phones; editing creates a new version; download as .md and upload a new revision; status control; comments |
| Experiments | List and detail; variants side by side with impressions and CTR; chart of CTR over time; mark winner and write conclusion |
| Videos | Table with latest metrics; detail page with time-series charts (views, CTR, average view duration, retention); link back to the originating idea |
| Activity | Filterable audit feed by actor, entity type and date, showing agent and human actions equally |
| Search | Global full-text search across idea titles, pitches and script bodies (Postgres `tsvector`) |
| Settings | Profile and effective access; own API tokens (create, set None, Read or Write per object, rotate, revoke, see last use); user access matrix for admins. Details in section 7 |

**Behavior requirements**

- Changes made by agents appear without a manual reload (SSE or short polling; 15 seconds is acceptable).
- Edit conflicts show a clear message and let the user reload or merge, never silently overwrite.
- Every mutating action shows who last changed the item.
- Empty, loading and error states exist for every screen.
- Light and dark themes following the system setting.
- Accessibility baseline: WCAG 2.1 AA for contrast, keyboard navigation and focus order.

**Out of scope for v1.** Drag-and-drop on touch devices can fall back to a "Move to stage" menu; rich WYSIWYG script editing (plain markdown editor with preview is enough); real-time collaborative editing.

## 7. Authentication and RBAC

Humans sign in through OpenID Connect against a standards-compliant provider; the app must be provider-agnostic and tested against Keycloak, which is the intended provider. Agents never use the browser flow.

**OIDC requirements**

- Authorization Code flow with PKCE; the app is a confidential client using a backend-for-frontend pattern, so tokens stay server-side.
- Access gate: login succeeds only if the token carries the required Keycloak group (name and claim path set in configuration) in its groups claim. Without it the user sees an "access denied" page and no user record is created. The check is repeated on every token refresh, so removing someone from the group in Keycloak ends their access. This is the only use of Keycloak groups; they never map to in-app permissions.
- Browser session is an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; no tokens in `localStorage` or `sessionStorage`.
- Discovery via the issuer's `/.well-known/openid-configuration`; ID and access tokens validated for signature, issuer, audience, expiry and nonce.
- Silent refresh via refresh tokens server-side; idle session timeout of 8 hours and absolute timeout of 7 days (configurable) so the PWA stays signed in on a phone.
- RP-initiated logout that ends the provider session as well.
- All provider settings come from environment variables: issuer URL, client ID, client secret, redirect URI, groups claim path and required group name.
- Unauthenticated requests get a redirect (pages) or `401` (API). No anonymous access to any data route.

**Access model.** Every user and every API token has a level of None, Read or Write on each object, and Write includes Read. The objects are ideas, scripts, experiments, videos (with their metrics) and notes, plus the activity log, which is None or Read only. Keycloak answers who the user is and whether they may enter at all (the access gate above); inside the app, levels are stored per user and are not linked to Keycloak groups or roles. On first login the app creates a user record linked to the Keycloak identity (issuer and `sub` claim). The very first user becomes admin with Write on everything; any later user starts with None everywhere until an admin sets their levels in settings. Two example users as the settings screen would show them:

| Object | Collaborator | Reader |
| --- | --- | --- |
| Ideas | Write | Read |
| Scripts | Write | Read |
| Experiments | Write | Read |
| Videos and metrics | Read | Read |
| Notes | Write | Read |
| Activity log | Read | None |

**Enforcement rules**

- Authorization is checked server-side on every route and mutation from the user's stored levels, never from client state. Hiding a button is cosmetic only.
- A user with None on every object sees an "access not granted" page.
- The first user to sign in is made admin automatically, in a single transaction so only one user can claim it. Admins have Write on everything and set other users' levels in settings; the last admin cannot be demoted or removed.
- The server sets the database session actor (for example `SET LOCAL app.actor = '<preferred_username>'`) so human writes appear in the audit log with the same fidelity as agent writes.
- One reusable policy layer, shared with the MCP server, with unit tests for None, Read and Write on every object, for both users and tokens.
- Lowering a user's levels immediately lowers their tokens, because a token never exceeds its owner.

**API tokens**

- Any signed-in user with Read or Write on at least one object can create tokens for their own account from settings.
- Each token has a name, an expiry (default 90 days, with a "never expires" option) and its own level for every object.
- A token's level for an object can be set at or below its owner's level, never above. An owner with Write can grant Write, Read or None; an owner with Read can grant only Read or None. The UI offers only allowed values and the server rejects anything higher.
- On every call the effective level is the lower of the token's level and the owner's current level, so lowering a user's access lowers their tokens too.
- The secret is shown once at creation, then stored only as a hash plus a short prefix for identification. Tokens are never logged.
- Owners can edit a token's permissions, rotate it or revoke it; revocation takes effect immediately.
- Tokens work only against the MCP service (tools and file endpoints) and never as a browser login.
- Audit entries record the token's name and id as the actor, along with its owner.

**Settings page**

- Profile: name, Keycloak identity and effective level per object, read-only.
- API tokens: a list with name, prefix, permission summary, created date, last used and expiry; create, edit, rotate and revoke. Creation offers only levels up to the owner's own.
- Access (admins only): a matrix of users by objects with a None, Read or Write control in each cell. Users appear after their first login. Changes apply immediately and are logged.
- On phones, each token and each user opens as its own screen with large None, Read and Write controls instead of a wide table.

**Local development.** The repo ships a Keycloak realm export with the client, the required access group, one test user inside it and one outside so the full login flow runs locally with one command.

## 8. Mobile and PWA requirements

The app must install to a phone home screen and be pleasant to use one-handed for reading scripts, checking pipeline state and leaving notes. Target browsers: iOS Safari 17+ and current Chrome on Android, plus desktop Chrome, Firefox and Safari.

**Installability**

- Web app manifest with name, short name, icons (192, 512 and maskable), `display: standalone`, theme and background colors, and `start_url` on the dashboard.
- Served over HTTPS only (a requirement for service workers).
- Lighthouse PWA installability checks pass.

**Offline and caching**

- Service worker precaches the app shell so the app opens instantly and shows a clear offline state.
- Read-through cache for recently viewed ideas and scripts, so a script opened earlier can be read with no connection.
- Mutations are not queued offline in v1; when offline, write controls are disabled with an explanation. (Queued offline edits are a later phase.)
- Authenticated API responses must never be cached in a way that serves one user's data to another or survives logout; the cache is cleared on logout.

**Mobile UX**

- Responsive layouts from 360 px wide; bottom navigation bar on phones, sidebar on desktop.
- Touch targets of at least 44 px; no hover-only interactions.
- Kanban collapses to a stage picker plus a vertical list on narrow screens.
- Script reader: comfortable line length, adjustable font size, safe-area insets respected.
- Pull-to-refresh on list screens.

**Stretch (later phase).** Web Push notifications for events such as "script moved to review" or "experiment concluded" (supported on iOS only for installed PWAs).

## 9. Non-functional requirements and setup

The implementation targets an existing Postgres instance and an existing Keycloak. Hosting, packaging and deployment are out of scope for this PRD; the notes below cover what the code must support.

**Environment and setup**

- The app connects to the existing Postgres instance through `DATABASE_URL` and never provisions or manages Postgres itself.
- Migrations are one command, safe to run repeatedly. They create the schema, the fixed database roles from section 5 and their grants, using a separate privileged connection string (`MIGRATION_DATABASE_URL`).
- All configuration comes from environment variables (database URLs, OIDC settings including the required group name); secrets are never committed.
- The web app and the MCP service are separate processes built from one repository.
- A `mise.toml` pins the toolchain and defines tasks for `dev`, `test`, `lint`, `migrate` and `build`.
- Local development uses a `docker-compose.yml` with a throwaway Postgres and a dev Keycloak realm, so it never touches the shared instances.

**Performance and capacity**

- Designed for one channel: up to 10 concurrent users and 10,000 videos or ideas. No premature scaling work.
- p95 API latency under 300 ms for list and detail endpoints at that scale; initial PWA load under 3 seconds on a mid-range phone over 4G.

**Security**

- A fixed set of least-privilege database roles (section 5) plus permission checks in the web backend and the MCP server; parameterized queries only.
- API tokens are stored only as hashes, shown once, revocable and expiring by default, and never written to logs.
- CSRF protection on cookie-authenticated mutations; strict CORS; security headers (CSP, `X-Content-Type-Options`, `Referrer-Policy`).
- Rendered markdown is sanitized to prevent XSS from agent-written content.
- Input size limits on script bodies (for example 1 MB) and on `query_sql` output; rate limiting on token authentication failures.
- Dependency and container image scanning in CI.

**Observability**

- Structured JSON logs including actor and request ID; `/healthz` and `/readyz` endpoints on both processes.
- Prometheus-style metrics endpoint with request rate, latency, error rate and MCP tool call counts by tool and token.

**Quality**

- Automated tests: unit tests for the policy layer and stage transitions, integration tests against a real Postgres, and an end-to-end test of the OIDC login against the Keycloak dev realm.
- CI runs lint, tests and a build on every pull request.
- README documents setup, configuration variables, how to create an API token for a new agent and how to add a new object type to the permission matrix.

## 10. Phased delivery plan

&#91;embedded content: delivery roadmap · 5 phases, 5 gates\]

Phases 1 and 2 are useful on their own: agents can collaborate through the database before any UI exists. Each phase is delivered as a reviewable set of pull requests, and it is done only when its gate criteria pass and the README reflects the new behavior. Detailed requirements for each phase are in sections 4 to 9.

## 11. Assumptions and open questions

The coding agent should proceed on the assumptions below and flag any it needs changed, rather than blocking.

**Assumptions**

- One YouTube channel, one workspace; no multi-tenancy.
- Keycloak is the identity provider and an existing realm can be reused or a new client added; the app reads the stable subject ID, basic profile claims and one group claim, used only as a login gate.
- The MCP server and web app are separate deployments sharing the same database functions and migrations.
- Postgres is the single source of truth for script and packaging markdown; the web UI is the way to read it on a phone.
- Agents populate `video_metrics` by calling `log_metrics`; the app does not call the YouTube Analytics API itself in v1.
- Experiment results are entered manually or by an agent; YouTube's own Test & Compare results are copied in, not fetched.

**Open questions**

No open questions remain. App-managed groups are deferred and only worth revisiting if more users are ever added.
