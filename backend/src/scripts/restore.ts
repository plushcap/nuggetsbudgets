#!/usr/bin/env node

/**
 * Check or restore a backup from the command line: for when the app can't
 * restore it (it won't start, or the backup is larger than the page uploads), for a backup
 * this server didn't make, and to prove a backup restores.
 *
 * Usage (in the backend image, which has the database settings, secrets and pg_restore):
 *   node dist/scripts/restore.js <backup.tar.age> --verify --identity-file <file|->
 *   node dist/scripts/restore.js <backup.tar>     --yes    --decrypted
 *   node dist/scripts/restore.js <backup.enc>     --yes    [--key-file <file>]
 *   (any of them with [--signer <ed25519:…>] or [--allow-foreign]; --yes also with [--ignore-current-database])
 *
 *   --verify         Restore into a scratch database, migrate and check it, report what it
 *                    holds, and drop it. Changes nothing; the app may keep running.
 *   --yes            Replace the app's data and upload files with the backup's, the way the
 *                    Backup page does. Stop the backend first: this refuses while anything
 *                    else is connected to the database.
 *   --identity-file  An age backup (.tar.age): a file holding the private key of one of the
 *                    backup keys it was made for, as age-keygen writes it. `-` reads it from
 *                    standard input (docker exec -i … < key.txt), so it is never written to
 *                    the server's disk.
 *   --decrypted      The file is a bundle you decrypted on your own machine (age -d -i key.txt
 *                    backup.tar.age > backup.tar): for a key age opens and this can't, such as
 *                    a hardware key. The signature is checked just the same.
 *   --key-file       An older .enc backup: a file holding the backup key it was made with (the
 *                    one the Backup page downloads). Without it, this server's own old key.
 *   --signer         Trust this signer besides this server's own: the public key a backup was
 *                    signed with (ed25519:…, which the Backup page shows and rewrap-secrets
 *                    prints for the key before a rotation). Repeat it for more.
 *   --allow-foreign  Restore a backup this server didn't sign: one from another server or
 *                    one made before backups were signed. A backup's contents run on the
 *                    database, so only use this for a backup you trust.
 *   --ignore-current-database
 *                    Take nothing from the database being replaced. A restore normally keeps
 *                    its sign-in state (locks, changed passwords, removed passkeys and admin
 *                    roles), its backup keys and OneDrive connection; use this when it can't be
 *                    read, or can't be trusted (someone with write access could have locked
 *                    every admin). Sessions and tokens are still ended.
 *
 * A restore ends every session and personal access token, and refuses data with no deployment
 * admin who can sign in: nothing on the server could make one afterwards.
 *
 * Exit status: 0 done, 1 failed or refused (nothing changed unless it says so), 2 usage.
 */

import { readFile } from 'fs/promises';
import * as path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { config, configProblems } from '../config.js';
// Neither loads the logger.
import { BASELINE } from '../db/baseline.js';
import { driftLines } from '../db/schemaFingerprint.js';

// Keep the routine logging (secrets, pools) out of the way unless LOG_LEVEL asks for it. The
// logger reads LOG_LEVEL when it loads, so the app modules are imported after this.
// eslint-disable-next-line no-restricted-syntax -- set before the logger loads, which reads it through config()
process.env.LOG_LEVEL ??= 'warn';

const __dirname = getDirname(import.meta.url);

const USAGE =
  'Usage: node dist/scripts/restore.js <backup> (--verify | --yes)\n' +
  '         [--identity-file <file|->] [--decrypted] [--key-file <file>] [--signer <ed25519:…>]... [--allow-foreign]\n' +
  '         [--ignore-current-database] (with --yes)\n' +
  '  --verify         restore into a scratch database, check it and drop it (changes nothing)\n' +
  "  --yes            replace the app's data with the backup's (stop the backend first)\n" +
  '  --identity-file  a .tar.age backup: your private key file (- reads it from standard input)\n' +
  '  --decrypted      the file is a backup you decrypted yourself (age -d), a .tar\n' +
  '  --key-file       an older .enc backup: the old backup key it was made with\n' +
  "  --signer         also trust this signer's backups (the public key the Backup page shows)\n" +
  '  --ignore-current-database  with --yes: take nothing from the database being replaced\n';

function parseArgs(argv: string[]) {
  const options = {
    file: '',
    keyFile: '',
    identityFile: '',
    signers: [] as string[],
    decrypted: false,
    verify: false,
    yes: false,
    allowForeign: false,
    ignoreCurrentDatabase: false,
    help: false,
  };
  // One iterator, so an option can take the argument after it.
  const args = argv[Symbol.iterator]();
  const value = (arg: string, name: string): string | null => {
    if (arg === name) return args.next().value ?? '';
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    return null;
  };
  for (const arg of args) {
    let given: string | null;
    if (arg === '--verify') options.verify = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--allow-foreign') options.allowForeign = true;
    else if (arg === '--ignore-current-database') options.ignoreCurrentDatabase = true;
    else if (arg === '--decrypted') options.decrypted = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if ((given = value(arg, '--key-file')) !== null) options.keyFile = given || ' ';
    else if ((given = value(arg, '--identity-file')) !== null) options.identityFile = given || ' ';
    else if ((given = value(arg, '--signer')) !== null) options.signers.push(given);
    else if (!arg.startsWith('-') && !options.file) options.file = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Standard input, all of it, up to `limit` bytes: the private key, never written to disk. */
async function readStdin(limit: number): Promise<string> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new Error('Standard input is longer than a private key file');
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

let options: ReturnType<typeof parseArgs>;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n${USAGE}`);
  process.exit(2);
}
if (options.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
// An option given without its value (`--key-file` last) was recorded as ' '.
if (!options.file || options.verify === options.yes || options.keyFile === ' ' || options.identityFile === ' ' || options.signers.includes('')) {
  process.stderr.write(USAGE);
  process.exit(2);
}
if (options.ignoreCurrentDatabase && !options.yes) {
  process.stderr.write('--ignore-current-database is for a restore (--yes): a --verify takes nothing from the database.\n' + USAGE);
  process.exit(2);
}
if (options.decrypted && options.identityFile) {
  process.stderr.write('--decrypted takes a backup you decrypted already: it needs no --identity-file.\n' + USAGE);
  process.exit(2);
}

// As the server does, refuse a setting that can't be used rather than take its default, and
// in production a secret in the environment (imported now: it loads the logger).
const { secretsInEnvironment } = await import('../utils/docker-secrets.js');
const problems = [...configProblems(), ...secretsInEnvironment()];
if (problems.length > 0) {
  process.stderr.write(`Fix the configuration first:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}

const { Pool } = await import('pg');
const { initializeSecrets } = await import('../utils/docker-secrets.js');
const { getDbLocation } = await import('../db/dbConfig.js');
const { servingRolePassword } = await import('../db/servingRole.js');
const { sessionOptions } = await import('../db/pgSession.js');
const { handleConnectionErrors } = await import('../db/connectionErrors.js');
const { BackupService, BackupInProgressError, RestoreFailedError, RestoreRefusedError, ShuttingDownError, assertBackupFileExists } = await import('../services/BackupService.js');
const { publicErrorMessage } = await import('../utils/apiError.js');
const { BackupWrongKeyError, parseIdentityFile, parseSignerId } = await import('../utils/backupFormat.js');
const { BackupKeyError } = await import('../utils/backupCrypto.js');

// A --signer that isn't a signer's public key is a usage mistake, like a missing value.
const signers = options.signers.map((text) => parseSignerId(text));
if (signers.some((signer) => signer === null)) {
  process.stderr.write(`--signer takes a signer's public key: ed25519: and 43 characters, as the Backup page shows it.\n${USAGE}`);
  process.exit(2);
}
const trustedSigners = signers.filter((signer): signer is Buffer => signer !== null);
const { createLogger } = await import('../utils/logger.js');
const logger = createLogger({ service: 'RestoreCli' });

const location = getDbLocation();
// The app's own connection, as the role it serves as: reads this server's backup key.
const pool = new Pool({
  ...location,
  user: config().DB_USER,
  password: servingRolePassword(initializeSecrets()),
  max: 2,
  application_name: 'nuggets-backup',
  options: sessionOptions(),
});
// The restore ends every session on the database when it swaps the data in, this pool's
// too, idle or checked out (db/connectionErrors.ts).
handleConnectionErrors(pool, (err) => logger.debug({ err }, 'A pooled connection ended'));

const service = new BackupService(pool, { migrationsDir: path.join(__dirname, '../../migrations') });
const write = (line: string) => process.stdout.write(`${line}\n`);

/**
 * Whether this --verify is of the server's own copy of a listed backup: only that one's verify
 * is recorded on the Backup page (another copy, or a file named like it, proves nothing about it).
 */
let recordable = false;
try {
  const key = options.keyFile ? (await readFile(options.keyFile, 'utf8')).trim() : null;
  // The private key: from standard input, or a file. Its text is never printed, whatever is wrong with it.
  const identities = options.identityFile
    ? parseIdentityFile(options.identityFile === '-' ? await readStdin(64 * 1024) : await readFile(options.identityFile, 'utf8'))
    : null;
  const file = path.resolve(options.file);
  // A path that names no file is said so first, not found out by decrypting it.
  await assertBackupFileExists(file).catch((error: unknown) => {
    throw error instanceof RestoreRefusedError ? new Error(`There is no backup file at ${file}`) : error;
  });
  if (options.verify) {
    const listed = await service.findBackup(path.basename(file));
    recordable = listed !== null && path.resolve(listed.filePath) === file;
  }
  if (options.yes) {
    const others = await service.otherSessions();
    if (others.length > 0) {
      throw new Error(
        `Something is connected to database ${location.database} (${others.join(', ')}): stop the backend first ` +
          '(the restore would end its sessions mid-request). --verify works while it runs.'
      );
    }
  }
  write(`${options.verify ? 'Checking' : 'Restoring'} ${file} (database ${location.database} on ${location.host}:${location.port})`);
  const result = await service.restoreFromFile(file, {
    key,
    identities,
    decrypted: options.decrypted,
    signers: trustedSigners,
    fileName: path.basename(file),
    allowForeign: options.allowForeign,
    verifyOnly: options.verify,
    // No one signed in: refused only when the restored data has no admin who can sign in.
    restorerId: null,
    ignoreCurrentDatabase: options.ignoreCurrentDatabase,
    onPhase: (phase) => write(`  ${phase}`),
    beforeSwap: async () => {
      const others = await service.otherSessions();
      if (others.length > 0) throw new Error(`Something connected to database ${location.database} meanwhile (${others.join(', ')})`);
    },
  });
  const signedBy = { valid: trustedSigners.length ? 'this server or a --signer' : "this server's", invalid: "another server's, or changed", unsigned: 'none (made before backups were signed)', unchecked: 'not checked (no data encryption key)' }[result.signature];
  write(`Format: ${result.format === 'age' ? 'age (.tar.age)' : 'the older .enc format'}`);
  write(`Signature: ${signedBy}${result.signer ? ` (${result.signer})` : ''}`);
  if (result.manifest?.backupId) write(`Backup: ${result.manifest.backupId}`);
  write(`Backup made: ${result.manifest?.createdAt ?? 'unknown'}; schema version ${result.manifest?.schemaVersion ?? 'unknown'}; app ${result.manifest?.appVersion ?? 'unknown'}`);
  write(`Rows: ${Object.entries(result.rowCounts).map(([table, n]) => `${table} ${n}`).join(', ')}`);
  if (result.cutover) {
    write(`Cutover: a v2.4.0 backup, cut over to the baseline (${BASELINE.version}).`);
    for (const line of driftLines(result.cutover.drift)) write(line);
  }
  if (options.verify) {
    write('OK: the backup restores, migrates and passes the checks. Nothing was changed.');
    // The Backup page's history shows it verified (by the restore command: no one signed in).
    if (recordable) await service.recordVerify(path.basename(file), null, 'passed', null);
    // The browser can't check a hardware key: opening a backup this server made to it alone counts.
    if (options.decrypted && result.signature === 'valid' && result.manifest?.recipients) {
      const marked = await service.markOnlyHardwareRecipientChecked(result.manifest.recipients).catch(() => null);
      if (marked) write(`Backup key "${marked}" (a hardware key) now shows as checked.`);
    }
  } else {
    write(`Restored, with ${result.uploadedFilesRestored} upload file(s).`);
    const carried = result.carryOver;
    if (carried) {
      const { ended, taken, kept } = carried;
      write(`Ended: ${ended.sessions} session(s), ${ended.tokens} access token(s), ${ended.invitations} invitation(s); ${ended.notifications} queued notification(s) won't be sent.`);
      if (!carried.tookFromRunningServer) write('Took nothing from the database it replaced (--ignore-current-database).');
      else if (!carried.sameDeployment) write("The backup is another deployment's: no sign-in state was taken from the database it replaced.");
      else {
        write(
          `Taken from the database it replaced: ${taken.locks} lock(s), ${taken.passwords} changed password(s), ${taken.passkeysRemoved} removed passkey(s), ` +
            `${taken.deploymentRoles} removed deployment role(s); ${carried.lockedDeletedSince} person(s) deleted since were locked.`
        );
      }
      if (carried.tookFromRunningServer) {
        write(
          `Kept: ${kept.backupKeys ? "this server's backup keys" : "the backup's backup keys (this server had none)"}, ${kept.oneDriveConnections} OneDrive connection(s)` +
            `${kept.automaticBackupsKeptOn ? ', automatic backups on' : ''}.`
        );
      }
      for (const removed of carried.removedSince) {
        const where = `${removed.kind} "${removed.name}"`;
        write(`Still ${removed.change === 'admin' ? 'an admin of' : 'a member of'} ${where} in the restored data, though removed since: ${removed.person}`);
      }
    }
    write(`The data from before is kept as database ${result.previousDatabase}, and its upload files in ${result.previousUploads}, until the next restore.`);
  }
} catch (error) {
  const changed = error instanceof RestoreFailedError && error.databaseChanged;
  const cause = error instanceof RestoreFailedError ? error.cause : error;
  // A verify of the listed backup that ran and failed; not a wrong key (the person's mistake,
  // not the backup's), nor one held up by another operation or a shutdown.
  const keyMistake = cause instanceof BackupWrongKeyError || cause instanceof BackupKeyError;
  if (recordable && !keyMistake && !(error instanceof BackupInProgressError) && !(cause instanceof ShuttingDownError)) {
    await service.recordVerify(path.basename(options.file), null, 'failed', publicErrorMessage(cause, 'The backup did not verify; the restore command said why.'));
  }
  process.stderr.write(`${(error as Error).message}\n${changed ? 'The data WAS replaced; see the message above.' : 'Nothing was changed.'}\n`);
  logger.debug({ err: error }, 'Restore failed');
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
