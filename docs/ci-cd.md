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
| 4 | Settings, Code security | Private repository only: CodeQL and dependency review need GitHub Code Security (a paid add-on of the `mirceanton` organization). If you enable it, also set the repository **variable** `CODE_SECURITY_ENABLED` to `true` (Settings, Secrets and variables, Actions, Variables). Making the repository public enables both jobs without the variable. Do not also switch on CodeQL "default setup": the two conflict. Until then the two jobs are reported as skipped | `security.yaml` jobs `codeql`, `dependency-review` |
| 5 | Settings, Code security | Turn on the dependency graph and Dependabot alerts (they feed dependency review and the security tab) and, if your plan offers it, secret scanning with push protection | Defence in depth |
| 6 | Settings, Actions, General | Workflow permissions can stay on the default; every workflow declares its own `permissions`. Keep "Allow GitHub Actions to create and approve pull requests" off | Least privilege |
| 7 | Renovate | The shared preset `github>mirceanton/renovate-config` is used by `.renovaterc.json`. The Renovate app must be installed on this repository; merging `.renovaterc.json` to `main` completes its onboarding PR (`renovate/configure`) | Dependency updates |
| 8 | After the first release | ghcr.io packages `youtube-workspace-web` and `youtube-workspace-mcp` are created private and linked to this repository by the publish job. Change their visibility under the package settings if you want them public, and keep "Actions access" set to this repository with Write | Pulling images |
| 9 | When pull requests start | Branch protection on `main`: require the checks `Typecheck, lint and format`, `Workflow syntax (actionlint)`, `Unit and integration tests`, `Build every package and the web UI`, and the `Build and smoke-test` and `Trivy` jobs | Merge gate |

Everything else (the `GITHUB_TOKEN`, the ghcr.io login, the build cache) uses the automatic token.

## Workflows

All workflow files are in `.github/workflows/`. Every action is pinned to a commit SHA with the
release in a trailing comment (`# v7.0.1`); Renovate keeps both in step. Every workflow starts from
`permissions: { contents: read }` and a job asks for more only where it needs it. Tool versions
come from `.mise.toml` (`jdx/mise-action`, then `mise exec -- ...`), so CI uses the Node, pnpm and
actionlint versions a developer gets from `mise install`.

| Workflow | Runs on | Jobs |
| --- | --- | --- |
| `lint.yaml` | push, pull request, manual | `actionlint` over the workflow files; `pnpm lint` (`tsc -b` + oxlint) and `pnpm format:check` |
| `test.yaml` | push, pull request, manual | Starts a `postgres:16` service (healthcheck `pg_isready`), exports `MIGRATION_DATABASE_URL`, runs `pnpm migrate` twice (the second run must be a no-op), then `pnpm test` (unit and integration) |
| `build.yaml` | push, pull request, manual | `pnpm build` (every package and the Vite bundle) and a check that the entry points exist. This is the PRD "build on every pull request" gate |
| `security.yaml` | push, pull request, manual, **weekly** | `audit` (`pnpm audit --audit-level=high`), `trivy-fs` (lockfile vulnerabilities, secrets, Dockerfile misconfiguration), `trivy-image` (builds each image and scans it), `secrets` (gitleaks CLI over the whole git history, findings redacted), `codeql` and `dependency-review` (see step 4 above; skipped otherwise) |
| `docker.yaml` | push, pull request, manual, **release published** | `verify` builds both images for linux/amd64, runs `docker/smoke.sh`, and (on `main`, on request, and for now on `claude/**`) also builds linux/arm64 under QEMU without publishing. `publish` runs only for a published release: it builds amd64 and arm64, adds an SBOM and max-mode provenance, and pushes to ghcr.io |
| `release.yaml` | **manual only** (nightly schedule disabled) | `verify-ci` requires the latest `lint`, `test`, `build`, `security` and `docker` runs for the commit to have succeeded; `release` creates the next semantic version and GitHub release from the conventional commits since the last release |

Pushes to `claude/**` run the same workflows as pushes to `main`, because the integration branch
has no pull request flow yet. Every push gets its own complete run: runs are grouped per commit and
are never cancelled by a later push, so each commit of the shared integration branch has a result
(only pull request runs are cancelled when the pull request gets a newer push). The price is runner
minutes, so watch the private repository plan's included minutes while many agents push; once the
build-out is finished, `concurrency.cancel-in-progress` can be switched to `true` for pushes.

### Release flow

1. A manual (or, once enabled, nightly) run of `release.yaml` on `main` checks that CI is green for
   the head commit, asks `mirceanton/action-semver-release` for the next version from the
   conventional commits (`feat` = minor, `fix` = patch, `!` or `BREAKING CHANGE` = major) and, unless it is a dry run,
   creates the tag `vX.Y.Z` and the GitHub release using the GitHub App token.
2. Publishing the release triggers `docker.yaml`. `verify` runs again on the tagged commit, then
   `publish` pushes both images:

   | Image | Tags |
   | --- | --- |
   | `ghcr.io/mirceanton/youtube-workspace-web` | `X.Y.Z`, `X.Y`, `X` (not for 0.x), `latest` (not for pre-releases) |
   | `ghcr.io/mirceanton/youtube-workspace-mcp` | the same |

3. Nothing in this repository publishes an image or creates a release on its own. No workflow
   pushes to a registry except `publish`, which only runs for the `release: published` event.

## Images

`docker/web.Dockerfile` (web server plus the built web UI) and `docker/mcp.Dockerfile` (MCP
server). The build context is the repository root; `.dockerignore` removes history, secrets,
dependencies and build output. Both Dockerfiles have the same shape:

- **build stage** (`node:24.21.0-slim` + corepack): `pnpm fetch` from the lockfile alone (a cached
  layer), `COPY . .`, `pnpm install --offline --frozen-lockfile`, build, then
  `pnpm --filter <service> deploy --prod --legacy` to extract the service with only its production
  dependencies. Sources and compiled tests are removed from the extracted tree.
- **runtime stage**: the same Node base, `NODE_ENV=production`, npm/corepack/yarn removed, runs as
  the numeric user `1000:1000`, `HEALTHCHECK` through `node` (the slim image has no curl),
  `CMD ["node", "service/dist/src/index.js"]`.
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
- **Migrations are not run by the images.** Run `pnpm migrate` (with `MIGRATION_DATABASE_URL`) as a
  separate job or init step before starting new versions.

### Smoke test

`docker/smoke.sh <image> <service> <port> <version> <commit>` (used by `docker.yaml`, runnable
locally) checks that the image runs as a non-root user, that Docker reports the container healthy
using the image's own `HEALTHCHECK`, and that `/healthz` returns `status: ok`, the service name and
the stamped version and commit. The container gets `docker/smoke.env`. When a service starts
requiring another environment variable at boot, add a placeholder value for it to that file in the
same change; the failure shows the service's own "Invalid environment" message.

## Reproducing CI locally

```bash
mise install                              # same toolchain as CI
pnpm install --frozen-lockfile
pnpm lint && pnpm format:check            # lint.yaml
mise exec -- actionlint                   # lint.yaml, workflow syntax
scripts/pg-local.sh start                 # a Postgres 16, like the test.yaml service
MIGRATION_DATABASE_URL=postgres://postgres:postgres@localhost:5432/youtube_workspace pnpm migrate
pnpm test                                 # test.yaml
pnpm build                                # build.yaml
pnpm audit --audit-level=high             # security.yaml, audit
docker build -f docker/web.Dockerfile --build-arg APP_VERSION=0.0.0-dev --build-arg GIT_SHA="$(git rev-parse HEAD)" -t ytw-web:dev .
docker/smoke.sh ytw-web:dev web-server 3000 0.0.0-dev "$(git rev-parse HEAD)"
```

## Differences from model-hub

| | model-hub | This repository |
| --- | --- | --- |
| Triggers | `main` and `renovate/**` pushes, PRs to `main` | the same plus `claude/**` pushes (no pull request flow yet) and concurrency cancellation |
| Postgres | none (SQLite) | `postgres:16` service with a healthcheck in `test.yaml`, migrations applied twice |
| Build gate | none | `build.yaml` |
| Scanning | none | `security.yaml`: pnpm audit, Trivy (filesystem and images), gitleaks, CodeQL and dependency review when the repository allows |
| Images | one | two (`web`, `mcp`), smoke-tested on every push, SBOM and provenance when published |
| Release | schedule on, no CI check | schedule off, dry run by default, requires green CI on the commit |
| Version stamp | not surfaced to the process | `APP_VERSION` / `GIT_SHA` in `ENV`, asserted by the smoke test |
| Base image | Playwright image (about 4 GB) | `node:24.21.0-slim`, no package managers in the runtime stage |
| Docker cache | gha | gha, one scope per image |

## Known limits and follow-ups

- The arm64 images are built under QEMU, which is slow, so arm64 is verified on `main`, on request
  (`docker.yaml` manual run with "multi-arch" ticked) and at release time rather than on every push.
- `mise` has no lockfile here (it cannot be generated in the agent sandbox). `model-hub` commits a
  `mise.lock`, and the shared Renovate preset refreshes it with `mise lock`; run `mise lock` once on
  a machine with mise and commit the result to get checksum-verified tool installs in CI.
- The base image is pinned by tag, not by digest. Renovate does not add digests to Docker images in
  the shared preset; the weekly Trivy scan and the tag bumps cover patch updates.
- Trivy runs with `--ignore-unfixed` and fails on HIGH and CRITICAL findings only. A finding that
  cannot be fixed can be recorded in a `.trivyignore` file with a comment and an expiry date.
