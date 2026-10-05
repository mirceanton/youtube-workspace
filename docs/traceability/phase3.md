# Phase 3 web gate

Task T49, reviewed against PRD section 2 stories and sections 6 and 7 on 2026-10-04.
Status: **Phase 3 implemented and CI validated; hosted Keycloak end-to-end acceptance passed**.
The work was merged in [PR #7](https://github.com/mirceanton/youtube-workspace/pull/7) at
`d7cb8ae9`; its [CI run](https://github.com/mirceanton/youtube-workspace/actions/runs/37241526833),
[OIDC E2E run](https://github.com/mirceanton/youtube-workspace/actions/runs/37241526840)
and [Keycloak smoke run](https://github.com/mirceanton/youtube-workspace/actions/runs/37241526759)
passed against PR head `849e83c`. This verifies the code and hosted test environment; it does not
mean the application has been deployed to production. Every section 2 story has a passing browser
scenario, and every declared feature API route has permission-matrix evidence.

## Evidence and execution

The Playwright runner creates a unique, migrated PostgreSQL database, launches the real web
server, MCP server and SPA, and drops only its own database afterwards. The mock mode replaces
the identity provider only; it does not mock the database, APIs or MCP service. Test setup writes
through the same authenticated HTTP APIs as the app. The shared PostgreSQL cluster is retained.

Commands run from the repository root:

```sh
E2E_IDP=mock pnpm --filter @ytw/e2e test:e2e
pnpm test
pnpm lint
pnpm build
pnpm format:check
actionlint -shellcheck= .github/workflows/lint.yaml .github/workflows/test.yaml .github/workflows/docker.yaml .github/workflows/e2e.yaml .github/workflows/keycloak-smoke.yaml .github/workflows/release.yaml
```

Final local browser result: **12 passing tests (30.9 seconds)**, including the mock OIDC flow.
The MCP revision became visible in the already-open phone reader in **14,529 ms**, with no
navigation or reload (the preceding run measured 14,523 ms). TypeScript, lint, formatting,
workflow lint and production build pass. The final combined Vitest run has **131 passing files /
3,793 passing tests (60.29 seconds)**, with no skipped tests.
Workflow lint disabled shellcheck integration because the local shellcheck shim was unavailable.
Hosted Keycloak validation is recorded by the successful OIDC E2E and smoke runs linked above;
the local mock OIDC run is separate evidence.

## PRD section 2 stories

| Story | Browser evidence under `e2e/` | Status |
| --- | --- | --- |
| See ideas and drag to the next stage | `stories/user-stories.spec.ts`: owner drag, persisted stage and actor; backward move rejects a missing note | Pass |
| Read a script on a phone and comment | `stories/user-stories.spec.ts`: 390×844 reader, rendered body, saved human comment via real API | Pass |
| Compare experiment variants and identify the winner | `stories/user-stories.spec.ts`: both variants, CTR and impressions, start, winner and conclusion | Pass |
| Download, edit and upload script Markdown without overwriting | `stories/user-stories.spec.ts`: MCP file export/import, revision 2 visible, stale upload returns 409; `stories/activity-live.spec.ts`: revision appears in already-open phone reader within 15 seconds | Pass |
| Generate scoped API tokens and revoke them | `stories/user-stories.spec.ts`: one-time secret, 90-day expiry, MCP read succeeds, immediate revoke fails with 401 | Pass |
| Set user permissions in one settings screen | `stories/access.spec.ts`: real matrix grants, API enforcement, allowed token options, excessive grant rejected, lower owner levels immediately lower tokens | Pass |
| See which human or agent changed an item, and when | `stories/activity-live.spec.ts`: human and agent events, filters, timestamps, token ID/owner audit payload, activity-denied reader | Pass |
| Clear conflict with two sessions and no overwrite | `stories/user-stories.spec.ts`: concurrent drafts, clear 409 dialog, preserved losing draft, discard/reload, exactly two stored revisions | Pass |

## PRD section 6 web review

Paths in the following table are repository relative. API tests use real PostgreSQL; feature UI
unit tests supplement the real-service browser stories.

| Area / behavior | Implementation and evidence | Status |
| --- | --- | --- |
| Dashboard stage counts, running experiments, latest published videos/metrics, last 20 events | `apps/web-server/src/routes/dashboard/dashboard.test.ts`; `apps/web-ui/src/features/dashboard/DashboardPage.test.tsx`; browser restricted-summary assertions | Pass |
| Ideas board/table, filtering, create/edit, validated moves/back-note, linked detail | `apps/web-server/src/routes/ideas/ideas.test.ts`; `apps/web-ui/test/features/ideas.test.tsx`; board story | Implemented; browser core pass |
| Scripts per idea/kind, history and arbitrary diff, reader, append-only edit, files, status and comments | `apps/web-server/src/routes/scripts/scripts.test.ts`; `apps/web-ui/test/features/scripts/`; phone, MCP and concurrent-session stories | Implemented; browser core pass |
| Experiments list/detail, comparison, video CTR series, winner/conclusion | `apps/web-server/src/routes/experiments/experiments.test.ts`; `apps/web-ui/test/features/experiments/Experiments.test.tsx`; compare story. CTR chart labels its source as overall video snapshots because variant time series are not stored | Implemented; browser core pass |
| Videos latest metrics and time series, retention, originating idea | `apps/web-server/src/routes/videos/videos.test.ts`; `apps/web-ui/test/features/videos.test.tsx` | Pass |
| Filtered human/agent activity and permission-respecting search | Activity/search API and feature tests; `stories/activity-live.spec.ts`: actor/entity filters, human/agent fidelity, script-only search, sanitized snippet, restricted activity | Pass |
| Settings profile/access, tokens, admin matrix | `apps/web-server/src/routes/settings/settings.test.ts`; `apps/web-ui/test/features/settings/`; token and access stories | Implemented; browser core pass |
| Agent updates without manual reload within 15 seconds | `LiveUpdatePoller.tsx`, `live-updates.test.tsx`, activity snapshot/cursor tests; browser MCP upload → already-open phone reader in 14,529 ms | Pass |
| Conflicts offer reload/merge and preserve drafts | Script conflict story; `apps/web-ui/test/kit/ConflictDialog.test.tsx`; feature conflict tests | Browser pass |
| Last changed actor shown on mutation screens | `LastChangedBy`, script/idea/video/experiment details; persisted actor assertion in board story and filtered audit story | Pass |
| Empty/loading/error states | Shared states plus feature tests, T47 screen tests and `SettingsFailures.test.tsx` | Pass |
| System light/dark themes and a11y baseline | `apps/web-ui/test/node/tokens.test.ts` verifies AA text/UI contrast in both schemes; shell focus/skip-link tests, semantic controls, labelled native dialogs and charts with data alternatives | Baseline pass; exhaustive viewport/axe/mobile pass is T51 |

## PRD section 7 authentication and access

| Requirement | Evidence | Status |
| --- | --- | --- |
| Authorization Code + PKCE, confidential BFF, server-side provider tokens | `apps/web-server/test/auth.test.ts`; `e2e/flows/oidc.spec.ts`; token story checks browser storage remains empty | Local and hosted Keycloak CI pass |
| Group gate, outsider creates no user, repeated at refresh | OIDC browser flow verifies denial and DB state, group-removal refresh revocation | Mock and hosted Keycloak CI pass |
| Session cookie flags, validation, discovery, session timeouts, env settings | `auth.test.ts`, `env.test.ts`, `app.test.ts` | Pass |
| RP-initiated provider logout | OIDC browser flow returns to provider credential form | Mock and hosted Keycloak CI pass |
| Unauthenticated API requests return 401 and pages redirect to login | OIDC flow and all-route anonymous probes | Browser pass |
| None/Read/Write enforced from current stored levels for each object | `stories/route-authz.spec.ts`: all 41 declared API routes × None/Read/Write plus anonymous requests; orthogonal video/experiment restrictions and search/resource privacy | Pass |
| None everywhere shows access-not-granted | OIDC browser flow | Pass |
| Atomic first-user admin, last-admin protection, shared policy | OIDC first-admin flow; `packages/db/test/identity.test.ts`, `permissions.test.ts`; `packages/policy/test/` | Pass |
| Human actor set through DB functions | Persisted owner actor on moved idea and saved comment; route tests | Browser pass |
| Token never exceeds owner; lowering owner immediately lowers token | Access story: invalid write grant, allowed UI values, immediate MCP 403 after lowering | Pass |
| Expiring, one-time, hashed token secrets; own tokens edit/rotate/revoke, last use | Token story; settings route/feature tests; `packages/tokens/test/`; MCP gate token-lifecycle tests | Pass |
| Bearer token cannot serve as browser login; audit token identity/owner | Token browser story asserts valid MCP bearer alone gets web 401; activity story checks token ID, agent type and owner payload | Pass |
| Profile read-only, own token list, admin matrix, phone detail screens | Settings feature tests and access story; phone controls audited in T51 | Core browser pass |
| Keycloak development realm export and CI flow | `dev/keycloak/`, `.github/workflows/e2e.yaml` | Hosted OIDC E2E and smoke checks passed; see links above |

## Route authorization evidence

`stories/route-authz.spec.ts` covers 41 declared API method/path pairs, including `/api/me`,
ideas (6), scripts (7), videos (4), experiments (8), notes (2), settings profile (1), tokens (5),
admin access (3), dashboard (1), activity (2), and search (1). Each receives anonymous and
None/Read/Write requests. Activity allows only
None/Read; the Write matrix case grants its maximum allowed Read. Admin routes remain forbidden
for every non-admin resource level, while the real admin access story proves permitted changes.

Authorized read requests reach valid data or the expected 404 for a nonexistent entity. Mutation
probes deliberately use invalid bodies (400) or nonexistent owned-token IDs (404) to distinguish
permission rejection from authorized request validation without mutating fixture versions.
Successful mutations and their persisted results are verified by separate browser stories and
the feature API integration tests. Permission denial is asserted as 403 before input validation.
The matrix also verifies that experiment read/write alone cannot expose video CTR or choices.
The web-server route registration test rejects every API route missing a resource guard.
The search privacy story additionally verifies that notes-only access cannot authorize search,
script-only readers receive no idea title or idea result, and snippets create no executable markup.
The dashboard omits unreadable summaries and audit data; change hints expose only resource names
and an opaque cursor, allowing live updates without granting activity-log access.

## Defects fixed during the gate

- Kanban title links could shrink to zero width beside the score badge and drag handle. The card
  header now uses two columns and puts the badge on its own row; the browser drag story asserts
  that the moved idea title remains visible and clickable.
- Experiment chart marker construction used a type predicate wider than its inferred string-only
  input. The equivalent typed-array correction is included in approved T47, which the gate retains.
- Mock OIDC preparation did not restore collaborator group membership after the T48 revocation
  scenario. Independent story files now restore fixture memberships through the provider's
  existing authenticated test API before signing in. Real Keycloak preparation already does this.
- Repeated Keycloak story setup would delete/recreate the collaborator, leaving duplicate username
  records with different OIDC subjects in the shared disposable database. Runner-level preparation
  now keeps one subject for the full run; per-file setup restores groups and final cleanup restores
  the original realm and removes only a collaborator created by this runner.
- The resource-extension integration fixture used migration number 0200, now taken by T47's real
  transaction-XID migration. It now picks the next version after the copied migration history;
  no applied production migration was changed.
- CI/E2E/Keycloak-smoke push filters omitted the `codex/` integration branch. Their allowed push
  branches now include `codex/**`; release and image-publication workflows retain their existing
  release rules. The other workflows are reusable or main-only release orchestration.

## Deployment and remaining scope

Phase 3 implementation and hosted Keycloak acceptance are complete. The linked GitHub Actions runs
validate the PR branch and test environment; they do not establish a production deployment or
production Keycloak configuration. Those remain deployment-specific work. Phase 4 PWA/mobile,
scale and security gates remain T50–T63 as defined in PLAN.md.
