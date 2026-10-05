# CI/CD

How the repository is built, checked, packaged and released with GitHub Actions. The pipelines are
adapted from the owner's `model-hub` project; the differences are listed at the end. Local setup is
in [`development.md`](development.md), conventions in [`../CLAUDE.md`](../CLAUDE.md).

## What you must configure (nothing runs by itself until you do)

The workflows work on a fresh clone without any secret, **except releasing**. Do these in the
repository settings on GitHub, in this order of importance.

| # | Where | What | Needed for |
| --- | --- | --- | --- |
| 1 | Settings, Secrets and variables, Actions, **Secrets** | `BOT_APP_ID` (the GitHub App's numeric App ID) and `BOT_APP_PRIVATE_KEY` (the whole PEM private key, including the `BEGIN`/`END` lines) | `release.yaml` |
| 2 | The GitHub App itself | A GitHub App (the one used by `model-hub` works if it is installed on this repository too) with **Repository permissions: Contents = Read and write** (Metadata = Read is implied), installed on this repository. It is used instead of `GITHUB_TOKEN` because a tag or release created by `GITHUB_TOKEN` does not trigger other workflows, so the images would never be built and published. If the same App and secrets are already defined as organization secrets, step 1 is already done as long as this repository is allowed to read them | `release.yaml`, tag-triggered `docker.yaml` |
| 3 | `.github/workflows/release.yaml` | Uncomment the two `schedule` lines to start the nightly release. Do this only after steps 1 and 2 and after one successful manual **dry run** (Actions, Release, Run workflow, keep "Dry run" ticked) | Nightly releases |
| 4 | Settings, Code security | Turn on the dependency graph and Dependabot alerts (they feed the security tab) and, if your plan offers it, secret scanning with push protection. CI itself runs no secret or code scanner; GitHub's push protection is the platform-side net | Defence in depth |
| 5 | Settings, Actions, General | Workflow permissions can stay on the default; every workflow declares its own `permissions`. Keep "Allow GitHub Actions to create and approve pull requests" off | Least privilege |
| 6 | Renovate | The shared preset `github>mirceanton/renovate-config` is used by `.renovaterc.json`. The Renovate app must be installed on this repository; merging `.renovaterc.json` to `main` completes its onboarding PR (`renovate/configure`) | Dependency updates |
| 7 | After the first release | ghcr.io packages `youtube-workspace-web` and `youtube-workspace-mcp` are created private and linked to this repository when `docker.yaml` pushes them. Change their visibility under the package settings if you want them public, and keep "Actions access" set to this repository with Write | Pulling images |
| 8 | When pull requests start | Branch protection on `main`: require the checks reported by `lint.yaml` and `test.yaml`. Both run on every non-documentation push and on every pull request, so they always report. Do **not** require an image build check: CI builds no images on a push. See "Required checks and skipped runs" below | Merge gate |

Everything else (the `GITHUB_TOKEN`, the ghcr.io login, the build cache) uses the automatic token.

## Workflows

All workflow files are in `.github/workflows/`. Every action is pinned to a commit SHA with the
release in a trailing comment (`# v7.0.1`); Renovate keeps both in step. Every workflow starts from
`permissions: { contents: read }` and a job asks for more only where it needs it. Tool versions
come from `.mise.toml` (`jdx/mise-action`, then `mise exec -- ...`), so CI uses the Node, pnpm and
actionlint versions a developer gets from `mise install`.

| Workflow | Runs on | Jobs |
| --- | --- | --- |
| `lint.yaml` | push (not documentation-only), pull request, manual, **weekly** | the checks every push gets: workflow lint, CI script tests, lint + typecheck, format, build and `pnpm audit` (the weekly run notices new advisories without any commit) |
| `test.yaml` | push (not documentation-only), pull request | Postgres service, migrations twice, `pnpm test`, the policy coverage gate |
| `docker.yaml` | **release tag** (`vX.Y.Z`) | `publish` first requires a green `lint.yaml` and `test.yaml` run on `main` for the release commit (`verify-ci.sh`, so a release made by hand on an arbitrary commit is not published), plants the local-only guard files, builds amd64 and arm64 with an SBOM and max-mode provenance, smoke-tests, and pushes to ghcr.io. It is the only workflow that builds or publishes an image |
| `release.yaml` | **manual only** (nightly schedule disabled) | `verify-ci` requires a green `lint.yaml` and `test.yaml` run on `main` for the commit (`verify-ci.sh`); `release` creates the next semantic version and GitHub release from the conventional commits since the last release, with an App token limited to `contents: write` on this repository. The tag it creates is what triggers `docker.yaml` |
| `e2e.yaml` | its own path filter | Owned by the E2E task (T48); not described here |
| `keycloak-smoke.yaml` | its own path filter | Owned by the Keycloak task; not described here |

The CI workflows:

| Workflow | What it does |
| --- | --- |
| `lint.yaml` | `actionlint` over the workflows; the tests of the CI helper scripts (`.github/scripts/test-scripts.sh`, which cover `verify-ci.sh`); `pnpm lint` (`tsc -b` + oxlint); `pnpm format:check`; `pnpm build` (every package and the Vite bundle) and a check that the entry points exist — this is the PRD "lint and build on every pull request" gate; and `pnpm audit --audit-level=high`. Dependency vulnerabilities are found only by `pnpm audit`: the Trivy and dependency-review scans were considered and removed |
| `test.yaml` | Starts a `postgres:16` service (healthcheck `pg_isready`), exports `MIGRATION_DATABASE_URL` and `TEST_DATABASE_URL`, runs `pnpm migrate` twice (the second run must be a no-op), then `pnpm test` (unit and integration, every vitest project) and `pnpm --filter @ytw/policy test`, which runs with `--coverage` and enforces the 100 % gate that the root run cannot (vitest ignores per-package thresholds there) |

### What runs when

Every push to `main`, `claude/**`, `codex/**` and `renovate/**` is considered. The integration
branches have no pull request flow yet, so they are built like `main`.

| Push | What runs |
| --- | --- |
| Only `docs/**`, `*.md` or `LICENSE` changed | **Nothing** (`paths-ignore` on the push trigger) |
| Anything else, on any allowed branch | `lint.yaml`, `test.yaml` |
| Pull request, manual run, weekly schedule (`lint.yaml` only) | the same |

That is the whole policy. The cost gating this repository used while `ci.yaml` also built images and
ran scans (`.github/scripts/ci-gate.sh`, the `[ci full]` commit-message token, the heavy/light job
split) is **gone**: there are no heavy CI jobs to gate. Images are built only by `docker.yaml` when a
release tag is pushed, so a change under `docker/**` or the lockfile is verified **locally** before
it merges (see "Reproducing CI locally") and on the release run.

GitHub itself skips every workflow for a push whose head commit message contains `[skip ci]`,
`[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]`; on `claude/**` and `codex/**` that
skips even `lint.yaml` and `test.yaml`, so do not use them there (on `main` the release gate still
needs a green run).

Runs are grouped per commit and are never cancelled by a later push, so every commit of the shared
branch keeps a result (only a pull request run is cancelled when the pull request gets a newer
push). Runner minutes are the cost to watch; once the build-out is finished,
`concurrency.cancel-in-progress` in the CI workflows can be switched to `true` for pushes.

The caches that keep the two CI workflows short: `jdx/mise-action` caches the mise tool installs
(keyed on `.mise.toml`), `.github/actions/setup` caches the pnpm store (keyed on
`pnpm-lock.yaml`); the image builds in `docker.yaml` use the GitHub Actions layer cache (one scope
per image).

### Required checks and skipped runs

`paths-ignore` is on the **push** trigger only. A workflow that does not start reports no checks, and
a required check that never reports blocks a merge, so the pull request trigger of `lint.yaml` and
`test.yaml` has no path filter: their checks always report on pull requests. Keep it that way if you
add branch protection: do not add `paths`/`paths-ignore` to their `pull_request` triggers, and do not
require a check that only some pushes produce. A documentation-only push to `main` therefore has no
run of its own. `.github/scripts/verify-ci.sh` (used by `release.yaml` and `docker.yaml`) looks only
at runs of `lint.yaml` and `test.yaml` on `main`. The push run of the commit itself decides when
there is one. Without one, the commit inherits the latest run on `main` only if that run is green,
the commit descends from it (compare status `ahead` or `identical`; a commit that is behind it, such
as an old release run that is re-run after `main` moved on, or on another line of history is
refused), the comparison lists fewer than 300 files, and all of them are documentation.

### Release flow

1. A manual (or, once enabled, nightly) run of `release.yaml` on `main` checks that CI is green for
   the head commit (`verify-ci.sh`: a green `lint.yaml` and `test.yaml` run on `main`; `docker.yaml`
   repeats the check), asks `mirceanton/action-semver-release` for the next version from the
   conventional commits (`feat` = minor, `fix` = patch, `!` or `BREAKING CHANGE` = major) and, unless
   it is a dry run, creates the tag `vX.Y.Z` and the GitHub release using the GitHub App token.
2. The tag `vX.Y.Z` triggers `docker.yaml`, which builds both images for amd64 and arm64,
   smoke-tests them and pushes:

   | Image | Tags |
   | --- | --- |
   | `ghcr.io/mirceanton/youtube-workspace-web` | `X.Y.Z`, `X.Y`, `X` (not for 0.x), `latest` (not for pre-releases) |
   | `ghcr.io/mirceanton/youtube-workspace-mcp` | the same |

3. Nothing else builds or publishes an image: `docker.yaml` is the only workflow that runs a Docker
   build or pushes to a registry, and only for a release tag. No on-push image build exists anymore.

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
  the bug in `model-hub`. The release build passes the release version (and `0.0.0-ci.<sha7>` for a
  non-release build), and `docker/smoke.sh` fails if `/healthz` does not echo them back.
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

`docker/smoke.sh <image> <service> <port> <version> <commit> [<sentinel>]` (used by `docker.yaml`
and runnable locally) checks that

- the image runs as a non-root user, root owns everything under `/app` and the runtime user cannot
  write to the application directory;
- no local-only file is in the image: no `.env` or `.env.*` other than `.env.example`, no `*.pem`,
  `*.key`, `*.p12`, `*.pfx`, local mise config, `.git`, `.claude` or `.auth` anywhere under `/app`
  (third-party packages in `node_modules/.pnpm` are skipped, workspace packages are not), and, when a
  sentinel is passed, no file containing it. In the `docker.yaml` publish job the build context first
  gets such files planted at several depths with `docker/plant-local-files.sh` (`apps/<app>/.env`,
  `packages/*/.env.local`, key files, saved login state, ...) and the sentinel is passed to
  `smoke.sh`, which proves `.dockerignore` end to end. The script refuses to overwrite existing
  files, so run it only in a clean checkout, and `--remove` deletes what it planted;
- once the service depends on `@ytw/db` (its `node_modules/@ytw/db` exists; until then the step is
  skipped on purpose), the package has at least one `migrations/*.sql` file and its migration command
  starts and exits with 2 without `MIGRATION_DATABASE_URL`;
- Docker reports the container healthy using the image's own `HEALTHCHECK`, and `/healthz` returns
  `status: ok`, the service name and the stamped version and commit.

The container gets `docker/smoke.env`. When a service starts requiring another environment variable
at boot, add a placeholder value for it to that file in the same change; the failure shows the
service's own "Invalid environment" message.

## Extending CI

- **Integration tests** find Postgres through `TEST_DATABASE_URL`
  (`postgres://postgres:postgres@localhost:5432/postgres`, the superuser of the `postgres:16`
  service); the `@ytw/db` harness creates one database per test file there and never falls back to
  `MIGRATION_DATABASE_URL`, which only `pnpm migrate` uses (`docs/database.md`, "Test harness").
  A harness that wants another variable exports it in the `env:` block of `test.yaml` as well.
- **A package with its own enforced coverage threshold** needs a separate step in `test.yaml`
  (`pnpm --filter <package> test`, as for `@ytw/policy`), because the root `pnpm test` runs every
  package as a vitest project and vitest ignores per-package thresholds there.
- **A new required environment variable in a service** needs a placeholder in `docker/smoke.env`.
  It is enforced when `docker.yaml` next builds the image (release time), so test the smoke locally.
- **A new workspace package** is picked up by every workflow and by the Docker build context
  automatically (`pnpm-workspace.yaml` lists the folders); do not add its folder to `.dockerignore`.
- **A path that can change an image** (`docker/**`, `.dockerignore`, the lockfile, an install
  setting) is exercised only by `docker.yaml` on the release tag, because CI builds no images on a
  push: run the build and `docker/smoke.sh` locally in the same change before merging it.
- **A new workflow** follows the pattern of the existing ones: pinned action SHAs with a version
  comment, `permissions: { contents: read }` at the top, `persist-credentials: false` on checkout,
  a `timeout-minutes`, and untrusted values (`github.event.*`) only through `env:`, never inside
  `run:` scripts.

## Reproducing CI locally

```bash
mise install                              # same toolchain as CI
pnpm install --frozen-lockfile
mise exec -- actionlint .github/workflows/lint.yaml .github/workflows/test.yaml \
  .github/workflows/docker.yaml .github/workflows/e2e.yaml \
  .github/workflows/keycloak-smoke.yaml .github/workflows/release.yaml
                                          # lint.yaml: workflow syntax
.github/scripts/test-scripts.sh           # lint.yaml: the release-gate script (verify-ci.sh) tests
pnpm lint && pnpm format:check            # lint.yaml
pnpm build                                # lint.yaml
scripts/pg-local.sh start                 # a Postgres 16, like the test job's service
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/youtube_workspace pnpm migrate
pnpm test && pnpm --filter @ytw/policy test   # test.yaml
pnpm audit --audit-level=high             # lint.yaml
# images: built only by docker.yaml on the release tag, so run this yourself for any docker/** change
docker build -f docker/web.Dockerfile --build-arg APP_VERSION=0.0.0-dev --build-arg GIT_SHA="$(git rev-parse HEAD)" -t ytw-web:dev .
docker/smoke.sh ytw-web:dev web-server 3000 0.0.0-dev "$(git rev-parse HEAD)"
# to prove .dockerignore as docker.yaml does (clean checkout only): sentinel=$(docker/plant-local-files.sh),
# build, pass "$sentinel" as the sixth argument of smoke.sh, then docker/plant-local-files.sh --remove
```

## Differences from model-hub

| | model-hub | This repository |
| --- | --- | --- |
| Workflows | `lint`, `test`, `release`, `docker` | CI split into `lint.yaml` (which also builds, so a merged lint+build; and runs `pnpm audit`) and `test.yaml`, plus `docker.yaml` (build **and** publish, only on a release tag), `release.yaml`, `e2e.yaml`, `keycloak-smoke.yaml` |
| Triggers | `main` and `renovate/**` pushes, PRs to `main` | the same plus `claude/**` and `codex/**` pushes (no pull request flow yet) and documentation-only pushes skipped |
| Postgres | none (SQLite) | `postgres:16` service with a healthcheck, migrations applied twice |
| Build gate | none | the `pnpm build` steps of `lint.yaml`, on every push and pull request |
| Scanning | none | `pnpm audit --audit-level=high` (kept); no other CI scanner — Trivy, gitleaks, CodeQL and dependency review were considered and removed |
| Images | one | two (`web`, `mcp`), smoke-tested, SBOM and provenance; built on the release tag in `docker.yaml`, never on a push |
| Release | schedule on, no CI check | schedule off, dry run by default, requires green CI on the commit (also before images are built and pushed), scoped App token |
| Version stamp | not surfaced to the process | `APP_VERSION` / `GIT_SHA` in `ENV`, asserted by the smoke test |
| Base image | Playwright image (about 4 GB) | `node:24.21.0-slim`, no package managers in the runtime stage |
| Docker cache | gha | gha, one scope per image |

## Known limits and follow-ups

- The arm64 images are built under QEMU, which is slow; that build now only happens in
  `docker.yaml` for a release tag, so it costs minutes once per release and not on every push.
- `mise` has no lockfile here (it cannot be generated in the agent sandbox). `model-hub` commits a
  `mise.lock`, and the shared Renovate preset refreshes it with `mise lock`; run `mise lock` once on
  a machine with mise and commit the result to get checksum-verified tool installs in CI.
- The base image is pinned by tag, not by digest. Renovate does not add digests to Docker images in
  the shared preset; the Renovate tag bumps cover patch updates.
- CI runs no secret scanner (the gitleaks per-push and history scans were removed) and no
  vulnerability scanner beyond `pnpm audit`: a secret pushed by accident must be rotated, not
  cleaned up, and GitHub's secret scanning with push protection (config step 4) is the only
  pre-commit-side net.
- Image-affecting changes are not verified by any push event; they are verified locally at review
  time and proven for real on the next release run.
