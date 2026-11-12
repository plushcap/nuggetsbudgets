#!/usr/bin/env bash
# Fails when git tracks a file that must stay out of the repository:
#   - anything under backend/uploads/ (members' uploads), and under a secrets/, data/ or
#     backups/ directory (the Docker secrets `npm run setup` writes, the compose files' data
#     volumes, backups), as .gitignore ignores them at any depth;
#   - an encrypted backup (*.enc, as the backup service names them);
#   - Windows download metadata (*:Zone.Identifier);
#   - personal Claude Code settings (.claude/settings.local.json);
#   - data dumps and exports: *.dump, *.backup, *.sql.gz, *.sql other than the migrations
#     (backend/migrations/), the baseline (backend/init.sql), the v2.4.0 cutover
#     (backend/upgrade/) and the v2.4.0 install the upgrade check loads
#     (backend/src/test/fixtures/v2.4.0-install.sql), *.csv outside a test fixtures directory;
#   - environment files other than the templates, cookie jars, key and certificate files;
#   - password files: Postgres's .pgpass (pgpass.conf on Windows) and .netrc (_netrc), whose
#     lines (host:port:database:user:password) gitleaks' rules don't read as secrets;
#   - a file holding a private key (a PEM "BEGIN ... PRIVATE KEY" block).
#
# .gitignore keeps these out of a plain `git add`; this catches a forced add, an ignore
# rule removed, or a file added before its rule. It checks what the index holds (what a
# commit takes), so run it after `git add`. CI runs it on every pull request
# (.github/workflows/repository-checks.yml).
#
# A test fixture CSV goes under a directory named fixtures/ or __fixtures__/, and its
# figures are made up (CONTRIBUTING.md). A file name matches whatever its case (KEY.PEM,
# data.CSV); a directory as .gitignore matches it.
#
# Usage: scripts/check-tracked-files.sh   (from anywhere in the checkout)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

problems=0
# A GitHub annotation; its file= value escapes %, : and , as the workflow command format asks.
report() {
  local file=${1//%/%25}
  file=${file//:/%3A}
  file=${file//,/%2C}
  echo "::error file=$file::$1 is tracked: $2"
  problems=$((problems + 1))
}

tracked=0
while IFS= read -r -d '' path; do
  tracked=$((tracked + 1))
  name=${path##*/}
  # The name matched whatever its case (KEY.PEM, Export.CSV); the directories as they are, as
  # .gitignore matches them (src/Data/ isn't data/).
  dir=${path%"$name"}
  # tr, not ${name,,}: macOS's /bin/bash is 3.2.
  lowered="$dir$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    backend/uploads/*)
      report "$path" "a member's upload (backend/uploads/ is ignored)" ;;
    secrets/* | */secrets/*)
      report "$path" "a Docker secret (secrets/ is ignored)" ;;
    data/* | */data/* | backups/* | */backups/*)
      report "$path" "local data or a backup (data/ and backups/ are ignored)" ;;
    *.enc)
      report "$path" "an encrypted backup" ;;
    *:zone.identifier)
      report "$path" "Windows download metadata (a Zone.Identifier stream)" ;;
    .claude/settings.local.json | */.claude/settings.local.json)
      report "$path" "personal Claude Code settings" ;;
    *.dump | *.backup | *.sql.gz)
      report "$path" "a database dump" ;;
    backend/init.sql | backend/migrations/*.sql | backend/upgrade/*.sql | backend/src/test/fixtures/v2.4.0-install.sql) ;;
    *.sql)
      report "$path" "SQL outside backend/migrations/, backend/init.sql and backend/upgrade/ (a dump?)" ;;
    */fixtures/*.csv | fixtures/*.csv | */__fixtures__/*.csv | __fixtures__/*.csv) ;;
    *.csv)
      report "$path" "a CSV export (a test fixture goes under fixtures/, with made-up figures)" ;;
    *.pem | *.key | *.key.pub | *.p12 | *.pfx)
      report "$path" "a key or certificate file" ;;
    *)
      # As .gitignore's patterns, in their case (a Budget.Envelope.ts isn't a .env file).
      case "$name" in
        .env.example | *.env.example) ;;
        *.env*)
          report "$path" "an environment file (only the .env.example templates are tracked)" ;;
        cookies.txt)
          report "$path" "a cookie jar" ;;
      esac
      # Password files in any case: Windows and macOS find .PGPASS as .pgpass.
      case "$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')" in
        .pgpass | pgpass.conf | .netrc | _netrc)
          report "$path" "a password file (Postgres's .pgpass, or the .netrc curl reads)" ;;
      esac ;;
  esac
done < <(git ls-files -z)
if [ "$tracked" -eq 0 ]; then
  echo "::error::git ls-files listed no files; run this in a checkout of the repository"
  exit 2
fi

# Built in two parts so this file doesn't match its own pattern. git grep exits 1 when
# nothing matches; anything above that is an error, not a pass.
marker='PRIVATE KEY'
pattern="-----BEGIN[A-Z0-9 ]* ${marker}( BLOCK)?-----"
status=0
keys=$(git grep --cached -l -I -E -e "$pattern") || status=$?
if [ "$status" -gt 1 ]; then
  echo "::error::git grep failed (exit $status)"
  exit 2
fi
while IFS= read -r path; do
  if [ -n "$path" ]; then report "$path" "it holds a private key"; fi
done <<<"$keys"

if [ "$problems" -gt 0 ]; then
  echo "$problems tracked file(s) must not be in the repository. Remove them from git"
  echo "(git rm --cached <file>), and rotate any credential or key they held."
  exit 1
fi
echo "No uploads, dumps, local settings or private keys are tracked."
