#!/usr/bin/env bash
# Smoke-test a built service image before it can be published.
#
#   docker/smoke.sh <image> <service> <port> <expected-version> <expected-commit> [<sentinel>]
#   docker/smoke.sh ytw-web:ci web-server 3000 1.2.3 "$(git rev-parse HEAD)"
#
# Checks that the image
#   - runs as a non-root user and the runtime user owns, and can write to, nothing under /app;
#   - contains no local-only file (.env files, keys, .git, ...), and, if a sentinel is given (see
#     docker/plant-local-files.sh), no file that contains it: this proves .dockerignore;
#   - becomes healthy according to its own HEALTHCHECK and answers GET /healthz with the service
#     name and the version and commit stamped at build time;
#   - once the service depends on @ytw/db, carries the migration command and the SQL files.
# Needs docker, curl and jq. The container gets its environment from docker/smoke.env.
set -euo pipefail

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
  echo "usage: $0 <image> <service> <port> <expected-version> <expected-commit> [<sentinel>]" >&2
  exit 2
fi
image=$1
service=$2
port=$3
expected_version=$4
expected_commit=$5
sentinel=${6:-}

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
name="ytw-smoke-${service}-$$"

cleanup() {
  echo "--- container logs (last 40 lines)"
  docker logs --tail 40 "$name" 2>&1 || true
  docker rm --force "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# in_image <entrypoint> [args...]: run one command in a throwaway container of the image.
in_image() {
  local entrypoint=$1
  shift
  docker run --rm --entrypoint "$entrypoint" "$image" "$@"
}

# --- user and ownership ------------------------------------------------------------------------
user=$(docker image inspect --format '{{.Config.User}}' "$image")
case "$user" in
  "" | 0 | root | 0:* | root:*) fail "image runs as root (USER='${user}')" ;;
esac
echo "ok: image runs as user ${user}"

owned=$(in_image find /app ! -user root -print)
[ -z "$owned" ] || fail "files under /app are not owned by root: $(head -n 3 <<<"$owned")"
if in_image sh -c 'touch /app/service/.write-test 2>/dev/null'; then
  fail "the runtime user can write to the application directory"
fi
echo "ok: the application code is root-owned and not writable by the runtime user"

# --- no local-only files ------------------------------------------------------------------------
# Third-party packages (node_modules/.pnpm/<name>@...) are not ours to judge; the workspace packages
# pnpm copies in (node_modules/.pnpm/@ytw+<name>@file+...) and everything else under /app are.
leaks=$(
  in_image find /app \
    \( -path '*/node_modules/.pnpm/*' ! -path '*/node_modules/.pnpm/@ytw+*' \) -prune -o \
    \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.p12' \
    -o -name '*.pfx' -o -name '.mise.local.toml' -o -name 'mise.local.toml' \
    -o -name '.git' -o -name '.claude' -o -name '.auth' \) \
    ! -name '.env.example' -print
)
[ -z "$leaks" ] || fail "local-only files made it into the image (check .dockerignore): $(tr '\n' ' ' <<<"$leaks")"
if [ -n "$sentinel" ]; then
  status=0
  hits=$(in_image grep -rIl -- "$sentinel" /app) || status=$?
  [ "$status" -le 1 ] || fail "searching the image for the planted sentinel failed (grep exit ${status})"
  [ -z "$hits" ] || fail "planted local files made it into the image (check .dockerignore): $(tr '\n' ' ' <<<"$hits")"
  echo "ok: no planted local file is in the image"
fi
echo "ok: the image contains no .env file, key file or other local-only file"

# --- the migration command ---------------------------------------------------------------------
# Condition: the service's node_modules contains @ytw/db, i.e. the service depends on it. Until
# then there is nothing to check and the step is skipped on purpose.
db_package=/app/service/node_modules/@ytw/db
if in_image test -d "$db_package"; then
  sql_files=$(in_image sh -c "ls ${db_package}/migrations/*.sql 2>/dev/null | wc -l")
  [ "$sql_files" -ge 1 ] || fail "${db_package}/migrations holds no .sql file"
  in_image test -f "${db_package}/dist/src/bin/migrate.js" || fail "${db_package}/dist/src/bin/migrate.js is missing"
  status=0
  in_image node "${db_package}/dist/src/bin/migrate.js" >/dev/null 2>&1 || status=$?
  # Without MIGRATION_DATABASE_URL the command exits with 2 (usage), which proves it starts.
  [ "$status" -eq 2 ] || fail "the migration command exited with ${status} instead of 2 without MIGRATION_DATABASE_URL"
  echo "ok: the image carries ${sql_files} migration files and a working migration command"
else
  echo "skip: the service does not depend on @ytw/db yet, so the image carries no migrations"
fi

# --- boot and health ---------------------------------------------------------------------------
# The probe settings override the image's HEALTHCHECK intervals so the test does not wait 30 s.
docker run --detach --name "$name" \
  --env-file "${here}/smoke.env" \
  --publish "127.0.0.1:${port}:${port}" \
  --health-interval 2s --health-timeout 5s --health-start-period 2s --health-retries 5 \
  "$image" >/dev/null

status=starting
for _ in $(seq 1 60); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]; then
    fail "container exited before becoming healthy"
  fi
  status=$(docker inspect --format '{{.State.Health.Status}}' "$name")
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 1
done
[ "$status" = "healthy" ] || fail "container health is '${status}' after 60 s"
echo "ok: container is healthy"

body=$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/healthz")
echo "healthz: ${body}"
if ! jq -e --arg service "$service" --arg version "$expected_version" --arg commit "$expected_commit" \
  '.status == "ok" and .service == $service and .version == $version and .commit == $commit' \
  <<<"$body" >/dev/null; then
  fail "/healthz does not report service=${service} version=${expected_version} commit=${expected_commit}"
fi
echo "ok: /healthz reports the stamped version and commit"
