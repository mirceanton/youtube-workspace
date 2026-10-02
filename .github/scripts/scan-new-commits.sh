#!/usr/bin/env bash
# Scans the commits a push added for secrets (gitleaks with .gitleaks.toml and .gitleaksignore).
# Called by the `check` job of ci.yaml on every push, so a secret committed in ordinary source is
# found on the push that adds it, not only by the next full run (the `scan` job rescans everything).
# It takes about two seconds. Needs the history: check out with fetch-depth: 0.
#
# Inputs (environment): BEFORE (head before the push), AFTER (head after it). Without a usable
# BEFORE (a new branch, or history that was rewritten) the whole reachable history is scanned.
# Tested by .github/scripts/test-scripts.sh with a fake gitleaks.
set -euo pipefail

: "${AFTER:?AFTER is required}"
before="${BEFORE:-}"

range=()
case "$before" in
  "" | 0000000000000000000000000000000000000000) ;;
  *)
    if git cat-file -e "${before}^{commit}" 2>/dev/null; then
      range=("--log-opts=${before}..${AFTER}")
    fi
    ;;
esac

if [ "${#range[@]}" -eq 0 ]; then
  echo "no usable previous head: scanning all reachable history"
else
  echo "scanning the commits ${before}..${AFTER}"
fi
exec gitleaks git --config .gitleaks.toml --redact --verbose --no-banner "${range[@]+"${range[@]}"}" .
