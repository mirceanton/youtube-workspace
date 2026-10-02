#!/usr/bin/env bash
# Tests for ci-gate.sh, verify-ci.sh and scan-new-commits.sh with fake `gh` and `gitleaks` commands.
# Runs in the `check` job of ci.yaml and locally: `.github/scripts/test-scripts.sh`. Needs bash, git
# and jq.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"

# The fake `gh` applies the --jq filter that the script under test passes (with the real jq) to
# canned JSON, so the filters are tested too. `gh api` answers with $FAKE_COMPARE (or fails when
# FAKE_API_FAIL is set); `gh run list` answers with $FAKE_RUN_OWN when it is asked about a commit
# (--commit) and with $FAKE_RUN_LATEST otherwise. Every call is appended to $FAKE_GH_LOG.
cat >"$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"${FAKE_GH_LOG:-/dev/null}"
filter=""
asked_for_commit=""
previous=""
for arg in "$@"; do
  [ "$previous" = "--jq" ] && filter=$arg
  [ "$arg" = "--commit" ] && asked_for_commit=yes
  previous=$arg
done
case "$1" in
  api)
    [ -z "${FAKE_API_FAIL:-}" ] || exit 1
    printf '%s' "${FAKE_COMPARE:?}" | jq -r "$filter"
    ;;
  run)
    if [ -n "$asked_for_commit" ]; then json=${FAKE_RUN_OWN:-[]}; else json=${FAKE_RUN_LATEST:-[]}; fi
    printf '%s' "$json" | jq -r "$filter"
    ;;
  *) exit 2 ;;
esac
FAKE
chmod +x "$work/bin/gh"

# The fake `gitleaks` only records its arguments.
cat >"$work/bin/gitleaks" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"${FAKE_GITLEAKS_LOG:?}"
FAKE
chmod +x "$work/bin/gitleaks"

failures=0
pass() { echo "ok:   $1"; }
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# --- canned GitHub answers ----------------------------------------------------------------------
# compare <status> [file...]: a comparison with exactly these files
compare() {
  local status=$1
  shift
  jq -cn --arg status "$status" '{status: $status, files: ($ARGS.positional | map({filename: .}))}' --args "$@"
}
# compare_many <status> <count>: a comparison with that many files, none of them relevant
compare_many() {
  jq -cn --arg status "$1" --argjson n "$2" \
    '{status: $status, files: [range($n) | {filename: "apps/web-ui/src/file-\(.).tsx"}]}'
}
# run_json <sha> <status> <conclusion>: what `gh run list --json headSha,status,conclusion` prints
# (an unfinished run has an empty conclusion)
run_json() {
  jq -cn --arg sha "$1" --arg status "$2" --arg conclusion "$3" \
    '[{headSha: $sha, status: $status, conclusion: $conclusion}]'
}

# --- ci-gate.sh ---------------------------------------------------------------------------------
# gate <label> <expected heavy value> VAR=value...
gate() {
  local label=$1 expected=$2
  shift 2
  local out="$work/output"
  : >"$out"
  env PATH="$work/bin:$PATH" REPO=o/r BEFORE=1111111111111111111111111111111111111111 \
    AFTER=2222222222222222222222222222222222222222 GITHUB_OUTPUT="$out" "$@" \
    bash "$here/ci-gate.sh" >/dev/null
  if [ "$(cat "$out")" = "heavy=${expected}" ]; then pass "gate: $label"; else fail "gate: $label (got $(cat "$out"), want heavy=${expected})"; fi
}

push=(EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=feat: x")
gate "pull request" true EVENT_NAME=pull_request REF=refs/pull/1/merge
gate "schedule" true EVENT_NAME=schedule REF=refs/heads/main
gate "manual run" true EVENT_NAME=workflow_dispatch REF=refs/heads/claude/x
gate "push to main" true EVENT_NAME=push REF=refs/heads/main "FAKE_COMPARE=$(compare ahead apps/mcp/src/a.ts)"
gate "opt-in token" true EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=chore: x [ci full]" "FAKE_COMPARE=$(compare ahead apps/mcp/src/a.ts)"
gate "opt-in token, any case" true EVENT_NAME=push REF=refs/heads/claude/x "HEAD_MESSAGE=chore: x [CI Full]" "FAKE_COMPARE=$(compare ahead apps/mcp/src/a.ts)"
gate "new branch" true "${push[@]}" BEFORE=0000000000000000000000000000000000000000
gate "comparison fails" true "${push[@]}" FAKE_API_FAIL=1
gate "force push (diverged)" true "${push[@]}" "FAKE_COMPARE=$(compare diverged apps/mcp/src/a.ts)"
gate "branch moved back (behind)" true "${push[@]}" "FAKE_COMPARE=$(compare behind)"
gate "application code only" false "${push[@]}" "FAKE_COMPARE=$(compare ahead apps/mcp/src/a.ts packages/db/package.json .github/CODEOWNERS docker-compose.yml apps/web-ui/src/env.ts)"
gate "no files" false "${push[@]}" "FAKE_COMPARE=$(compare ahead)"
gate "identical" false "${push[@]}" "FAKE_COMPARE=$(compare identical)"
gate "299 files, none relevant" false "${push[@]}" "FAKE_COMPARE=$(compare_many ahead 299)"
gate "300 files (list truncated)" true "${push[@]}" "FAKE_COMPARE=$(compare_many ahead 300)"
for path in docker/web.Dockerfile docker/smoke.env .dockerignore .gitleaks.toml .gitleaksignore \
  .trivyignore .trivyignore.yaml trivy.yaml .npmrc packages/db/.npmrc \
  .github/workflows/ci.yaml .github/actions/setup/action.yaml .github/scripts/ci-gate.sh \
  pnpm-lock.yaml pnpm-workspace.yaml package.json apps/web-server/src/env.ts apps/mcp/src/env.ts; do
  gate "relevant: $path" true "${push[@]}" "FAKE_COMPARE=$(compare ahead apps/mcp/src/a.ts "$path")"
done

# --- verify-ci.sh -------------------------------------------------------------------------------
head=cccccccccccccccccccccccccccccccccccccccc
old=dddddddddddddddddddddddddddddddddddddddd
# verify <label> <expected exit status> VAR=value...
verify() {
  local label=$1 expected=$2 status=0
  shift 2
  : >"$work/gh.log"
  env PATH="$work/bin:$PATH" REPOSITORY=o/r COMMIT=$head FAKE_GH_LOG="$work/gh.log" "$@" \
    bash "$here/verify-ci.sh" >/dev/null 2>&1 || status=$?
  if [ "$status" -eq "$expected" ]; then pass "verify-ci: $label"; else fail "verify-ci: $label (exit $status, want $expected)"; fi
}

verify "green run of the commit itself" 0 "FAKE_RUN_OWN=$(run_json $head completed success)"
verify "run of the commit itself failed" 1 "FAKE_RUN_OWN=$(run_json $head completed failure)"
verify "run of the commit itself cancelled" 1 "FAKE_RUN_OWN=$(run_json $head completed cancelled)"
verify "run of the commit itself still running" 1 "FAKE_RUN_OWN=$(run_json $head in_progress '')"
# A re-run of an old release run: the commit is red, a newer commit on main is green.
verify "red commit behind a green run (re-run of an old release)" 1 \
  "FAKE_RUN_OWN=$(run_json $head completed failure)" "FAKE_RUN_LATEST=$(run_json $old completed success)" "FAKE_COMPARE=$(compare behind)"
verify "no run of its own, no run on main at all" 1
verify "no run of its own, latest run on main still running" 1 "FAKE_RUN_LATEST=$(run_json $old queued '')" "FAKE_COMPARE=$(compare ahead docs/ci-cd.md)"
verify "no run of its own, latest run on main failed" 1 "FAKE_RUN_LATEST=$(run_json $old completed failure)" "FAKE_COMPARE=$(compare ahead docs/ci-cd.md)"
green_latest="FAKE_RUN_LATEST=$(run_json $old completed success)"
verify "no run of its own, ahead of a green run, documentation only" 0 "$green_latest" "FAKE_COMPARE=$(compare ahead docs/ci-cd.md README.md docs/adr/0002-x.md LICENSE)"
verify "no run of its own, ahead of a green run, no files" 0 "$green_latest" "FAKE_COMPARE=$(compare ahead)"
verify "no run of its own, identical to a green run" 0 "$green_latest" "FAKE_COMPARE=$(compare identical)"
verify "no run of its own, BEHIND a green run (no files listed)" 1 "$green_latest" "FAKE_COMPARE=$(compare behind)"
verify "no run of its own, diverged from a green run" 1 "$green_latest" "FAKE_COMPARE=$(compare diverged docs/ci-cd.md)"
verify "no run of its own, code changed since the green run" 1 "$green_latest" "FAKE_COMPARE=$(compare ahead docs/ci-cd.md apps/mcp/src/a.ts)"
verify "no run of its own, 300 documentation files (list truncated)" 1 "$green_latest" \
  "FAKE_COMPARE=$(jq -cn '{status: "ahead", files: [range(300) | {filename: "docs/page-\(.).md"}]}')"
verify "no run of its own, comparison fails" 1 "$green_latest" FAKE_API_FAIL=1
# Only runs on main count: every `gh run list` call must be restricted to the main branch.
: >"$work/gh.log"
env PATH="$work/bin:$PATH" REPOSITORY=o/r COMMIT=$head FAKE_GH_LOG="$work/gh.log" "$green_latest" \
  "FAKE_COMPARE=$(compare ahead docs/ci-cd.md)" bash "$here/verify-ci.sh" >/dev/null 2>&1 || true
runs_asked=$(grep -c '^run list' "$work/gh.log" || true)
runs_on_main=$(grep '^run list' "$work/gh.log" | grep -c -- '--branch main' || true)
if [ "$runs_asked" -ge 2 ] && [ "$runs_asked" -eq "$runs_on_main" ]; then pass "verify-ci: asks only for runs on main"; else fail "verify-ci: asks only for runs on main (${runs_on_main} of ${runs_asked})"; fi

# --- scan-new-commits.sh ------------------------------------------------------------------------
repo="$work/repo"
mkdir "$repo"
git -C "$repo" init -q
git -C "$repo" config user.email "test@example.invalid"
git -C "$repo" config user.name "test"
for n in 1 2 3; do
  echo "$n" >"$repo/file"
  git -C "$repo" add file
  git -C "$repo" commit -q -m "commit $n"
done
first=$(git -C "$repo" rev-parse HEAD~2)
last=$(git -C "$repo" rev-parse HEAD)
# scanned <label> <expected arguments> BEFORE
scanned() {
  local label=$1 expected=$2 before=$3
  : >"$work/gitleaks.log"
  (cd "$repo" && env PATH="$work/bin:$PATH" FAKE_GITLEAKS_LOG="$work/gitleaks.log" BEFORE="$before" AFTER="$last" \
    bash "$here/scan-new-commits.sh" >/dev/null)
  if [ "$(cat "$work/gitleaks.log")" = "$expected" ]; then pass "scan-new-commits: $label"; else fail "scan-new-commits: $label (got: $(cat "$work/gitleaks.log"))"; fi
}
base="git --config .gitleaks.toml --redact --verbose --no-banner"
scanned "only the commits of the push" "${base} --log-opts=${first}..${last} ." "$first"
scanned "new branch scans all history" "${base} ." "0000000000000000000000000000000000000000"
scanned "unknown previous head (rewritten history) scans all history" "${base} ." "1111111111111111111111111111111111111111"
scanned "no previous head scans all history" "${base} ." ""

if [ "$failures" -ne 0 ]; then
  echo "$failures test(s) failed" >&2
  exit 1
fi
echo "all helper script tests passed"
