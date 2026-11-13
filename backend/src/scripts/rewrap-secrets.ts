#!/usr/bin/env node

/**
 * Re-encrypt every stored secret from the old data_encryption_key to a new one.
 *
 * Usage: in the running backend container (docker exec), then restart it with the new key
 * and run it once more for what it saved under the old key meanwhile. A backend that won't
 * start (a weak key) runs it in a container of its own from the backend's image.
 *   node dist/scripts/rewrap-secrets.js --old-key-file <path> --new-key-file <path> [--dry-run]
 *
 *   --old-key-file  the key the values are encrypted with now
 *   --new-key-file  the key they are to be encrypted with (default: the data_encryption_key
 *                   secret, /run/secrets/data_encryption_key)
 *   --dry-run       report what would change, and change nothing
 *
 * Connects as the schema owner, like the migration runner (MIGRATION_DB_USER, else DB_USER,
 * with the db_password secret), and rewraps in one
 * transaction: all of it or none. Run again, it finds everything current and changes
 * nothing. Exits 1 if some value opens with neither key (it is listed by table and id).
 * Prints counts and ids, never a value or a key.
 */

import { readFileSync } from 'node:fs';

// eslint-disable-next-line no-restricted-syntax -- set before the logger loads, which reads it through config()
process.env.LOG_LEVEL ??= 'warn';

const { createMigrationPool } = await import('../db/migrationPool.js');
const { rewrapSecrets } = await import('../services/secretRewrap.js');
const { keyIdOf } = await import('../utils/crypto-envelope.js');
const { DATA_ENCRYPTION_SECRET_PATH } = await import('../utils/data-encryption-secret.js');
const { secretsInEnvironment } = await import('../utils/docker-secrets.js');

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function readKey(path: string, which: string): string {
  let key: string;
  try {
    key = readFileSync(path, 'utf8').trim();
  } catch {
    throw new Error(`Can't read the ${which} key file ${path}.`);
  }
  if (key.length < 32) throw new Error(`The ${which} key in ${path} is shorter than 32 characters.`);
  return key;
}

const dryRun = process.argv.includes('--dry-run');
const oldPath = argument('--old-key-file');
const newPath = argument('--new-key-file') ?? DATA_ENCRYPTION_SECRET_PATH;

if (!oldPath) {
  process.stderr.write('Usage: rewrap-secrets --old-key-file <path> [--new-key-file <path>] [--dry-run]\n');
  process.exit(2);
}

// As the server and the migration runner do, refuse a secret in the environment in production.
const refused = secretsInEnvironment();
if (refused.length > 0) {
  process.stderr.write(`Fix the configuration first:\n${refused.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}

const pool = createMigrationPool();
const client = await pool.connect();
try {
  const oldKey = readKey(oldPath, 'old');
  const newKey = readKey(newPath, 'new');
  process.stdout.write(`Old key id ${keyIdOf(oldKey)}, new key id ${keyIdOf(newKey)}${dryRun ? ' (dry run: nothing is written)' : ''}\n`);

  await client.query('BEGIN');
  const results = await rewrapSecrets(client, oldKey, newKey);
  await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');

  let unreadable = 0;
  for (const r of results) {
    process.stdout.write(`${r.label}: ${r.rewrapped} ${dryRun ? 'to rewrap' : 'rewrapped'}, ${r.current} already current` +
      (r.unreadable.length ? `, ${r.unreadable.length} opened by neither key (ids ${r.unreadable.join(', ')})` : '') + '\n');
    unreadable += r.unreadable.length;
  }
  if (unreadable > 0) {
    process.stdout.write(`${unreadable} value(s) opened with neither key and were left as they are: re-enter them in the app.\n`);
    process.exitCode = 1;
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => undefined);
  process.stderr.write(`rewrap-secrets failed, nothing was changed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
