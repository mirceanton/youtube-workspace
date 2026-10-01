#!/usr/bin/env bash
# Proves that the secret scan still catches real secrets with the repository's allowlist in place
# (.gitleaks.toml): the allowlist hides the known fake fixtures at their one path and nothing else.
# Needs the gitleaks CLI on PATH. Run by the `scan` job in .github/workflows/ci.yaml.
#
# Every fixture is built at run time from random or split strings, so no line of this script looks
# like a credential to the scanner itself.
set -euo pipefail

config=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.gitleaks.toml
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fixture_path='packages/observability/test/helpers.ts'
other_path='apps/mcp/src/config.ts'

# A random GitHub-token-shaped value (36 alphanumeric characters after the prefix).
planted="ghp_$(head -c 96 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 36)"
# The allowlisted fake password, written in the shape of the fixture line it comes from.
fake_password="hunter2""-correct-horse-battery"
fixture_line=$(printf '  %s: "%s",' password "$fake_password")

# A UUID row id as the database tests use it, generated here so the script holds no literal.
row_id=$(cat /proc/sys/kernel/random/uuid)
row_id_line=$(printf '  %s: "%s",' tokenId "$row_id")
planted_id_line=$(printf '  %s: "%s",' tokenId "$planted")

failures=0

# scan <label> <expected: leak|clean> <path> <file content>
scan() {
  local label=$1 expected=$2 path=$3 content=$4 repo status=0
  repo=$(mktemp -d -p "$work")
  (
    cd "$repo"
    git init -q
    git config user.email "test@example.invalid"
    git config user.name "test"
    mkdir -p "$(dirname "$path")"
    printf '%s\n' "$content" >"$path"
    git add -A
    git commit -q -m "fixture"
    gitleaks git --config "$config" --no-banner --redact --exit-code 1 . >/dev/null 2>&1
  ) || status=$?
  local got=clean
  [ "$status" -eq 1 ] && got=leak
  if [ "$status" -gt 1 ]; then
    echo "FAIL: ${label} (gitleaks exited with ${status})" >&2
    failures=$((failures + 1))
  elif [ "$got" = "$expected" ]; then
    echo "ok:   ${label} -> ${got}"
  else
    echo "FAIL: ${label} (got ${got}, want ${expected})" >&2
    failures=$((failures + 1))
  fi
}

scan "planted token in application code" leak "$other_path" "const token = \"${planted}\";"
scan "planted token in the allowlisted file" leak "$fixture_path" "const token = \"${planted}\";"
scan "known fake password in another file" leak "$other_path" "$fixture_line"
scan "known fake password in the allowlisted file" clean "$fixture_path" "$fixture_line"
scan "UUID token row id in a test file" clean "packages/db/test/example.test.ts" "$row_id_line"
scan "real token under a tokenId key" leak "$other_path" "$planted_id_line"

if [ "$failures" -ne 0 ]; then
  echo "${failures} secret scan test(s) failed" >&2
  exit 1
fi
echo "secret scan tests passed"
