#!/usr/bin/env bash
# Smoke-test a built service image before it can be published.
#
#   docker/smoke.sh <image> <service> <port> <expected-version> <expected-commit>
#   docker/smoke.sh ytw-web:ci web-server 3000 1.2.3 "$(git rev-parse HEAD)"
#
# Checks that the image runs as a non-root user, that the container becomes healthy according to
# its own HEALTHCHECK, and that GET /healthz reports the service name and the version and commit
# stamped at build time. Needs docker, curl and jq. Environment comes from docker/smoke.env.
set -euo pipefail

if [ "$#" -ne 5 ]; then
  echo "usage: $0 <image> <service> <port> <expected-version> <expected-commit>" >&2
  exit 2
fi
image=$1
service=$2
port=$3
expected_version=$4
expected_commit=$5

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
name="ytw-smoke-${service}-$$"

cleanup() {
  echo "--- container logs (last 40 lines)"
  docker logs --tail 40 "$name" 2>&1 || true
  docker rm --force "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

user=$(docker image inspect --format '{{.Config.User}}' "$image")
case "$user" in
  "" | 0 | root | 0:* | root:*)
    echo "FAIL: image runs as root (USER='${user}')" >&2
    exit 1
    ;;
esac
echo "ok: image runs as user ${user}"

# The probe settings override the image's HEALTHCHECK intervals so the test does not wait 30 s.
docker run --detach --name "$name" \
  --env-file "${here}/smoke.env" \
  --publish "127.0.0.1:${port}:${port}" \
  --health-interval 2s --health-timeout 5s --health-start-period 2s --health-retries 5 \
  "$image" >/dev/null

status=starting
for _ in $(seq 1 60); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$name")" != "true" ]; then
    echo "FAIL: container exited before becoming healthy" >&2
    exit 1
  fi
  status=$(docker inspect --format '{{.State.Health.Status}}' "$name")
  if [ "$status" = "healthy" ]; then
    break
  fi
  sleep 1
done
if [ "$status" != "healthy" ]; then
  echo "FAIL: container health is '${status}' after 60 s" >&2
  exit 1
fi
echo "ok: container is healthy"

body=$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:${port}/healthz")
echo "healthz: ${body}"
if ! jq -e --arg service "$service" --arg version "$expected_version" --arg commit "$expected_commit" \
  '.status == "ok" and .service == $service and .version == $version and .commit == $commit' \
  <<<"$body" >/dev/null; then
  echo "FAIL: /healthz does not report service=${service} version=${expected_version} commit=${expected_commit}" >&2
  exit 1
fi
echo "ok: /healthz reports the stamped version and commit"
