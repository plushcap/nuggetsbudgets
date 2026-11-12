#!/usr/bin/env bash
#
# Regenerate backend/init.sql, the baseline schema, from the current one plus every
# migration, and check that the new baseline makes the same database.
#
# WHY
#   A fresh install loads init.sql (the migration runner does it in an empty database;
#   docker-entrypoint-initdb.d does it in the shipped Postgres image), then applies the
#   migrations newer than it. The baseline must be consistent: its schema and its
#   schema_migrations seed at the same migration level, or the runner re-applies
#   migrations the schema already has and the install fails. Regenerating it now
#   and then (before a release, say) keeps fresh installs from replaying a long history
#   and keeps init.sql a readable picture of the schema.
#
#   The seed is the baseline's own row (db/baseline.ts: v3.0.0 made one baseline of every
#   migration up to v2.4.0, and its row stands for them) and a row for each migration newer
#   than it. A regeneration folds those migrations into the schema and keeps their rows (and
#   so their files: the runner checks each applied migration against its file); the
#   baseline's row stays as it is.
#
# WHAT
#   In a throwaway Postgres 18:
#   1. database A: the migration runner loads the current init.sql and applies every
#      migration (what a fresh install does today). With --from DUMP, A starts from DUMP
#      instead, loaded with psql (an older release's install, such as
#      src/test/fixtures/v2.4.0-install.sql), and the runner brings it forward: it cuts a
#      v2.4.0 database over to the baseline (upgrade/from-v2.4.0.sql), then applies the
#      migrations. v3.0.0's init.sql was made that way, from the v2.4.0 install;
#   2. the new init.sql is A's schema with its privileges (pg_dump --schema-only
#      --no-owner), the serving role it grants to, A's database settings, A's rows (the
#      settings, the deployment, the first organization and ledger, ...; each install gets
#      its own uuids and timestamps from the column defaults), the sequences' positions
#      and a schema_migrations seed listing every row of A's: the baseline's, then each
#      migration newer than it;
#   3. database B: the runner loads the new init.sql, which must leave 0 migrations
#      pending; then A and B must have the same schema and privileges, rows, sequences,
#      migration history and database settings.
#   Only then is backend/init.sql replaced.
#
# REQUIREMENTS
#   A running Docker daemon and the backend's dependencies, with shared and mcp built (the
#   npm workspace, from the repository root: npm ci && npm run build:server).
#
# USAGE
#   backend/scripts/regen-init-sql.sh [--from DUMP]   # then review `git diff backend/init.sql`
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INIT_SQL="$BACKEND_DIR/init.sql"

PG_IMAGE="postgres:18"
CONTAINER="nuggets_init_regen_$$"
PG_USER="postgres"
PG_PASSWORD="regen"
HOST_PORT="${REGEN_PG_PORT:-55432}"
SERVING_ROLE="nuggets_app"

FROM_DUMP=""
case "${1:-}" in
  "") ;;
  --from)
    FROM_DUMP="$(cd "$(dirname "${2:?--from takes a dump to start from}")" && pwd)/$(basename "$2")"
    [ -f "$FROM_DUMP" ] || { echo "✗ No such file: $2" >&2; exit 2; }
    ;;
  *) echo "usage: $0 [--from DUMP]" >&2; exit 2 ;;
esac

WORK="$(mktemp -d)"
cp "$INIT_SQL" "$WORK/init.sql.old"
REPLACED=false
cleanup() {
  # Unless every check passed, backend/init.sql is left as it was.
  if [ "$REPLACED" != true ]; then cp "$WORK/init.sql.old" "$INIT_SQL"; fi
  docker rm -f -v "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

psql_db() {
  local db=$1
  shift
  docker exec -e PGPASSWORD="$PG_PASSWORD" -i "$CONTAINER" \
    psql -X -q -v ON_ERROR_STOP=1 -U "$PG_USER" -d "$db" "$@"
}
# The migration runner (dist/scripts/migrate.js) against database $1, as the owner.
run_migrate() {
  (cd "$BACKEND_DIR" && env DB_HOST=127.0.0.1 DB_PORT="$HOST_PORT" DB_NAME="$1" \
    DB_USER="$PG_USER" DB_PASSWORD="$PG_PASSWORD" MIGRATION_DB_USER="$PG_USER" \
    JWT_SECRET=regen SESSION_SECRET=regen CSRF_SECRET=regen \
    node dist/scripts/migrate.js migrate)
}
# pg_dump in the container (its version matches the server's). The \restrict lines a
# plain dump starts and ends with (psql meta-commands, CVE-2025-8714) are dropped: the
# migration runner, which loads init.sql too, runs SQL only.
dump() {
  local db=$1
  shift
  docker exec -e PGPASSWORD="$PG_PASSWORD" "$CONTAINER" pg_dump -U "$PG_USER" -d "$db" "$@" \
    | sed -E '/^\\(un)?restrict /d'
}

# The rows of every table but schema_migrations, as INSERTs that leave each column named
# uuid, created_at or updated_at that has a default to that default; then setval() for
# every sequence that has been used. Referenced tables come first.
SEED_SQL=$(cat <<'SQL'
CREATE FUNCTION pg_temp.row_count(t regclass) RETURNS bigint LANGUAGE plpgsql AS $f$
DECLARE n bigint;
BEGIN EXECUTE format('SELECT count(*) FROM %s', t) INTO n; RETURN n; END $f$;

CREATE FUNCTION pg_temp.seed() RETURNS SETOF text LANGUAGE plpgsql AS $f$
DECLARE t record; cols text; vals text;
BEGIN
  FOR t IN
    WITH RECURSIVE seeded AS (
      SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'schema_migrations'
         AND pg_temp.row_count(c.oid) > 0
    ), depth(oid, d) AS (
      SELECT oid, 0 FROM seeded
      UNION ALL
      SELECT con.conrelid, depth.d + 1 FROM depth
        JOIN pg_constraint con ON con.confrelid = depth.oid AND con.contype = 'f'
       WHERE con.conrelid IN (SELECT oid FROM seeded) AND con.conrelid <> depth.oid AND depth.d < 20
    )
    SELECT oid::regclass AS rel FROM depth GROUP BY oid ORDER BY max(d), oid::regclass::text
  LOOP
    SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
           string_agg(format('quote_nullable(%I::text) || %L', a.attname, '::' || format_type(a.atttypid, a.atttypmod)),
                      $$ || ', ' || $$ ORDER BY a.attnum)
      INTO cols, vals
      FROM pg_attribute a
     WHERE a.attrelid = t.rel AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
       AND NOT (a.attname IN ('uuid', 'created_at', 'updated_at') AND a.atthasdef);
    RETURN QUERY EXECUTE format('SELECT format(%L, %s) FROM %s ORDER BY 1',
                                'INSERT INTO ' || t.rel::text || ' (' || cols || ') VALUES (%s);', vals, t.rel);
  END LOOP;
  RETURN QUERY
    SELECT format('SELECT pg_catalog.setval(%L, %s, true);', quote_ident(schemaname) || '.' || quote_ident(sequencename), last_value)
      FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL ORDER BY sequencename;
END $f$;

-- Qualified names (public.x), as the dump's own search_path is empty.
SET search_path = '';
SELECT * FROM pg_temp.seed();
SQL
)
seed_rows() { psql_db "$1" -tA <<<"$SEED_SQL"; }

# Rows a migration computes from the server it runs on: a snapshot would hand every fresh
# install the value of the machine this script ran on, so the baseline computes them again.
# Each is copied from its migration; add any new one here. (The comparison below runs A
# and B on one server, so it can't see such a difference.)
ENVIRONMENT_SQL=$(cat <<'SQL'
-- application_timezone (from the migration that added the setting, now part of the
-- baseline): a fresh install starts with the zone its database cluster was
-- configured with (TZ at initdb), UTC's aliases spelled UTC, or UTC when that can't be read
-- or isn't an Area/Location zone.
DO $seed$
DECLARE
    configured text;
BEGIN
    BEGIN
        SELECT setting INTO configured
          FROM pg_file_settings
         WHERE lower(name) = 'timezone' AND applied
         ORDER BY seqno DESC
         LIMIT 1;
    EXCEPTION WHEN insufficient_privilege THEN
        configured := NULL;
    END;
    IF configured IS NULL
       OR configured IN ('Etc/UTC', 'Etc/UCT', 'Etc/Universal', 'Etc/Zulu', 'Etc/GMT', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0', 'Etc/Greenwich')
       OR configured !~ '^[A-Za-z][A-Za-z0-9_+-]*/[A-Za-z0-9_+/-]+$'
       OR configured ~ '^(posix|right)/'
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = configured)
       OR EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_abbrevs WHERE lower(abbrev) = lower(configured)) THEN
        configured := 'UTC';
    END IF;
    UPDATE public.system_settings SET setting_value = configured WHERE setting_key = 'application_timezone';
END
$seed$;
SQL
)
migration_seed() {
  psql_db "$1" -tA -c "SELECT string_agg(format('  (%L, %L, %L)', version, name, checksum), E',\n' ORDER BY version) || ';' FROM schema_migrations"
}
database_settings() {
  psql_db "$1" -tA -c "SELECT unnest(setconfig) FROM pg_db_role_setting WHERE setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) AND setrole = 0 ORDER BY 1"
}

echo "▶ Building the migration runner ..."
(cd "$BACKEND_DIR" && npm run --silent build)

echo "▶ Starting throwaway $PG_IMAGE ..."
docker run -d --name "$CONTAINER" -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASSWORD" \
  -e TZ=UTC -p "127.0.0.1:$HOST_PORT:5432" "$PG_IMAGE" >/dev/null
for _ in $(seq 1 60); do
  # The image restarts the server once after initdb; wait for the final one.
  if docker exec "$CONTAINER" pg_isready -U "$PG_USER" -h 127.0.0.1 >/dev/null 2>&1 \
    && psql_db postgres -c 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_db postgres -c 'CREATE DATABASE regen_a' -c 'CREATE DATABASE regen_b'

if [ -n "$FROM_DUMP" ]; then
  echo "▶ A: $(basename "$FROM_DUMP"), brought forward by the runner ..."
  psql_db regen_a < "$FROM_DUMP" > "$WORK/load_a.log" 2>&1 || { cat "$WORK/load_a.log" >&2; exit 1; }
else
  echo "▶ A: the current init.sql plus every migration ..."
fi
run_migrate regen_a > "$WORK/migrate_a.log" 2>&1 || { cat "$WORK/migrate_a.log" >&2; exit 1; }

# The seed: the baseline's row, and only migrations newer than it.
baseline_version=$(cd "$BACKEND_DIR" && node --input-type=module -e "import('./dist/db/baseline.js').then((m) => console.log(m.BASELINE.version))")
seed_check=$(psql_db regen_a -tA -c "SELECT count(*) FILTER (WHERE version = '$baseline_version') || ' ' || count(*) FILTER (WHERE version < '$baseline_version') FROM schema_migrations")
if [ "$seed_check" != "1 0" ]; then
  echo "✗ A's schema_migrations should hold the baseline's row ($baseline_version) and only migrations newer than it (baseline rows, older rows: $seed_check)." >&2
  exit 1
fi

echo "▶ Writing the new baseline ..."
settings=$(database_settings regen_a)
granted_roles=$(dump regen_a --schema-only --no-owner | sed -nE 's/^(GRANT|REVOKE) .* (TO|FROM) ([^ ;]+);$/\3/p' | sort -u | grep -vx PUBLIC || true)
if [ -n "$granted_roles" ] && [ "$granted_roles" != "$SERVING_ROLE" ]; then
  echo "✗ The schema grants to roles other than $SERVING_ROLE ($granted_roles); teach this script to create them." >&2
  exit 1
fi
NEW_SQL="$WORK/init.sql"
{
  cat <<HEADER
-- ============================================================================
-- Nuggets baseline schema
-- Generated by backend/scripts/regen-init-sql.sh. Don't edit by hand: change the schema
-- with a migration (backend/migrations), and regenerate this file now and then.
--
-- A fresh install loads this into an empty database (the migration runner does, or the
-- Postgres image's docker-entrypoint-initdb.d), as the role that owns the schema, then
-- applies the migrations newer than the schema_migrations seed at the end: the baseline's
-- own row (db/baseline.ts) and the migrations folded in since.
-- ============================================================================

-- The unprivileged role the app serves as. Row-level security applies to
-- it; the migration runner gives it LOGIN and its password (app_db_password).
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$SERVING_ROLE') THEN
    CREATE ROLE $SERVING_ROLE NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
\$\$;

HEADER
  if [ -n "$settings" ]; then
    echo "-- The database's own settings. Skipped, with a notice, when the role loading this"
    echo "-- doesn't own the database."
    while IFS= read -r setting; do
      name=${setting%%=*}
      value=${setting#*=}
      cat <<SETTING
DO \$\$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET %s TO %L', current_database(), '$name', '$value');
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Not the owner of database %, so its $name setting is unchanged', current_database();
END
\$\$;
SETTING
    done <<<"$settings"
    echo
  fi
  # Default privileges as the role that loads the file (FOR ROLE <regen superuser> would
  # name a role a deployment doesn't have); extension comments need the extension's owner.
  # Without pg_dump's comment block above each object ("-- Name: ...; Type: ..."), which
  # only repeats the statement under it.
  dump regen_a --schema-only --no-owner \
    | sed -E "s/^ALTER DEFAULT PRIVILEGES FOR ROLE $PG_USER /ALTER DEFAULT PRIVILEGES /" \
    | sed -E '/^COMMENT ON EXTENSION /d' \
    | awk '
        /^--$/ && !held { held = 1; next }
        held == 1 && /^-- Name: .*; Type: / { held = 2; next }
        held == 2 && /^--$/ { held = 0; next }
        held == 1 { print "--"; held = 0 }
        { print }' \
    | cat -s
  echo
  echo "-- ============================================================================"
  echo "-- SEED DATA: the rows a fresh install starts with"
  echo "-- ============================================================================"
  echo
  seed_rows regen_a
  echo
  echo "$ENVIRONMENT_SQL"
  echo
  echo "-- ============================================================================"
  echo "-- MIGRATION TRACKING SEED DATA"
  echo "-- ============================================================================"
  echo "-- Seed schema_migrations so the migration runner knows these are already applied"
  echo "INSERT INTO public.schema_migrations (version, name, checksum) VALUES"
  migration_seed regen_a
} > "$NEW_SQL"
if grep -q "FOR ROLE $PG_USER" "$NEW_SQL"; then
  echo "✗ The new baseline still names the throwaway superuser ($PG_USER)." >&2
  exit 1
fi

echo "▶ B: the new init.sql alone ..."
# The runner loads backend/init.sql (dist/scripts/../../init.sql).
cp "$NEW_SQL" "$INIT_SQL"
if ! run_migrate regen_b > "$WORK/migrate_b.log" 2>&1 || ! grep -q 'No pending migrations' "$WORK/migrate_b.log"; then
  cat "$WORK/migrate_b.log" >&2
  echo "✗ Loading the new baseline failed or left migrations pending; $INIT_SQL is unchanged." >&2
  exit 1
fi

echo "▶ Comparing A and B ..."
# compare WHAT COMMAND [ARGS...]: COMMAND DB [ARGS...] must print the same for A and B.
compare() {
  local what=$1 command=$2
  shift 2
  "$command" regen_a "$@" > "$WORK/a.txt"
  "$command" regen_b "$@" > "$WORK/b.txt"
  if ! diff -u "$WORK/a.txt" "$WORK/b.txt" > "$WORK/diff.txt"; then
    head -n 80 "$WORK/diff.txt" >&2
    if [ -n "${REGEN_DIFF_OUT:-}" ]; then cp "$WORK/diff.txt" "$REGEN_DIFF_OUT"; fi
    echo "✗ $what differs between the old baseline (or the --from dump) plus migrations (A) and the new baseline (B); $INIT_SQL is unchanged." >&2
    exit 1
  fi
}
# A CHECK on a varchar column prints one way as a migration made it and another way once
# reloaded from a dump: both sides get one spelling before comparing (schema-compare.sed,
# which check-migrations.sh uses too).
schema() {
  dump "$1" --schema-only --no-owner | sed -E -f "$SCRIPT_DIR/schema-compare.sed"
}
compare "The schema and its privileges" schema
compare "The seeded rows and sequences" seed_rows
compare "The migration history" migration_seed
compare "The database settings" database_settings
REPLACED=true

if [ -n "$FROM_DUMP" ]; then
  echo "✓ Wrote $INIT_SQL: it makes the same database as $(basename "$FROM_DUMP") brought forward by the runner."
else
  echo "✓ Wrote $INIT_SQL: it makes the same database as the old baseline plus every migration."
fi
echo "  Review 'git diff --stat backend/init.sql' before committing."
