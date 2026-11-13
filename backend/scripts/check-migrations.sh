#!/usr/bin/env bash
#
# Checks of the migration runner against a real database, run by CI after it has loaded
# backend/init.sql and applied the migrations (.github/workflows/ci-cd.yml). Each compares
# pg_dump --schema-only output, so the schema, its privileges and RLS policies must match.
#
#   rollback       Roll back every migration newer than the baseline (db/baseline.ts: the
#                  migrations before it are part of init.sql), apply them again, and compare
#                  the schema with before. With none newer, it says so and
#                  passes.
#   fresh-install  In a new, empty database, let the migration runner load the baseline and
#                  apply the migrations, as on a plain Postgres 18, and compare the schema
#                  with $DB_NAME's, which was made by loading init.sql with psql first.
#                  The new database is dropped afterwards.
#   upgrade        Load a v2.4.0 install (src/test/fixtures/v2.4.0-install.sql) into a new,
#                  empty database and let the runner bring it forward: it cuts it over to the
#                  baseline (upgrade/from-v2.4.0.sql) and applies the migrations newer than
#                  it. Then compare its schema and privileges, schema_migrations and database
#                  settings with a fresh install the runner made from init.sql. Both new
#                  databases are dropped afterwards.
#
# Usage, from the repository root, after `npm run build` in backend/:
#   PG_CONTAINER=<postgres container> backend/scripts/check-migrations.sh rollback|fresh-install|upgrade
#
# Environment: what `node dist/scripts/migrate.js` needs (DB_HOST, DB_PORT, DB_NAME, DB_USER
# or MIGRATION_DB_USER as the owner, DB_PASSWORD, and the secrets),
# and PG_CONTAINER, the Postgres container: pg_dump and psql run there, so their version
# matches the server's.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${PG_CONTAINER:?set PG_CONTAINER to the Postgres container}"
: "${DB_NAME:?set DB_NAME}"
OWNER="${MIGRATION_DB_USER:-${DB_USER:?set DB_USER or MIGRATION_DB_USER}}"
OWNER_PASSWORD="${DB_PASSWORD:-}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# pg_dump in the container, without the \restrict lines (a random key per run), and with
# one spelling for a CHECK on a varchar column (schema-compare.sed, which
# regen-init-sql.sh uses too): Postgres prints it one way as a migration made it and
# another once init.sql reloaded it, so a regenerated baseline would differ from the
# same migrations applied again.
schema() {
  docker exec -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" \
    pg_dump -U "$OWNER" -d "$1" --schema-only | sed -E -e '/^\\(un)?restrict /d' -f "$BACKEND_DIR/scripts/schema-compare.sed"
}
psql_admin() {
  docker exec -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" psql -X -q -v ON_ERROR_STOP=1 -U "$OWNER" -d postgres "$@"
}
migrate() { (cd "$BACKEND_DIR" && node dist/scripts/migrate.js "$@"); }
same_schema() {
  if ! diff -u "$1" "$2" > "$WORK/diff.txt"; then
    head -n 100 "$WORK/diff.txt"
    echo "✗ $3"
    exit 1
  fi
}

# The baseline's schema_migrations version, as the built runner has it.
baseline_version() {
  (cd "$BACKEND_DIR" && node --input-type=module -e "import('./dist/db/baseline.js').then((m) => console.log(m.BASELINE.version))")
}
# One line per setting the database itself has (ALTER DATABASE ... SET), sorted.
database_settings() {
  docker exec -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" psql -X -tA -U "$OWNER" -d "$1" -c \
    "SELECT unnest(setconfig) FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0 ORDER BY 1"
}
# The migration history: each row's version, name and checksum.
migration_history() {
  docker exec -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" psql -X -tA -U "$OWNER" -d "$1" -c \
    "SELECT version || ' ' || name || ' ' || checksum FROM schema_migrations ORDER BY version"
}

case "${1:-}" in
  rollback)
    # Every migration file is newer than the baseline (the runner refuses one that isn't), and
    # each has a DOWN part (migrationFiles.test.ts): all of them are rolled back.
    baseline=$(baseline_version)
    count=$(find "$BACKEND_DIR/migrations" -maxdepth 1 -name '[0-9]*.sql' -printf '%f\n' \
      | awk -v v="$baseline" 'substr($0, 1, 14) > v' | wc -l)
    if [ "$count" -eq 0 ]; then
      echo "✓ No migration newer than the baseline ($baseline), so nothing to roll back: the check passes."
      exit 0
    fi
    echo "▶ Rolling back the $count migration(s) newer than the baseline ($baseline), then applying them again"
    schema "$DB_NAME" > "$WORK/before.sql"
    applied() {
      docker exec -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" psql -X -tA -U "$OWNER" -d "$DB_NAME" \
        -c "SELECT count(*) FROM schema_migrations"
    }
    before=$(applied)
    # Through the npm script, which must hand the count on (it once rolled back only one).
    (cd "$BACKEND_DIR" && npm run --silent migrate:rollback -- "$count" --yes)
    after=$(applied)
    if [ "$((before - after))" -ne "$count" ]; then
      echo "✗ Asked to roll back $count migration(s); $((before - after)) were rolled back"
      exit 1
    fi
    migrate migrate
    schema "$DB_NAME" > "$WORK/after.sql"
    same_schema "$WORK/before.sql" "$WORK/after.sql" \
      "Rolling back and re-applying the last $count migration(s) changed the schema: a DOWN part doesn't undo its migration"
    echo "✓ Rolled back $count migration(s) and applied them again: the schema is the same"
    ;;

  fresh-install)
    fresh="${DB_NAME}_fresh_install"
    psql_admin -c "DROP DATABASE IF EXISTS $fresh WITH (FORCE)" -c "CREATE DATABASE $fresh"
    trap 'psql_admin -c "DROP DATABASE IF EXISTS $fresh WITH (FORCE)" > /dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
    tables() {
      docker exec -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" psql -X -tA -U "$OWNER" -d "$fresh" \
        -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'"
    }
    echo "▶ An empty database: status creates nothing, migrate loads the baseline and applies the migrations"
    DB_NAME="$fresh" migrate status > /dev/null
    if [ "$(tables)" != "0" ]; then
      echo "✗ migrate status created tables in an empty database"
      exit 1
    fi
    DB_NAME="$fresh" migrate migrate
    DB_NAME="$fresh" migrate migrate | tee "$WORK/again.log"
    grep -q 'No pending migrations' "$WORK/again.log" || { echo "✗ a second migrate found migrations to apply"; exit 1; }
    schema "$DB_NAME" > "$WORK/psql-loaded.sql"
    schema "$fresh" > "$WORK/runner-loaded.sql"
    same_schema "$WORK/psql-loaded.sql" "$WORK/runner-loaded.sql" \
      "A database the runner bootstrapped differs from one loaded with psql -f init.sql and migrated"
    echo "✓ The runner bootstrapped an empty database to the same schema as init.sql plus migrations"
    ;;

  upgrade)
    upgraded="${DB_NAME}_upgrade_v240"
    fresh="${DB_NAME}_upgrade_fresh"
    fixture="$BACKEND_DIR/src/test/fixtures/v2.4.0-install.sql"
    drop_both() {
      psql_admin -c "DROP DATABASE IF EXISTS $upgraded WITH (FORCE)" -c "DROP DATABASE IF EXISTS $fresh WITH (FORCE)"
    }
    drop_both > /dev/null
    psql_admin -c "CREATE DATABASE $upgraded" -c "CREATE DATABASE $fresh"
    trap 'drop_both > /dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

    echo "▶ A v2.4.0 install: loading $(basename "$fixture"), then migrate cuts it over and applies the migrations"
    docker exec -i -e PGPASSWORD="$OWNER_PASSWORD" "$PG_CONTAINER" \
      psql -X -q -v ON_ERROR_STOP=1 -U "$OWNER" -d "$upgraded" < "$fixture" > /dev/null
    before=$(migration_history "$upgraded" | wc -l)
    DB_NAME="$upgraded" migrate migrate | tee "$WORK/upgrade.log"
    grep -q 'Cut over to the baseline' "$WORK/upgrade.log" || { echo "✗ migrate didn't cut the v2.4.0 install over to the baseline"; exit 1; }
    DB_NAME="$upgraded" migrate migrate | tee "$WORK/again.log"
    grep -q 'No pending migrations' "$WORK/again.log" || { echo "✗ a second migrate found migrations to apply"; exit 1; }

    echo "▶ A fresh install: migrate loads init.sql into an empty database"
    DB_NAME="$fresh" migrate migrate > /dev/null

    schema "$fresh" > "$WORK/fresh.sql"
    schema "$upgraded" > "$WORK/upgraded.sql"
    same_schema "$WORK/fresh.sql" "$WORK/upgraded.sql" \
      "The v2.4.0 install, cut over and migrated, differs from a fresh install (schema or privileges)"
    migration_history "$fresh" > "$WORK/fresh-history.txt"
    migration_history "$upgraded" > "$WORK/upgraded-history.txt"
    same_schema "$WORK/fresh-history.txt" "$WORK/upgraded-history.txt" \
      "The v2.4.0 install's schema_migrations differs from a fresh install's"
    database_settings "$fresh" > "$WORK/fresh-settings.txt"
    database_settings "$upgraded" > "$WORK/upgraded-settings.txt"
    same_schema "$WORK/fresh-settings.txt" "$WORK/upgraded-settings.txt" \
      "The v2.4.0 install's database settings differ from a fresh install's"
    echo "✓ A v2.4.0 install ($before migrations) was cut over to the baseline: its schema, privileges, migration history ($(wc -l < "$WORK/upgraded-history.txt") row(s)) and database settings are a fresh install's"
    ;;

  *)
    echo "usage: PG_CONTAINER=<container> $0 rollback|fresh-install|upgrade" >&2
    exit 2
    ;;
esac
