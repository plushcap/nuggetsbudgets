#!/usr/bin/env bash
#
# First-time local setup for Nuggets development.
#
# Idempotent: creates .env from the template (if missing), generates the Docker
# secret files in ./secrets, and creates the local ./data directories so
# `npm run dev` works out of the box. Safe to re-run — it never overwrites an
# existing .env or existing secret files.
#
#   npm run setup
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "Nuggets local setup"
echo "==================="

# 1. .env from template
if [ -f .env ]; then
  echo "  .env already exists — leaving it as-is"
else
  cp .env.example .env
  echo "  created .env from .env.example (review it before starting)"
fi

# 2. Docker secret files (./secrets/*.txt)
node scripts/generate-secrets.js

# 3. Local data directories (defaults used by docker-compose.yml / .env.example)
for d in postgres uploads backups temp logs; do
  mkdir -p "data/$d"
done
echo "  ensured ./data/{postgres,uploads,backups,temp,logs}"

echo
echo "Setup complete. Next steps:"
echo "  1. Review .env"
echo "  2. Start the stack:  npm run dev   (or: npm run dev:detached)"
echo "  3. Open http://localhost:3000 and create the first admin user"
