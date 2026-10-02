# Web UI (`apps/web-ui`)

The single-page app that the web server serves: React 19, react-router 8, Tailwind 4, TanStack Query
5, uPlot for charts. This page is for the people who add screens to it (ideas, scripts, experiments,
videos, dashboard, activity, search, settings). It explains how a feature plugs in, what the shell
and the UI kit already do for you, how to develop without the web server, and the rules that keep
the bundle small and the screens accessible.

- Requirements: PRD sections 6 (web UI), 7 (access states), 8 (mobile). The PRD wins over this page.
- The contract with the web server (`/api/me`, CSRF, 401, 409, `/api/notes`) is in
  [`packages/shared/src/api/session.ts`](../packages/shared/src/api/session.ts) and
  [`notes.ts`](../packages/shared/src/api/notes.ts); the policy vocabulary is in [`policy.md`](policy.md).

## Run it

```bash
pnpm --filter @ytw/web-ui dev      # http://localhost:5173, mock API when no web server answers
pnpm --filter @ytw/web-ui test     # components, shell, contract, tokens, bundle rules (about 20 s)
pnpm --filter @ytw/web-ui build    # tsc -b && vite build (also run by `pnpm build`)
```

Under `pnpm dev` the Vite server proxies `/api` and `/auth` to the web server. If nothing answers
`/api/me` (the web server is not running or does not have the route yet), an in-memory **mock API**
takes over, so you can build screens before the server exists. `VITE_MOCK_API=on|off|auto` (shell or
`apps/web-ui/.env`) forces it on or off. Open `/kit` in development for a page that shows every UI
kit component with mock data (the **UI kit gallery**); it is not part of production builds.

## Layout of `src/`

| Path | What lives there |
| --- | --- |
| `main.tsx`, `App.tsx` | Bootstrap: dev mocks (development only), query client, router, error boundary |
| `app/` | The shell: `features.ts` (discovery), `registry.ts` (the glob), `router.tsx`, `SessionGate.tsx`, `AppShell.tsx` (sidebar, phone bottom bar, offline banner), full-page states in `pages.tsx` |
| `kit/` | The UI kit. Import it as `@/kit` |
| `lib/` | `api.ts` (the only place that calls `fetch` for `/api`), `errors.ts`, `session.ts` (hooks), `query-client.ts`, `format.ts`, `safe-url.ts`, `contract.ts` |
| `styles/` | `tokens.css` (all colours, light and dark), `theme.css` (Tailwind mapping), `markdown.css`, `chart.css` |
| `features/<feature>/` | **Yours.** One folder per feature, discovered automatically |
| `dev/` | Development only: mock API, gallery. Never imported by production code |

`@/` means `src/`. Files are imported with their real extension (`./Thing.tsx`).

## Adding a feature (the whole recipe)

A feature is a folder `src/features/<id>/` with a `routes.tsx`. Nothing outside the folder changes:
the shell finds it with `import.meta.glob("../features/*/routes.tsx")`, adds the routes, builds
the navigation, and wraps the routes in an access check.

```tsx
// src/features/ideas/routes.tsx
import { Lightbulb } from "lucide-react";
import { defineFeature } from "@/app/features.ts";

export default defineFeature({
  id: "ideas", // equals the folder name; lower-case letters, digits, dashes
  requires: { resource: "ideas", level: "read" }, // who sees the nav item and the routes
  nav: { label: "Ideas", icon: Lightbulb, order: 20 }, // omit for a feature reachable only by links
  routes: [
    { path: "ideas", lazy: () => import("./IdeasPage.tsx") },
    { path: "ideas/:ideaId", lazy: () => import("./IdeaDetailPage.tsx") },
  ],
});
```

```tsx
// src/features/ideas/IdeasPage.tsx: a route module exports `Component` (code-split by `lazy`)
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/kit";

export function Component() {
  return <PageHeader title="Ideas" />;
}
```

The rules (checked at startup by `discoverFeatures`; a mistake throws one error naming every
problem and the file):

- **`id`** is unique and equals the folder name. **Every top-level route `path` is the id or starts
  with `<id>/`**, so two features can never collide. No index routes at the top level.
- **`requires`** uses the policy layer's vocabulary (`@ytw/policy`, [`policy.md`](policy.md)):
  - `{ resource: "ideas", level: "read" | "write" }` (one level on one object; `write` on the
    activity log is rejected because nobody can have it),
  - `"authenticated"` for screens every signed-in user may open (the settings page),
  - `"admin"` for admin-only screens,
  - or an array of these, where any one is enough.
    Admins satisfy every level rule, `write` includes `read`, as on the servers. This only decides
    what the browser **shows**. The web server checks every request again, so a hidden button is
    cosmetic and a missing server guard is a bug in the server route.
- **`nav`** is `{ label, icon, order, to? }`. `icon` is any `lucide-react` icon. `to` defaults to
  `/<id>` and must stay inside it. `order` sorts the menu, lowest first. Suggested values:
  dashboard 10, ideas 20, scripts 30, experiments 40, videos 50, activity 60, search 70,
  settings 90. On a phone the first four items sit in the bottom bar and the rest (with sign-out)
  under **More**; on desktop all of them are in the sidebar.
- **`routes`** are ordinary react-router `RouteObject`s. Use `lazy: () => import("./Page.tsx")`
  and export a function named `Component` (optionally `ErrorBoundary`): that code-splits the page.
  A page that throws shows an error inside the shell, so the navigation survives.
- `/` redirects to the first menu item the user may open, so the dashboard (order 10) becomes the
  start page by existing.

Also needed for a complete feature: server routes `apps/web-server/src/routes/<id>/index.ts`
(with `requireLevel` on every route), request/response schemas in
`packages/shared/src/api/<id>.ts`, and tests (below).

## What the shell does for you

| Situation | Behaviour |
| --- | --- |
| Loading the session | `GET /api/me` (started before the first page's code finishes downloading) |
| Not signed in (401 from any call) | The API client sends the browser to `/auth/login?return_to=<current path>` once |
| Signed in, `None` on every object | "Access not granted yet" page; it re-checks every 15 s and has a "Check again" button |
| Group gate refused the login | `/access-denied` is a public SPA route with the standard wording; the web server may redirect there |
| `/api/me` has a shape this build cannot read | "A new version is available" page with a Reload button, **fail closed**: no navigation, no screens, no write controls. This is what an old cached app sees after the server gained an object type. It never retries the unreadable response |
| User opens a feature they lack the level for | "You do not have access to this" inside the shell |
| Unknown address | "Page not found" inside the shell |
| Browser offline | Banner on every screen; `WriteGuard` disables write controls with the reason |
| Levels change on the server | The session polls every 15 s: menu, screens and `WriteGuard` follow without a reload |

Sign-out is a plain link to `/auth/logout` (a full navigation; the server ends the session).

## Talking to the server

All `/api` traffic goes through `@/lib/api.ts`. Never call `fetch` for `/api` yourself.

```ts
import { api } from "@/lib/api.ts";
import { ideaListSchema } from "@ytw/shared/api/ideas"; // zod: fine inside a lazy feature chunk

const list = await api.get("/api/ideas", { query: { stage: "inbox" }, parse: ideaListSchema });
await api.patch(`/api/ideas/${id}`, { title, expected_version: idea.version });
```

- `api.get(path, options)`, `api.delete(path, options)`, `api.post/put/patch(path, body, options)`;
  options are `{ query, parse, signal, headers, rawBody }`. `parse` takes anything with
  `.parse(data)`, so a zod schema works directly; a mismatch throws `ResponseShapeError`. `rawBody`
  sends a `FormData`/`Blob`/text unchanged (uploads).
- Mutations (anything but GET/HEAD/OPTIONS) send the CSRF token from `/api/me` in `X-CSRF-Token`
  automatically (fetched first if needed; retried once if the server rotated it).
- Failures are typed, all with the server's readable message: `UnauthorizedError` (401, the login
  redirect has started), `ForbiddenError`, `NotFoundError`, **`ConflictError`** (409; `.latest` is
  what the server sent next to `error`), `ApiError` (anything else, `.status`), `NetworkError`
  (offline), `ResponseShapeError`. Use `isConflictError`, `describeError` from `@/lib/errors.ts`.

### Queries and live updates

TanStack Query is configured once (`lib/query-client.ts`): every active query refetches every **15 s**
(`LIVE_UPDATE_INTERVAL_MS`), not while the tab is hidden, and again on focus or reconnect; 4xx answers
and unreadable responses are not retried; **mutations never queue offline** (they fail at once).
That polling is the "agents' changes appear without a reload" requirement. A query that must not
refresh under the user (an editor's source document) sets `refetchInterval: false`.

**Query key convention**: the first element is the feature or resource (`["ideas", "list", filters]`,
`["ideas", id]`, `["scripts", ideaId, kind]`). The session is `["session"]`, notes are
`["notes", entityType, entityId]`. The dashboard's event poll (T47) invalidates by that prefix.

### Optimistic concurrency (never overwrite silently)

```tsx
const save = useMutation({
  mutationFn: (input: IdeaInput) =>
    api.patch(`/api/ideas/${idea.id}`, { ...input, expected_version: idea.version }),
  onError: (error) => isConflictError(error) && setConflict(error),
});

<ConflictDialog
  open={conflict !== null}
  entity="idea"
  error={conflict}
  changedBy={<LastChangedBy actor={latest.updatedBy} actorType={latest.actorType} at={latest.updatedAt} />}
  yours={<Preview draft={draft} />}
  latest={<Preview idea={latest} />}
  onReload={() => { setDraft(latest); setConflict(null); }}
  onMerge={() => { setDraft(mergeInto(latest, draft)); setConflict(null); }} // optional
  onKeepEditing={() => setConflict(null)}
/>;
```

The dialog offers reload, merge (only if you pass `onMerge`) and keep editing. There is no "save
anyway" and Escape or a click outside means "keep editing".

## UI kit (`import { ... } from "@/kit"`)

Everything is accessible by construction (labels, roles, focus, 44 px targets) and uses the colour
tokens, so light and dark need no extra work.

| Component | Use |
| --- | --- |
| `PageHeader` | The screen's single `h1` (also sets the tab title), description, `actions`, optional `back` link |
| `EmptyState`, `LoadingState`, `ErrorState` | The three states every screen needs. `compact` for in-card use; `LoadingState lines={n}` mirrors list content; `ErrorState error={e} onRetry` explains offline/forbidden/API errors |
| `Button` (`variant` primary/secondary/danger/ghost, `busy`), `buttonClasses()` | Buttons; `buttonClasses` styles a `<Link>` like one |
| `TextField`, `TextAreaField`, `SelectField` | Label + control + hint + error wired for assistive technology |
| `Dialog` | Native `<dialog>`: focus trap, inert page, Escape, focus returns to the opener; a bottom sheet on phones. Controlled (`open`, `onClose`), `dismissible={false}` for must-choose dialogs |
| `ConflictDialog` | The 409 flow above |
| `Alert`, `Badge`, `Card`, `Spinner` | Inline messages (danger/warn announce at once), status labels (meaning always in text), surfaces |
| `LastChangedBy` | "Last changed by **name** [Agent] 5 minutes ago": put it on every screen that edits something |
| `MarkdownView` | Agent- and user-written markdown, sanitised (below) |
| `NotesPanel entityType entityId` | Notes list + add form for an idea, script, video or experiment (`/api/notes`); needs Read on notes, form disabled without Write |
| `TimeSeriesChart`, `Sparkline` | uPlot charts (below) |
| `WriteGuard resource`, `useWriteGuard` | Disables the controls inside (a `<fieldset disabled>`) when the user lacks Write or is offline, with the reason in text; `whenReadOnly="hide"` hides instead. Children keep their state when the connection drops |
| `RequireAccess requires` | Shows its children (or the route outlet) only if the user satisfies a rule, e.g. an admin-only tab |
| `useOnlineStatus` | `false` while offline |
| `useWideLayout()` | Call from a screen that needs the full width (a kanban board) |

Session hooks (`@/lib/session.ts`): `useSession()` (`{ user, levels }`), `usePrincipal()` (a
`@ytw/policy` principal, so `grantOptions`, `describeLevels`, `can` work on it), `useLevel(resource)`,
`useCan(resource, level)`.

### MarkdownView

Raw HTML is never rendered (it shows as literal text); only `http`, `https`, `mailto` and same-page
`#fragment` links survive (others become plain text), external links open in a new tab with
`rel="noopener noreferrer nofollow ugc"`; **images are never loaded** (they become a link, so
markdown cannot fire a tracking request); headings are re-levelled below the page's own
(`headingStart`, default `h3`) and never skip a level; tables scroll inside their own box. The
renderer is a lazy chunk; the source shows as plain text until it arrives. A 70-payload XSS corpus
(`test/fixtures/xss-corpus.ts`) is rendered in the tests, and any new place that renders markdown
must use `MarkdownView` (T60 audits this).

### Charts

`TimeSeriesChart` takes `title`, `series` (`{ label, points: [{ x, y }] }[]`, memoise it), optional
`xKind="linear"` (retention curves: x is a number, not a time), `markers` (vertical lines such as
"Experiment started"), `valueFormat`, `yMin`, `height`. Up to four series are drawn in the validated
colour order; more stay in the table. `Sparkline` takes `values`, `label`, `width`, `height`.

Both are **lazy** (uPlot and its CSS download when the first chart renders, with a same-size
placeholder) and **accessible**: the figure has a name, a generated text alternative (range, lowest,
highest, latest per series), a "Show data table" disclosure with every value (latest 200 rows), and
markers listed as text. The canvas itself is not keyboard or screen-reader accessible, which is why
the table exists. Empty data shows an `EmptyState`, one point shows a dot, gaps (`y: null`) stay gaps.
Do not import `uplot` anywhere else and do not call `plot.redraw()` without `false`: right after a
plot is built it re-applies an empty x range and the chart paints axes but no lines.

## Styling rules

- Colours come from **tokens** (`src/styles/tokens.css`), never hex values: `bg-canvas`,
  `bg-surface`, `bg-subtle`, `border-line`, `border-line-strong` (controls), `text-ink`,
  `text-ink-muted`, `bg-brand text-brand-ink`, `text-link`, and the status pairs
  `text-danger bg-danger-soft` (`ok`, `warn`, `info` alike). Light/dark follows the system; there is no
  toggle. `test/node/tokens.test.ts` checks WCAG AA contrast of every pair in both schemes, so
  add a pair there when you add a token that carries text.
- Touch targets are at least 44 px (`min-h-11`); the kit's controls already are. No hover-only actions.
- Mobile first: design at 360 px, widen with `md:` (768 px and up is the desktop layout with a sidebar).
  Use the safe-area insets for anything fixed to a screen edge.
- **Never let a wide child set the width of a grid.** A bare `grid gap-4` has an implicit `auto`
  column, so a table or chart inside it widens the page on phones. Stack with `flex flex-col gap-4`
  or `grid grid-cols-1`, and put `min-w-0` on flex/grid children that hold tables or code.
- Do not use `dangerouslySetInnerHTML`. Anything from the database that is markdown goes through
  `MarkdownView`; everything else is rendered as React text.

## Bundle rules

`test/node/bundle.test.ts` builds the app for production and fails when:

- the initial download (entry chunk and its static imports) contains **zod**, **uPlot**, the
  markdown renderer, the dev mock layer or the gallery;
- the initial JavaScript exceeds 150 kB gzipped (about 119 kB today).

So: the shell and `lib/` import values from `@ytw/shared/constants` (zod-free) and `@ytw/policy`,
never from the `@ytw/shared` barrel. Import zod schemas (`@ytw/shared/api/<feature>`) only in code
that a lazy route loads. `NotesPanel`, charts and `MarkdownView` already follow this. Inside a
feature, prefer importing from `@/kit`; files under `src/app` and `src/lib` import individual kit
files.

## Testing a feature

Unit and component tests sit next to the code (`src/features/ideas/ideas.test.tsx`) or in `test/`.
Reusable helpers (import them with a relative path such as `../../../test/helpers/render.tsx`):

| Helper | What it gives you |
| --- | --- |
| `renderWithSession(ui, { session, route })` | Renders inside a query client, router and session; `personaSession("reader")` or `sessionWith({ ideas: "write" }, isAdmin)` build the user |
| `stubApi(persona, { notes })` | Installs the mock API as `fetch`; returns it (`api.requests`, `api.notes`, `api.setPersona`, `api.router.get(...)` to add routes) |
| `renderApp(features, route)` | The whole app (gate, shell, your routes) at a URL |
| `setOnline(false)` | Fires the browser's offline event |
| `expectNoA11yViolations(container)` | axe-core; colour contrast is checked by the token test and in browsers |
| `createTestQueryClient()` | No retries, no polling |

jsdom has no `<dialog>` modal support, no layout and no canvas: `test/setup.ts` shims `showModal()`
and tests replace `uplot` with a recorder (see `test/kit/charts.test.tsx`). Real focus trapping,
layout, touch-target sizes and contrast are checked in a browser (Playwright suites, T51).

### Mocking your own endpoints in development

Add `src/features/<id>/mock.ts` with a default export; the dev mock layer loads it automatically:

```ts
import { errorResponse, requireMockLevel, type MockRouter } from "@/dev/mock-api.ts";

export default function mock(router: MockRouter) {
  router.get("/api/ideas", () => ({ json: { ideas: [] } }));
  router.patch("/api/ideas/:id", (request) =>
    requireMockLevel(request, "ideas", "write") ?? errorResponse(409, "Stale", { latest: {} }),
  );
}
```

Mutations need the mock's CSRF token, exactly like the real server (the API client handles it).
Switch users with `?mock_persona=owner|collaborator|reader|newcomer|anonymous`.
Production builds never load the dev layer, so `mock.ts` files cost nothing there.

## Not done here / hand-offs

- Against the real web server (T40): the shell was built and tested against the mock of the contract
  in `packages/shared/src/api/session.ts`; run it against T40 once it lands (login redirect, CSRF
  header name, `/api/me` body).
- `/api/notes` routes are T41b; `NotesPanel` is tested against the mock of that contract.
- PWA (T50): the "new version available" page calls `browser.reload()` (`lib/navigation.ts`); T50
  should make a new service-worker build take over before that reload so it actually fetches the new
  build. The offline banner and `WriteGuard` are in place; caching is T50.
- Pull-to-refresh, per-screen mobile polish and the axe/Playwright sweep over every screen are T51.
