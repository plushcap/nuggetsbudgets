import { sql, type Kysely } from 'kysely';
import { backupRunOutcome, backupRunTrigger, backupVerifyOutcome, type BackupRun, type BackupRunTrigger, type BackupVerifyOutcome } from '@nuggets/shared';
import type { DB } from '../../db/schema.generated.js';

/**
 * The record of backups (`backup_runs`, control plane): one row per run, failures included,
 * with the file it made and when it was last verified. The Backup page shows it, the backup
 * health check reads the last scheduled run from it after a restart, a restore keeps the
 * running server's rows (restoreCarryOver.ts), and the daily retention job deletes a row a
 * year after its file is gone (retention.ts). A verify is recorded only for the server's own
 * copy of a listed backup.
 */

export type { BackupRunTrigger, BackupVerifyOutcome };

/** Shown when no backup has been verified for this long. */
export const VERIFY_OVERDUE_DAYS = 90;
/** How many runs the Backup page lists, newest first. */
export const LISTED_RUNS = 50;
/** The longest message kept (the column's check). */
const MAX_MESSAGE = 2000;

const clip = (text: string | null): string | null => (text === null ? null : text.slice(0, MAX_MESSAGE));

export interface BackupRunRecord {
  startedAt: Date;
  finishedAt: Date;
  trigger: BackupRunTrigger;
  outcome: 'succeeded' | 'failed';
  /** Why it failed, written for people (publicErrorMessage); null when it succeeded. */
  message: string | null;
  fileName: string | null;
  fileSize: number | null;
  sha256: string | null;
  /** The fingerprints of the keys an age backup was encrypted to. */
  recipients: readonly string[];
  /** Who started it (a manual backup); null for a scheduled one. */
  startedBy: number | null;
}

export async function recordBackupRun(db: Kysely<DB>, run: BackupRunRecord): Promise<void> {
  await db
    .insertInto('backup_runs')
    .values({
      started_at: run.startedAt.toISOString(),
      finished_at: run.finishedAt.toISOString(),
      trigger: run.trigger,
      outcome: run.outcome,
      message: clip(run.message),
      file_name: run.fileName,
      file_size: run.fileSize,
      sha256: run.sha256,
      recipients: [...run.recipients],
      started_by: run.startedBy,
    })
    .execute();
}

/**
 * Record a verify of the backup named `fileName`: when, by whom (null: the restore command)
 * and how it went. True when a run made that file; a backup this server has no record of
 * (one from another server) is verified all the same, but nothing is recorded.
 */
export async function recordVerify(
  db: Kysely<DB>,
  verify: { fileName: string; verifiedBy: number | null; outcome: BackupVerifyOutcome; message: string | null }
): Promise<boolean> {
  const result = await db
    .updateTable('backup_runs')
    .set({
      verified_at: sql<string>`now()`,
      verified_by: verify.verifiedBy,
      verify_outcome: verify.outcome,
      verify_message: clip(verify.message),
      // A failed verify leaves the last pass: one failure doesn't make a backup unverified.
      ...(verify.outcome === backupVerifyOutcome.enum.passed && { passed_verify_at: sql<string>`now()` }),
    })
    .where('file_name', '=', verify.fileName)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Someone's name as the history shows it: first and last name, else the email. */
const personName = (first: string | null, last: string | null, email: string | null): string | null =>
  [first, last].filter((part) => part?.trim()).join(' ') || email;

/** The newest runs, and when a backup last passed a verify, as the Backup page shows them. */
export async function listBackupRuns(
  db: Kysely<DB>,
  limit = LISTED_RUNS
): Promise<{ runs: BackupRun[]; lastVerifiedAt: string | null; verifyOverdue: boolean }> {
  const rows = await db
    .selectFrom('backup_runs as r')
    .leftJoin('users as s', 's.id', 'r.started_by')
    .leftJoin('users as v', 'v.id', 'r.verified_by')
    .select([
      'r.uuid', 'r.started_at', 'r.finished_at', 'r.trigger', 'r.outcome', 'r.message', 'r.file_name', 'r.file_size', 'r.sha256',
      'r.recipients', 'r.verified_at', 'r.verify_outcome', 'r.verify_message', 'r.passed_verify_at',
      's.first_name as started_first', 's.last_name as started_last', 's.email as started_email',
      'v.first_name as verified_first', 'v.last_name as verified_last', 'v.email as verified_email',
    ])
    .orderBy('r.started_at', 'desc')
    .orderBy('r.id', 'desc')
    .limit(limit)
    .execute();
  const cutoff = sql`now() - make_interval(days => ${VERIFY_OVERDUE_DAYS})`;
  const summary = await db
    .selectFrom('backup_runs')
    .select([
      sql<Date | null>`max(passed_verify_at)`.as('last_verified_at'),
      // Overdue: the last pass is older than the cutoff, or there has been none while backups
      // have been made for that long (a new server's first backups aren't overdue).
      sql<boolean>`coalesce(
        CASE WHEN max(passed_verify_at) IS NOT NULL THEN max(passed_verify_at) < ${cutoff}
             ELSE min(started_at) FILTER (WHERE outcome = ${sql.lit(backupRunOutcome.enum.succeeded)}) < ${cutoff} END,
        false)`.as('overdue'),
    ])
    .executeTakeFirst();
  return {
    runs: rows.map((r) => ({
      uuid: r.uuid,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at.toISOString(),
      trigger: r.trigger as BackupRunTrigger,
      outcome: r.outcome as BackupRun['outcome'],
      message: r.message,
      fileName: r.file_name,
      fileSize: r.file_size === null ? null : Number(r.file_size),
      sha256: r.sha256,
      recipients: r.recipients,
      startedBy: personName(r.started_first, r.started_last, r.started_email),
      verifiedAt: r.verified_at?.toISOString() ?? null,
      verifiedBy: r.verified_at === null ? null : personName(r.verified_first, r.verified_last, r.verified_email),
      verifyOutcome: (r.verify_outcome as BackupVerifyOutcome | null) ?? null,
      verifyMessage: r.verify_message,
      passedVerifyAt: r.passed_verify_at?.toISOString() ?? null,
    })),
    lastVerifiedAt: summary?.last_verified_at?.toISOString() ?? null,
    verifyOverdue: summary?.overdue === true,
  };
}

/** The newest scheduled run: the health check's "last run" after a restart. */
export async function lastScheduledRun(
  db: Kysely<DB>
): Promise<{ startedAt: Date; finishedAt: Date; outcome: 'success' | 'failed' } | null> {
  const row = await db
    .selectFrom('backup_runs')
    .select(['started_at', 'finished_at', 'outcome'])
    .where('trigger', '=', backupRunTrigger.enum.scheduled)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return { startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome === backupRunOutcome.enum.succeeded ? 'success' : 'failed' };
}
