# Ideas web API (`@ytw/web-server`)

The Ideas routes live in `apps/web-server/src/routes/ideas/index.ts`; the shared request and
response schemas are in `packages/shared/src/api/ideas.ts`. The browser uses these routes through
`apps/web-ui/src/features/ideas/api.ts`.

Every route requires a signed-in session and checks the user's current Ideas level on that request.
Collection and detail reads need `ideas=read`; create, edit, stage changes and archive need
`ideas=write`. Mutations use the session actor through `app.db.withActor` and call the typed
`@ytw/db` wrappers. Stage transitions and backward-note validation stay in `advanceIdea`.

| Method and path | Body or query | Result |
| --- | --- | --- |
| `GET /api/ideas` | `stage`, exact `tag`, `score_min`, `score_max`, case-insensitive `source` substring, `sort_by`, `sort_order`, `limit`, `offset`, `include_archived` | `{ ideas, page: { limit, offset, total } }` |
| `POST /api/ideas` | `title`, optional `pitch`, `source`, `tags`, `score` | `201 { idea }`, created in `inbox` |
| `GET /api/ideas/:id` | — | `{ idea, videos? }`; script metadata and video links are omitted unless the session can read those resources |
| `PATCH /api/ideas/:id` | Editable fields plus `expected_version` | `{ idea }` |
| `POST /api/ideas/:id/stage` | `new_status`, `expected_version`, optional `note` | `{ idea }`; the database writes a backward-move note in the same transaction |
| `POST /api/ideas/:id/archive` | `expected_version` | `{ idea }` with `archived_at` set |

List pages default to 100 rows and cap at 500. Sorting is deterministic, with the idea UUID as the
tie breaker. The database reader applies filters, sort and pagination before returning the page, so
the total and matches remain correct beyond the 1,000-row limit of the pipeline helper.

Validation errors use `400 { error }`; missing ideas use `404 { error }`; current-level denials use
`401` or `403`; transition failures preserve the database's readable message and use `422`. A stale
`expected_version` returns `409 { error, latest }`, where `latest` is the current idea or `null` if
it disappeared. Clients show the conflict dialog and never offer a force-save operation.

The Ideas detail screen uses `GET /api/notes?entity_type=idea&entity_id=:id` and
`POST /api/notes` through the shared `NotesPanel`. Script links point to the T44 feature routes
(`/scripts/:ideaId/script` and `/scripts/:ideaId/packaging`); each is available from the idea detail
even before its first document version exists. Video links point to the T46 screen
(`/videos/:videoId`).

## Bundle behavior

The Ideas routes are lazy, and the detail screen uses the existing NotesPanel. The old bundle test
searched **every emitted chunk** for all heavy-library markers. That treated intentionally lazy
code as a shell regression: the expected app graph includes a Markdown renderer chunk even though
the shell does not import it statically. The old check's intent and failure were therefore broader
than its “initial download” requirement.

The relevant production graph is:

```text
app entry ──lazy route──> IdeasPage
         └──lazy route──> IdeaDetailPage ──> NotesPanel ──> MarkdownView
                                                        └──lazy──> MarkdownViewImpl [Markdown marker]
```

The new shell assertion follows only static imports from the app entry, matching the bytes needed
for the first render. A separate heavy-feature fixture deliberately imports a Zod schema, chart and
Markdown view; it verifies each marker exists in emitted code but outside that fixture's initial
static import closure. This retains a direct lazy-splitting check rather than allowing heavy code to
disappear and make the test pass vacuously.

NotesPanel also replaced its runtime Zod imports with small request and response guards. This keeps
Zod out of the current app's actual production assets, while `MarkdownViewImpl` remains a real lazy
chunk needed to render notes and pitches. The built app was checked for the Zod marker across all
assets; the marker is absent. The test's narrower shell check describes the initial-download
contract, and the fixture separately proves that an intentional Zod consumer remains lazy.
