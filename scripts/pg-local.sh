#!/usr/bin/env bash
# Local Postgres 16 without Docker, for development and tests (the agent sandbox has no Docker
# daemon). With Docker available, `docker compose up -d postgres` gives an equivalent server.
#
# One cluster is shared by every checkout and worktree on the machine. Test runs create and drop
# their own uniquely named databases inside it, so there is deliberately no "reset" command, and
# `stop` is for humans only: other agents may be using the cluster.
#
# Usage: scripts/pg-local.sh <command>
#   start   Start the cluster (initialising it on first use); idempotent. Prints the admin URL.
#   url     Print the admin (superuser) connection URL.
#   status  Exit 0 and print the URL when running, exit 3 when not.
#   stop    Stop the cluster. Do not use while other agents or test runs share it.
#
# Environment (all optional):
#   PG_BIN         Postgres 16 binaries   (default /usr/lib/postgresql/16/bin)
#   PG_LOCAL_DIR   Cluster directory      (default /var/tmp/ytw-postgres-16)
#   PG_LOCAL_PORT  TCP port on localhost  (default 5432)
#
# Credentials are the dev-only superuser postgres/postgres, the same as docker-compose.yml.
# Postgres refuses to run as root, so when invoked as root every server command runs as the
# `postgres` OS user.
set -euo pipefail

PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
BASE_DIR="${PG_LOCAL_DIR:-/var/tmp/ytw-postgres-16}"
PORT="${PG_LOCAL_PORT:-5432}"
DATA_DIR="${BASE_DIR}/data"
SOCKET_DIR="${BASE_DIR}/run"
LOG_FILE="${BASE_DIR}/postgres.log"
LOCK_FILE="${BASE_DIR}.lock"
SUPERUSER="postgres"
PASSWORD="postgres"
DEV_DATABASE="youtube_workspace"
ADMIN_URL="postgres://${SUPERUSER}:${PASSWORD}@localhost:${PORT}/postgres"

# Server settings, applied on every start so this script stays the single source of truth.
# Durability is traded for speed: this cluster only ever holds throwaway dev and test data.
SERVER_OPTS="-p ${PORT} -k ${SOCKET_DIR} -c listen_addresses=localhost -c max_connections=300 -c shared_buffers=256MB -c fsync=off -c synchronous_commit=off -c full_page_writes=off"

usage() {
  echo "usage: scripts/pg-local.sh start|url|status|stop (see the header of this script)" >&2
  exit 2
}

# Runs a command as the cluster owner: the `postgres` OS user when we are root, else ourselves.
as_owner() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

is_running() {
  [ -f "${DATA_DIR}/PG_VERSION" ] && as_owner "${PG_BIN}/pg_ctl" status -D "${DATA_DIR}" >/dev/null 2>&1
}

init_cluster() {
  mkdir -p "${BASE_DIR}"
  if [ "$(id -u)" -eq 0 ]; then
    chown postgres:postgres "${BASE_DIR}"
  fi
  as_owner mkdir -p "${SOCKET_DIR}"

  local locale_args=(--no-locale)
  if locale -a 2>/dev/null | grep -qiE '^c\.utf-?8$'; then
    locale_args=(--locale=C.UTF-8)
  fi

  local pwfile="${BASE_DIR}/.pwfile"
  as_owner sh -c "umask 077 && printf '%s\n' '${PASSWORD}' > '${pwfile}'"
  as_owner "${PG_BIN}/initdb" -D "${DATA_DIR}" -U "${SUPERUSER}" --pwfile="${pwfile}" \
    --auth-local=trust --auth-host=scram-sha-256 --encoding=UTF8 "${locale_args[@]}" >/dev/null
  as_owner rm -f "${pwfile}"
}

start() {
  if [ ! -x "${PG_BIN}/pg_ctl" ]; then
    echo "pg-local: no Postgres binaries in ${PG_BIN} (set PG_BIN)" >&2
    exit 1
  fi

  # Serialise concurrent `start` calls from parallel agents.
  exec 9>"${LOCK_FILE}"
  flock 9

  if ! is_running; then
    if [ ! -f "${DATA_DIR}/PG_VERSION" ]; then
      init_cluster
    fi
    as_owner mkdir -p "${SOCKET_DIR}"
    # `9>&-`: the server must not inherit the lock descriptor, or it would hold the lock forever.
    if ! as_owner "${PG_BIN}/pg_ctl" start -D "${DATA_DIR}" -l "${LOG_FILE}" -w -t 60 \
      -o "${SERVER_OPTS}" >/dev/null 9>&-; then
      echo "pg-local: Postgres failed to start; last log lines:" >&2
      tail -n 20 "${LOG_FILE}" >&2 || true
      exit 1
    fi
  fi

  # Same database name as docker-compose.yml, for the URLs in .env.example.
  if ! PGPASSWORD="${PASSWORD}" psql "${ADMIN_URL}" -tAc \
    "SELECT 1 FROM pg_database WHERE datname = '${DEV_DATABASE}'" | grep -q 1; then
    PGPASSWORD="${PASSWORD}" psql "${ADMIN_URL}" -qc "CREATE DATABASE ${DEV_DATABASE}" >/dev/null
  fi

  echo "${ADMIN_URL}"
}

status() {
  if is_running; then
    echo "running: ${ADMIN_URL}"
  else
    echo "not running (start it with: scripts/pg-local.sh start)"
    exit 3
  fi
}

stop() {
  exec 9>"${LOCK_FILE}"
  flock 9
  if is_running; then
    as_owner "${PG_BIN}/pg_ctl" stop -D "${DATA_DIR}" -m fast -w >/dev/null
    echo "stopped"
  else
    echo "not running"
  fi
}

case "${1:-}" in
  start) start ;;
  url) echo "${ADMIN_URL}" ;;
  status) status ;;
  stop) stop ;;
  *) usage ;;
esac
