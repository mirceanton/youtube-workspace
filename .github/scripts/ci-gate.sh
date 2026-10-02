#!/usr/bin/env bash
# Decides whether the heavy CI jobs (container images, scans, CodeQL) run for this event.
# Called by the `check` job in .github/workflows/ci.yaml; tested by .github/scripts/test-scripts.sh.
#
# Heavy jobs always run for pull requests, pushes to main, manual runs and the weekly schedule.
# On other pushes (the shared integration branch) they run only when
#   - the head commit message contains the opt-in token [ci full] (any case), or
#   - the push changed a path that can alter an image or a scan result, or
#   - the changed files cannot be determined reliably (fail open, never silently skip): the
#     comparison failed, the push is not a plain fast-forward, or GitHub truncated the file list.
# Note that GitHub itself skips every workflow for a push whose head commit message contains
# [skip ci], [ci skip], [no ci], [skip actions] or [actions skip]; this script never sees those.
#
# Inputs (environment): EVENT_NAME REF BEFORE AFTER HEAD_MESSAGE REPO and, for `gh`, GH_TOKEN.
# Writes `heavy=true|false` to $GITHUB_OUTPUT.
set -euo pipefail

# Paths whose change can alter an image or a scan result: the Docker files and context rules, the
# secret and vulnerability scanner configuration, install settings, the workflows, local actions and
# scripts themselves, the dependency manifests, and the files that define what a service needs in
# its environment (a new required variable needs a placeholder in docker/smoke.env).
relevant='^(docker/|\.dockerignore$|\.gitleaks(\.toml|ignore)$|\.trivyignore(\.yaml)?$|trivy\.ya?ml$|(.*/)?\.npmrc$|\.github/(workflows|actions|scripts)/|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|package\.json$|apps/(web-server|mcp)/src/env\.ts$)'
optin='[ci full]'
# GitHub lists at most this many files for a comparison.
file_limit=300

decide() {
  echo "heavy=$1" >>"${GITHUB_OUTPUT:-/dev/stdout}"
  echo "heavy jobs: $1 ($2)"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    echo "Heavy jobs (images, scans, CodeQL): **$1** ($2)" >>"$GITHUB_STEP_SUMMARY"
  fi
  exit 0
}

: "${EVENT_NAME:?EVENT_NAME is required}"
: "${REF:?REF is required}"

[ "$EVENT_NAME" = "push" ] || decide true "event is ${EVENT_NAME}"
[ "$REF" != "refs/heads/main" ] || decide true "push to main"

message="${HEAD_MESSAGE:-}"
case "${message,,}" in
  *"$optin"*) decide true "head commit message contains ${optin}" ;;
esac

before="${BEFORE:-}"
case "$before" in
  "" | 0000000000000000000000000000000000000000) decide true "no previous commit to compare with" ;;
esac

if ! comparison=$(gh api "repos/${REPO}/compare/${before}...${AFTER}" \
  --jq '.status, (.files | length), (.files[].filename)' 2>/dev/null); then
  decide true "could not list the changed files"
fi
mapfile -t lines <<<"$comparison"
relation=${lines[0]:-}
count=${lines[1]:-0}
case "$relation" in
  ahead | identical) ;;
  *) decide true "the push is '${relation}' relative to the previous head, so its file list is not reliable" ;;
esac
[ "$count" -lt "$file_limit" ] || decide true "the comparison lists ${count} files, the point at which GitHub truncates the list"

if hits=$(printf '%s\n' "${lines[@]:2}" | grep -E "$relevant"); then
  decide true "relevant path changed: $(head -n 1 <<<"$hits")"
fi
decide false "no relevant path changed"
