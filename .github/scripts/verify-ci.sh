#!/usr/bin/env bash
# Fails unless CI is green for the commit that is being released or published.
# Called by release.yaml (job verify-ci) and docker.yaml (job publish); tested by
# .github/scripts/test-scripts.sh.
#
# Only runs on main count: the push run of ci.yaml for COMMIT itself decides if it exists, because
# runs on main always include the heavy jobs (images, scans). Pushes that only change documentation
# start no workflow (paths-ignore in ci.yaml), so a commit may have no run of its own. It then
# inherits the latest push run on main, but only when
#   - that run completed successfully (a newer queued, failed or cancelled run therefore blocks), and
#   - COMMIT descends from the commit of that run (compare status "ahead" or "identical"): a commit
#     behind it or on another line of history, such as an old release run that is re-run after main
#     moved on, is rejected, and
#   - nothing but documentation changed since, and the file list is complete (GitHub lists at most
#     300 files of a comparison).
#
# Inputs (environment): REPOSITORY COMMIT and, for `gh`, GH_TOKEN.
set -euo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${COMMIT:?COMMIT is required}"

# Must stay in step with `paths-ignore` of the push trigger in ci.yaml.
documentation='^(docs/|.*\.md$|LICENSE$)'
# GitHub truncates the file list of a comparison at this many files.
file_limit=300

# main_run [gh run list flags]: "<sha> <status> <conclusion>" of the latest ci.yaml push run on main,
# or "none".
main_run() {
  gh run list --repo "$REPOSITORY" --workflow ci.yaml --branch main --event push --limit 1 "$@" \
    --json headSha,status,conclusion \
    --jq 'if length == 0 then "none" else "\(.[0].headSha) \(.[0].status) \(.[0].conclusion // "-")" end'
}

fail() {
  echo "::error::$*"
  exit 1
}

own=$(main_run --commit "$COMMIT")
echo "ci.yaml push run on main for ${COMMIT}: ${own}"
if [ "$own" != "none" ]; then
  read -r _ status conclusion <<<"$own"
  [ "$status" = "completed" ] && [ "$conclusion" = "success" ] ||
    fail "CI for ${COMMIT} is ${status}/${conclusion}, not completed/success; not releasing."
  echo "CI is green for ${COMMIT}."
  exit 0
fi

latest=$(main_run)
echo "latest ci.yaml push run on main: ${latest}"
[ "$latest" != "none" ] || fail "No CI run found on main; not releasing."
read -r run_sha status conclusion <<<"$latest"
[ "$status" = "completed" ] && [ "$conclusion" = "success" ] ||
  fail "${COMMIT} has no CI run of its own and the latest run on main (${run_sha}) is ${status}/${conclusion}, not completed/success; not releasing."

comparison=$(gh api "repos/${REPOSITORY}/compare/${run_sha}...${COMMIT}" \
  --jq '.status, (.files | length), (.files[].filename)') ||
  fail "${COMMIT} has no CI run of its own and could not be compared with the green run on ${run_sha}; not releasing."
mapfile -t lines <<<"$comparison"
relation=${lines[0]:-}
count=${lines[1]:-0}
case "$relation" in
  ahead | identical) ;;
  *) fail "${COMMIT} has no CI run of its own and is '${relation}' relative to the green run on ${run_sha}, not a descendant of it; not releasing." ;;
esac
[ "$count" -lt "$file_limit" ] ||
  fail "${COMMIT} changed ${count} files or more since ${run_sha}; GitHub truncates the list, so documentation-only cannot be proven; not releasing."
other=$(printf '%s\n' "${lines[@]:2}" | grep -Ev "${documentation}|^\$" || true)
[ -z "$other" ] ||
  fail "${COMMIT} has no CI run of its own and changed non-documentation files since ${run_sha} (first: $(head -n 1 <<<"$other")); not releasing."
echo "${COMMIT} only changes documentation since the green run on ${run_sha}."
echo "CI is green for ${COMMIT}."
