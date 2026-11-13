import type { RestorePhase } from '@nuggets/shared';
import { Client, Pool, escapeIdentifier, escapeLiteral } from 'pg';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { existsSync, readdirSync, statSync, createWriteStream } from 'fs';
import * as path from 'path';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { EncryptionService } from './EncryptionService.js';
import { readSystemSetting, readSystemSettings, readSystemSettingsIn, writeSystemSetting, type SystemSettingRow } from './systemSettings.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { MigrationService } from './MigrationService.js';
import type { SchemaDrift } from '../db/schemaFingerprint.js';
import { BASELINE } from '../db/baseline.js';
import { V2_4_0_NEWEST_VERSION } from '../db/v240Migrations.js';
import { createLogger } from '../utils/logger.js';
import { oneRow } from '../utils/present.js';
import { errorCode, errorMessage } from '../utils/errors.js';
import { getDirname } from '../utils/esm-compat.js';
import { initializeSecrets } from '../utils/docker-secrets.js';
import { safeExtractZip } from '../utils/safeUnzip.js';
import { appVersion } from '../utils/appVersion.js';
import { sessionOptions } from '../db/pgSession.js';
import { handleConnectionErrors } from '../db/connectionErrors.js';
import { getDbLocation, getOwnerCredentials, type DbCredentials, type DbLocation } from '../db/dbConfig.js';
import { assertServingRoleEnforcesRls, servingRolePassword } from '../db/servingRole.js';
import { definerFunctionsRevokeSql, servingRoleGrantsSql } from '../db/servingRoleGrants.js';
import { decryptBackupFile, encryptBackupFile, type BackupSignature } from '../utils/backupCrypto.js';
import {
  BACKUP_ID,
  BackupBundleError,
  BackupWrongKeyError,
  MAX_BACKUP_RECIPIENTS,
  RecipientProblem,
  SIGNED_TAIL_BYTES,
  UploadChangedError,
  assertRecipientsCompatible,
  bundleChunks,
  checkRecipient,
  checkSignedTail,
  countStanzas,
  decryptBundle,
  detectBackupFormat,
  encryptToRecipients,
  extractBundle,
  copyAndHashBundle,
  hashFile,
  isBackupFileName,
  isHardwareRecipient,
  publishFile,
  readAgeHeader,
  recipientFingerprint,
  recipientKind,
  signerId,
  sweepPartialBackups,
  type BackupFileFormat,
  type BundleKey,
  type RecipientKind,
} from '../utils/backupFormat.js';
import {
  backupKeyKindMismatch,
  backupKeyNotFound,
  damagedBackupHeader,
  duplicateBackupKey,
  invalidBackupKey,
  notAnAgeBackup,
  tooManyBackupKeys,
} from './backup/errors.js';
import { runPgTool, terminatePgTools } from '../utils/pgTools.js';
import { ZipArchive } from 'archiver';
import { sql } from 'kysely';
import { config } from '../config.js';

const __dirname = getDirname(import.meta.url);
const logger = createLogger({ service: 'BackupService' });

/**
 * Metadata written into every backup archive (manifest.json) so a restore can
 * verify — BEFORE touching the database — that the backup can be applied.
 * `schemaVersion` is the max `schema_migrations.version` (the 14-digit
 * migration timestamp) captured at backup time.
 */
export interface BackupManifest {
  manifestVersion: number;
  appVersion: string;
  /** Max applied schema_migrations.version at backup time, or null if unknown. */
  schemaVersion: string | null;
  createdAt: string;
  /** The backup's id, signed (an age backup's; format 4): its file name should be it. */
  backupId?: string;
  /** The fingerprints of the keys an age backup was encrypted to. */
  recipients?: string[];
}

/** What holds the backup lock: this process's backup, restore or verify, or another process. */
export type BackupLockHolder = 'backup' | 'restore' | 'verify' | 'elsewhere';

/** A backup was refused because another one is running, in this process or another server. */
export class BackupInProgressError extends ControlPlaneError {
  constructor(
    message = 'A backup is already in progress',
    readonly heldBy: BackupLockHolder = 'backup'
  ) {
    super(409, 'BACKUP_IN_PROGRESS', message);
    this.name = 'BackupInProgressError';
  }
}

/**
 * The server is shutting down (BackupService.refuseNewOperations): no backup or restore
 * starts, and a restore that hadn't begun replacing the data was stopped. A 503.
 */
export class ShuttingDownError extends ControlPlaneError {
  constructor(message = 'The server is shutting down, so no backup or restore can start now. Try again once it has restarted.') {
    super(503, 'SHUTTING_DOWN', message);
    this.name = 'ShuttingDownError';
  }
}

/** What a restore stopped by a shutdown before it replaced the data reports. */
const RESTORE_STOPPED_BY_SHUTDOWN =
  'The server shut down before the restore replaced the data, so nothing was changed. Restore the backup again once the server has restarted.';

/** No backup key has been set up yet: no key, no backup. Its message says what to do. */
export class BackupKeyMissingError extends ControlPlaneError {
  constructor() {
    super(
      409,
      'BACKUP_KEY_MISSING',
      'No backup key has been set up. Make one or add your public key under Backup keys in Settings → Database Backup before creating a backup.'
    );
    this.name = 'BackupKeyMissingError';
  }
}

/** The stored backup keys can't be used together (a mix of kinds, or one that no longer parses). */
export class BackupKeysUnusableError extends ControlPlaneError {
  constructor(reason: string) {
    super(409, 'BACKUP_KEYS_UNUSABLE', `The backup keys can't be used: ${reason} Fix them under Backup keys in Settings → Database Backup.`);
    this.name = 'BackupKeysUnusableError';
  }
}

/** One of the owner's public keys a backup is encrypted to, as the Backup page lists it. */
export interface BackupRecipient {
  uuid: string;
  /** The age public key. */
  recipient: string;
  label: string;
  kind: RecipientKind;
  /** A hardware key's tag form, which the browser can't check. */
  hardware: boolean;
  fingerprint: string;
  /** When the private key file was shown to match it, or null (a pasted key not checked yet). */
  checkedAt: string | null;
  createdAt: string;
  /** Who added it, by name, or null when they are gone. */
  createdBy: string | null;
}

/** A failed restore. `databaseChanged` says whether it got as far as replacing the data. */
export class RestoreFailedError extends Error {
  constructor(
    message: string,
    readonly databaseChanged: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'RestoreFailedError';
  }
}

/**
 * A restore refused for a reason the person restoring can act on (the wrong key, a backup
 * from a newer version, …): its message is safe to show them, unlike other failures'.
 */
export class RestoreRefusedError extends ControlPlaneError {
  constructor(message: string, options?: ErrorOptions, code = 'RESTORE_REFUSED') {
    super(422, code, message);
    this.name = 'RestoreRefusedError';
    if (options && 'cause' in options) this.cause = options.cause;
  }
}

/**
 * Refuse a restore of a backup file that isn't there, or isn't a file, before anything else:
 * it went on to decrypt, and the decryption's failure said "This server's backup key
 * can't open this backup". For the restore command too, which checks the path it was given
 * first. The message names no path: the command prints the one it was given.
 */
export async function assertBackupFileExists(file: string): Promise<void> {
  let isFile: boolean;
  try {
    isFile = (await fs.stat(file)).isFile();
  } catch (err) {
    const code = errorCode(err);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
    isFile = false;
  }
  if (!isFile) throw new RestoreRefusedError('The backup file was not found: there is no file at that path', undefined, 'BACKUP_FILE_NOT_FOUND');
}

/**
 * The backup isn't signed by this server, so the app won't restore it.
 * A restore runs the archive's SQL on the database; only this server's own backups are
 * known to hold nothing but what its migrations made. Anyone who can open the Backup page
 * can download the backup key and encrypt an archive of their own with it, so the key
 * proves nothing; the signature's key comes from the data_encryption_key secret, which no
 * app session can read. Someone with a shell on the server can restore any backup with the
 * restore command and --allow-foreign, vouching for it.
 */
export class ForeignBackupError extends RestoreRefusedError {
  constructor(
    readonly signature: Exclude<BackupSignature, 'valid'>,
    /** An age backup's signer (`ed25519:…`), which the restore command's --signer can trust. */
    readonly signer: string | null = null
  ) {
    const why = {
      invalid: signer
        ? `it is signed by ${signer}, not by this server: it was made by another server (one with a different data_encryption_key, or before it was rotated), or changed since`
        : "it is not signed by this server: it was made by another server (one with a different data_encryption_key), or changed since",
      unsigned: 'it was made before backups were signed',
      unchecked: 'this server has no data encryption key to check its signature with',
    }[signature];
    super(
      `This backup can't be restored here because ${why}. ` +
        'A restore runs what the backup holds on the database, so the app restores only backups this server made. ' +
        'To restore it anyway, a deployment admin with a shell on the server can stop the backend and run the restore command in a ' +
        "container of its own from the backend's image, with its mounts, secrets and database settings: docker run --rm -i " +
        '--volumes-from nuggets_backend --network <the stack network> -e USE_DOCKER_SECRETS=true -e NODE_ENV=production ' +
        '-e DB_HOST=postgres -e DB_NAME=<database> -e DB_USER=nuggets_app -e MIGRATION_DB_USER=<the owner role> ' +
        '--entrypoint node <the backend image> dist/scripts/restore.js <backup file> --yes ' +
        (signer ? `--signer ${signer} (the signer you trust; --allow-foreign trusts any) ` : '--allow-foreign ') +
        'and, for a .tar.age backup, --identity-file - with your private key on standard input; for an older .enc one, ' +
        "--key-file <a file holding the key it was made with, unless it is this server's current one>.",
      undefined,
      'BACKUP_NOT_SIGNED_HERE'
    );
    this.name = 'ForeignBackupError';
  }
}

/** What a restore is doing, for its status: the answer's phases (`@nuggets/shared`). */
export type { RestorePhase };

export interface RestoreOptions {
  /**
   * An older .enc backup: the key the user typed; without one, this server's backup key (then
   * the legacy Docker-secret key).
   */
  key?: string | null;
  /** An age backup: its file key, which the browser got by opening the header with the private key. */
  fileKey?: Buffer | null;
  /** An age backup: the private keys (the restore command's --identity-file). */
  identities?: readonly string[] | null;
  /** The file is a bundle the owner decrypted (`age -d`), not encrypted (the restore command's --decrypted). */
  decrypted?: boolean;
  /** Signers to trust besides this server's own (the restore command's --signer): Ed25519 public keys. */
  signers?: readonly Buffer[];
  /**
   * The name the backup was listed or uploaded under. When it is a backup's name, the id its
   * signed manifest names must be the same (an older backup renamed is refused).
   */
  fileName?: string | null;
  /** Restore a backup this server didn't sign (the restore command's --allow-foreign). */
  allowForeign?: boolean;
  /** Do everything but replace the data: restore into a scratch database, check it, drop it. */
  verifyOnly?: boolean;
  onPhase?: (phase: RestorePhase) => void;
  /** Runs after every check has passed, just before the data is replaced: may still refuse. */
  beforeSwap?: () => Promise<void>;
}

export interface RestoreResult {
  manifest: BackupManifest | null;
  /** age, or the older .enc format. */
  format: 'age' | 'legacy';
  signature: BackupSignature;
  /** An age backup's signer (`ed25519:…`), or null for an .enc one. */
  signer: string | null;
  /** Row counts of a few tables in the restored data. */
  rowCounts: Record<string, number>;
  /** The replaced database, kept under this name (null for verifyOnly). */
  previousDatabase: string | null;
  /** Where the replaced upload files were moved (null for verifyOnly). */
  previousUploads: string | null;
  uploadedFilesRestored: number;
  /**
   * When the backup was v2.4.0's, the cutover the migrate after the restore made: what its
   * comparison with a fresh baseline found (`drift` null: it couldn't compare, the log says
   * why). Null when there was no cutover.
   */
  cutover: { drift: SchemaDrift | null } | null;
}

/** A backup in the backup directory, as listBackups lists it. */
export interface ListedBackup {
  fileName: string;
  filePath: string;
  size: number;
  created: Date;
  /** What its first bytes say it is: age (opens with a backup key's private key), legacy (the old key). */
  format: BackupFileFormat;
}

/** A backup createBackup made. */
export interface CreatedBackup {
  filePath: string;
  fileName: string;
  fileSize: number;
  /** The SHA-256 of the file as written (an age backup's), or null (an .enc one). */
  sha256: string | null;
}

export interface BackupServiceOptions {
  /** The app's database (DB_HOST, DB_PORT, DB_NAME). */
  location?: DbLocation;
  /** The schema owner: makes the dump, and does everything in a restore but pg_restore. */
  owner?: DbCredentials;
  /** The role the app serves as, for the serving-role check on restored data. */
  serving?: DbCredentials;
  backupLocation?: string;
  uploadsDir?: string;
  tempDir?: string;
  migrationsDir?: string;
  /** A database to connect to for creating, renaming and dropping the others. */
  maintenanceDatabase?: string;
}

/**
 * The role pg_restore runs as: no superuser, no BYPASSRLS, no
 * CREATEDB/CREATEROLE/REPLICATION, a member of no role (so not of pg_execute_server_program
 * or the server-file roles). It owns only the scratch database it restores into, and
 * can log in only during a restore, with a password made for that restore and never stored.
 */
export const RESTORE_ROLE = 'nuggets_restore';

/** Held (on the maintenance database) while RESTORE_ROLE can log in. */
export const RESTORE_ROLE_LOCK_KEY = 4242042044;

/**
 * TOC entry types a Nuggets dump has, and that a restore lets through. Anything else —
 * event triggers, rules, casts, operators, foreign servers, large objects, publications,
 * another schema — is no part of this schema, and the restore refuses the backup.
 */
const ALLOWED_TOC_TYPES = [
  'TABLE DATA',
  'TABLE ATTACH',
  'TABLE',
  'SEQUENCE SET',
  'SEQUENCE OWNED BY',
  'SEQUENCE',
  'DEFAULT ACL',
  'DEFAULT',
  'FK CONSTRAINT',
  'CONSTRAINT',
  'INDEX ATTACH',
  'INDEX',
  'TRIGGER',
  'FUNCTION',
  'PROCEDURE',
  'AGGREGATE',
  'MATERIALIZED VIEW DATA',
  'MATERIALIZED VIEW',
  'VIEW',
  'ROW SECURITY',
  'POLICY',
  'ACL',
  'COMMENT',
  'EXTENSION',
  'TYPE',
  'DOMAIN',
  'STATISTICS',
];

/** The application_name of backup and restore connections, which otherSessions() leaves out. */
const BACKUP_APPLICATION_NAME = 'nuggets-backup';

/** Tables whose row counts a restore reports (those that exist). */
const COUNTED_TABLES = ['tenants', 'users', 'accounts', 'transactions', 'budget_items', 'stored_images'];

/** What an operation is: a backup, a restore, or a verify (a restore into a scratch database that is then dropped). */
export type OperationKind = 'backup' | 'restore' | 'verify';

/** A backup, restore or verify this process is running. */
interface Operation {
  kind: OperationKind;
  /** The database it backs up or replaces. */
  database: string;
  done: Promise<void>;
  /**
   * A restore past its last check: it is swapping the databases in (or back), then the
   * upload files. A shutdown waits for it, since stopping it there can leave the database
   * refusing connections (ALLOW_CONNECTIONS false) or the uploads half moved.
   */
  replacingData: boolean;
  /** Ends what a restore that isn't replacing the data waits on, so it fails now (interruptRestore). */
  interrupt: (() => Promise<void>) | null;
  /** interruptRestore was called on it. */
  interrupted: boolean;
}

/**
 * Whether this process is making a backup or restoring one. Module-level, not per
 * instance: index.ts (for the scheduler) and routes/backup.ts (for manual backups and
 * restores) each construct a BackupService.
 */
let currentOperation: Operation | null = null;

/** A shutdown has begun: no backup or restore starts any more (refuseNewOperations). */
let refusingOperations = false;

const IN_PROGRESS: Record<OperationKind, string> = {
  backup: 'A backup is already in progress',
  restore: 'A restore is in progress',
  verify: 'A backup is being verified; try again when it has finished',
};

function claimOperation(kind: OperationKind, database: string): { operation: Operation; release: () => void } {
  if (refusingOperations) throw new ShuttingDownError();
  if (currentOperation) {
    throw new BackupInProgressError(IN_PROGRESS[currentOperation.kind], currentOperation.kind);
  }
  let finish!: () => void;
  const done = new Promise<void>((resolve) => (finish = resolve));
  const operation: Operation = { kind, database, done, replacingData: false, interrupt: null, interrupted: false };
  currentOperation = operation;
  return {
    operation,
    release: () => {
      currentOperation = null;
      finish();
    },
  };
}

/** Stop a restore that hasn't begun replacing the data, at its next step, once a shutdown has begun. */
function stopIfShuttingDown(): void {
  if (refusingOperations) throw new ShuttingDownError(RESTORE_STOPPED_BY_SHUTDOWN);
}

/**
 * `nuggets_backup_YYYYMMDD_HHMMSS[_mmm].tar.age` (age) or `.enc` (the format before), the
 * names createBackup gives its files.
 */
const BACKUP_FILE_NAME = /^nuggets_backup_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})(?:_(\d{3}))?\.(?:enc|tar\.age)$/;

/**
 * The time a backup's name says it was made: `YYYYMMDD_HHMMSS`, and the milliseconds when the
 * name has them (an older .enc one's may not). Null when it isn't a backup's name.
 */
export function backupStampOfFileName(fileName: string): { stamp: string; millis: string | null } | null {
  const match = BACKUP_FILE_NAME.exec(fileName);
  if (!match) return null;
  const [, year, month, day, hours, minutes, seconds, millis] = match;
  return { stamp: `${year}${month}${day}_${hours}${minutes}${seconds}`, millis: millis ?? null };
}

/**
 * The time a file's name claims for it, read as loosely as a person would: a backup's stamp
 * anywhere in it, in any case (`Nuggets_backup_…`, `….age`, `….tar.age.tar.age`), or null. A
 * restore checks it against the signed id, so a near-miss name can't pass for an older backup.
 */
export function claimedBackupStamp(fileName: string): { stamp: string; millis: string | null } | null {
  const match = /nuggets_backup_(\d{8})_(\d{6})(?:_(\d{3}))?/i.exec(fileName);
  if (!match) return null;
  const [, date, time, millis] = match;
  return { stamp: `${date}_${time}`, millis: millis ?? null };
}

/** The id a backup's name says it is (`nuggets_backup_…_mmm`), or null when it isn't a backup's name. */
export function backupIdFromFileName(fileName: string): string | null {
  const id = fileName.replace(/\.(?:enc|tar\.age)$/, '');
  return BACKUP_FILE_NAME.test(fileName) && BACKUP_ID.test(id) ? id : null;
}

/** How many times a backup is tried when an upload changes while it is read. */
const UPLOAD_CHANGED_ATTEMPTS = 3;

/**
 * When a backup was made, read from its file name, or null when the name carries no
 * (valid) timestamp. The stamp is UTC, as `formatDate` writes it, so it reads the same
 * whatever the process TZ. Names written before were the server's local time,
 * which the compose files used to set to a zone west of UTC: those read hours early.
 */
export function backupTimeFromFileName(fileName: string): Date | null {
  const match = BACKUP_FILE_NAME.exec(fileName);
  if (!match) return null;
  const [year = 0, month = 0, day = 0, hours = 0, minutes = 0, seconds = 0, millis = 0] = match.slice(1).map((part) => Number(part ?? 0));
  const created = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds, millis));
  // Date.UTC rolls an impossible date (month 13, Feb 30) over instead of failing.
  if (created.getUTCFullYear() !== year || created.getUTCMonth() !== month - 1 || created.getUTCDate() !== day) return null;
  return created;
}

/** A timestamptz as pg returns it (a Date), as ISO-8601, or null. */
function instant(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** A person's name as a list shows it: their name, else their email; null when they are gone. */
function personName(row: { first_name: string | null; last_name: string | null; email: string | null }): string | null {
  const name = [row.first_name, row.last_name].filter((part) => part && part.trim()).join(' ').trim();
  return name || row.email || null;
}

/** `base` + `suffix` as a database name: Postgres keeps 63 bytes of one. */
function databaseName(base: string, suffix: string): string {
  return Buffer.from(base).subarray(0, 63 - Buffer.byteLength(suffix)).toString() + suffix;
}

/** The password verifier Postgres stores for SCRAM-SHA-256, so the password itself never reaches the server's logs. */
function scramVerifier(password: string): string {
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Each entry type in a `pg_restore -l` listing, with its schema, e.g. ['TABLE DATA', 'public']. */
export function parseTocListing(listing: string): Array<{ type: string; schema: string; line: string }> {
  const entries: Array<{ type: string; schema: string; line: string }> = [];
  for (const line of listing.split('\n')) {
    if (!line.trim() || line.startsWith(';')) continue;
    // "<dump id>; <catalog oid> <object oid> <type...> <schema> <name...> <owner>"
    const rest = line.replace(/^\d+;\s+\d+\s+\d+\s+/, '');
    const type = ALLOWED_TOC_TYPES.find((t) => rest.startsWith(`${t} `));
    // An unknown type can't be told from its schema: the whole entry stands for it.
    if (!type) entries.push({ type: rest.trim(), schema: '', line });
    else entries.push({ type, schema: rest.slice(type.length + 1).split(' ')[0] ?? '', line });
  }
  return entries;
}

export class BackupService {
  /**
   * Session-level advisory lock held for the whole of a backup or a restore (on the app's
   * database), so two can't run at once on servers sharing the database, or a server and
   * the restore command. Distinct from MigrationService.MIGRATION_LOCK_KEY.
   */
  static readonly BACKUP_LOCK_KEY = 4242042043;

  /** Whether this process is making a backup right now (manual or scheduled). */
  static isBackupInProgress(): boolean {
    return currentOperation?.kind === 'backup';
  }

  /** Whether this process is restoring a backup right now (a verify is not a restore: the data stays). */
  static isRestoreInProgress(): boolean {
    return currentOperation?.kind === 'restore';
  }

  /** Whether this process is verifying a backup right now. */
  static isVerifyInProgress(): boolean {
    return currentOperation?.kind === 'verify';
  }

  /**
   * A shutdown has begun (ApplicationLifecycleService.shutdown): from now on this process
   * starts no backup or restore (ShuttingDownError, a 503), and a restore that hasn't begun
   * replacing the data stops at its next step, leaving the data as it was. Never undone:
   * the process is exiting.
   */
  static refuseNewOperations(): void {
    refusingOperations = true;
  }

  /** Whether refuseNewOperations has been called. */
  static isRefusingNewOperations(): boolean {
    return refusingOperations;
  }

  /**
   * The backup or restore this process is running, if any: which, on what database, and
   * (a restore) whether it is replacing the data, past the point where it can be stopped.
   */
  static runningOperation(): { kind: OperationKind; database: string; replacingData: boolean } | null {
    if (!currentOperation) return null;
    const { kind, database, replacingData } = currentOperation;
    return { kind, database, replacingData };
  }

  /**
   * Make a restore that hasn't begun replacing the data, or a verify, fail now rather than at
   * its next step: its pg_restore is stopped, and its sessions on the scratch database ended.
   * It then drops the scratch database, and the data stays as it was. Call it after
   * refuseNewOperations, which keeps the restore from starting anything new; call it again
   * if the restore goes on (a query it started just after). False when no such restore runs.
   */
  static async interruptRestore(): Promise<boolean> {
    const operation = currentOperation;
    if ((operation?.kind !== 'restore' && operation?.kind !== 'verify') || operation.replacingData) return false;
    operation.interrupted = true;
    terminatePgTools();
    await operation.interrupt?.();
    return true;
  }

  /** Resolves when the backup or restore this process is running (if any) has finished. */
  static idle(): Promise<void> {
    return currentOperation?.done ?? Promise.resolve();
  }

  /**
   * Wait for the backup or restore this process is running, for up to `timeoutMs`.
   * True when none is running (any more).
   */
  static async waitForIdle(timeoutMs: number): Promise<boolean> {
    const operation = currentOperation;
    if (!operation) return true;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
    try {
      return await Promise.race([operation.done.then(() => true as const), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  private readonly backupLocation: string;
  private readonly uploadsDir: string;
  private readonly tempDir: string;
  private readonly migrationsDir: string;
  private readonly location: DbLocation;
  private readonly maintenanceDatabase: string;
  private readonly encryptionService: EncryptionService;
  private ownerOverride: DbCredentials | undefined;
  private servingOverride: DbCredentials | undefined;

  /** `YYYYMMDD_HHMMSS` in UTC: backup names don't depend on the process TZ. */
  private formatDate(date: Date): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    const hours = String(date.getUTCHours()).padStart(2, '0');
    const minutes = String(date.getUTCMinutes()).padStart(2, '0');
    const seconds = String(date.getUTCSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hours}${minutes}${seconds}`;
  }

  private settingsKysely: Kysely<DB> | undefined;

  constructor(private db: Pool, options: BackupServiceOptions = {}) {
    // Next to the app (/app/backups, /app/uploads and /app/temp in the image): the same
    // places app.ts serves uploads from and the compose files mount.
    this.backupLocation = options.backupLocation || config().BACKUP_LOCATION || path.join(__dirname, '../../backups');
    this.uploadsDir = options.uploadsDir || config().UPLOADS_DIR || path.join(__dirname, '../../uploads');
    this.tempDir = options.tempDir || config().BACKUP_TEMP_DIR || path.join(__dirname, '../../temp');
    this.migrationsDir = options.migrationsDir || path.join(process.cwd(), 'migrations');
    this.location = options.location || getDbLocation();
    this.maintenanceDatabase = options.maintenanceDatabase || config().DB_MAINTENANCE_NAME;
    this.ownerOverride = options.owner;
    this.servingOverride = options.serving;
    this.encryptionService = new EncryptionService();
  }

  /** The temp directory backups and restores work in. */
  getTempDir(): string {
    return this.tempDir;
  }

  /** Read when needed, not at construction: the secrets may not be there in a unit test. */
  private owner(): DbCredentials {
    return (this.ownerOverride ??= getOwnerCredentials());
  }

  private serving(): DbCredentials {
    return (this.servingOverride ??= {
      user: config().DB_USER,
      password: servingRolePassword(initializeSecrets()),
    });
  }

  /** A directory of our own under the temp dir: 0700, as it holds plaintext dumps. */
  private async makeWorkDir(name: string): Promise<string> {
    const dir = path.join(this.tempDir, name);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    return dir;
  }

  /** A connection to `database` as `credentials` (the owner unless said). */
  private async connect(database: string, credentials: DbCredentials = this.owner()): Promise<Client> {
    const client = new Client({
      host: this.location.host,
      port: this.location.port,
      database,
      user: credentials.user,
      password: credentials.password,
      application_name: BACKUP_APPLICATION_NAME,
      options: sessionOptions(),
    });
    // A connection the swap terminates must not become an uncaught 'error'.
    client.on('error', (error) => logger.warn({ err: error, database }, 'A backup/restore database connection failed'));
    await client.connect();
    return client;
  }

  private async withConnection<T>(database: string, work: (client: Client) => Promise<T>, credentials?: DbCredentials): Promise<T> {
    const client = await this.connect(database, credentials);
    try {
      return await work(client);
    } finally {
      await client.end().catch(() => {});
    }
  }

  // ── The old backup key (K) ───────────────────────────────────────────────────
  // Before backups were age, K was the key they were encrypted with: a random key, stored in
  // system_settings encrypted with the data encryption secret, which a deployment admin
  // downloads. It stays, only to open the .enc backups made with it, and to keep making
  // them on an upgraded install until a backup key (a recipient) is set up. Nothing new
  // makes one.
  private static readonly BACKUP_KEY_SETTING = 'backup_data_key';
  private static readonly BACKUP_KEY_DOWNLOADED_SETTING = 'backup_key_downloaded';

  /**
   * Its settings (system_settings: the schedule, the old key) and keys (backup_recipients)
   * on its own pool, never a request's transaction. Made on first use.
   */
  private settingsDb(): Kysely<DB> {
    this.settingsKysely ??= new Kysely<DB>({ dialect: new PostgresDialect({ pool: this.db }) });
    return this.settingsKysely;
  }

  /** The old backup key K (decrypted), or null if this server never had one. */
  private async getActiveBackupKey(): Promise<string | null> {
    await this.encryptionService.initialize();
    const stored = await readSystemSetting(BackupService.BACKUP_KEY_SETTING, this.settingsDb());
    if (!stored) return null;
    return this.encryptionService.decryptString(stored);
  }

  /** Store one backup setting (system_settings, category 'backup'): the schedule, or the key. */
  async saveBackupSetting(key: string, value: string): Promise<void> {
    await writeSystemSetting(key, value, { category: 'backup' }, this.settingsDb());
  }

  /** The values of the named system settings; a key that isn't set is left out. */
  async readSettings(keys: readonly string[]): Promise<Record<string, string | null>> {
    return (await readSystemSettings(keys, this.settingsDb())) as Record<string, string | null>;
  }

  /**
   * The backup settings the Backup page may change (`keys`, BACKUP_SETTING_KEYS), by key:
   * never the encrypted backup key or its download flag, which are settings of the same
   * category.
   */
  async readEditableSettings(keys: readonly string[]): Promise<SystemSettingRow[]> {
    return readSystemSettingsIn('backup', { keys }, this.settingsDb());
  }

  /** Whether the old backup key K exists and whether the user has downloaded it. */
  async getBackupKeyStatus(): Promise<{ exists: boolean; downloaded: boolean }> {
    const stored = await readSystemSettings(
      [BackupService.BACKUP_KEY_SETTING, BackupService.BACKUP_KEY_DOWNLOADED_SETTING],
      this.settingsDb()
    );
    return {
      exists: !!stored[BackupService.BACKUP_KEY_SETTING],
      downloaded: stored[BackupService.BACKUP_KEY_DOWNLOADED_SETTING] === 'true',
    };
  }

  /**
   * Return the old backup key K for the user to download, marking it as downloaded. Null if
   * this server never had one.
   */
  async getBackupKeyForDownload(): Promise<string | null> {
    const key = await this.getActiveBackupKey();
    if (!key) return null;
    await this.saveBackupSetting(BackupService.BACKUP_KEY_DOWNLOADED_SETTING, 'true');
    return key;
  }

  // ── Backup keys (recipients) ─────────────────────────────────────────────────
  // The owner's age public keys (backup_recipients, control plane). The server stores only
  // these: the private keys stay with the owner, and the server can't open its own backups.

  /** The backup keys, oldest first. */
  async listRecipients(): Promise<BackupRecipient[]> {
    const rows = await this.settingsDb()
      .selectFrom('backup_recipients as r')
      .leftJoin('users as u', 'u.id', 'r.created_by')
      .select(['r.uuid', 'r.recipient', 'r.label', 'r.checked_at', 'r.created_at', 'u.first_name', 'u.last_name', 'u.email'])
      .orderBy('r.created_at')
      .orderBy('r.id')
      .execute();
    return rows.map((row) => ({
      uuid: row.uuid,
      recipient: row.recipient,
      label: row.label,
      kind: recipientKind(row.recipient),
      hardware: isHardwareRecipient(row.recipient),
      fingerprint: recipientFingerprint(row.recipient),
      checkedAt: instant(row.checked_at),
      createdAt: instant(row.created_at) ?? '',
      createdBy: personName(row),
    }));
  }

  /**
   * Add a backup key: checked as age reads it (the message never repeats the key), at most
   * MAX_BACKUP_RECIPIENTS, all of one kind, none twice. `checked` when the browser made it, or
   * was shown the private key file and it matched. Under a table lock, so two adds can't
   * together pass the limit or mix the kinds.
   */
  async addRecipient(input: { recipient: string; label: string; checked: boolean; createdBy: number | null }): Promise<BackupRecipient> {
    const recipient = input.recipient.trim();
    let kind: RecipientKind;
    try {
      kind = checkRecipient(recipient);
    } catch (error) {
      throw invalidBackupKey(error instanceof RecipientProblem ? error.message : "That public key isn't valid.");
    }
    const uuid = await this.settingsDb()
      .transaction()
      .execute(async (trx) => {
        await sql`LOCK TABLE public.backup_recipients IN SHARE ROW EXCLUSIVE MODE`.execute(trx);
        const existing = await trx.selectFrom('backup_recipients').select(['recipient']).execute();
        if (existing.some((row) => row.recipient === recipient)) throw duplicateBackupKey();
        if (existing.length >= MAX_BACKUP_RECIPIENTS) throw tooManyBackupKeys(MAX_BACKUP_RECIPIENTS);
        const other = existing.find((row) => recipientKind(row.recipient) !== kind);
        if (other) throw backupKeyKindMismatch(recipientKind(other.recipient));
        const row = await trx
          .insertInto('backup_recipients')
          .values({
            recipient,
            label: input.label.trim(),
            kind,
            checked_at: input.checked ? new Date().toISOString() : null,
            created_by: input.createdBy,
          })
          .returning('uuid')
          .executeTakeFirstOrThrow();
        return row.uuid;
      });
    logger.info({ uuid, kind, fingerprint: recipientFingerprint(recipient), checked: input.checked }, 'Backup key added');
    const added = (await this.listRecipients()).find((r) => r.uuid === uuid);
    if (!added) throw backupKeyNotFound();
    return added;
  }

  /** Remove a backup key. Backups made to it still open with its private key. */
  async removeRecipient(uuid: string): Promise<void> {
    const removed = await this.settingsDb().deleteFrom('backup_recipients').where('uuid', '=', uuid).returning('recipient').executeTakeFirst();
    if (!removed) throw backupKeyNotFound();
    logger.info({ uuid, fingerprint: recipientFingerprint(removed.recipient) }, 'Backup key removed');
  }

  /** Mark a backup key checked: its private key file was shown to match it ("Check a key"). */
  async markRecipientChecked(uuid: string): Promise<BackupRecipient> {
    const updated = await this.settingsDb()
      .updateTable('backup_recipients')
      .set({ checked_at: new Date().toISOString() })
      .where('uuid', '=', uuid)
      .returning('uuid')
      .executeTakeFirst();
    if (!updated) throw backupKeyNotFound();
    const recipient = (await this.listRecipients()).find((r) => r.uuid === uuid);
    if (!recipient) throw backupKeyNotFound();
    return recipient;
  }

  /**
   * After the restore command's --decrypted verify opened a backup this server signed: when
   * it was made to one key only, and that is a hardware key, that key opened it, so it counts
   * as checked (the browser can't check one). With more keys the bundle doesn't say which
   * opened it, so nothing is marked. Returns the label marked, or null.
   */
  async markOnlyHardwareRecipientChecked(fingerprints: readonly string[]): Promise<string | null> {
    if (fingerprints.length !== 1) return null;
    const recipient = (await this.listRecipients()).find((r) => r.fingerprint === fingerprints[0]);
    if (!recipient?.hardware || recipient.checkedAt) return null;
    await this.markRecipientChecked(recipient.uuid);
    return recipient.label;
  }

  /**
   * This server's signer, as `ed25519:…`: the Backup page shows it, and the restore
   * command's --signer takes one. Null without a data encryption key.
   */
  async signerPublicId(): Promise<string | null> {
    try {
      return signerId((await this.encryptionService.getBackupSigner()).publicKey);
    } catch {
      return null;
    }
  }

  /**
   * How backups are encrypted now: to the backup keys (age); with the old key K, an upgraded
   * install's until it has a backup key; or not at all.
   */
  async encryptionState(): Promise<{ recipients: number; legacyKey: boolean; mode: 'age' | 'legacy' | 'none' }> {
    const [recipients, legacy] = await Promise.all([
      this.settingsDb().selectFrom('backup_recipients').select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      this.getBackupKeyStatus(),
    ]);
    const count = Number(recipients.n);
    return { recipients: count, legacyKey: legacy.exists, mode: count > 0 ? 'age' : legacy.exists ? 'legacy' : 'none' };
  }

  /**
   * Create a complete backup
   * Will fail if Docker secret is not available
   *
   * One at a time: refused with BackupInProgressError while this process (a manual or a
   * scheduled backup, or a restore) or another server sharing the database is making one.
   * Two that ran together could share a temp directory, and one's cleanup deleted the
   * other's dump.
   */
  async createBackup(): Promise<CreatedBackup> {
    // Claimed before the first await, so two calls in this process can't both get past it.
    // Refused (ShuttingDownError) once a shutdown has begun.
    const { release } = claimOperation('backup', this.location.database);
    try {
      return await this.withBackupLock(() => this.createBackupLocked());
    } finally {
      release();
    }
  }

  /**
   * Run `work` holding BACKUP_LOCK_KEY on a connection of its own, or refuse with
   * BackupInProgressError when another server holds it. A connection that can't unlock is
   * closed instead of returned to the pool: ending its session drops the lock.
   */
  private async withBackupLock<T>(work: () => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    // A checked-out client has no 'error' listener (pg-pool only listens while it is idle),
    // and an 'error' with none is an uncaught exception, which shuts the server down. So a
    // session killed mid-backup (pg_terminate_backend, a Postgres restart or failover) took
    // the backend with it. Now it only loses the lock; the backup itself carries on.
    let lockLost: Error | undefined;
    const onError = (error: Error) => {
      lockLost = error;
      logger.error({ err: error }, 'Lost the backup lock connection — the backup carries on without the lock');
    };
    client.on('error', onError);
    let closeConnection = false;
    try {
      let locked: boolean;
      try {
        const { rows } = await client.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1) AS locked',
          [BackupService.BACKUP_LOCK_KEY]
        );
        locked = rows[0]?.locked === true;
      } catch (error) {
        closeConnection = true;
        throw error;
      }
      if (!locked) {
        // Another process: another server, or the restore command (its --verify among them).
        throw new BackupInProgressError('A backup or restore is already in progress on another server', 'elsewhere');
      }

      try {
        return await work();
      } finally {
        if (!lockLost) {
          try {
            await client.query('SELECT pg_advisory_unlock($1)', [BackupService.BACKUP_LOCK_KEY]);
          } catch (error) {
            closeConnection = true;
            logger.warn({ err: error }, 'Could not release the backup lock; closing its connection instead');
          }
        }
      }
    } finally {
      if (lockLost || closeConnection) {
        // Discarded, not pooled. The listener stays: a broken client can still emit.
        client.release(lockLost ?? true);
      } else {
        client.off('error', onError);
        client.release();
      }
    }
  }

  private async createBackupLocked(): Promise<CreatedBackup> {
    // This will throw an error if Docker secret is missing
    await this.encryptionService.initialize();

    // No key, no backup: refuse before doing any work without a backup key, so no backup is
    // ever encrypted with anything but a key the owner holds.
    const recipients = (await this.listRecipients()).map((r) => r.recipient);
    if (recipients.length === 0) {
      // The upgrade window: an install that had the old key keeps making .enc backups with it
      // until a backup key is set up, so the upgrade leaves no gap.
      if (await this.getActiveBackupKey()) {
        logger.warn('Backups still use the old backup key: set up a backup key in Settings → Database Backup');
        return this.createLegacyBackup();
      }
      throw new BackupKeyMissingError();
    }
    try {
      assertRecipientsCompatible(recipients);
    } catch (error) {
      throw new BackupKeysUnusableError(error instanceof RecipientProblem ? error.message : 'one of them is not a valid key.');
    }

    // An upload that changes while it is read fails that attempt: a signed bundle whose
    // member is cut short couldn't be parsed. The next attempt reads them again.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.createAgeBackup(recipients);
      } catch (error) {
        if (!(error instanceof UploadChangedError) || attempt >= UPLOAD_CHANGED_ATTEMPTS) throw error;
        logger.warn({ attempt, member: error.member }, 'An upload changed while the backup read it; making the backup again');
      }
    }
  }

  /** A new backup id: to the millisecond, so two backups in a second don't share a name. */
  private newBackupId(): string {
    const now = new Date();
    return `nuggets_backup_${this.formatDate(now)}_${String(now.getUTCMilliseconds()).padStart(3, '0')}`;
  }

  /**
   * An age backup: the dump, then in one pass the bundle (signed as it is written), encrypted
   * to `recipients`, into `<id>.tar.age.partial` in the backup directory, flushed, then
   * renamed. No plaintext copy of the bundle is written. The server can't open what it wrote,
   * so it checks what it can: a stanza per recipient, and the file on disk is what it wrote.
   */
  private async createAgeBackup(recipients: string[]): Promise<CreatedBackup> {
    const backupId = this.newBackupId();
    const createdAt = backupTimeFromFileName(`${backupId}.tar.age`) ?? new Date();
    const fileName = `${backupId}.tar.age`;
    const finalPath = path.join(this.backupLocation, fileName);
    const partialPath = `${finalPath}.partial`;
    let tempDir: string | null = null;
    let partialWritten = false;
    try {
      tempDir = await this.makeWorkDir(backupId);
      logger.info({ backupId }, 'Creating database dump');
      const dumpFile = await this.createDatabaseDump(tempDir, backupId);

      await fs.mkdir(this.backupLocation, { recursive: true });
      const signer = await this.encryptionService.getBackupSigner();
      logger.info({ backupId, recipients: recipients.length }, 'Writing the encrypted backup');
      partialWritten = true;
      const written = await encryptToRecipients(
        bundleChunks({
          dumpFile,
          uploadsDir: this.uploadsDir,
          manifest: {
            backupId,
            createdAt: createdAt.toISOString(),
            appVersion: appVersion(),
            schemaVersion: await this.readSchemaVersion(),
            recipients: recipients.map(recipientFingerprint),
          },
          signer,
          onUploadsListed: ({ files, bytes, skipped }) => {
            if (skipped > 0) logger.warn({ skipped }, 'Uploads that are not regular files (links, devices) or have names a backup refuses were left out');
            if (files === 0) logger.warn({ uploadsDir: this.uploadsDir }, 'No upload files: the backup holds the database only');
            else logger.info({ files, bytes }, 'Backing up the upload files');
          },
        }),
        recipients,
        partialPath
      );

      // What the server can check of a file it can't open.
      const stanzas = countStanzas(await readAgeHeader(partialPath));
      if (stanzas !== recipients.length) throw new Error(`The backup's header has ${stanzas} key stanzas, not ${recipients.length}`);
      const onDisk = await hashFile(partialPath);
      if (onDisk.sha256 !== written.sha256 || onDisk.size !== written.size) throw new Error('The backup file on disk is not what was written');

      await publishFile(partialPath, finalPath);
      partialWritten = false;
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = null;
      logger.info({ fileName, sizeMB: (written.size / 1024 / 1024).toFixed(2), sha256: written.sha256 }, 'Backup created successfully');
      return { filePath: finalPath, fileName, fileSize: written.size, sha256: written.sha256 };
    } catch (error) {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      if (partialWritten) await fs.rm(partialPath, { force: true }).catch(() => {});
      if (error instanceof UploadChangedError) throw error;
      throw new Error(`Backup creation failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  /** An .enc backup with the old key K: the format before age, for the upgrade window only. */
  private async createLegacyBackup(): Promise<CreatedBackup> {
    const backupId = this.newBackupId();
    let tempDir: string | null = null;

    try {
      tempDir = await this.makeWorkDir(backupId);

      logger.info({ backupId }, 'Creating database dump');
      const dumpFile = await this.createDatabaseDump(tempDir, backupId);

      // The version manifest (lets restore check compatibility before touching the database).
      const manifestFile = await this.writeManifest(tempDir);

      logger.info({ backupId }, 'Creating archive with uploads');
      const archiveFile = await this.createArchiveWithUploads(tempDir, backupId, dumpFile, manifestFile);

      logger.info({ backupId }, 'Encrypting backup with the old backup key');
      const encryptedFile = await this.encryptBackup(archiveFile);

      const finalPath = await this.moveToBackupLocation(encryptedFile, backupId);
      await fs.rm(tempDir, { recursive: true, force: true });
      const stats = await fs.stat(finalPath);
      logger.info({ fileName: path.basename(finalPath), sizeMB: (stats.size / 1024 / 1024).toFixed(2) }, 'Backup created successfully');
      return { filePath: finalPath, fileName: path.basename(finalPath), fileSize: stats.size, sha256: null };
    } catch (error) {
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Backup creation failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  /**
   * Create a PostgreSQL dump of the app's database (DB_NAME), as the schema owner.
   */
  private async createDatabaseDump(tempDir: string, backupId: string): Promise<string> {
    const dumpFile = path.join(tempDir, `${backupId}.dump`);
    const owner = this.owner();
    logger.info({ dbHost: this.location.host, dbPort: this.location.port, database: this.location.database }, 'Creating database dump using pg_dump');

    const result = await runPgTool('pg_dump', [
      '-h', this.location.host,
      '-p', String(this.location.port),
      '-U', owner.user,
      '-d', this.location.database,
      // Ownership is stripped (--no-owner) for portability across installs. GRANTs stay in
      // the dump, though a restore re-applies the serving role's from the code instead.
      '--no-owner',
      '--no-password',
      '--format=custom',
      '--compress=9',
      '--exclude-schema=information_schema',
      '--exclude-schema=pg_catalog',
      // pg-boss builds its own schema at runtime and holds only ephemeral job
      // -queue state; excluding it keeps backups portable across versions
      // (and unblocks restore onto installs that never create that schema).
      '--exclude-schema=pgboss',
      '--file', dumpFile,
    ], owner.password);
    if (result.code !== 0) {
      logger.error({ errorOutput: result.stderr, code: result.code, signal: result.signal }, 'pg_dump failed');
      throw new Error(`pg_dump failed with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}: ${result.stderr}`);
    }
    return dumpFile;
  }

  /** The newest applied migration (schema_migrations, which isn't tenant-scoped), or null. */
  private async readSchemaVersion(): Promise<string | null> {
    try {
      const result = await this.db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
      return result.rows[0]?.version ?? null;
    } catch (error) {
      logger.warn({ err: error }, 'Could not read schema_migrations version for backup manifest');
      return null;
    }
  }

  /**
   * Write the backup manifest (manifest.json) into the temp dir.
   *
   * The manifest records the schema version (max applied migration) so a restore
   * can refuse an incompatible (newer) backup before mutating the database, and
   * decide whether to run migrations afterward to reconcile an older backup.
   */
  private async writeManifest(tempDir: string): Promise<string> {
    const manifestPath = path.join(tempDir, 'manifest.json');

    const schemaVersion = await this.readSchemaVersion();
    const manifest: BackupManifest = {
      manifestVersion: 1,
      appVersion: appVersion(),
      schemaVersion,
      createdAt: new Date().toISOString(),
    };

    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    logger.info({ schemaVersion }, 'Backup manifest written');
    return manifestPath;
  }

  /**
   * The latest schema version this running code ships: the newest migration file baked into
   * the image (its 14-digit prefix, as MigrationService reads them), else the baseline's.
   */
  private getCodeSchemaVersion(): string {
    const migrationsDir = this.migrationsDir;
    let versions: string[] = [];
    try {
      if (existsSync(migrationsDir)) {
        versions = readdirSync(migrationsDir)
          .filter(f => /^\d{14}_.*\.sql$/.test(f))
          .map(f => f.substring(0, 14));
      }
    } catch (error) {
      logger.warn({ err: error }, 'Could not read the migration files; comparing the backup with the baseline');
    }
    return [BASELINE.version, ...versions].sort().at(-1)!;
  }

  /**
   * Verify a backup can be restored onto this application BEFORE mutating the DB. The
   * migrate after the restore brings its schema to this code's, from the baseline or from
   * v2.4.0's (the cutover), and from nothing older: the migrations before the baseline
   * aren't shipped any more. So it refuses
   * - a backup whose schema is NEWER than this code (an unsupported downgrade);
   * - one older than v2.4.0's, and one whose manifest doesn't say (made before backups
   *   recorded it): restored on v2.4.0 first, it is upgraded from there.
   */
  private assertRestorable(manifest: BackupManifest | null): void {
    const restoreOnV240 =
      'Restore it on Nuggets v2.4.0 (which migrates it to v2.4.0\'s schema), then upgrade to this release, ' +
      'or restore a backup made on v2.4.0 or later.';
    if (!manifest || !manifest.schemaVersion) {
      throw new RestoreRefusedError(
        "This backup doesn't record its schema version (it was made before backups did), so it can't be upgraded " +
        `here: this release upgrades a database from v2.4.0 (schema ${V2_4_0_NEWEST_VERSION}) or newer only. ${restoreOnV240}`
      );
    }

    const codeVersion = this.getCodeSchemaVersion();
    if (manifest.schemaVersion > codeVersion) {
      throw new RestoreRefusedError(
        `Backup schema version ${manifest.schemaVersion} is NEWER than this application's latest ` +
        `migration ${codeVersion}. Restoring would downgrade the schema, which is not supported. ` +
        `Upgrade the application to at least the backup's version, then restore.`
      );
    }

    if (manifest.schemaVersion < BASELINE.version && manifest.schemaVersion !== V2_4_0_NEWEST_VERSION) {
      throw new RestoreRefusedError(
        `Backup schema version ${manifest.schemaVersion} is neither v2.4.0's (${V2_4_0_NEWEST_VERSION}) nor this release's ` +
        `baseline (${BASELINE.version}) or newer, and this release upgrades a database from v2.4.0 or newer only: the ` +
        `migrations before its baseline aren't part of it any more. ${restoreOnV240}`
      );
    }

    if (manifest.schemaVersion === V2_4_0_NEWEST_VERSION) {
      logger.info(
        { backupVersion: manifest.schemaVersion, codeVersion },
        'Backup is from v2.4.0; the migrate after the restore cuts it over to the baseline'
      );
    } else if (manifest.schemaVersion < codeVersion) {
      logger.info(
        { backupVersion: manifest.schemaVersion, codeVersion },
        'Backup is from an older schema version; migrations will run after restore to reconcile'
      );
    } else {
      logger.info({ version: codeVersion }, 'Backup schema version matches this application');
    }
  }

  /** Recursively count files and total bytes under a directory (for backup logging). */
  private countFiles(dir: string): { files: number; bytes: number } {
    let files = 0;
    let bytes = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const sub = this.countFiles(full);
        files += sub.files;
        bytes += sub.bytes;
      } else if (entry.isFile()) {
        files++;
        try { bytes += statSync(full).size; } catch { /* ignore unreadable entry */ }
      }
    }
    return { files, bytes };
  }

  /**
   * Create ZIP archive with database dump, manifest, and uploads
   */
  private async createArchiveWithUploads(tempDir: string, backupId: string, dumpFile: string, manifestFile: string): Promise<string> {
    const archiveFile = path.join(tempDir, `${backupId}.zip`);

    return new Promise((resolve, reject) => {
      const output = createWriteStream(archiveFile, { mode: 0o600 });
      const archive = new ZipArchive({ zlib: { level: 9 } });

      output.on('close', () => {
        resolve(archiveFile);
      });

      archive.on('error', (error) => {
        reject(error);
      });

      archive.pipe(output);

      // Add PostgreSQL custom dump to archive
      archive.file(dumpFile, { name: path.basename(dumpFile) });

      // Add the version manifest
      archive.file(manifestFile, { name: 'manifest.json' });

      // Add uploads directory (bulk files that stay on the filesystem — e.g. PDF
      // documents; small images now live in the DB). Count + log what's archived
      // so a backup that silently captured zero files is visible, not a surprise
      // at restore time.
      try {
        if (existsSync(this.uploadsDir)) {
          const { files, bytes } = this.countFiles(this.uploadsDir);
          if (files === 0) {
            logger.warn({ uploadsDir: this.uploadsDir }, 'Uploads directory is empty; backup will contain no upload files');
          } else {
            logger.info({ uploadsDir: this.uploadsDir, files, bytes }, 'Archiving uploads directory');
          }
          archive.directory(this.uploadsDir, 'uploads');
        } else {
          logger.warn({ uploadsDir: this.uploadsDir }, 'Uploads directory does not exist; backup will contain no upload files');
        }
      } catch (error) {
        logger.warn({ err: error }, 'Could not add uploads to backup');
      }

      void archive.finalize();
    });
  }

  /**
   * Encrypt backup file with the generated backup key (K) — deliberately SEPARATE
   * from the Docker secret — and sign it with this server's signing key. There is
   * NO fallback: if no key has been generated, backups are refused (no key, no backup) so
   * every backup file is encrypted with a known, user-held key. Streams: memory use doesn't
   * grow with the backup.
   */
  private async encryptBackup(archiveFile: string): Promise<string> {
    const encryptedFile = archiveFile.replace(/\.zip$/, '.enc');

    const backupKey = await this.getActiveBackupKey();
    if (!backupKey) {
      throw new BackupKeyMissingError();
    }
    await encryptBackupFile(archiveFile, encryptedFile, backupKey, await this.encryptionService.getBackupSigningKey());

    // Remove unencrypted file
    await fs.unlink(archiveFile);

    return encryptedFile;
  }

  /**
   * Move backup to final location (handles cross-device moves)
   */
  private async moveToBackupLocation(encryptedFile: string, backupId: string): Promise<string> {
    const finalPath = path.join(this.backupLocation, `${backupId}.enc`);
    // Made here, when a backup needs it, and waited for: the constructor used to start it
    // without waiting, and a failure only logged.
    await fs.mkdir(this.backupLocation, { recursive: true });

    try {
      // Try rename first (faster if on same filesystem)
      await fs.rename(encryptedFile, finalPath);
    } catch (error) {
      // If rename fails (cross-device), use copy + delete
      if (errorCode(error) === 'EXDEV') {
        logger.info('Cross-device move detected, using copy method');
        await fs.copyFile(encryptedFile, finalPath);
        await fs.unlink(encryptedFile);
      } else {
        throw error;
      }
    }

    return finalPath;
  }

  /**
   * Read the manifest.json from an extracted backup, or null for older backups
   * that predate the manifest (a missing manifest is not an error).
   */
  private async readManifest(extractDir: string): Promise<BackupManifest | null> {
    const manifestPath = path.join(extractDir, 'manifest.json');
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return JSON.parse(raw) as BackupManifest;
    } catch {
      return null;
    }
  }

  // ── Restore ──────────────────────────────────────────────────────────────────

  /** Restore with this server's backup key (only a backup this server signed). */
  async restoreBackup(backupFilePath: string, options: Omit<RestoreOptions, 'key'> = {}): Promise<RestoreResult> {
    return this.restoreFromFile(backupFilePath, { ...options, key: null });
  }

  /** Restore with the key the user typed. */
  async restoreBackupWithCustomKey(backupFilePath: string, customKey: string, options: Omit<RestoreOptions, 'key'> = {}): Promise<RestoreResult> {
    if (!customKey) {
      throw new Error('Custom encryption key is required for restore operation');
    }
    return this.restoreFromFile(backupFilePath, { ...options, key: customKey });
  }

  /**
   * Restore a backup file over the app's database and uploads.
   *
   * Nothing the app serves changes until every step has succeeded: the backup is restored
   * into a scratch database by a role that can't escape the database (RESTORE_ROLE),
   * migrated forward, given the serving role's grants, and checked — the same row-level
   * security as this server's database has, and the serving-role check — and only
   * then swapped in, by renaming the two databases in one transaction. The replaced
   * database is kept as `<db>_before_restore`, and the replaced upload files under the temp
   * directory, until the next restore. If the uploads can't be put in place the swap is
   * undone. One at a time: refused while a backup or another restore runs, here or (by
   * the advisory lock) in another process.
   *
   * Throws RestoreFailedError; its `databaseChanged` is true only if the data was replaced
   * and couldn't be put back.
   *
   * A shutdown (refuseNewOperations) stops it at its next step until the swap begins (and
   * interruptRestore stops what it is waiting on): it drops the scratch database and fails
   * with a ShuttingDownError as its cause, the data unchanged. From the swap on it finishes.
   */
  async restoreFromFile(backupFilePath: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    // A restore accepted (restoreJob) just before the shutdown began: it never started.
    stopIfShuttingDown();
    // A verify is an operation of its own: it stops no scheduler and puts nothing in
    // maintenance mode, since the data stays as it is.
    const { operation, release } = claimOperation(options.verifyOnly ? 'verify' : 'restore', this.location.database);
    try {
      return await this.restoreClaimed(backupFilePath, options, operation);
    } finally {
      release();
    }
  }

  private async restoreClaimed(backupFilePath: string, options: RestoreOptions, operation: Operation): Promise<RestoreResult> {
    const now = new Date();
    const restoreId = `restore_${this.formatDate(now)}_${String(now.getMilliseconds()).padStart(3, '0')}`;
    const live = this.location.database;
    const scratch = databaseName(live, `_restore_${this.formatDate(now).replace('_', '')}${String(now.getMilliseconds()).padStart(3, '0')}`);
    const phase = (p: RestorePhase) => {
      // Each step before the swap starts only while no shutdown has begun.
      if (!operation.replacingData) stopIfShuttingDown();
      logger.info({ restoreId, phase: p }, 'Restore: ' + p);
      options.onPhase?.(p);
    };
    // What a shutdown ends (with its pg_restore, which interruptRestore stops): the work on
    // the scratch database — the migrations, the grants, the checks.
    operation.interrupt = () =>
      this.withConnection(this.maintenanceDatabase, async (client) => {
        await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [scratch]);
      });

    let tempDir: string | null = null;
    let lock: Client | null = null;
    let scratchCreated = false;
    let swapped = false;

    try {
      await assertBackupFileExists(backupFilePath);
      tempDir = await this.makeWorkDir(restoreId);

      // The lock backups take, so neither runs during the other here or in another process.
      lock = await this.connect(live);
      const { rows } = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [BackupService.BACKUP_LOCK_KEY]);
      if (rows[0]?.locked !== true) {
        throw new BackupInProgressError('A backup or restore is already in progress (on another server, or in the restore command)', 'elsewhere');
      }

      const extractDir = path.join(tempDir, 'extracted');
      const opened = await this.openBackup(backupFilePath, tempDir, extractDir, options, phase, restoreId);
      const { manifest, signature, signer, format, dumpFile } = opened;
      // Refuses a backup newer than this code before anything is created.
      this.assertRestorable(manifest);
      await this.assertArchiveContents(dumpFile);

      phase('restoring');
      // RESTORE_ROLE belongs to the whole cluster: one restore at a time uses it, whatever
      // the database (advisory locks are per database, so this one is on the maintenance one).
      const roleLock = await this.connect(this.maintenanceDatabase);
      try {
        await roleLock.query('SELECT pg_advisory_lock($1)', [RESTORE_ROLE_LOCK_KEY]);
        const rolePassword = await this.prepareRestoreRole();
        try {
          await this.createScratchDatabase(scratch);
          scratchCreated = true;
          // Checked as pg_restore starts (no await between): one started before a shutdown
          // began is stopped by interruptRestore.
          stopIfShuttingDown();
          await this.pgRestoreAsRestoreRole(scratch, dumpFile, rolePassword);
        } finally {
          await this.closeRestoreRole();
        }
      } finally {
        await roleLock.end().catch(() => {});
      }
      await this.handOverToOwner(scratch);

      phase('migrating');
      const cutover = await this.migrateDatabase(scratch);
      await this.reapplyServingRoleGrants(scratch);
      await this.copyDatabaseSettings(live, scratch);

      phase('verifying');
      await this.assertIsolationMatches(live, scratch);
      // The serving role check against the restored data, before it is served: e.g. a second tenant under
      // ALLOW_RLS_BYPASS_ROLE is refused here, with nothing replaced.
      await this.withConnection(scratch, (client) => assertServingRoleEnforcesRls(client), this.serving());
      const rowCounts = await this.countRows(scratch);

      if (options.verifyOnly) {
        await this.dropDatabase(scratch);
        return { manifest, format, signature, signer, rowCounts, previousDatabase: null, previousUploads: null, uploadedFilesRestored: 0, cutover };
      }

      await options.beforeSwap?.();

      // The last check. From here the data is being replaced: a shutdown that begins now
      // waits for the swap (and the uploads, and a swap back) to finish, since stopping it
      // part way can leave the database refusing connections.
      stopIfShuttingDown();
      operation.replacingData = true;
      phase('swapping');
      // The lock's connection is to the database being renamed, which takes none.
      await lock.end().catch(() => {});
      lock = null;
      const previousDatabase = databaseName(live, '_before_restore');
      await this.swapDatabases(live, scratch, previousDatabase);
      swapped = true;
      scratchCreated = false;

      phase('restoring-uploads');
      let uploads: { previous: string; restored: number };
      try {
        uploads = await this.replaceUploads(path.join(extractDir, 'uploads'));
      } catch (uploadError) {
        logger.error({ err: uploadError, restoreId }, 'Restoring the uploads failed; putting the database back');
        try {
          await this.swapDatabases(live, previousDatabase, scratch);
          swapped = false;
          scratchCreated = true;
        } catch (swapBackError) {
          logger.fatal({ err: swapBackError, restoreId, previousDatabase }, 'Could not put the database back after the uploads failed');
          throw new Error(
            `Restoring the uploads failed (${errorMessage(uploadError)}), and putting the previous database back failed too ` +
              `(${errorMessage(swapBackError)}): the data is the backup's, without its upload files. The previous data is in database ${previousDatabase}.`,
            { cause: swapBackError }
          );
        }
        throw new Error(`Restoring the uploads failed, so the database was put back as it was: ${errorMessage(uploadError)}`, { cause: uploadError });
      }

      logger.info({ restoreId, previousDatabase, previousUploads: uploads.previous, rowCounts }, 'Restore completed successfully');
      return {
        manifest,
        format,
        signature,
        signer,
        rowCounts,
        previousDatabase,
        previousUploads: uploads.previous,
        uploadedFilesRestored: uploads.restored,
        cutover,
      };
    } catch (error) {
      if (scratchCreated) {
        await this.dropDatabase(scratch).catch((dropError) =>
          logger.warn({ err: dropError, scratch }, 'Could not drop the scratch database of a failed restore')
        );
      }
      if (error instanceof BackupInProgressError) throw error;
      // What interruptRestore ended (a pg_restore killed, a query terminated) fails as itself:
      // say it was the shutdown, unless the restore was refused for a reason of its own.
      let cause = error;
      if (!swapped && operation.interrupted && !(error instanceof ControlPlaneError)) {
        cause = Object.assign(new ShuttingDownError(RESTORE_STOPPED_BY_SHUTDOWN), { cause: error });
      }
      throw new RestoreFailedError(`Restore failed: ${errorMessage(cause)}`, swapped, { cause });
    } finally {
      if (lock) await lock.end().catch(() => {});
      if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * Open a backup for a restore or a verify, by its format (its first bytes, never its name):
   * decrypt it, check that this server signed it (or that it may restore it anyway), and
   * extract it into `extractDir`. Nothing is parsed before the signature is checked.
   *
   * - age: decrypted with the file key (the web app) or the private keys (the restore
   *   command) into one scratch file, hashed as it goes; its tail is checked byte for byte,
   *   then the signature, then the tar is parsed, its members checked against the signed
   *   manifest. A file named as a backup must be the backup its signed manifest names.
   * - a bundle the owner decrypted (the restore command's --decrypted): the same, from the
   *   hashing on.
   * - .enc (the format before): decrypted with the old key, the signature checked, then the zip
   *   extracted, as before.
   */
  private async openBackup(
    file: string,
    tempDir: string,
    extractDir: string,
    options: RestoreOptions,
    phase: (p: RestorePhase) => void,
    restoreId: string
  ): Promise<{ manifest: BackupManifest | null; signature: BackupSignature; signer: string | null; format: 'age' | 'legacy'; dumpFile: string }> {
    const detected = await detectBackupFormat(file);
    phase('decrypting');

    if (detected === 'legacy' && !options.decrypted) {
      const zipFile = path.join(tempDir, 'backup.zip');
      const signature = await this.decryptForRestore(file, zipFile, options.key ?? null);
      if (signature !== 'valid') {
        if (!options.allowForeign) throw new ForeignBackupError(signature);
        logger.warn({ restoreId, signature }, 'Restoring a backup this server did not sign (--allow-foreign)');
      }
      phase('checking');
      await safeExtractZip(zipFile, extractDir);
      await fs.rm(zipFile, { force: true });
      const dumpName = (await fs.readdir(extractDir)).find((f) => f.endsWith('.dump'));
      if (!dumpName) throw new RestoreRefusedError('This backup has no database dump in it');
      return { manifest: await this.readManifest(extractDir), signature, signer: null, format: 'legacy', dumpFile: path.join(extractDir, dumpName) };
    }

    let bundle: { digest: Buffer; tail: Buffer; size: number };
    let tarFile: string;
    if (options.decrypted) {
      if (detected !== 'tar') {
        throw new RestoreRefusedError(
          detected === 'age' || detected === 'legacy'
            ? 'This backup is still encrypted: --decrypted takes the tar that age -d makes of it'
            : "This file isn't a decrypted Nuggets backup (a tar)",
          undefined,
          'NOT_A_BACKUP'
        );
      }
      // Copied into the scratch directory as it is hashed: what is checked is what is parsed,
      // even if the owner's file changes meanwhile.
      tarFile = path.join(tempDir, 'backup.tar');
      bundle = await copyAndHashBundle(file, tarFile);
    } else if (detected === 'age') {
      const key: BundleKey | null = options.fileKey
        ? { fileKey: options.fileKey }
        : options.identities?.length
          ? { identities: options.identities }
          : null;
      if (!key) {
        throw new RestoreRefusedError(
          'This backup is encrypted with age: it opens with the private key of one of the backup keys it was made for. Choose your key file.',
          undefined,
          'BACKUP_KEY_REQUIRED'
        );
      }
      tarFile = path.join(tempDir, 'backup.tar');
      try {
        bundle = await decryptBundle(file, key, tarFile);
      } catch (error) {
        if (error instanceof BackupWrongKeyError) throw new RestoreRefusedError(error.message, undefined, 'WRONG_BACKUP_KEY');
        if (error instanceof BackupBundleError) throw new RestoreRefusedError(error.message, undefined, 'BACKUP_DAMAGED');
        throw error;
      }
    } else {
      throw new RestoreRefusedError("This isn't a Nuggets backup file, or it was made by a newer version of Nuggets", undefined, 'NOT_A_BACKUP');
    }

    phase('checking');
    const own = await this.encryptionService.getBackupSigner().catch(() => null);
    const trusted = [...(own ? [own.publicKey] : []), ...(options.signers ?? [])];
    let checked: { signature: BackupSignature; signer: string };
    try {
      checked = checkSignedTail(bundle, trusted);
    } catch (error) {
      if (error instanceof BackupBundleError) throw new RestoreRefusedError(error.message, undefined, 'BACKUP_DAMAGED');
      throw error;
    }
    if (checked.signature !== 'valid') {
      // A trusted signer whose signature doesn't check out: the file was changed, not made
      // elsewhere, so the message doesn't name a signer to trust.
      const trustedSigner = trusted.some((key) => signerId(key) === checked.signer);
      if (!options.allowForeign) throw new ForeignBackupError(checked.signature, trustedSigner ? null : checked.signer);
      logger.warn({ restoreId, signature: checked.signature, signer: checked.signer }, 'Restoring a backup this server did not sign (--allow-foreign)');
    }

    let bundleManifest;
    try {
      bundleManifest = await extractBundle(tarFile, bundle.size - SIGNED_TAIL_BYTES, extractDir);
    } catch (error) {
      if (error instanceof BackupBundleError) throw new RestoreRefusedError(error.message, undefined, 'BACKUP_DAMAGED');
      throw error;
    } finally {
      await fs.rm(tarFile, { force: true });
    }

    // An older backup renamed as a newer one, say, is refused: the id is signed, the name isn't.
    // Any name in a backup's form says when it was made (the list dates it by that), with or
    // without the milliseconds: it must say the signed id's time.
    const name = options.fileName !== undefined && options.fileName !== null ? path.basename(options.fileName) : null;
    const named = name ? claimedBackupStamp(name) : null;
    const signed = backupStampOfFileName(`${bundleManifest.backupId}.tar.age`);
    if (named && (!signed || named.stamp !== signed.stamp || (named.millis !== null && named.millis !== signed.millis))) {
      throw new RestoreRefusedError(
        `This file is named as backup ${name?.replace(/\.(?:enc|tar\.age)$/, '')}, but it is backup ${bundleManifest.backupId} ` +
          `(made ${bundleManifest.createdAt}): it was renamed. Restore it under its own name if it is the one you meant.`,
        undefined,
        'BACKUP_RENAMED'
      );
    }
    const manifest: BackupManifest = {
      manifestVersion: bundleManifest.manifestVersion,
      appVersion: bundleManifest.appVersion,
      schemaVersion: bundleManifest.schemaVersion,
      createdAt: bundleManifest.createdAt,
      backupId: bundleManifest.backupId,
      recipients: bundleManifest.recipients,
    };
    return { manifest, signature: checked.signature, signer: checked.signer, format: 'age', dumpFile: path.join(extractDir, 'database.dump') };
  }

  /**
   * Decrypt `file` into `zipFile`: with the typed key, else this server's backup key, else
   * (a backup from before backup keys) the Docker-secret key. Returns the signature status.
   */
  private async decryptForRestore(file: string, zipFile: string, key: string | null): Promise<BackupSignature> {
    // The restore command may run where there is no data encryption secret: then a
    // signature can't be checked, and only --allow-foreign restores.
    const signingKey = await this.encryptionService.getBackupSigningKey().catch(() => null);
    if (key) return (await decryptBackupFile(file, zipFile, key, signingKey)).signature;

    let ownKeyError: unknown;
    try {
      // Reading the stored key fails too if it can't be decrypted (the Docker secret changed).
      const ownKey = await this.getActiveBackupKey();
      if (ownKey) return (await decryptBackupFile(file, zipFile, ownKey, signingKey)).signature;
      ownKeyError = new Error('No backup key has been generated on this server');
    } catch (error) {
      ownKeyError = error;
    }
    // A backup from before backup keys existed is encrypted with the Docker secret.
    try {
      await this.encryptionService.decryptFile(file, zipFile);
      return 'unsigned';
    } catch {
      throw new RestoreRefusedError("This server's backup key can't open this backup. Enter the key it was made with.", { cause: ownKeyError });
    }
  }

  /** Refuse an archive with anything a Nuggets dump doesn't have (`pg_restore -l`). */
  private async assertArchiveContents(dumpFile: string): Promise<void> {
    const listing = await runPgTool('pg_restore', ['--list', dumpFile], '');
    if (listing.code !== 0) throw new Error(`The backup's database dump can't be read: ${listing.stderr.trim()}`);
    const refused = parseTocListing(listing.stdout).filter(
      (entry) => !ALLOWED_TOC_TYPES.includes(entry.type) || !['public', '-'].includes(entry.schema)
    );
    if (refused.length > 0) {
      throw new RestoreRefusedError(
        `The backup holds database objects a Nuggets backup doesn't (${refused.length}): ` +
          refused.slice(0, 5).map((e) => e.line.replace(/^\d+;\s+\d+\s+\d+\s+/, '')).join('; ')
      );
    }
  }

  /**
   * Make RESTORE_ROLE as unprivileged as it should be, and let it log in with a new random
   * password for this restore. Returns the password.
   */
  private async prepareRestoreRole(): Promise<string> {
    const password = crypto.randomBytes(32).toString('base64url');
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const role = escapeIdentifier(RESTORE_ROLE);
    await this.withConnection(this.maintenanceDatabase, async (client) => {
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [RESTORE_ROLE]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(
        `ALTER ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT ` +
          `LOGIN PASSWORD ${escapeLiteral(scramVerifier(password))} VALID UNTIL ${escapeLiteral(validUntil)}`
      );
      const memberships = await client.query<{ role: string }>(
        'SELECT m.roleid::regrole::text AS role FROM pg_auth_members m WHERE m.member = $1::regrole',
        [RESTORE_ROLE]
      );
      if (memberships.rows.length > 0) {
        throw new Error(
          `The restore role ${RESTORE_ROLE} has been made a member of ${memberships.rows.map((r) => r.role).join(', ')}; ` +
            'a restore runs it with no privileges beyond its own database. Revoke the membership (REVOKE … FROM nuggets_restore).'
        );
      }
    });
    return password;
  }

  /** RESTORE_ROLE can't log in again, and its sessions end. */
  private async closeRestoreRole(): Promise<void> {
    await this.withConnection(this.maintenanceDatabase, async (client) => {
      await client.query(`ALTER ROLE ${escapeIdentifier(RESTORE_ROLE)} NOLOGIN PASSWORD NULL`);
      await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [RESTORE_ROLE]);
    }).catch((error) => logger.error({ err: error }, `Could not stop ${RESTORE_ROLE} logging in after a restore`));
  }

  /**
   * The sessions on the app's database other than backups' and restores' own, e.g. a running
   * backend's (`user@address`). The restore command refuses to replace the data under them.
   */
  async otherSessions(): Promise<string[]> {
    return this.withConnection(this.maintenanceDatabase, async (client) => {
      const { rows } = await client.query<{ who: string }>(
        `SELECT coalesce(usename, '?') || '@' || coalesce(host(client_addr), 'local') AS who
           FROM pg_stat_activity
          WHERE datname = $1 AND pid <> pg_backend_pid() AND backend_type = 'client backend'
            AND application_name IS DISTINCT FROM $2`,
        [this.location.database, BACKUP_APPLICATION_NAME]
      );
      return rows.map((r) => r.who);
    });
  }

  /** A new, empty database owned by RESTORE_ROLE, with the app database's encoding and locale. */
  private async createScratchDatabase(scratch: string): Promise<void> {
    await this.withConnection(this.maintenanceDatabase, async (client) => {
      const { rows } = await client.query<{
        encoding: string;
        collate: string;
        ctype: string;
        provider: string;
        locale: string | null;
      }>(
        `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate AS collate, datctype AS ctype,
                datlocprovider AS provider, datlocale AS locale
           FROM pg_database WHERE datname = $1`,
        [this.location.database]
      );
      const live = rows[0];
      if (!live) throw new Error(`The database ${this.location.database} does not exist`);
      const locale =
        live.provider === 'i'
          ? ` LOCALE_PROVIDER icu ICU_LOCALE ${escapeLiteral(live.locale ?? '')}`
          : live.provider === 'b'
            ? ` LOCALE_PROVIDER builtin BUILTIN_LOCALE ${escapeLiteral(live.locale ?? '')}`
            : ' LOCALE_PROVIDER libc';
      await client.query(
        `CREATE DATABASE ${escapeIdentifier(scratch)} OWNER ${escapeIdentifier(RESTORE_ROLE)} TEMPLATE template0 ` +
          `ENCODING ${escapeLiteral(live.encoding)} LC_COLLATE ${escapeLiteral(live.collate)} LC_CTYPE ${escapeLiteral(live.ctype)}${locale}`
      );
    });
  }

  /**
   * pg_restore into the scratch database, logged in as RESTORE_ROLE (not SET ROLE from the
   * owner: what the archive runs could RESET ROLE back). Without privileges: the serving
   * role's grants are re-applied from the code afterwards. Only version noise is tolerated
   * (a SET of a parameter this server doesn't have); any other error refuses the backup.
   */
  private async pgRestoreAsRestoreRole(scratch: string, dumpFile: string, password: string): Promise<void> {
    const result = await runPgTool('pg_restore', [
      '-h', this.location.host,
      '-p', String(this.location.port),
      '-U', RESTORE_ROLE,
      '-d', scratch,
      '--no-password',
      '--no-owner',
      '--no-privileges',
      dumpFile,
    ], password);
    if (result.code === 0) return;
    const errors = result.stderr.split(/(?=pg_restore: error:)/).filter((block) => block.startsWith('pg_restore: error:'));
    const onlyVersionNoise = errors.length > 0 && errors.every((block) => block.includes('unrecognized configuration parameter'));
    if (result.signal === null && onlyVersionNoise) {
      logger.warn({ errorOutput: result.stderr }, 'pg_restore completed with version compatibility warnings (non-fatal)');
      return;
    }
    logger.error({ code: result.code, signal: result.signal, errorOutput: result.stderr }, 'pg_restore failed');
    throw new Error(`pg_restore failed with ${result.signal ? `signal ${result.signal}` : `code ${result.code}`}: ${result.stderr.slice(0, 2000)}`);
  }

  /** What RESTORE_ROLE made becomes the schema owner's, as migrations would have made it. */
  private async handOverToOwner(scratch: string): Promise<void> {
    const owner = this.owner().user;
    await this.withConnection(scratch, async (client) => {
      const { rows } = await client.query<{ owner: string }>(
        'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
        [this.location.database]
      );
      await client.query(`REASSIGN OWNED BY ${escapeIdentifier(RESTORE_ROLE)} TO ${escapeIdentifier(owner)}`);
      const databaseOwner = rows[0]?.owner ?? owner;
      if (databaseOwner !== owner) {
        await client.query(`ALTER DATABASE ${escapeIdentifier(scratch)} OWNER TO ${escapeIdentifier(databaseOwner)}`);
      }
    });
  }

  /**
   * Bring the restored schema up to this code's (a backup's own version: nothing to do), and
   * say whether that cut a v2.4.0 one over, with what its comparison found.
   */
  private async migrateDatabase(database: string): Promise<RestoreResult['cutover']> {
    const owner = this.owner();
    const pool = new Pool({
      host: this.location.host,
      port: this.location.port,
      database,
      user: owner.user,
      password: owner.password,
      max: 2,
      application_name: BACKUP_APPLICATION_NAME,
      options: sessionOptions(),
    });
    // A shutdown ends the migration's sessions on the scratch database (interruptRestore):
    // the migration fails as itself, and a connection's 'error' must not be uncaught.
    handleConnectionErrors(pool, (err) => logger.warn({ err, database }, 'A restore migration database connection failed'));
    try {
      // The restore gives the database this code's privileges after this (reapplyServingRoleGrants),
      // not the backup's: a cutover's comparison leaves them out.
      const migrations = new MigrationService(pool, { migrationsDir: this.migrationsDir, compareGrants: false });
      await migrations.migrate();
      return migrations.cutOver ? { drift: migrations.cutoverDrift } : null;
    } finally {
      await pool.end();
    }
  }

  /**
   * Idempotently re-grant the RLS serving role (DB_USER, default `nuggets_app`)
   * the object privileges the migrations give it (db/servingRoleGrants.ts), on
   * `database`. The restore leaves the archive's privileges out, so these are the only
   * ones it has. The SECURITY DEFINER functions lose PUBLIC's EXECUTE whatever role
   * serves: without the archive's privileges every role could run them again, and in a
   * single-role setup (or with no serving role) nothing below would take it back.
   */
  private async reapplyServingRoleGrants(database: string): Promise<void> {
    const servingRole = this.serving().user;
    await this.withConnection(database, async (client) => {
      await client.query(definerFunctionsRevokeSql());
      const roleExists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [servingRole]);
      if (roleExists.rowCount === 0) {
        logger.info({ servingRole }, 'Serving role does not exist; skipping grant reapplication');
        return;
      }
      if (servingRole === this.owner().user) {
        // No role split (app connects as the owner): grants are moot.
        logger.info('Serving role is the schema owner; no grant reapplication needed');
        return;
      }
      await client.query(servingRoleGrantsSql(escapeIdentifier(servingRole)));
      logger.info({ servingRole, database }, 'Re-applied serving-role grants after restore');
    });
  }

  /**
   * The database-level settings (ALTER DATABASE … SET, ALTER ROLE … IN DATABASE … SET) and
   * privileges of `from`, on `to`: a dump has neither, and a swap would lose them (e.g. a
   * time zone set on the database).
   */
  private async copyDatabaseSettings(from: string, to: string): Promise<void> {
    await this.withConnection(this.maintenanceDatabase, async (client) => {
      const target = escapeIdentifier(to);
      const settings = await client.query<{ role: string | null; setting: string }>(
        `SELECT CASE WHEN s.setrole = 0 THEN NULL ELSE pg_get_userbyid(s.setrole) END AS role, unnest(s.setconfig) AS setting
           FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
          WHERE d.datname = $1`,
        [from]
      );
      for (const { role, setting } of settings.rows) {
        const eq = setting.indexOf('=');
        const name = setting.slice(0, eq);
        const value = setting.slice(eq + 1);
        const prefix = role ? `ALTER ROLE ${escapeIdentifier(role)} IN DATABASE ${target}` : `ALTER DATABASE ${target}`;
        await client.query(`${prefix} SET ${escapeIdentifier(name)} TO ${escapeLiteral(value)}`);
      }
      const acl = await client.query<{ grantee: string | null; privilege: string; grantable: boolean; custom: boolean }>(
        `SELECT CASE WHEN a.grantee = 0 THEN NULL ELSE pg_get_userbyid(a.grantee) END AS grantee,
                a.privilege_type AS privilege, a.is_grantable AS grantable, d.datacl IS NOT NULL AS custom
           FROM pg_database d LEFT JOIN LATERAL aclexplode(d.datacl) a ON true
          WHERE d.datname = $1`,
        [from]
      );
      if (acl.rows[0]?.custom) {
        await client.query(`REVOKE ALL ON DATABASE ${target} FROM PUBLIC`);
        for (const { grantee, privilege, grantable } of acl.rows) {
          if (!privilege) continue;
          await client.query(
            `GRANT ${privilege} ON DATABASE ${target} TO ${grantee ? escapeIdentifier(grantee) : 'PUBLIC'}${grantable ? ' WITH GRANT OPTION' : ''}`
          );
        }
      }
    });
  }

  /**
   * What decides tenant isolation in `database`: RLS on the tenant and organization tables,
   * their policies, SECURITY DEFINER functions, rules, views' security_invoker and event
   * triggers.
   */
  private async isolationCatalog(database: string): Promise<string[]> {
    return this.withConnection(database, async (client) => {
      const queries = [
        `SELECT 'rls ' || c.relname || ' enabled=' || c.relrowsecurity || ' forced=' || c.relforcerowsecurity AS item
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
            AND EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname IN ('tenant_id', 'organization_id') AND NOT a.attisdropped)`,
        `SELECT 'policy ' || tablename || '.' || policyname || ' ' || permissive || ' ' || roles::text || ' ' || cmd ||
                ' USING ' || coalesce(qual, '-') || ' CHECK ' || coalesce(with_check, '-') AS item
           FROM pg_policies WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
        `SELECT 'security definer ' || p.oid::regprocedure::text || ' ' || md5(pg_get_functiondef(p.oid)) AS item
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')`,
        `SELECT 'rule ' || schemaname || '.' || tablename || '.' || rulename AS item
           FROM pg_rules WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
        `SELECT 'view ' || n.nspname || '.' || c.relname || ' invoker=' ||
                coalesce('security_invoker=true' = ANY(c.reloptions) OR 'security_invoker=on' = ANY(c.reloptions), false) AS item
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('v', 'm')`,
        `SELECT 'event trigger ' || evtname AS item FROM pg_event_trigger`,
      ];
      const items: string[] = [];
      for (const query of queries) items.push(...(await client.query<{ item: string }>(query)).rows.map((r) => r.item));
      return items.sort();
    });
  }

  /**
   * Refuse restored data whose tenant isolation differs from this server's database, which
   * its migrations made: after the migrations both are at this code's schema, so a backup
   * that changed a policy, turned RLS off or added a SECURITY DEFINER function shows here.
   */
  private async assertIsolationMatches(live: string, restored: string): Promise<void> {
    const [expected, actual] = await Promise.all([this.isolationCatalog(live), this.isolationCatalog(restored)]);
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const differences = [
      ...actual.filter((item) => !expectedSet.has(item)).map((item) => `+ ${item}`),
      ...expected.filter((item) => !actualSet.has(item)).map((item) => `- ${item}`),
    ];
    if (differences.length > 0) {
      throw new RestoreRefusedError(
        `The restored data's row-level security differs from this server's database (${differences.length} difference(s)): ` +
          differences.slice(0, 5).join('; ')
      );
    }
  }

  private async countRows(database: string): Promise<Record<string, number>> {
    return this.withConnection(database, async (client) => {
      const counts: Record<string, number> = {};
      for (const table of COUNTED_TABLES) {
        const exists = await client.query("SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1", [table]);
        if (exists.rowCount === 0) continue;
        try {
          const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM public.${escapeIdentifier(table)}`);
          counts[table] = oneRow(rows, 'count(*)').n;
        } catch (error) {
          // An owner that isn't a superuser is held to the forced RLS: no count, no failure.
          logger.warn({ err: error, table }, 'Could not count the rows of a restored table');
        }
      }
      return counts;
    });
  }

  private async dropDatabase(name: string): Promise<void> {
    await this.withConnection(this.maintenanceDatabase, (client) =>
      client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(name)} WITH (FORCE)`)
    );
  }

  /**
   * Put `replacement` in place of `live`, keeping `live`'s data as `keepAs` (dropping
   * whatever had that name). Every session on `live` ends first: the rename takes none.
   * The two renames are one transaction, so `live` is always one or the other.
   */
  private async swapDatabases(live: string, replacement: string, keepAs: string): Promise<void> {
    await this.withConnection(this.maintenanceDatabase, async (client) => {
      const liveId = escapeIdentifier(live);
      await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(keepAs)} WITH (FORCE)`);
      await client.query(`ALTER DATABASE ${liveId} ALLOW_CONNECTIONS false`);
      try {
        for (let attempt = 0; ; attempt++) {
          const { rows } = await client.query<{ n: number }>(
            `SELECT count(pg_terminate_backend(pid))::int AS n FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [live]
          );
          if (oneRow(rows, 'count(pg_terminate_backend(pid))').n === 0) break;
          if (attempt >= 50) throw new Error(`Sessions on ${live} did not end`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        await client.query('BEGIN');
        await client.query(`ALTER DATABASE ${liveId} RENAME TO ${escapeIdentifier(keepAs)}`);
        await client.query(`ALTER DATABASE ${escapeIdentifier(replacement)} RENAME TO ${liveId}`);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        // A connection lost at COMMIT can hide a swap that happened: then `replacement` is gone.
        const swapped = await this.withConnection(this.maintenanceDatabase, (other) =>
          other.query('SELECT 1 FROM pg_database WHERE datname = $1', [replacement]).then((r) => r.rowCount === 0)
        ).catch(() => false);
        if (!swapped) {
          await client.query(`ALTER DATABASE ${liveId} ALLOW_CONNECTIONS true`).catch(() => {});
          throw error;
        }
        logger.error({ err: error, live, replacement }, 'The database swap reported an error, but it happened');
      }
      // Swapped: from here nothing may throw, or the caller would think the data unchanged.
      // The kept copy can be connected to again, to look at or to swap back.
      for (const name of [keepAs, live]) {
        await client
          .query(`ALTER DATABASE ${escapeIdentifier(name)} ALLOW_CONNECTIONS true`)
          .catch((error) => logger.error({ err: error, database: name }, 'Swapped the databases, but could not allow connections to one'));
      }
    });
  }

  /**
   * Replace the upload files with the backup's (`from`; none when it has no uploads).
   * The current ones are moved aside to `<temp>/before-restore/uploads` (replacing those
   * of the restore before), not renamed: /app/uploads is a mount point. Undone on failure.
   */
  private async replaceUploads(from: string): Promise<{ previous: string; restored: number }> {
    const keepDir = path.join(this.tempDir, 'before-restore', 'uploads');
    await fs.rm(keepDir, { recursive: true, force: true });
    await fs.mkdir(keepDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.uploadsDir, { recursive: true });

    const current = await fs.readdir(this.uploadsDir);
    const movedAside: string[] = [];
    const placed: string[] = [];
    try {
      for (const name of current) {
        await this.moveEntry(path.join(this.uploadsDir, name), path.join(keepDir, name));
        movedAside.push(name);
      }
      const incoming = existsSync(from) ? await fs.readdir(from) : [];
      for (const name of incoming) {
        placed.push(name);
        await this.moveEntry(path.join(from, name), path.join(this.uploadsDir, name));
      }
      const restored = existsSync(this.uploadsDir) ? this.countFiles(this.uploadsDir).files : 0;
      logger.info({ restored, previous: keepDir, replaced: current.length }, 'Restored the upload files');
      return { previous: keepDir, restored };
    } catch (error) {
      for (const name of placed) await fs.rm(path.join(this.uploadsDir, name), { recursive: true, force: true }).catch(() => {});
      for (const name of movedAside) {
        await this.moveEntry(path.join(keepDir, name), path.join(this.uploadsDir, name)).catch((undoError) =>
          logger.error({ err: undoError, name }, 'Could not put an upload back after a failed restore')
        );
      }
      throw error;
    }
  }

  /** Rename, or copy and delete across file systems. Symlinks are skipped (a backup could carry one). */
  private async moveEntry(from: string, to: string): Promise<void> {
    try {
      await fs.rename(from, to);
    } catch (error) {
      if (errorCode(error) !== 'EXDEV') throw error;
      const stats = await fs.lstat(from);
      if (stats.isDirectory()) await this.copyDirectory(from, to);
      else if (stats.isFile()) await fs.copyFile(from, to);
      await fs.rm(from, { recursive: true, force: true });
    }
  }

  /**
   * Recursively copy directory
   */
  private async copyDirectory(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    const items = await fs.readdir(src);

    for (const item of items) {
      const srcPath = path.join(src, item);
      const destPath = path.join(dest, item);
      // Use lstat (not stat) so symlinks are detected rather than followed: a
      // malicious backup archive could otherwise carry a symlink that reads an
      // arbitrary host file (e.g. /etc/passwd) into the uploads dir on restore.
      const stats = await fs.lstat(srcPath);

      if (stats.isSymbolicLink()) {
        logger.warn({ srcPath }, 'Skipping symlink while restoring uploads');
        continue;
      }
      if (stats.isDirectory()) {
        await this.copyDirectory(srcPath, destPath);
      } else if (stats.isFile()) {
        await fs.copyFile(srcPath, destPath);
      }
    }
  }

  /**
   * At startup: remove what a backup or restore that was killed left behind — plaintext
   * dumps and archives in the temp directory, uploaded backups, scratch databases — and
   * make sure RESTORE_ROLE can't log in. Only while no backup or restore
   * runs anywhere (the advisory lock is free); otherwise it leaves everything alone.
   */
  async sweepLeftovers(): Promise<void> {
    if (currentOperation) return;
    let lock: Client | null = null;
    try {
      lock = await this.connect(this.location.database);
      const { rows } = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [BackupService.BACKUP_LOCK_KEY]);
      if (rows[0]?.locked !== true) {
        logger.info('A backup or restore is running elsewhere; leaving its temp files alone');
        return;
      }
      const removed: string[] = [];
      for (const entry of await fs.readdir(this.tempDir).catch(() => [] as string[])) {
        if (/^(nuggets_backup_|restore_)/.test(entry)) {
          await fs.rm(path.join(this.tempDir, entry), { recursive: true, force: true });
          removed.push(entry);
        }
      }
      // An age backup cut short while it was written: it was never renamed into place.
      for (const entry of await sweepPartialBackups(this.backupLocation)) removed.push(`backups/${entry}`);
      // Backups uploaded for a restore (routes/backup.ts).
      const uploads = path.join(this.tempDir, 'uploads');
      for (const entry of await fs.readdir(uploads).catch(() => [] as string[])) {
        await fs.rm(path.join(uploads, entry), { recursive: true, force: true });
        removed.push(`uploads/${entry}`);
      }
      await this.withConnection(this.maintenanceDatabase, async (client) => {
        const scratch = await client.query<{ datname: string }>(
          `SELECT datname FROM pg_database WHERE datname LIKE $1 AND datname ~ '_restore_[0-9]{17}$'`,
          [`${this.location.database.replace(/[\\%_]/g, '\\$&')}\\_restore\\_%`]
        );
        for (const { datname } of scratch.rows) {
          await client.query(`DROP DATABASE IF EXISTS ${escapeIdentifier(datname)} WITH (FORCE)`);
          removed.push(`database ${datname}`);
        }
        const role = await client.query<{ rolcanlogin: boolean }>('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [RESTORE_ROLE]);
        if (role.rows[0]?.rolcanlogin) {
          await client.query(`ALTER ROLE ${escapeIdentifier(RESTORE_ROLE)} NOLOGIN PASSWORD NULL`);
          removed.push(`login of ${RESTORE_ROLE}`);
        }
      });
      if (removed.length > 0) logger.warn({ removed }, 'Removed what an interrupted backup or restore left behind');
    } catch (error) {
      logger.warn({ err: error }, 'Could not check for what an interrupted backup or restore left behind');
    } finally {
      if (lock) await lock.end().catch(() => {});
    }
  }

  /**
   * List available backups
   */
  async listBackups(): Promise<ListedBackup[]> {
    try {
      // Regular files only: a symlink named *.tar.age or *.enc would otherwise be listed,
      // uploaded and restored as the file it points at, and a dangling one made the whole
      // listing fail. A file deleted while this runs is skipped, not an error. A .partial
      // file (a backup being written) isn't a backup's name.
      const entries = await fs.readdir(this.backupLocation, { withFileTypes: true });
      const backupFiles = entries.filter((e) => e.isFile() && isBackupFileName(e.name)).map((e) => e.name);

      const backups = await Promise.all(
        backupFiles.map(async (fileName) => {
          const filePath = path.join(this.backupLocation, fileName);
          const stats = await fs.lstat(filePath).catch(() => null);
          if (!stats?.isFile()) return null;

          // Not birthtime: filesystems without it (NFS/SMB shares, common for backups)
          // report the epoch, and retention then deleted every backup as 56 years old.
          return {
            fileName,
            filePath,
            size: stats.size,
            created: backupTimeFromFileName(fileName) ?? stats.mtime,
            // From its first bytes: which key it opens with.
            format: await detectBackupFormat(filePath).catch((): BackupFileFormat => 'unknown'),
          };
        })
      );

      return backups
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => b.created.getTime() - a.created.getTime());

    } catch (error) {
      // No backup directory yet: nothing has been backed up.
      if (errorCode(error) === 'ENOENT') return [];
      logger.error({ err: error }, 'Failed to list backups');
      return [];
    }
  }

  /** A backup in the backup directory by its file name, or null (no paths, only listed files). */
  async findBackup(fileName: string): Promise<ListedBackup | null> {
    return (await this.listBackups()).find((b) => b.fileName === fileName) ?? null;
  }

  /**
   * The age header of a listed backup (at most MAX_AGE_HEADER_BYTES), for the browser to
   * open with the owner's private key. Null when no backup has that name.
   */
  async readBackupHeader(fileName: string): Promise<Buffer | null> {
    const backup = await this.findBackup(fileName);
    if (!backup) return null;
    if (backup.format !== 'age') throw notAnAgeBackup();
    try {
      return await readAgeHeader(backup.filePath);
    } catch (error) {
      if (error instanceof BackupBundleError) throw damagedBackupHeader(error.message);
      throw error;
    }
  }

  /**
   * Delete a backup file. Defence in depth against path traversal: strip any
   * directory component and require a backup's extension (`.tar.age`, `.enc`), so this can
   * only ever unlink a file directly inside the backup directory.
   */
  async deleteBackup(fileName: string): Promise<void> {
    const safeName = path.basename(fileName);
    if (safeName !== fileName || !isBackupFileName(safeName)) {
      throw new Error('Invalid backup file name');
    }
    const filePath = path.join(this.backupLocation, safeName);
    await fs.unlink(filePath);
  }
}
