#!/usr/bin/env node

/**
 * Nuggets secret-file generator.
 *
 * Writes the Docker secret FILES that the compose stacks consume:
 *   docker-compose.yml (dev)            -> ./secrets/*.txt
 *   docker-compose.prod.yml / portainer -> $SECRETS_BASE_PATH/*.txt
 *
 * Every secret is generated with crypto.randomBytes(). (SimpleFin and SMTP have no
 * secret file: they are set up in the app, which stores their credentials encrypted.)
 * Existing files are preserved, so re-running never clobbers live secrets; --force
 * names the ones to replace.
 *
 * Usage:
 *   node scripts/generate-secrets.js                 # -> ./secrets
 *   npm run security:generate                        # same
 *   node scripts/generate-secrets.js --dir /opt/nuggets/secrets
 *   SECRETS_DIR=/opt/nuggets/secrets node scripts/generate-secrets.js
 *   node scripts/generate-secrets.js --force jwt_secret,session_secret   # replace these
 *
 * Replacing jwt_secret, session_secret or csrf_secret signs everyone out. Replacing
 * db_password, app_db_password or data_encryption_key breaks things that a new file
 * doesn't mend: the database keeps its old passwords, and whatever was encrypted
 * with the old data key (the stored backup key, bank-sync and OneDrive credentials) can't
 * be read again. Those take --i-understand as well.
 *
 * NEVER commit the secrets directory.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirFlagIdx = args.indexOf('--dir');
const secretsDir = path.resolve(
  dirFlagIdx !== -1 && args[dirFlagIdx + 1]
    ? args[dirFlagIdx + 1]
    : process.env.SECRETS_DIR || path.join(process.cwd(), 'secrets')
);

// filename -> generator.
const SECRETS = {
  'db_password.txt': () => crypto.randomBytes(32).toString('base64'),
  // Serving-role (nuggets_app) password — the unprivileged, RLS-enforced DB role the app
  // connects as. Must be non-empty: the backend syncs the role's LOGIN + password from it
  // on migrate, then connects as nuggets_app.
  'app_db_password.txt': () => crypto.randomBytes(32).toString('base64'),
  'jwt_secret.txt': () => crypto.randomBytes(64).toString('base64'),
  'session_secret.txt': () => crypto.randomBytes(32).toString('base64'),
  'csrf_secret.txt': () => crypto.randomBytes(32).toString('base64'),
  // Data-at-rest key: backups, the SimpleFin access URL, and OneDrive tokens.
  // HKDF derives the per-purpose AES-256 keys from it, so any value >= 32 chars
  // works; 32 random bytes -> 44 base64 chars.
  'data_encryption_key.txt': () => crypto.randomBytes(32).toString('base64'),
};

/** Replacing these breaks what was made with the old value; the reason is shown. */
const LOSSY = {
  'db_password.txt': 'Postgres keeps the old password: the backend can no longer connect until the role is changed to the new one (ALTER ROLE).',
  'app_db_password.txt': 'the serving role gets the new password at the next migrate; until then the backend cannot connect.',
  'data_encryption_key.txt':
    'everything encrypted with the old key can no longer be read: the stored backup key (backups then restore only with a downloaded copy), the bank-sync access URL, OneDrive tokens and the SMTP password.',
};

/** The files --force names, or null without --force. Exits on a mistake. */
function forcedFiles() {
  const index = args.indexOf('--force');
  if (index === -1) return null;
  const list = args[index + 1];
  if (!list || list.startsWith('--')) {
    console.error('--force needs the secrets to replace, e.g. --force jwt_secret,session_secret');
    process.exit(2);
  }
  const files = list.split(',').map((name) => `${name.trim().replace(/\.txt$/, '')}.txt`);
  const unknown = files.filter((file) => !(file in SECRETS));
  if (unknown.length > 0) {
    console.error(`Unknown secret(s): ${unknown.join(', ')}. Known: ${Object.keys(SECRETS).map((f) => f.replace(/\.txt$/, '')).join(', ')}`);
    process.exit(2);
  }
  const lossy = files.filter((file) => file in LOSSY);
  if (lossy.length > 0 && !args.includes('--i-understand')) {
    console.error('Refusing to replace these without --i-understand:');
    for (const file of lossy) console.error(`  ${file}: ${LOSSY[file]}`);
    process.exit(2);
  }
  return new Set(files);
}

function main() {
  const forced = forcedFiles();
  fs.mkdirSync(secretsDir, { recursive: true });
  try { fs.chmodSync(secretsDir, 0o700); } catch { /* best effort */ }

  console.log(`Writing Nuggets secret files to: ${secretsDir}`);

  let generated = 0;
  let preserved = 0;

  for (const [file, gen] of Object.entries(SECRETS)) {
    const target = path.join(secretsDir, file);
    const exists = fs.existsSync(target);

    if (exists && !(forced && forced.has(file))) {
      console.log(`  preserve  ${file} (already exists)`);
      preserved++;
      continue;
    }

    fs.writeFileSync(target, gen(), { mode: 0o600 });
    try { fs.chmodSync(target, 0o600); } catch { /* best effort */ }

    console.log(`  ${exists ? 'rewrite ' : 'create  '}${file}`);
    generated++;
  }

  console.log(`\nDone: ${generated} generated, ${preserved} preserved.`);
  if (preserved && !forced) {
    console.log('To replace one, name it: --force jwt_secret (replacing jwt_secret, session_secret or csrf_secret signs everyone out).');
  }
  console.log('Reminder: the secrets directory must NEVER be committed to version control.');
}

main();
