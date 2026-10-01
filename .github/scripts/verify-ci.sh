#!/usr/bin/env bash
# Fails unless CI is green for the commit a release would be cut from.
# Called by the `verify-ci` job in .github/workflows/release.yaml; tested by
# .github/scripts/test-scripts.sh.
#
# The latest push run of ci.yaml on main must have completed successfully. It normally belongs to
# the commit being released. Pushes that only change documentation start no workflow (paths-ignore
# in ci.yaml), so the run may belong to an older commit; that is accepted only when every commit
# since then changed nothing but documentation.
#
# Inputs (environment): REPOSITORY COMMIT and, for `gh`, GH_TOKEN.
set -euo pipefail

: "${REPOSITORY:?REPOSITORY is required}"
: "${COMMIT:?COMMIT is required}"

# Must stay in step with `paths-ignore` of the push trigger in ci.yaml.
documentation='^(docs/|.*\.md$|LICENSE$)'

latest=$(gh run list --repo "$REPOSITORY" --workflow ci.yaml --branch main --event push --limit 1 \
  --json headSha,status,conclusion \
  --jq 'if length == 0 then "none" else "\(.[0].headSha) \(.[0].status) \(.[0].conclusion // "-")" end')
echo "latest ci.yaml push run on main: ${latest}"

if [ "$latest" = "none" ]; then
  echo "::error::No CI run found on main; not releasing."
  exit 1
fi
read -r run_sha status conclusion <<<"$latest"
if [ "$status" != "completed" ] || [ "$conclusion" != "success" ]; then
  echo "::error::The latest CI run (${run_sha}) is ${status}/${conclusion}, not completed/success; not releasing."
  exit 1
fi

if [ "$run_sha" != "$COMMIT" ]; then
  files=$(gh api --paginate "repos/${REPOSITORY}/compare/${run_sha}...${COMMIT}" --jq '.files[].filename')
  other=$(grep -Ev "${documentation}|^\$" <<<"$files" || true)
  if [ -n "$other" ]; then
    echo "::error::${COMMIT} has no CI run of its own and changed non-documentation files since ${run_sha}: $(head -n 1 <<<"$other"); not releasing."
    exit 1
  fi
  echo "${COMMIT} only changes documentation since the green run on ${run_sha}."
fi
echo "CI is green for ${COMMIT}."
