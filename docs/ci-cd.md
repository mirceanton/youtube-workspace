# CI/CD

How the repository is built, checked, scanned, packaged and released with GitHub Actions. The
pipelines are adapted from the owner's `model-hub` project; the differences are listed at the end.
Local setup is in [`development.md`](development.md), conventions in [`../CLAUDE.md`](../CLAUDE.md).

## What you must configure (nothing runs by itself until you do)

The workflows work on a fresh clone without any secret, **except releasing**. Do these in the
repository settings on GitHub, in this order of importance.

| # | Where | What | Needed for |
| --- | --- | --- | --- |
| 1 | Settings, Secrets and variables, Actions, **Secrets** | `BOT_APP_ID` (the GitHub App's numeric App ID) and `BOT_APP_PRIVATE_KEY` (the whole PEM private key, including the `BEGIN`/`END` lines) | `release.yaml` |
| 2 | The GitHub App itself | A GitHub App (the one used by `model-hub` works if it is installed on this repository too) with **Repository permissions: Contents = Read and write** (Metadata = Read is implied), installed on this repository. It is used instead of `GITHUB_TOKEN` because a release created by `GITHUB_TOKEN` does not trigger other workflows, so the images would never be published. If the same App and secrets are already defined as organization secrets, step 1 is already done as long as this repository is allowed to read them | `release.yaml`, `docker.yaml` publishing |
| 3 | `.github/workflows/release.yaml` | Uncomment the two `schedule` lines to start the nightly release. Do this only after steps 1 and 2 and after one successful manual **dry run** (Actions, Release, Run workflow, keep "Dry run" ticked) | Nightly releases |
| 4 | Settings, Code security | Private repository only: CodeQL and dependency review need GitHub Code Security (a paid add-on of the `mirceanton` organization). If you enable it, also set the repository **variable** `CODE_SECURITY_ENABLED` to `true` (Settings, Secrets and variables, Actions, Variables). Making the repository public enables both jobs without the variable. Do not also switch on CodeQL "default setup": the two conflict. Until then the two jobs are reported as skipped | `ci.yaml` jobs `codeql`, `dependency-review` |
| 5 | Settings, Code security | Turn on the dependency graph and Dependabot alerts (they feed dependency review and the security tab) and, if your plan offers it, secret scanning with push protection | Defence in depth |
| 6 | Settings, Actions, General | Workflow permissions can stay on the default; every workflow declares its own `permissions`. Keep "Allow GitHub Actions to create and approve pull requests" off | Least privilege |
| 7 | Renovate | The shared preset `github>mirceanton/renovate-config` is used by `.renovaterc.json`. The Renovate app must be installed on this repository; merging `.renovaterc.json` to `main` completes its onboarding PR (`renovate/configure`) | Dependency updates |
| 8 | After the first release | ghcr.io packages `youtube-workspace-web` and `youtube-workspace-mcp` are created private and linked to this repository by the publish job. Change their visibility under the package settings if you want them public, and keep "Actions access" set to this repository with Write | Pulling images |
| 9 | When pull requests start | Branch protection on `main`: require the checks `Lint, typecheck and build`, `Unit and integration tests`, `Image web`, `Image mcp` and `Dependency, filesystem and secret scans`. Pull request runs are not path filtered, so these always report. See "Required checks and skipped runs" below | Merge gate |

Everything else (the `GITHUB_TOKEN`, the ghcr.io login, the build cache) uses the automatic token.

## Workflows

All workflow files are in `.github/workflows/`. Every action is pinned to a commit SHA with the
release in a trailing comment (`# v7.0.1`); Renovate keeps both in step. Every workflow starts from
`permissions: { contents: read }` and a job asks for more only where it needs it. Tool versions
come from `.mise.toml` (`jdx/mise-action`, then `mise exec -- ...`), so CI uses the Node, pnpm and
actionlint versions a developer gets from `mise install`.

| Workflow | Runs on | Jobs |
| --- | --- | --- |
| `ci.yaml` | push (not documentation-only), pull request, manual, **weekly** | `check`, `test` (always), `images`, `scan`, `codeql` (heavy, see "What runs when"), `dependency-review` (pull requests, when the repository allows) |
| `docker.yaml` | **release published** | `publish` first requires a green `ci.yaml` run on `main` for the release commit (`verify-ci.sh`, so a release made by hand on an arbitrary commit is not published), smoke-tests the amd64 image, then builds amd64 and arm64 with an SBOM and max-mode provenance and pushes to ghcr.io |
| `release.yaml` | **manual only** (nightly schedule disabled) | `verify-ci` requires a green `ci.yaml` run on `main` for the commit (`verify-ci.sh`); `release` creates the next semantic version and GitHub release from the conventional commits since the last release, with an App token limited to `contents: write` on this repository |
| `keycloak-smoke.yaml` | its own path filter | Owned by the Keycloak task; not described here |

The jobs of `ci.yaml`:

| Job | What it does |
| --- | --- |
| `check` | `actionlint` over the workflows; the tests of the CI helper scripts (`.github/scripts/test-scripts.sh`); a gitleaks scan of the commits the push added (`.github/scripts/scan-new-commits.sh`, a few seconds, so a secret committed in ordinary source is found on the push that adds it); `pnpm lint` (`tsc -b` + oxlint); `pnpm format:check`; `pnpm build` (every package and the Vite bundle) and a check that the entry points exist. This is the PRD "lint and build on every pull request" gate. It also decides whether the heavy jobs run |
| `test` | Starts a `postgres:16` service (healthcheck `pg_isready`), exports `MIGRATION_DATABASE_URL` and `TEST_DATABASE_URL`, runs `pnpm migrate` twice (the second run must be a no-op), then `pnpm test` (unit and integration, every vitest project) and `pnpm --filter @ytw/policy test`, which runs with `--coverage` and enforces the 100 % gate that the root run cannot (vitest ignores per-package thresholds there) |
| `images` | Per image (`web`, `mcp`): plants local-only files in the build context (`docker/plant-local-files.sh`), builds the image for linux/amd64, runs `docker/smoke.sh`, scans it with Trivy (HIGH and CRITICAL, fixable only). On `main`, the weekly run and manual runs it also builds linux/arm64 under QEMU without publishing |
| `scan` | `pnpm audit --audit-level=high`; Trivy filesystem scan (secrets and Dockerfile misconfiguration); gitleaks over the whole git history with `.gitleaks.toml`; a self-test that the secret scan still catches planted secrets. The steps are independent, so one finding does not hide the others. Dependency vulnerabilities are found by `pnpm audit` and by the Trivy image scans (their node-pkg targets), not by the Trivy filesystem scan: Trivy does not parse pnpm 12's two-document `pnpm-lock.yaml`, so that scan lists no lockfile (`vuln` stays enabled so it starts to once Trivy does) |
| `codeql`, `dependency-review` | See step 4 above; skipped while the repository is private without Code Security |

### What runs when

Every push to `main`, `claude/**` and `renovate/**` is considered. The integration branch has no
pull request flow yet, so it is built like `main`; with many agents pushing, the cost of a push
matters.

| Push | Jobs started |
| --- | --- |
| Only `docs/**`, `*.md` or `LICENSE` changed | **None** (`paths-ignore` on the push trigger) |
| Anything else on `claude/**` or `renovate/**` | `check`, `test` |
| Same, and the **head commit message contains `[ci full]`** (any case) | `check`, `test`, `images` x2, `scan` (`codeql` when allowed) |
| Same, and the push changed `docker/**`, `.dockerignore`, `.gitleaks.toml`, `.gitleaksignore`, `.trivyignore`, `trivy.yaml`, any `.npmrc`, `.github/workflows/**`, `.github/actions/**`, `.github/scripts/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, the root `package.json` or `apps/web-server/src/env.ts` / `apps/mcp/src/env.ts` (a new required variable needs a placeholder in `docker/smoke.env`) | the same full set |
| Push to `main`, pull request, manual run, weekly schedule | the full set, always |

Measured on the integration branch (GitHub bills every runner job rounded up to a whole minute):

| Push | Runner jobs | Billed minutes | Wall time |
| --- | --- | --- | --- |
| Documentation only | 0 | 0 | none |
| Normal (`check`, `test`) | 2 | 2 | about 1 minute |
| Full (`[ci full]`, relevant path, `main`) | 5 | 6 to 7 | under 2 minutes with warm caches |
| Before this restructuring (lint, test, build, security and docker workflows on every push) | 11 | 15 (17 with the arm64 build) | about 2 minutes |

`.github/scripts/ci-gate.sh` makes the decision from the event, the commit message and the file list
of the push (GitHub compare API, no checkout needed). It fails open: the heavy jobs run when the
files cannot be listed, when the push is not a plain fast-forward (force push, branch moved back) and
when the comparison lists 300 files, because GitHub truncates the list there. Only the **head**
commit message counts, so put the token in the last commit of a push. GitHub itself skips every
workflow for a push whose head commit message contains `[skip ci]`, `[ci skip]`, `[no ci]`,
`[skip actions]` or `[actions skip]`; on `claude/**` that skips even `check` and `test`, so do not use
them there (on `main` the release gate still needs a green run). The heavy jobs wait for `check`, so a push that fails lint does not
spend minutes on images and scans. A normal code push therefore runs the image build, the Trivy
scans, the full history scan and CodeQL only when you ask for them or when `main` or a pull request
does: use `[ci full]` for gate tasks and before a hand-off. Pull requests are never path filtered.

Runs are grouped per commit and are never cancelled by a later push, so every commit of the shared
branch keeps a result (only a pull request run is cancelled when the pull request gets a newer
push). Runner minutes are the cost to watch; once the build-out is finished,
`concurrency.cancel-in-progress` in `ci.yaml` can be switched to `true` for pushes.

The caches that keep the light jobs short: `jdx/mise-action` caches the mise tool installs (keyed
on `.mise.toml`), `.github/actions/setup` caches the pnpm store (keyed on `pnpm-lock.yaml`), and
the image builds use the GitHub Actions layer cache (one scope per image).

### Required checks and skipped runs

`paths-ignore` is on the **push** trigger only. A workflow that does not start reports no checks, and
a required check that never reports blocks a merge, so the pull request trigger has no path filter:
the five checks above always report on pull requests, and jobs skipped by their own `if` (`images`,
`scan`, `codeql`) count as passing. Keep it that way if you add branch protection: do not add
`paths`/`paths-ignore` to the `pull_request` trigger of `ci.yaml`, and do not require a check that
only some pushes produce. A documentation-only push to `main` therefore has no run of its own.
`.github/scripts/verify-ci.sh` (used by `release.yaml` and `docker.yaml`) looks only at runs on
`main`. The `ci.yaml` push run of the commit itself decides when there is one. Without one, the
commit inherits the latest run on `main` only if that run is green, the commit descends from it
(compare status `ahead` or `identical`; a commit that is behind it, such as an old release run that
is re-run after `main` moved on, or on another line of history is refused), the comparison lists
fewer than 300 files, and all of them are documentation.

### Release flow

1. A manual (or, once enabled, nightly) run of `release.yaml` on `main` checks that CI is green for
   the head commit (`verify-ci.sh`; `docker.yaml` repeats the check), asks `mirceanton/action-semver-release` for the next version
   from the conventional commits (`feat` = minor, `fix` = patch, `!` or `BREAKING CHANGE` = major)
   and, unless it is a dry run, creates the tag `vX.Y.Z` and the GitHub release using the GitHub
   App token.
2. Publishing the release triggers `docker.yaml`, which pushes both images:

   | Image | Tags |
   | --- | --- |
   | `ghcr.io/mirceanton/youtube-workspace-web` | `X.Y.Z`, `X.Y`, `X` (not for 0.x), `latest` (not for pre-releases) |
   | `ghcr.io/mirceanton/youtube-workspace-mcp` | the same |

3. Nothing in this repository publishes an image or creates a release on its own. No workflow
   pushes to a registry except `docker.yaml`, which only runs for the `release: published` event.

## Images

`docker/web.Dockerfile` (web server plus the built web UI) and `docker/mcp.Dockerfile` (MCP
server). The build context is the repository root; `.dockerignore` removes history, agent tooling,
dependencies, build output and every local-only file at any depth (`**/.env`, `**/.env.*` except
`**/.env.example`, key files, saved login state, local mise configs): `.dockerignore` patterns are
anchored at the context root, unlike `.gitignore`, and per-process secrets live in `apps/<app>/.env`.
Both Dockerfiles have the same shape:

- **build stage** (`node:24.21.0-slim` + corepack): `pnpm fetch` from the lockfile alone (a cached
  layer), `COPY . .`, `pnpm install --offline --frozen-lockfile`, build, then
  `pnpm --filter <service> deploy --prod --legacy` to extract the service with only its production
  dependencies. Sources and compiled tests are removed from the extracted tree.
- **runtime stage**: the same Node base, `NODE_ENV=production`, npm/corepack/yarn removed, runs as
  the numeric user `1000:1000`, `HEALTHCHECK` through `node` (the slim image has no curl),
  `CMD ["node", "service/dist/src/index.js"]`. The application code is owned by root, so the
  runtime user can run it but not change it; nothing under `/app` needs to be writable.
- Keep the Node version in `.mise.toml` and in both `FROM node:...-slim` lines the same.

Runtime contract with the applications:

| Image | Port | Environment set by the image | Supplied by the deployment |
| --- | --- | --- | --- |
| web | `3000` | `PORT`, `APP_VERSION`, `GIT_SHA`, `STATIC_WEB_DIR=/app/web-dist` | `DATABASE_URL` (role `ytw_web`), `OIDC_*`, `SESSION_*`, `LOG_LEVEL` |
| mcp | `3001` | `PORT`, `APP_VERSION`, `GIT_SHA` | `DATABASE_URL` (role `ytw_mcp`), `READONLY_DATABASE_URL`, `LOG_LEVEL` |

- **Version stamp.** `APP_VERSION` and `GIT_SHA` are build args declared in the *runtime* stage and
  copied into `ENV`, which is where the apps read them (`/healthz` reports them). Build args that
  are declared only in an earlier stage, or only as `ARG`, never reach the running process; that was
  the bug in `model-hub`. CI passes the release version (or `0.0.0-ci.<sha7>` outside releases)
  and the commit, and `docker/smoke.sh` fails if `/healthz` does not echo them back.
- **Static files.** The web server must serve the single-page app from the directory in
  `STATIC_WEB_DIR` (the same variable name `model-hub` uses). Until the web server reads it, the
  variable is ignored harmlessly.
- **Migrations are not run when a service starts.** Run them as a separate job or init step before
  starting new versions. The images have no pnpm; once a service depends on `@ytw/db` its image
  carries the package with its `migrations/*.sql`, so the same image can be the migration job:
  `docker run --rm -e MIGRATION_DATABASE_URL=... <image> node service/node_modules/@ytw/db/dist/src/bin/migrate.js`
  (working directory `/app`; exits 2 without `MIGRATION_DATABASE_URL`). Pass the privileged
  connection string to that one command only. In development, `pnpm migrate` does the same.

### Smoke test

`docker/smoke.sh <image> <service> <port> <version> <commit> [<sentinel>]` (used by `ci.yaml` and
`docker.yaml`, runnable locally) checks that

- the image runs as a non-root user, root owns everything under `/app` and the runtime user cannot
  write to the application directory;
- no local-only file is in the image: no `.env` or `.env.*` other than `.env.example`, no `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, local mise config, `.git`, `.claude` or `.auth` anywhere under `/app`
  (third-party packages in `node_modules/.pnpm` are skipped, workspace packages are not), and, when a
  sentinel is passed, no file containing it. In CI the `images` job first plants such files at several
  depths with `docker/plant-local-files.sh` (`apps/<app>/.env`, `packages/*/.env.local`, key files,
  saved login state, ...) and passes its sentinel, which proves `.dockerignore` end to end. The
  script refuses to overwrite existing files, so run it only in a clean checkout, and `--remove`
  deletes what it planted;
- once the service depends on `@ytw/db` (its `node_modules/@ytw/db` exists; until then the step is
  skipped on purpose), the package has at least one `migrations/*.sql` file and its migration command
  starts and exits with 2 without `MIGRATION_DATABASE_URL`;
- Docker reports the container healthy using the image's own `HEALTHCHECK`, and `/healthz` returns
  `status: ok`, the service name and the stamped version and commit.

The container gets `docker/smoke.env`. When a service starts requiring another environment variable
at boot, add a placeholder value for it to that file in the same change; the failure shows the
service's own "Invalid environment" message.

## Secret scan and its allowlist

The `scan` job runs the gitleaks CLI (version pinned in `ci.yaml`, installed and verified by mise)
over the whole git history with `.gitleaks.toml`, which extends gitleaks' default rules. The `check`
job, which runs on every push, scans only the commits that push added (`scan-new-commits.sh`, a few
seconds; a new branch or rewritten history is scanned in full). The
gitleaks GitHub Action is not used because it needs a license key for organization-owned
repositories; the CLI is MIT licensed.

A single finding that is already in pushed history can also be acknowledged by its exact
fingerprint (`commit:file:rule:line`, as gitleaks prints it) in `.gitleaksignore`; the history of the
integration branch cannot be rewritten. That is the preferred way to accept a one-off false
positive. `.gitleaks.toml` is for classes of fixtures that will keep coming back, and contains two
allowlists and nothing else.

1. **The redaction fixtures.** The tests of `@ytw/observability` need fake credentials
   (`packages/observability/test/helpers.ts`, the `SECRET` fixtures: an API token, a JWT, a
   password, a client secret and a database password, all invented). The tests prove that these
   exact values never reach a log line, so they have to look like real credentials. The allowlist
   uses `condition = "AND"`: a finding is ignored only if it is in that file **and** its line
   contains one of the five fake values. A real secret added to the same file, or one of the fake
   values in any other file, is still reported. If you add another fake credential to that fixture,
   add its literal value to the list in `.gitleaks.toml`; do not widen the path or use a pattern.
2. **Token row ids.** API token ids are UUIDs (a database primary key); a secret token is `ytw_`
   followed by random characters, never a UUID. The generic rule reads `tokenId: "<uuid>"` in test
   code (first seen in `packages/db/test/audit.test.ts`) as a credential. The allowlist applies to
   the `generic-api-key` rule only, tests the matched text rather than the line (so another secret on
   the same line is still reported) and requires a UUID after a key named `tokenId` or `token_id`
   (so a real token assigned to that key is still reported).

`.github/scripts/test-gitleaks.sh` runs in the `scan` job after the scan and keeps both allowlists
honest: it builds throwaway repositories and requires that a planted token is reported in
application code, inside the allowlisted file and under a `tokenId` key, that a fake value is
reported in another file, and that the fake value and a UUID row id are accepted where the allowlists
say. The fixtures are generated at run time, so nothing in the repository looks like a credential to
the scanner. A finding stays in the history scan for as long as its commit is reachable, so a false
positive that is already pushed can only be accepted by a rule or a fingerprint; a real secret must
be rotated, never allowlisted.

## Extending CI

- **Integration tests** find Postgres through `TEST_DATABASE_URL`
  (`postgres://postgres:postgres@localhost:5432/postgres`, the superuser of the `postgres:16`
  service); the `@ytw/db` harness creates one database per test file there and never falls back to
  `MIGRATION_DATABASE_URL`, which only `pnpm migrate` uses (`docs/database.md`, "Test harness").
  A harness that wants another variable exports it in the `env:` block of the `test` job as well.
- **A package with its own enforced coverage threshold** needs a separate step in the `test` job
  (`pnpm --filter <package> test`, as for `@ytw/policy`), because the root `pnpm test` runs every
  package as a vitest project and vitest ignores per-package thresholds there.
- **A new required environment variable in a service** needs a placeholder in `docker/smoke.env`.
- **A new workspace package** is picked up by every workflow and by the Docker build context
  automatically (`pnpm-workspace.yaml` lists the folders); do not add its folder to `.dockerignore`.
- **A path that can change an image or a scan result** belongs in the `relevant` pattern of
  `.github/scripts/ci-gate.sh` (with a case in `test-scripts.sh`), otherwise a normal push to
  `claude/**` will not run the heavy jobs for it.
- **A new workflow** follows the pattern of the existing ones: pinned action SHAs with a version
  comment, `permissions: { contents: read }` at the top, `persist-credentials: false` on checkout,
  a `timeout-minutes`, and untrusted values (`github.event.*`) only through `env:`, never inside
  `run:` scripts.

## Reproducing CI locally

```bash
mise install                              # same toolchain as CI
pnpm install --frozen-lockfile
mise exec -- actionlint                   # ci.yaml, check: workflow syntax
.github/scripts/test-scripts.sh           # ci.yaml, check: the gate and release-gate scripts
pnpm lint && pnpm format:check            # ci.yaml, check
pnpm build                                # ci.yaml, check
scripts/pg-local.sh start                 # a Postgres 16, like the test job's service
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/youtube_workspace pnpm migrate
pnpm test && pnpm --filter @ytw/policy test   # ci.yaml, test
pnpm audit --audit-level=high             # ci.yaml, scan
docker build -f docker/web.Dockerfile --build-arg APP_VERSION=0.0.0-dev --build-arg GIT_SHA="$(git rev-parse HEAD)" -t ytw-web:dev .
docker/smoke.sh ytw-web:dev web-server 3000 0.0.0-dev "$(git rev-parse HEAD)"
# to prove .dockerignore as CI does (clean checkout only): sentinel=$(docker/plant-local-files.sh),
# build, pass "$sentinel" as the sixth argument of smoke.sh, then docker/plant-local-files.sh --remove
```

## Differences from model-hub

| | model-hub | This repository |
| --- | --- | --- |
| Workflows | `lint`, `test`, `release`, `docker` | one `ci.yaml` (merged to save setup cost), plus `docker` (publish) and `release` |
| Triggers | `main` and `renovate/**` pushes, PRs to `main` | the same plus `claude/**` pushes (no pull request flow yet), documentation-only pushes skipped, heavy jobs gated |
| Postgres | none (SQLite) | `postgres:16` service with a healthcheck, migrations applied twice |
| Build gate | none | the `check` job |
| Scanning | none | pnpm audit, Trivy (filesystem and images), gitleaks CLI with a narrow allowlist, CodeQL and dependency review when the repository allows |
| Images | one | two (`web`, `mcp`), smoke-tested, SBOM and provenance when published |
| Release | schedule on, no CI check | schedule off, dry run by default, requires green CI on the commit (also before images are pushed), scoped App token |
| Version stamp | not surfaced to the process | `APP_VERSION` / `GIT_SHA` in `ENV`, asserted by the smoke test |
| Base image | Playwright image (about 4 GB) | `node:24.21.0-slim`, no package managers in the runtime stage |
| Docker cache | gha | gha, one scope per image |

## Known limits and follow-ups

- The arm64 images are built under QEMU, which is slow, so arm64 is verified on `main` (including
  the weekly run), on request (`ci.yaml` manual run) and when a release is published, not on every
  push.
- `mise` has no lockfile here (it cannot be generated in the agent sandbox). `model-hub` commits a
  `mise.lock`, and the shared Renovate preset refreshes it with `mise lock`; run `mise lock` once on
  a machine with mise and commit the result to get checksum-verified tool installs in CI.
- The base image is pinned by tag, not by digest. Renovate does not add digests to Docker images in
  the shared preset; the weekly Trivy scan and the tag bumps cover patch updates.
- Trivy runs with `--ignore-unfixed` and fails on HIGH and CRITICAL findings only. A finding that
  cannot be fixed can be recorded in a `.trivyignore` file with a comment and an expiry date.
- Pushes to `claude/**` do not run the image build, the Trivy scans, the full history scan or CodeQL
  unless a relevant path changed or `[ci full]` is used. A secret committed in ordinary source is
  still found on the push that adds it, by the per-push scan in `check`.
