#!/usr/bin/env bash
# Smoke test of the production images, run the way they are deployed.
#
# Starts the whole stack in docker-compose.portainer.yml (the deployment manifest) from
# images already built locally, with scripts/smoke-test.compose.yml on top so it runs
# beside anything else on the host: its own compose project, directories and loopback
# ports. Then it checks that:
#   - every service starts and the ones with a healthcheck report healthy;
#   - the backend answers /api/ready (or /api/health in a build without /api/ready);
#   - every migration the backend image ships is applied, and the API refuses a request
#     without a session (401 with its error code);
#   - the first admin can be set up with the logged setup token, and signs in;
#   - a backup key (an age key pair made for the run) can be added, a backup created and
#     downloaded, and restoring it (in the background) with its file key brings the data back;
#   - the frontend serves the app, on an app route too, with its security headers, and the
#     backend sends its deny-all Content-Security-Policy;
#   - Dozzle asks for a sign-in, and lets the user in the dozzle_users secret in.
# Whatever happens, it tears the stack and its files down again.
#
# Usage:
#   NUGGETS_IMAGE_TAG=<tag> scripts/smoke-test.sh
#
# The images are ghcr.io/plushcap/nuggets-{backend,frontend,postgres}:$NUGGETS_IMAGE_TAG;
# build them first, from the repo root:
#   docker build -f backend/Dockerfile.prod  -t ghcr.io/plushcap/nuggets-backend:smoke .
#   docker build -f frontend/Dockerfile.prod -t ghcr.io/plushcap/nuggets-frontend:smoke .
#   docker build -f Dockerfile.postgres      -t ghcr.io/plushcap/nuggets-postgres:smoke .
# Dozzle and the socket proxy are pulled at the versions the manifest pins, before the stack
# starts; a pull the registry refuses (a rate limit, an outage) is tried again after 5, 15
# and 30 seconds.
#
# Optional environment:
#   SMOKE_PROJECT        compose project name (default: nuggets-smoke)
#   SMOKE_BACKEND_PORT   loopback port for the backend (default: 15000)
#   SMOKE_FRONTEND_PORT  loopback port for the frontend (default: 13000)
#   SMOKE_DOZZLE_PORT    loopback port for Dozzle (default: 13200)
#   SMOKE_WORKDIR        an existing directory to hold the run's secrets and data, in a new
#                        subdirectory removed afterwards (default: $TMPDIR or /tmp); on
#                        Docker Desktop, one that is shared with the Docker VM
#   SMOKE_KEEP=1         on failure, leave the stack running to look at (tear it down with
#                        the `docker compose ... down -v` line the script prints)
#   SMOKE_EXPECT_APP_VERSION  the version the backend image was built with (its APP_VERSION
#                        build argument), which /api/health must then report
#
# Needs docker with compose v2.24 or later, curl, jq and openssl.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${NUGGETS_IMAGE_TAG:?set NUGGETS_IMAGE_TAG to the tag of the locally built images}"
export NUGGETS_IMAGE_TAG
PROJECT="${SMOKE_PROJECT:-nuggets-smoke}"
export SMOKE_BACKEND_PORT="${SMOKE_BACKEND_PORT:-15000}"
export SMOKE_FRONTEND_PORT="${SMOKE_FRONTEND_PORT:-13000}"
export SMOKE_DOZZLE_PORT="${SMOKE_DOZZLE_PORT:-13200}"
BACKEND="http://127.0.0.1:${SMOKE_BACKEND_PORT}"
FRONTEND="http://127.0.0.1:${SMOKE_FRONTEND_PORT}"
POSTGRES_IMAGE="ghcr.io/plushcap/nuggets-postgres:${NUGGETS_IMAGE_TAG}"

ADMIN_EMAIL="smoke-admin@example.com"
ADMIN_PASSWORD="Smoke-test-Passw0rd!$(openssl rand -hex 4)"

log() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nSMOKE TEST FAILED: %s\n' "$*" >&2; exit 1; }

for tool in docker curl jq openssl; do
  command -v "$tool" > /dev/null || fail "$tool is not installed"
done
for image in backend frontend postgres; do
  docker image inspect "ghcr.io/plushcap/nuggets-${image}:${NUGGETS_IMAGE_TAG}" > /dev/null 2>&1 \
    || fail "no local image ghcr.io/plushcap/nuggets-${image}:${NUGGETS_IMAGE_TAG}; build it first"
done

# A new directory for this run (the teardown deletes it, and only it).
WORK="$(mktemp -d "${SMOKE_WORKDIR:-${TMPDIR:-/tmp}}/nuggets-smoke.XXXXXX")"
# The containers run as other users (backend 1001, postgres 1999) and read the secrets
# and data through bind mounts, so the directories must be reachable by them.
chmod 755 "$WORK"
DATA="$WORK/data"
SECRETS="$WORK/secrets"
mkdir -p "$SECRETS" "$DATA"/{postgres,uploads,backups,temp,logs}
COOKIES="$WORK/headers"

# The manifest's required settings, pointed at the work directory.
export SECRETS_BASE_PATH="$SECRETS"
export POSTGRES_DATA_PATH="$DATA/postgres"
export UPLOADS_PATH="$DATA/uploads"
export BACKUPS_PATH="$DATA/backups"
export TEMP_PATH="$DATA/temp"
export LOGS_PATH="$DATA/logs"
export DOMAIN_URL="http://localhost:${SMOKE_FRONTEND_PORT}"

compose() {
  docker compose -p "$PROJECT" \
    -f "$REPO_ROOT/docker-compose.portainer.yml" \
    -f "$REPO_ROOT/scripts/smoke-test.compose.yml" "$@"
}

# Runs as root in a throwaway container (the postgres image is already here), so it can
# hand the data directories to the containers' users, and remove what they wrote, without
# sudo on the host.
as_root_in_container() {
  docker run --rm --user 0:0 -v "$DATA:/data" --entrypoint sh "$POSTGRES_IMAGE" -c "$1"
}

teardown() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    log "Stack state and recent logs"
    compose ps -a || true
    compose logs --no-color --tail=150 || true
    if [ "${SMOKE_KEEP:-}" = "1" ]; then
      printf '\nSMOKE_KEEP=1: left running. Tear down with:\n  SECRETS_BASE_PATH=%s POSTGRES_DATA_PATH=%s UPLOADS_PATH=%s BACKUPS_PATH=%s TEMP_PATH=%s LOGS_PATH=%s NUGGETS_IMAGE_TAG=%s docker compose -p %s -f %s -f %s down -v\n' \
        "$SECRETS" "$POSTGRES_DATA_PATH" "$UPLOADS_PATH" "$BACKUPS_PATH" "$TEMP_PATH" "$LOGS_PATH" \
        "$NUGGETS_IMAGE_TAG" "$PROJECT" "$REPO_ROOT/docker-compose.portainer.yml" "$REPO_ROOT/scripts/smoke-test.compose.yml"
      exit "$status"
    fi
  fi
  log "Tearing down"
  compose down -v --remove-orphans --timeout 10 || true
  as_root_in_container 'rm -rf /data/*' || true
  rm -rf "$WORK" || true
  if [ "$status" -eq 0 ]; then
    printf '\nSMOKE TEST PASSED\n'
  fi
  exit "$status"
}
trap teardown EXIT

# pull_with_retry IMAGE: pulls an image unless it is here already, trying again after each
# of PULL_RETRY_DELAYS seconds when the registry refuses, and fails the run naming it.
PULL_RETRY_DELAYS=(5 15 30)
pull_with_retry() {
  local image=$1 attempts=$((${#PULL_RETRY_DELAYS[@]} + 1)) attempt=1
  if docker image inspect "$image" > /dev/null 2>&1; then
    echo "$image: already here"
    return 0
  fi
  until docker pull --quiet "$image"; do
    [ "$attempt" -lt "$attempts" ] || fail "could not pull $image (tried $attempts times)"
    local delay=${PULL_RETRY_DELAYS[$((attempt - 1))]}
    printf 'pulling %s failed (attempt %d of %d); trying again in %ss\n' \
      "$image" "$attempt" "$attempts" "$delay" >&2
    sleep "$delay"
    attempt=$((attempt + 1))
  done
}

log "Pulling the images the stack doesn't build here"
# Every image in the manifest but the Nuggets ones (built locally, checked above, and never
# pulled), so that a registry refusing a pull for a moment fails neither `docker run` nor
# `compose up` below, which then pull nothing.
images=$(compose config --images) || fail "could not list the stack's images"
while IFS= read -r image; do
  case "$image" in
    '' | ghcr.io/plushcap/nuggets-*) ;;
    *) pull_with_retry "$image" ;;
  esac
done <<< "$images"

log "Secrets and data directories in $WORK"
# Generated with openssl, as deploy.sh does it (the backend refuses weak ones).
for name in db_password app_db_password session_secret csrf_secret data_encryption_key; do
  openssl rand -base64 32 | tr -d '\n' > "$SECRETS/$name.txt"
done
openssl rand -base64 64 | tr -d '\n' > "$SECRETS/jwt_secret.txt"
# Dozzle's sign-in: one user, written with the pinned image's `dozzle generate`.
DOZZLE_IMAGE=$(compose config --format json | jq -r '.services.dozzle.image')
DOZZLE_PASSWORD="$(openssl rand -hex 16)"
docker run --rm --pull never "$DOZZLE_IMAGE" generate smoke --password "$DOZZLE_PASSWORD" > "$SECRETS/dozzle_users.yml" \
  || fail "could not write Dozzle's users file"
# Test-only secrets, deleted with the work directory: readable by the containers' users.
chmod 644 "$SECRETS"/*.txt "$SECRETS/dozzle_users.yml"
chmod 755 "$SECRETS"
as_root_in_container 'chown -R 1999:1999 /data/postgres && chown -R 1001:1001 /data/uploads /data/backups /data/temp /data/logs && chmod 700 /data/*'

log "Starting the stack (project $PROJECT, images tagged $NUGGETS_IMAGE_TAG)"
# --wait: every container running, and healthy where it has a healthcheck. Every image is
# here by now (--pull never).
compose up -d --pull never --wait --wait-timeout 240 || fail "the stack did not come up healthy"
compose ps

# ---------------------------------------------------------------------------
# HTTP helpers. The backend sets Secure cookies (NODE_ENV=production), which an HTTP
# client may refuse to store from http://, so the two cookies the API needs are kept
# here and sent by hand: the session, and the CSRF token bound to it. In production
# they are __Host-nuggets_session and __Host-csrf_token; an older image names
# them without the prefix, so the names are taken from what the backend sets.
# ---------------------------------------------------------------------------
SESSION=""
CSRF=""
SESSION_COOKIE="__Host-nuggets_session"
CSRF_COOKIE="__Host-csrf_token"
STATUS=""
BODY="$WORK/body"

remember_cookies() {
  local line
  line=$(tr -d '\r' < "$COOKIES" | grep -E '^[Ss]et-[Cc]ookie: (__Host-)?nuggets_session=[^;]' | tail -n 1 || true)
  if [ -n "$line" ]; then
    SESSION_COOKIE=$(printf '%s' "$line" | sed 's/^[Ss]et-[Cc]ookie: \([^=]*\)=.*/\1/')
    SESSION=$(printf '%s' "$line" | sed 's/^[^=]*=\([^;]*\).*/\1/')
  fi
  line=$(tr -d '\r' < "$COOKIES" | grep -E '^[Ss]et-[Cc]ookie: (__Host-)?csrf_token=[^;]' | tail -n 1 || true)
  if [ -n "$line" ]; then
    CSRF_COOKIE=$(printf '%s' "$line" | sed 's/^[Ss]et-[Cc]ookie: \([^=]*\)=.*/\1/')
    CSRF=$(printf '%s' "$line" | sed 's/^[^=]*=\([^;]*\).*/\1/')
  fi
  return 0
}

# api METHOD PATH [curl args...]: sets STATUS, leaves the response body in $BODY.
api() {
  local method=$1 path=$2
  shift 2
  STATUS=$(curl -sS -o "$BODY" -D "$COOKIES" -w '%{http_code}' -X "$method" \
    -H "Cookie: ${SESSION_COOKIE}=${SESSION}; ${CSRF_COOKIE}=${CSRF}" \
    -H "X-CSRF-Token: ${CSRF}" \
    "$@" "$BACKEND$path") || STATUS="000"
  remember_cookies
}

expect() {
  local want=$1 what=$2
  if [ "$STATUS" != "$want" ]; then
    printf 'response body: ' >&2
    head -c 2000 "$BODY" >&2 || true
    printf '\n' >&2
    fail "$what: expected HTTP $want, got $STATUS"
  fi
}

json_post() {
  api POST "$1" -H 'Content-Type: application/json' --data "$2"
}

# ---------------------------------------------------------------------------
log "Backend readiness"
ready=""
for _ in $(seq 1 60); do
  api GET /api/ready
  if [ "$STATUS" = "200" ]; then ready="/api/ready"; break; fi
  if [ "$STATUS" = "404" ]; then
    api GET /api/health
    if [ "$STATUS" = "200" ]; then ready="/api/health (this build has no /api/ready)"; break; fi
  fi
  sleep 2
done
[ -n "$ready" ] || fail "the backend never answered /api/ready or /api/health"
echo "ready: $ready"

# The version the image was built as: the release workflow bakes it in.
api GET /api/health
expect 200 "GET /api/health"
version=$(jq -r '.version' "$BODY")
echo "backend version: $version"
if [ -n "${SMOKE_EXPECT_APP_VERSION:-}" ] && [ "$version" != "$SMOKE_EXPECT_APP_VERSION" ]; then
  fail "/api/health reports version '$version', not the image's '$SMOKE_EXPECT_APP_VERSION'"
fi
# What the backend sends loads nothing; the app's own policy comes from the frontend.
tr -d '\r' < "$COOKIES" | grep -qi "^content-security-policy: default-src 'none';" \
  || fail "the backend did not send its deny-all Content-Security-Policy"

log "Migrations"
# The baseline and every migration the backend image ships are applied (the entrypoint
# migrates on start, and /api/ready answers only once it has): schema_migrations holds the
# baseline's own row and one per migration, counted as the dev-stack job counts the repo's.
# The image also ships the SQL that cuts a v2.4.0 database over to the baseline.
# shellcheck disable=SC2016 # expanded by the container's shell, from its secret and env
applied=$(compose exec -T postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/db_password)" psql -X -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM schema_migrations"' \
  | tr -d '[:space:]') || fail "could not count the applied migrations"
shipped=$(compose exec -T backend sh -c 'ls /app/migrations' | grep -c '^[0-9].*\.sql$' || true)
echo "schema_migrations rows: $applied, for the baseline and the $shipped migration(s) the backend image ships"
[ "$applied" = "$((shipped + 1))" ] || fail "$applied schema_migrations rows, but the baseline and the $shipped migrations the backend image ships make $((shipped + 1))"
compose exec -T backend test -s /app/upgrade/from-v2.4.0.sql \
  || fail "the backend image doesn't ship /app/upgrade/from-v2.4.0.sql, which cuts a v2.4.0 database over"
compose exec -T backend test -s /app/upgrade/baseline-fingerprint.txt \
  || fail "the backend image doesn't ship /app/upgrade/baseline-fingerprint.txt, which a cut-over database is compared with"

log "Without a session, the API refuses"
api GET /api/accounts
expect 401 "GET /api/accounts without a session"
[ "$(jq -r '.code // empty' "$BODY")" != "" ] || fail "the 401 has no error code (ApiErrorBody)"

log "First-run setup"
api GET /api/auth/setup-status
expect 200 "setup status"
[ "$(jq -r '.requiresSetup' "$BODY")" = "true" ] || fail "a fresh deployment should require setup"
# The token the backend logged at startup (64 hex characters in the First-run setup line).
TOKEN=$(compose logs --no-color backend 2>/dev/null \
  | grep -o 'First-run setup[^"]*' | grep -oE '[0-9a-f]{64}' | tail -n 1 || true)
[ -n "$TOKEN" ] || fail "no setup token in the backend log"
json_post /api/auth/setup-admin "$(jq -n --arg t "$TOKEN" --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" \
  '{setup_token: $t, email: $e, password: $p, first_name: "Smoke", last_name: "Test"}')"
expect 201 "first admin setup"

log "Sign in"
SESSION=""
json_post /api/auth/login "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email: $e, password: $p}')"
expect 200 "sign-in"
[ -n "$SESSION" ] || fail "sign-in set no session cookie"
api GET /api/auth/me
expect 200 "the signed-in user"
[ "$(jq -r '.user.email // .email' "$BODY")" = "$ADMIN_EMAIL" ] || fail "/api/auth/me is not the admin"
[ -n "$CSRF" ] || fail "the backend set no CSRF cookie"

log "Data to back up"
json_post /api/tags '{"name": "smoke-before-backup"}'
expect 201 "creating a tag"

log "Backup"
# A backup key made for this run, with the backend image's own age library: the private key
# stays in $WORK (deleted afterwards), and the server gets the public key, as from the
# Backup page. Adding a key takes step-up, which signing in just now counts as.
backend_node() { compose exec -T backend node --input-type=module -e "$1"; }
backend_node 'import { generateHybridIdentity, identityToRecipient } from "age-encryption";
  const identity = await generateHybridIdentity();
  console.log(identity); console.log(await identityToRecipient(identity));' > "$WORK/backup-key.txt" \
  || fail "making a backup key with the backend image's age library"
identity=$(sed -n 1p "$WORK/backup-key.txt")
recipient=$(sed -n 2p "$WORK/backup-key.txt")
[[ "$recipient" == age1pq1* ]] || fail "the backup key's public key is not a post-quantum age key"
json_post /api/backup/recipients "$(jq -n --arg r "$recipient" '{recipient: $r, label: "smoke test", checked: true}')"
expect 201 "adding the backup key"
json_post /api/backup/create '{}'
expect 202 "starting a backup"
backup_file=""
for _ in $(seq 1 60); do
  api GET /api/backup/create-status
  expect 200 "backup status"
  case "$(jq -r '.status' "$BODY")" in
    completed) backup_file=$(jq -r '.fileName' "$BODY"); break ;;
    failed) fail "the backup failed: $(jq -r '.error' "$BODY")" ;;
  esac
  sleep 2
done
[ -n "$backup_file" ] || fail "the backup did not finish"
echo "backup: $backup_file"
api GET "/api/backup/download/$backup_file"
expect 200 "downloading the backup"
cp "$BODY" "$WORK/$backup_file"
[ -s "$WORK/$backup_file" ] || fail "the downloaded backup is empty"
[[ "$backup_file" == *.tar.age ]] || fail "the backup is not an age backup: $backup_file"
[ "$(head -c 21 "$WORK/$backup_file")" = "age-encryption.org/v1" ] || fail "the backup does not start with age's header"
# What the Backup page does in the browser: open the backup's header with the private key, and
# send the server only the file key. The age command can't print one, so the image's age
# library does it, reading the private key and the header on standard input.
api GET "/api/backup/$backup_file/header"
expect 200 "the backup's header"
file_key=$({ printf '%s\n' "$identity"; cat "$BODY"; } | backend_node 'import { Decrypter } from "age-encryption";
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks); const cut = input.indexOf(10);
  const decrypter = new Decrypter(); decrypter.addIdentity(input.subarray(0, cut).toString("utf8"));
  console.log(Buffer.from(await decrypter.decryptHeader(input.subarray(cut + 1))).toString("base64"));') \
  || fail "opening the backup's header with the backup key"
[[ "$file_key" =~ ^[A-Za-z0-9+/]{22}==$ ]] || fail "the file key is not 16 bytes in base64"

log "Changes after the backup"
api GET /api/tags
expect 200 "listing tags"
tag_uuid=$(jq -r '.[] | select(.name == "smoke-before-backup") | .uuid' "$BODY")
[ -n "$tag_uuid" ] || fail "the tag created before the backup is missing"
api DELETE "/api/tags/$tag_uuid"
expect 200 "deleting the tag"
json_post /api/tags '{"name": "smoke-after-backup"}'
expect 201 "creating a second tag"

log "Restore"
# A restore takes step-up too. Signing in counted for five minutes; the password, confirmed
# again here, starts them over, and the status check the Backup page asks first agrees.
json_post /api/auth/reauthenticate "$(jq -n --arg p "$ADMIN_PASSWORD" '{password: $p}')"
expect 200 "confirming the password before the restore"
api GET /api/auth/reauthenticate
expect 200 "the step-up status"
[ "$(jq -r '.reauthenticated' "$BODY")" = "true" ] || fail "the step-up status doesn't count the confirmed password"
api POST /api/backup/restore -F "backup=@$WORK/$backup_file;type=application/octet-stream" \
  -F "fileKey=$file_key"
expect 202 "starting the restore"
# The restore runs in the background; follow it until it is done. The restored data
# has the backup's sign-ins: should this one not be among them, the status answers 401 and
# the admin signs in again (refused with 503 until the restore has finished).
outcome=""
for _ in $(seq 1 150); do
  sleep 2
  api GET /api/backup/restore-status
  case "$STATUS" in
    200)
      outcome=$(jq -r '.status' "$BODY")
      [ "$outcome" = "completed" ] && break
      [ "$outcome" = "failed" ] && fail "the restore failed: $(jq -r '.error' "$BODY")"
      ;;
    401)
      SESSION=""
      json_post /api/auth/login "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email: $e, password: $p}')"
      ;;
  esac
done
[ "$outcome" = "completed" ] || fail "the restore did not finish"
echo "restore: $(jq -c '{phase, databaseChanged, previousDatabase, rowCounts}' "$BODY")"
echo "carried over: $(jq -c '.carryOver | {sameDeployment, ended, kept}' "$BODY")"
# The backup is this server's own: the restore ended every sign-in (this one too, which the
# loop above signed in again after) and took the running server's sign-in state and keys.
jq -e '.carryOver.sameDeployment == true and .carryOver.ended.sessions >= 1 and .carryOver.kept.backupKeys == true' "$BODY" > /dev/null \
  || fail "the restore didn't end the sign-ins, or didn't keep this server's sign-in state and backup keys"

log "Sign in again, and check the restored data"
SESSION=""
json_post /api/auth/login "$(jq -n --arg e "$ADMIN_EMAIL" --arg p "$ADMIN_PASSWORD" '{email: $e, password: $p}')"
expect 200 "sign-in after the restore"
api GET /api/tags
expect 200 "listing tags after the restore"
jq -e 'any(.[]; .name == "smoke-before-backup")' "$BODY" > /dev/null \
  || fail "the restore did not bring back the tag from the backup"
if jq -e 'any(.[]; .name == "smoke-after-backup")' "$BODY" > /dev/null; then
  fail "the tag created after the backup survived the restore"
fi

log "Frontend"
for path in / /settings; do
  status=$(curl -sS -o "$BODY" -D "$WORK/frontend-headers" -w '%{http_code}' "$FRONTEND$path") || status="000"
  [ "$status" = "200" ] || fail "frontend $path: expected HTTP 200, got $status"
  grep -qi '<div id="root"' "$BODY" || fail "frontend $path did not serve the app's index.html"
  # The app document's own security headers (frontend/public/serve.json).
  for header in "content-security-policy: default-src 'self';.*frame-ancestors 'none'" \
    'x-frame-options: DENY' 'x-content-type-options: nosniff'; do
    tr -d '\r' < "$WORK/frontend-headers" | grep -qi "^${header}" \
      || fail "frontend $path did not send ${header%%:*}"
  done
done

log "Dozzle, and container logs through the socket proxy"
status=$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:${SMOKE_DOZZLE_PORT}/healthcheck") || status="000"
[ "$status" = "200" ] || fail "Dozzle /healthcheck: expected HTTP 200, got $status"
# The logs only after a sign-in, as a user from the dozzle_users secret.
DOZZLE="http://127.0.0.1:${SMOKE_DOZZLE_PORT}"
status=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "$DOZZLE/api/events/stream") || status="000"
[ "$status" = "401" ] || fail "Dozzle served its event stream without a sign-in (HTTP $status)"
status=$(curl -sS -o /dev/null -w '%{http_code}' -X POST --data-urlencode "username=smoke" \
  --data-urlencode "password=wrong-$DOZZLE_PASSWORD" "$DOZZLE/api/token") || status="000"
[ "$status" = "401" ] || fail "Dozzle took a wrong password (HTTP $status)"
status=$(curl -sS -o /dev/null -w '%{http_code}' -c "$WORK/dozzle-cookies" -X POST --data-urlencode "username=smoke" \
  --data-urlencode "password=$DOZZLE_PASSWORD" "$DOZZLE/api/token") || status="000"
[ "$status" = "200" ] || fail "Dozzle refused its user's sign-in (HTTP $status)"
# An event stream, so curl stops it after 3 seconds (and exits non-zero) with what came.
curl -sS -m 3 -b "$WORK/dozzle-cookies" -o "$WORK/dozzle-events" "$DOZZLE/api/events/stream" 2>/dev/null || true
grep -q 'containers-changed' "$WORK/dozzle-events" || fail "Dozzle listed no containers after the sign-in"
# What Dozzle asks the proxy for, asked from a container on the proxy's network (the
# backend image has curl): the container list, and a container's log stream.
backend_id=$(compose ps -q backend)
for path in /containers/json "/containers/${backend_id}/logs?stdout=1&tail=1"; do
  status=$(docker run --rm --network "${PROJECT}_dockersock" --entrypoint curl \
    "ghcr.io/plushcap/nuggets-backend:${NUGGETS_IMAGE_TAG}" \
    -sS -o /dev/null -w '%{http_code}' "http://socket-proxy:2375${path}") || status="000"
  [ "$status" = "200" ] || fail "socket proxy ${path%%\?*}: expected HTTP 200, got $status"
done
# The proxy must stay read-only.
status=$(docker run --rm --network "${PROJECT}_dockersock" --entrypoint curl \
  "ghcr.io/plushcap/nuggets-backend:${NUGGETS_IMAGE_TAG}" \
  -sS -o /dev/null -w '%{http_code}' -X POST "http://socket-proxy:2375/containers/${backend_id}/stop") || status="000"
[ "$status" = "403" ] || fail "socket proxy let a POST through (HTTP $status)"

log "Health after the run"
compose ps
unhealthy=$(compose ps --format '{{.Service}} {{.State}} {{.Health}}' | awk '$2 != "running" || ($3 != "" && $3 != "healthy")')
[ -z "$unhealthy" ] || fail "services not running and healthy: $unhealthy"
