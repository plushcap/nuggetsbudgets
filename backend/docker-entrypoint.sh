#!/bin/sh
# Backend container entrypoint.
#
# Applies pending database migrations (idempotent; only unapplied migrations
# run) before starting the server, then hands off to the image CMD. An empty
# database (a plain or external Postgres) gets the baseline schema, init.sql,
# first. Disable by setting RUN_MIGRATIONS=false. Migrations are guarded by a
# Postgres advisory lock in MigrationService, so concurrent container starts
# can't race.
set -e

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  # The prod compose uses a plain `depends_on: - postgres` (no health gate), so
  # the DB may not be reachable yet. Wait with `migrate check`, which connects as
  # migrate does (the app's db config, including Docker secrets). It exits 75 only
  # while the database isn't reachable yet; anything waiting won't fix (a secret that
  # is missing or can't be read, a wrong password, an unknown role or database) stops
  # here at once, with what it said. A *broken* migration still fails fast too,
  # in `migrate` below.
  echo "[entrypoint] Waiting for database..."
  attempts=0
  max_attempts="${DB_WAIT_ATTEMPTS:-30}"
  case "$max_attempts" in
    ''|*[!0-9]*|0)
      echo "[entrypoint] DB_WAIT_ATTEMPTS must be a whole number of 1 or more, not \"$max_attempts\""
      exit 1
      ;;
  esac
  while :; do
    attempts=$((attempts + 1))
    output=$(node dist/scripts/migrate.js check 2>&1) && status=0 || status=$?
    [ "$status" -eq 0 ] && break
    if [ "$status" -ne 75 ]; then
      echo "[entrypoint] The database can't be used with this configuration; not retrying:"
      printf '%s\n' "$output"
      exit 1
    fi
    if [ "$attempts" -ge "$max_attempts" ]; then
      echo "[entrypoint] Database not reachable after $attempts attempts; aborting. The last attempt said:"
      printf '%s\n' "$output"
      exit 1
    fi
    # The reason is check's own line, which starts with ⏳ (log lines may come after it).
    reason=$(printf '%s\n' "$output" | grep -F '⏳' | tail -n 1 || true)
    echo "[entrypoint] database not ready ($attempts/$max_attempts): ${reason:-$(printf '%s\n' "$output" | tail -n 1)}; retrying in 3s..."
    sleep 3
  done

  echo "[entrypoint] Applying database migrations..."
  # A migration that fails leaves its report, the schema and the applied migrations in the
  # backups directory (BACKUPS_PATH on the host) before migrate exits, and set -e stops
  # here.
  node dist/scripts/migrate.js migrate
else
  echo "[entrypoint] RUN_MIGRATIONS=${RUN_MIGRATIONS}; skipping migrations"
fi

exec "$@"
