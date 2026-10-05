#!/usr/bin/env bash
# Fails unless CI is green for the commit that is being released or published.
# Called by release.yaml (job verify-ci) and docker.yaml (job publish); tested by
# .github/scripts/test-scripts.sh.
#
# CI is the pair of push workflows lint.yaml and test.yaml: both must be green for COMMIT.
#
# Only runs on main count: the push runs of lint.yaml and test.yaml for COMMIT itself decide whether
# they exist, because only pushes to main run the complete set of jobs. Pushes that only change
# documentation start no workflow (paths-ignore in the two workflows), so a commit may have no run of
# its own. It then inherits the latest push run on main of that workflow, but only when
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

# Every one of these must be green for COMMIT. Must stay in step with the workflows that trigger on
# a push to main.
workflows=(lint.yaml test.yaml)

# Must stay in step with `paths-ignore` of the push trigger in lint.yaml and test.yaml.
documentation='^(docs/|.*\.md$|LICENSE$)'
# GitHub truncates the file list of a comparison at this many files.
file_limit=300

fail() {
  echo "::error::$*"
  exit 1
}

# main_run <workflow> [gh run list flags]: "<sha> <status> <conclusion>" of the latest push run of
# <workflow> on main, or "none".
main_run() {
  local workflow=$1
  shift
  gh run list --repo "$REPOSITORY" --workflow "$workflow" --branch main --event push --limit 1 "$@" \
    --json headSha,status,conclusion \
    --jq 'if length == 0 then "none" else "\(.[0].headSha) \(.[0].status) \(.[0].conclusion // "-")" end'
}

# check_workflow <workflow>: succeeds when <workflow> is green for COMMIT, otherwise fails.
check_workflow() {
  local workflow=$1
  local own latest run_sha status conclusion comparison relation count other
  local -a lines

  own=$(main_run "$workflow" --commit "$COMMIT")
  echo "${workflow} push run on main for ${COMMIT}: ${own}"
  if [ "$own" != "none" ]; then
    read -r _ status conclusion <<<"$own"
    [ "$status" = "completed" ] && [ "$conclusion" = "success" ] ||
      fail "CI for ${COMMIT} is ${status}/${conclusion} in ${workflow}, not completed/success; not releasing."
    return 0
  fi

  latest=$(main_run "$workflow")
  echo "latest ${workflow} push run on main: ${latest}"
  [ "$latest" != "none" ] || fail "No ${workflow} run found on main; not releasing."
  read -r run_sha status conclusion <<<"$latest"
  [ "$status" = "completed" ] && [ "$conclusion" = "success" ] ||
    fail "${COMMIT} has no ${workflow} run of its own and the latest run on main (${run_sha}) is ${status}/${conclusion}, not completed/success; not releasing."

  comparison=$(gh api "repos/${REPOSITORY}/compare/${run_sha}...${COMMIT}" \
    --jq '.status, (.files | length), (.files[].filename)') ||
    fail "${COMMIT} has no ${workflow} run of its own and could not be compared with the green run on ${run_sha}; not releasing."
  mapfile -t lines <<<"$comparison"
  relation=${lines[0]:-}
  count=${lines[1]:-0}
  case "$relation" in
    ahead | identical) ;;
    *) fail "${COMMIT} has no ${workflow} run of its own and is '${relation}' relative to the green run on ${run_sha}, not a descendant of it; not releasing." ;;
  esac
  [ "$count" -lt "$file_limit" ] ||
    fail "${COMMIT} changed ${count} files or more since ${run_sha}; GitHub truncates the list, so documentation-only cannot be proven; not releasing."
  other=$(printf '%s\n' "${lines[@]:2}" | grep -Ev "${documentation}|^\$" || true)
  [ -z "$other" ] ||
    fail "${COMMIT} has no ${workflow} run of its own and changed non-documentation files since ${run_sha} (first: $(head -n 1 <<<"$other")); not releasing."
  echo "${COMMIT} only changes documentation since the ${workflow} green run on ${run_sha}."
}

for workflow in "${workflows[@]}"; do
  check_workflow "$workflow"
done

echo "CI is green for ${COMMIT} (${workflows[*]})."
