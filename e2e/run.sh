#!/usr/bin/env bash
# End-to-end tests: Playwright drives the built frontend against the built backend,
# as they are deployed.
#
#   - a fresh database, migrated by the migration runner as the container entrypoint does it
#     (it loads backend/init.sql into the empty database, then the migrations);
#   - the backend from backend/dist, NODE_ENV=production, serving as the RLS-bound
#     nuggets_app role, with strong throwaway secrets generated for the run (in Docker secret
#     files under e2e/.run, as production reads them);
#   - the frontend build served by its production static server (frontend/static-server,
#     with the build's serve.json and so its Content-Security-Policy);
#   - e2e/proxy.mjs in front, one origin for both, as a deployment's reverse proxy;
#   - then the journeys in e2e/tests, in Chromium.
#
# Usage, from anywhere, after installing and building (from the repository root: the npm
# workspace, then the frontend image's static server, which is a package of its own):
#   npm ci && npm run build && npm ci --prefix frontend/static-server
#   E2E_DATABASE_URL=postgresql://OWNER:PASSWORD@localhost:5432/nuggets_e2e \
#     APP_DB_PASSWORD=... e2e/run.sh [playwright test arguments]
#
#   E2E_DATABASE_URL  the schema owner's connection to the database to use. It is DROPPED and
#                     created again, so its name must contain "e2e". The owner needs CREATEDB
#                     (CI's is a superuser). The backend runs as production, which refuses a
#                     weak database password: 16 characters or more, of three kinds (lower and
#                     upper case, digits, symbols), and no "password" or "secret" in it.
#   APP_DB_PASSWORD   the password migrate gives the nuggets_app role, which the backend serves
#                     as. The role is cluster-wide: on a cluster another database also serves
#                     as nuggets_app, give the password that one uses.
#   E2E_PORT          where the app is served, on 127.0.0.1, as http://localhost (default 4173); the backend and the
#                     static server take the two ports after it.
#   E2E_BROWSER_CHANNEL  a Playwright browser channel, e.g. "chrome" for the installed Google
#                     Chrome (CI); unset, Playwright's own Chromium.
#
# Needs node, psql and openssl. Exits with Playwright's status. The backend's log is e2e/.run/backend.log;
# a failing test leaves a screenshot and a trace in e2e/test-results.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { printf 'e2e: %s\n' "$*" >&2; exit 1; }

: "${E2E_DATABASE_URL:?set E2E_DATABASE_URL to the owner connection of a database the run may recreate}"
: "${APP_DB_PASSWORD:?set APP_DB_PASSWORD to the nuggets_app role password}"
for tool in node psql openssl; do
  command -v "$tool" > /dev/null || fail "$tool is not installed"
done
for built in backend/dist/index.js frontend/build/index.html frontend/build/serve.json \
  frontend/static-server/node_modules/.bin/serve; do
  [ -e "$ROOT/$built" ] || fail "$built is missing: build and install first (see the top of this script)"
done
# Playwright's CLI, where Node finds @playwright/test from e2e/: the workspace hoists it to
# the root node_modules, unless another version is there.
PLAYWRIGHT_CLI="$(cd "$ROOT/e2e" && node -p 'require.resolve("@playwright/test/cli")' 2> /dev/null)" \
  || fail "@playwright/test is not installed: install first (see the top of this script)"

# The URL's parts, decoded (a password may hold URL-escaped characters), NUL-separated.
{
  IFS= read -r -d '' DB_HOST
  IFS= read -r -d '' DB_PORT
  IFS= read -r -d '' DB_NAME
  IFS= read -r -d '' OWNER
  IFS= read -r -d '' OWNER_PASSWORD
} < <(node -e '
  const u = new URL(process.argv[1]);
  const d = decodeURIComponent;
  process.stdout.write([u.hostname, u.port || "5432", d(u.pathname.slice(1)), d(u.username), d(u.password)].join("\0") + "\0");
' "$E2E_DATABASE_URL")
case "$DB_NAME" in
  *e2e*) ;;
  *) fail "refusing to recreate database \"$DB_NAME\": its name must contain e2e" ;;
esac
[[ "$DB_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "database name \"$DB_NAME\": letters, digits and _ only"

PORT_APP="${E2E_PORT:-4173}"
export E2E_PORT="$PORT_APP"
export E2E_BACKEND_PORT=$((PORT_APP + 1))
export E2E_STATIC_PORT=$((PORT_APP + 2))
# localhost, not 127.0.0.1: a browser refuses passkeys (WebAuthn) on an IP address.
export E2E_BASE_URL="http://localhost:${PORT_APP}"

echo "==> Database $DB_NAME on $DB_HOST:$DB_PORT, recreated"
maintenance="${E2E_DATABASE_URL%/*}/postgres"
psql "$maintenance" -Xq -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$DB_NAME\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$OWNER\""

# The backend's settings, as the deployment manifest gives them: the owner migrates, the
# serving role is nuggets_app. Secrets are new for every run, in Docker secret files as a
# deployment has them: production refuses a secret in the environment.
# Outside test-results/, which Playwright empties when it starts.
RUN_DIR="$ROOT/e2e/.run"
rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"
export DB_HOST DB_PORT DB_NAME
export MIGRATION_DB_USER="$OWNER"
export USE_DOCKER_SECRETS=true SECRETS_PATH="$RUN_DIR/secrets"
mkdir -m 700 "$SECRETS_PATH"
secret_file() { (umask 077 && printf '%s' "$2" > "$SECRETS_PATH/$1"); }
secret_file db_password "$OWNER_PASSWORD"
secret_file app_db_password "$APP_DB_PASSWORD"
secret_file jwt_secret "$(openssl rand -base64 48)"
secret_file session_secret "$(openssl rand -base64 32)"
secret_file csrf_secret "$(openssl rand -base64 32)"
unset APP_DB_PASSWORD
export DATA_ENCRYPTION_KEY_FILE="$RUN_DIR/data_encryption_key"
openssl rand -base64 32 | tr -d '\n' > "$DATA_ENCRYPTION_KEY_FILE"
chmod 600 "$DATA_ENCRYPTION_KEY_FILE"
export TZ=UTC

echo "==> Migrating (as $OWNER)"
(cd "$ROOT/backend" && DB_USER="$OWNER" NODE_ENV=production LOG_LEVEL=warn node dist/scripts/migrate.js migrate)

export DB_USER=nuggets_app
export NODE_ENV=production
export DOMAIN_URL="$E2E_BASE_URL"
# Behind proxy.mjs, as the deployment manifests run it behind theirs (TRUST_PROXY=true there).
export TRUST_PROXY=1
export PORT="$E2E_BACKEND_PORT"
# The settings that move the backend's working files; the run's go under the run directory.
export BACKUPS_PATH="$RUN_DIR/backups" TEMP_PATH="$RUN_DIR/temp"
mkdir -p "$BACKUPS_PATH" "$TEMP_PATH"

echo "==> Playwright"
cd "$ROOT/e2e"
exec node "$PLAYWRIGHT_CLI" test "$@"
