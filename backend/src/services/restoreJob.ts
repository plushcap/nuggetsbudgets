import type { Pool } from 'pg';
import appPool from '../db.js';
import { unlink } from 'fs/promises';
import type { RestoreStatus, VerifyStatus } from '@nuggets/shared';
import { BackupService, BackupInProgressError, RestoreFailedError, ShuttingDownError } from './BackupService.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { assertServingRoleEnforcesRls, RlsBypassRoleError } from '../db/servingRole.js';
import { BackupFormatError, BackupKeyError } from '../utils/backupCrypto.js';
import { runDetached } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger({ service: 'RestoreJob' });

/**
 * A restore through the app, run in the background: it takes minutes, longer
 * than a reverse proxy waits for an answer, so POST /api/backup/restore answers 202 and the
 * page polls GET /api/backup/restore-status. While it runs:
 *   - the server is in maintenance mode: every request that would change something gets a
 *     503 (restoreMaintenanceGate), as what it wrote would be replaced;
 *   - the schedulers (bank sync, backups, notifications, prices) are stopped, and start
 *     again afterwards from the restored settings;
 *   - no backup or other restore starts (BackupService runs one operation at a time).
 */

/** A restore's progress and outcome, as GET /api/backup/restore-status answers it (`@nuggets/shared`). */
export type { RestoreStatus, VerifyStatus };

/** What the job stops and starts again: ApplicationLifecycleService. */
export interface RestoreSchedulers {
  pauseSchedulersForRestore(): Promise<void>;
  resumeSchedulersAfterRestore(): Promise<void>;
}

let status: RestoreStatus = { status: 'idle' };
let running: Promise<void> | null = null;

export function getRestoreStatus(): RestoreStatus {
  return status;
}

/** True from the moment a restore is accepted until its schedulers are running again. */
export function isRestoreRunning(): boolean {
  return running !== null || BackupService.isRestoreInProgress();
}

let verifyStatus: VerifyStatus = { status: 'idle' };
let verifying: Promise<void> | null = null;

/** How the verify running, or the last one, went (GET /api/backup/verify-status). */
export function getVerifyStatus(): VerifyStatus {
  return verifyStatus;
}

/** True from the moment a verify is accepted until it has ended. */
export function isVerifyRunning(): boolean {
  return verifying !== null || BackupService.isVerifyInProgress();
}

/** Resolves when the running verify job (if any) has finished. */
export function verifyJobSettled(): Promise<void> {
  return verifying ?? Promise.resolve();
}

/** Resolves when the running restore job (if any) has finished. */
export function restoreJobSettled(): Promise<void> {
  return running ?? Promise.resolve();
}

/**
 * The message to show for a failure: the reason when it is written for the person restoring
 * (a ControlPlaneError: a refusal, another backup running; a wrong key or damaged file),
 * never an internal error's text.
 */
function shownError(error: unknown): string {
  const cause = error instanceof RestoreFailedError ? error.cause : error;
  if (
    cause instanceof ControlPlaneError ||
    cause instanceof BackupKeyError ||
    cause instanceof BackupFormatError ||
    cause instanceof RlsBypassRoleError
  ) {
    return cause.message;
  }
  if (error instanceof RestoreFailedError && error.databaseChanged) {
    return 'The restore failed after the data was replaced; see the server log';
  }
  return 'The restore failed and nothing was changed; see the server log for why';
}

export interface StartRestoreInput {
  filePath: string;
  fileName: string;
  /** An older .enc backup: the key the user typed, or null for this server's own. */
  key: string | null;
  /**
   * An age backup: its file key, which the browser got from the header with the private key.
   * Kept in memory for this job only, never stored or logged, and zeroed when it ends.
   */
  fileKey: Buffer | null;
  /** Delete the file afterwards (an uploaded backup). */
  deleteAfter: boolean;
  userId: number;
}

/**
 * What a restore job uses. `pool` is the server's own (db.ts's, unless a test passes
 * another): the restored data is checked again on it once it is served.
 */
export interface RestoreJobDependencies {
  backupService: BackupService;
  schedulers: RestoreSchedulers;
  pool?: Pool | undefined;
}

/**
 * Start a restore in the background. Throws (synchronously) ShuttingDownError once a
 * shutdown has begun, and BackupInProgressError when a backup or restore is already
 * running; otherwise the outcome is in getRestoreStatus().
 */
export function startRestoreJob(
  deps: RestoreJobDependencies,
  input: StartRestoreInput
): void {
  if (BackupService.isRefusingNewOperations()) throw new ShuttingDownError();
  if (isRestoreRunning()) throw new BackupInProgressError('A restore is in progress', 'restore');
  if (BackupService.isBackupInProgress()) throw new BackupInProgressError('A backup is in progress; restore when it has finished');
  // Before the schedulers are paused: a verify holds the backup lock, so the restore would
  // only fail once they were.
  if (isVerifyRunning()) throw new BackupInProgressError('A backup is being verified; restore when it has finished', 'verify');

  const startedAt = new Date().toISOString();
  status = { status: 'running', phase: 'decrypting', fileName: input.fileName, startedAt };
  // Outside the request, and any transaction it has open (runDetached): the schedulers
  // it starts again would otherwise keep its context.
  running = runDetached(() => runRestore(deps, input, startedAt)).finally(() => {
    running = null;
  });
}

async function runRestore(
  deps: RestoreJobDependencies,
  input: StartRestoreInput,
  startedAt: string
): Promise<void> {
  const { pool = appPool, backupService, schedulers } = deps;
  const { userId, fileName } = input;
  let databaseChanged: boolean;
  let shutDown = false;
  try {
    await schedulers.pauseSchedulersForRestore();
    logger.info({ userId, fileName, usingCustomKey: input.key !== null, usingFileKey: input.fileKey !== null }, 'Restoring a backup');
    const result = await backupService.restoreFromFile(input.filePath, {
      key: input.key,
      fileKey: input.fileKey,
      fileName,
      // Refused unless they can manage the server afterwards, in the restored data.
      restorerId: userId,
      onPhase: (phase) => {
        status = { ...status, phase };
      },
    });
    databaseChanged = true;
    status = {
      status: 'completed',
      fileName,
      startedAt,
      finishedAt: new Date().toISOString(),
      databaseChanged: true,
      previousDatabase: result.previousDatabase,
      rowCounts: result.rowCounts,
      backupId: result.manifest?.backupId ?? null,
      backupCreatedAt: result.manifest?.createdAt ?? null,
      carryOver: result.carryOver,
    };
    logger.info({ userId, fileName, previousDatabase: result.previousDatabase, rowCounts: result.rowCounts }, 'Backup restored');
  } catch (error) {
    databaseChanged = error instanceof RestoreFailedError && error.databaseChanged;
    status = {
      status: 'failed',
      fileName,
      startedAt,
      finishedAt: new Date().toISOString(),
      error: shownError(error),
      databaseChanged,
    };
    const cause = error instanceof RestoreFailedError ? error.cause : error;
    if (error instanceof BackupInProgressError) logger.warn({ err: error, userId, fileName }, 'Restore refused: a backup or restore is running');
    else if (cause instanceof ShuttingDownError && !databaseChanged) {
      // A shutdown began before the restore replaced the data (accepted just before it, or
      // stopped part way): the scratch database is dropped, the data as it was.
      logger.warn({ err: error, userId, fileName }, 'Restore stopped by the shutdown before it replaced the data; the data is unchanged');
    } else logger.error({ err: error, userId, fileName, databaseChanged }, 'Backup restore failed');
  }

  // The restored data passed the serving role check before it was swapped in; check
  // again now that it is served, and stop rather than serve tenants' data mixed: SIGTERM
  // shuts down gracefully, and the restart checks again.
  if (databaseChanged) {
    try {
      await assertServingRoleEnforcesRls(pool);
    } catch (checkError) {
      const refused = checkError instanceof RlsBypassRoleError;
      logger.fatal(
        { err: checkError },
        refused
          ? 'The database fails the serving role check after a restore; shutting down'
          : 'Could not check the database role after a restore; shutting down'
      );
      status = {
        ...status,
        status: 'failed',
        error: refused
          ? 'The server has to stop: after the restore, the database fails the database role check (see the server log)'
          : 'The server has to stop: after the restore, the database role check could not run (see the server log)',
      };
      shutDown = true;
      process.kill(process.pid, 'SIGTERM');
    }
  }

  if (!shutDown) {
    try {
      await schedulers.resumeSchedulersAfterRestore();
    } catch (error) {
      logger.error({ err: error }, 'Could not start the schedulers again after a restore');
    }
  }
  input.fileKey?.fill(0);
  if (input.deleteAfter) {
    await unlink(input.filePath).catch((error) => logger.warn({ err: error, filePath: input.filePath }, 'Could not delete an uploaded backup'));
  }
}

/**
 * Start a verify in the background: the backup is restored into a scratch database, checked
 * and dropped, while the app keeps serving. No scheduler stops, and nothing goes into
 * maintenance mode. Throws (synchronously) ShuttingDownError once a shutdown has begun, and
 * BackupInProgressError while a backup, restore or other verify runs; otherwise the outcome
 * is in getVerifyStatus().
 */
export function startVerifyJob(deps: Pick<RestoreJobDependencies, 'backupService'>, input: StartRestoreInput): void {
  if (BackupService.isRefusingNewOperations()) throw new ShuttingDownError();
  if (isVerifyRunning()) throw new BackupInProgressError('A backup is already being verified', 'verify');
  if (isRestoreRunning()) throw new BackupInProgressError('A restore is in progress', 'restore');
  if (BackupService.isBackupInProgress()) throw new BackupInProgressError('A backup is in progress; verify when it has finished');

  const startedAt = new Date().toISOString();
  verifyStatus = { status: 'running', phase: 'decrypting', fileName: input.fileName, startedAt };
  verifying = runDetached(() => runVerify(deps.backupService, input, startedAt)).finally(() => {
    verifying = null;
  });
}

async function runVerify(backupService: BackupService, input: StartRestoreInput, startedAt: string): Promise<void> {
  const { userId, fileName } = input;
  try {
    logger.info({ userId, fileName, usingFileKey: input.fileKey !== null }, 'Verifying a backup');
    const result = await backupService.restoreFromFile(input.filePath, {
      key: input.key,
      fileKey: input.fileKey,
      fileName,
      verifyOnly: true,
      onPhase: (phase) => {
        verifyStatus = { ...verifyStatus, phase };
      },
    });
    // Recorded against the backup it is (its signed id), whatever it was uploaded as.
    await backupService.recordVerify(result.manifest?.backupId ? `${result.manifest.backupId}.tar.age` : fileName, userId, 'passed', null);
    verifyStatus = {
      status: 'completed',
      fileName,
      startedAt,
      finishedAt: new Date().toISOString(),
      backupId: result.manifest?.backupId ?? null,
      backupCreatedAt: result.manifest?.createdAt ?? null,
      schemaVersion: result.manifest?.schemaVersion ?? null,
      appVersion: result.manifest?.appVersion ?? null,
      rowCounts: result.rowCounts,
    };
    logger.info({ userId, fileName, backupId: result.manifest?.backupId, rowCounts: result.rowCounts }, 'Backup verified');
  } catch (error) {
    verifyStatus = { status: 'failed', fileName, startedAt, finishedAt: new Date().toISOString(), error: shownVerifyError(error) };
    const cause = error instanceof RestoreFailedError ? error.cause : error;
    // A verify that ran and failed; not one held up by another operation or the shutdown.
    if (!(error instanceof BackupInProgressError) && !(cause instanceof ShuttingDownError)) {
      await backupService.recordVerify(fileName, userId, 'failed', verifyStatus.error ?? null);
    }
    if (error instanceof BackupInProgressError) logger.warn({ err: error, userId, fileName }, 'Verify refused: a backup or restore is running');
    else if (cause instanceof ShuttingDownError) logger.warn({ err: error, userId, fileName }, 'Verify stopped by the shutdown');
    else logger.error({ err: error, userId, fileName }, 'Backup verify failed');
  } finally {
    input.fileKey?.fill(0);
    if (input.deleteAfter) {
      await unlink(input.filePath).catch((error) => logger.warn({ err: error, filePath: input.filePath }, 'Could not delete an uploaded backup'));
    }
  }
}

/** A verify's failure, for the person who asked: a reason they can act on, else generic. */
function shownVerifyError(error: unknown): string {
  const cause = error instanceof RestoreFailedError ? error.cause : error;
  if (cause instanceof ShuttingDownError) return 'The server shut down during the verify, which changes nothing. Verify again once it has restarted.';
  const shown = shownError(error);
  return shown.startsWith('The restore failed') ? 'The backup did not verify; see the server log for why' : shown.replace(/^Restore failed: /, '');
}
