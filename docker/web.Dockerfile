# syntax=docker/dockerfile:1

# Web server (Fastify backend-for-frontend) plus the built web UI, in one image.
#   docker build -f docker/web.Dockerfile --build-arg APP_VERSION=1.2.3 --build-arg GIT_SHA=$(git rev-parse HEAD) .
# Build context is the repository root; .dockerignore keeps secrets, history and build output out.
# Contract with the application (docs/ci-cd.md):
#   - listens on $PORT (default 3000) on all interfaces and answers GET /healthz
#   - reports $APP_VERSION and $GIT_SHA on /healthz (stamped below as environment variables)
#   - serves the single-page app from $STATIC_WEB_DIR (/app/web-dist)
#   - needs DATABASE_URL, OIDC_* and SESSION_SECRET at run time (supplied by the deployment)

# Keep the Node version in step with .mise.toml (Renovate bumps both).
FROM node:24.21.0-slim AS node

# ---------------------------------------------------------------------------------------------
# build: install all dependencies, compile the packages and bundle the web UI
# ---------------------------------------------------------------------------------------------
FROM node AS build
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Download the dependencies first. This layer depends only on the lockfile, so it stays cached
# while the sources change. pnpm reads its own version from "packageManager" in package.json.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile
RUN pnpm --filter @ytw/web-server build \
    && pnpm --filter @ytw/web-ui build

# Extract the web server with only its production dependencies (workspace packages are copied in
# as real files), then drop sources and compiled tests that are not needed at run time.
RUN pnpm --filter @ytw/web-server deploy --prod --legacy /out/service \
    && rm -rf /out/service/src /out/service/test /out/service/dist/test \
       /out/service/tsconfig.json /out/service/vitest.config.ts \
    && for pkg in /out/service/node_modules/.pnpm/@ytw+*/node_modules/@ytw/*; do \
         rm -rf "$pkg/src" "$pkg/test" "$pkg/dist/test" "$pkg/tsconfig.json" "$pkg/vitest.config.ts"; \
       done

# ---------------------------------------------------------------------------------------------
# runtime: Node only. No package managers, no shell scripts, non-root user.
# ---------------------------------------------------------------------------------------------
FROM node AS runtime
ENV NODE_ENV=production

# The service never installs anything at run time, so npm, corepack and yarn (and the dependencies
# they bundle) are removed from the image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx \
        /usr/local/bin/corepack /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
# The application code stays owned by root: the runtime user can read and run it but not change it,
# so a compromised process cannot rewrite its own code. Nothing under /app needs to be writable
# (docker/smoke.sh checks both). Add a directory owned by the runtime user only when a feature needs one.
COPY --from=build /out/service ./service
COPY --from=build /app/apps/web-ui/dist ./web-dist

# Declared after the copies so a new commit only invalidates the layers below this line.
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_SHA} \
    PORT=3000 \
    STATIC_WEB_DIR=/app/web-dist

LABEL org.opencontainers.image.source="https://github.com/mirceanton/youtube-workspace" \
      org.opencontainers.image.title="youtube-workspace-web" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${GIT_SHA}"

# 1000:1000 is the "node" user of the base image. A numeric user lets Kubernetes verify runAsNonRoot.
USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "service/dist/src/index.js"]
