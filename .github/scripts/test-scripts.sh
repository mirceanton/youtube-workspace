#!/usr/bin/env bash
# Tests for ci-gate.sh and verify-ci.sh with a fake `gh`. Runs in the `check` job of ci.yaml and
# locally: `.github/scripts/test-scripts.sh`.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

# `gh api ...` prints $FAKE_FILES (or fails when FAKE_API_FAIL is set); `gh run list ...` prints
# $FAKE_RUN, which is what the real command would print after applying the script's --jq filter.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  api)
    if [ -n "${FAKE_API_FAIL:-}" ]; then exit 1; fi
    if [ -n "${FAKE_FILES:-}" ]; then printf '%s\n' "$FAKE_FILES"; fi
    ;;
  run) printf '%s\n' "${FAKE_RUN:-none}" ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$work/bin/gh"

failures=0
pass() { echo "ok:   $1"; }
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# gate <label> <expected heavy value> VAR=value...
gate() {
  local label=$1 expected=$2
  shift 2
  local out="$work/output"
  : >"$out"
  env PATH="$work/bin:$PATH" REPO=o/r BEFORE=1111111111111111111111111111111111111111 AFTER=2222222222222222222222222222222222222222 \
    GITHUB_OUTPUT="$out" "$@" bash "$here/ci-gate.sh" >/dev/null
  if [ "$(cat "$out")" = "heavy=${expected}" ]; then pass "gate: $label"; else fail "gate: $label (got $(cat "$out"), want heavy=${expected})"; fi
}

gate "pull request" true EVENT_NAME=pull_request REF=refs/pull/1/merge
gate "schedule" true EVENT_NAME=schedule REF=refs/heads/main
gate "manual run" true EVENT_NAME=workflow_dispatch REF=refs/heads/claude/x
gate "push to main" true EVENT_NAME=push REF=refs/heads/main FAKE_FILES=apps/mcp/src/a.ts
gate "opt-in token" true EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=chore: x [ci full]" FAKE_FILES=apps/mcp/src/a.ts
gate "opt-in token, any case" true EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=chore: x [CI Full]" FAKE_FILES=apps/mcp/src/a.ts
gate "new branch" true EVENT_NAME=push REF=refs/heads/claude/x BEFORE=0000000000000000000000000000000000000000
gate "file list unavailable" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_API_FAIL=1
gate "application code only" false EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=feat: x" "FAKE_FILES=apps/mcp/src/a.ts
packages/db/package.json
.github/CODEOWNERS
docker-compose.yml"
gate "no files" false EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=feat: x"
gate "Dockerfile" true EVENT_NAME=push REF=refs/heads/claude/x "FAKE_FILES=apps/mcp/src/a.ts
docker/web.Dockerfile"
gate "dockerignore" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=.dockerignore
gate "workflow" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=.github/workflows/ci.yaml
gate "local action" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=.github/actions/setup/action.yaml
gate "secret scan configuration" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=.gitleaks.toml
gate "secret scan ignore list" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=.gitleaksignore
gate "CI script" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=.github/scripts/ci-gate.sh
gate "lockfile" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=pnpm-lock.yaml
gate "workspace file" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=pnpm-workspace.yaml
gate "root package.json" true EVENT_NAME=push REF=refs/heads/claude/x FAKE_FILES=package.json

# verify <label> <expected exit status> VAR=value...
verify() {
  local label=$1 expected=$2 status=0
  shift 2
  env PATH="$work/bin:$PATH" REPOSITORY=o/r COMMIT=cccccccccccccccccccccccccccccccccccccccc "$@" \
    bash "$here/verify-ci.sh" >/dev/null 2>&1 || status=$?
  if [ "$status" -eq "$expected" ]; then pass "verify-ci: $label"; else fail "verify-ci: $label (exit $status, want $expected)"; fi
}

head=cccccccccccccccccccccccccccccccccccccccc
old=dddddddddddddddddddddddddddddddddddddddd
verify "green run on the commit" 0 "FAKE_RUN=$head completed success"
verify "no run at all" 1 FAKE_RUN=none
verify "run still in progress" 1 "FAKE_RUN=$head in_progress -"
verify "failed run" 1 "FAKE_RUN=$head completed failure"
verify "cancelled run" 1 "FAKE_RUN=$head completed cancelled"
verify "older green run, documentation-only commits since" 0 "FAKE_RUN=$old completed success" "FAKE_FILES=docs/ci-cd.md
README.md
LICENSE"
verify "older green run, no file difference" 0 "FAKE_RUN=$old completed success"
verify "older green run, code changed since" 1 "FAKE_RUN=$old completed success" "FAKE_FILES=docs/ci-cd.md
apps/mcp/src/a.ts"
verify "older green run, comparison fails" 1 "FAKE_RUN=$old completed success" FAKE_API_FAIL=1

if [ "$failures" -ne 0 ]; then
  echo "$failures test(s) failed" >&2
  exit 1
fi
echo "all helper script tests passed"
