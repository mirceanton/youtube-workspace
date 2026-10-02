#!/usr/bin/env bash
# Plants the files that exist on a developer machine but must never reach an image, to prove that
# .dockerignore keeps them out of the build context. CI runs this before building the images and
# passes the sentinel to docker/smoke.sh, which fails if one of these files, or any file containing
# the sentinel, is found in the image.
#
#   docker/plant-local-files.sh            plant the files, print the sentinel written into them
#   docker/plant-local-files.sh --remove   delete the files this script planted
#
# It never overwrites a file that already exists (your real apps/<app>/.env, for example) and only
# removes files that still carry its marker line.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
marker="PLANTED_BY=docker/plant-local-files.sh"

files=(
  .env
  .env.production
  apps/mcp/.env
  apps/web-server/.env
  apps/web-ui/.env.local
  packages/shared/.env.local
  packages/db/.env
  e2e/.auth/state.json
  .claude/settings.local.json
  apps/mcp/signing.pem
  packages/shared/signing.key
)

if [ "${1:-}" = "--remove" ]; then
  for file in "${files[@]}"; do
    if [ -f "${root}/${file}" ] && grep -qF "$marker" "${root}/${file}"; then
      rm -f "${root}/${file}"
    fi
  done
  exit 0
fi

for file in "${files[@]}"; do
  if [ -e "${root}/${file}" ]; then
    echo "refusing to overwrite ${file}; move it away first or run this in a clean checkout" >&2
    exit 1
  fi
done

sentinel="ytw-planted-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
for file in "${files[@]}"; do
  mkdir -p "$(dirname "${root}/${file}")"
  printf '%s\nPLANTED_SENTINEL=%s\n' "$marker" "$sentinel" >"${root}/${file}"
done
echo "$sentinel"
