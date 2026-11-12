import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { Kysely, PostgresDialect, sql } from 'kysely';
import type { Pool } from 'pg';
import type { DB } from '../db/schema.generated.js';
import type { DbCredentials, DbLocation } from '../db/dbConfig.js';
import { MigrationRefusal, type MigrationFile } from './MigrationService.js';
import { appliedMigrations, migrationsListing, writePrivateFile, writeSchemaDump } from './databaseDiagnostics.js';
import { appCommit, appVersion } from '../utils/appVersion.js';
import { dbErrorLine, publicDbError, type PublicDbError } from '../utils/dbErrorText.js';
import { createLogger } from '../utils/logger.js';
import { getDirname } from '../utils/esm-compat.js';
import { config } from '../config.js';

const logger = createLogger({ service: 'MigrationFailureFiles' });

/**
 * When a migration fails as the backend container starts (docker-entrypoint.sh runs
 * `migrate` before the server), the container stops there and restarts over and over, so
 * Settings → Utilities can't be reached. The migrate script then writes what that
 * page would download to the backups directory, which the compose files mount at
 * BACKUPS_PATH on the host, with a short report:
 *
 * - nuggets-migration-failure.txt: which migration failed, the database's error code,
 *   message and the object it names (its DETAIL and SQL, and what its message quotes or
 *   lists in parentheses, are left out: utils/dbErrorText.ts);
 * - nuggets-migration-failure-schema.sql: the schema, pg_dump --schema-only, no rows;
 * - nuggets-migration-failure-migrations.sql: the migrations the database has applied.
 *
 * Each failed start replaces them (a restart loop doesn't fill the directory), and each is
 * readable by its owner only. None holds a ledger's rows or a password.
 */

export const FAILURE_REPORT_FILE = 'nuggets-migration-failure.txt';
export const FAILURE_SCHEMA_FILE = 'nuggets-migration-failure-schema.sql';
export const FAILURE_MIGRATIONS_FILE = 'nuggets-migration-failure-migrations.sql';

/** How long reading the applied migrations may take, or wait for a lock. */
const LISTING_TIMEOUT = '15s';

export interface MigrationFailureInput {
  /** What migrate() threw. */
  error: unknown;
  /** The migration it failed in (MigrationService.failedMigration); null when none had run. */
  migration: MigrationFile | null;
  /** The migration pool (the schema owner). */
  pool: Pool;
  /** Where to write: the backups directory unless given. */
  dir?: string;
  /** Where pg_dump connects, and as whom: as the schema download does unless given. */
  location?: DbLocation;
  credentials?: DbCredentials;
  now?: Date;
}

export interface MigrationFailureFiles {
  dir: string;
  /** The files written, as paths. */
  written: string[];
  /** Each file not written, and why (for the log). */
  notWritten: { file: string; reason: string }[];
}

/** The backups directory, as BackupService has it: BACKUP_LOCATION, else /app/backups beside the app. */
export function backupsDirectory(): string {
  return config().BACKUP_LOCATION || path.join(getDirname(import.meta.url), '../../backups');
}

/** Why a file wasn't written, for the log: its error's code and message, the code once. */
function reasonOf(err: unknown): string {
  const e = (err ?? {}) as { code?: unknown; message?: unknown };
  const message = typeof e.message === 'string' && e.message ? e.message : String(err);
  return typeof e.code === 'string' && !message.startsWith(e.code) ? `${e.code}: ${message}` : message;
}

/** A one-line value: control characters out, cut at `max`. */
const oneLine = (value: string, max = 500): string => value.replace(/\p{Cc}+/gu, ' ').trim().slice(0, max);

/**
 * The line of the migration's file the error's position is on, for a migration that runs
 * in one transaction (its whole UP part is one query, so the position counts from its
 * start); null when there is none or it can't be placed.
 */
export function failedLine(migration: MigrationFile, position: unknown): number | null {
  const at = Number(position);
  if (migration.noTransaction || !Number.isInteger(at) || at < 1 || at > migration.upSql.length + 1) return null;
  let content: string;
  try {
    content = fs.readFileSync(migration.fullPath, 'utf8');
  } catch {
    return null;
  }
  const start = content.indexOf(migration.upSql);
  if (start < 0) return null;
  return content.slice(0, start + at - 1).split('\n').length;
}

/** The object the error names: its schema, table, column, data type and constraint. */
function namedObject(error: PublicDbError): string | undefined {
  const parts = (
    [
      ['schema', error.schema],
      ['table', error.table],
      ['column', error.column],
      ['data type', error.dataType],
      ['constraint', error.constraint],
    ] as const
  )
    .map(([label, value]) => (value ? `${label} ${oneLine(value, 200)}` : undefined))
    .filter((part): part is string => part !== undefined);
  return parts.length ? parts.join(', ') : undefined;
}

/** The report: what failed and where, and which files are with it. */
export function failureReport(
  input: Pick<MigrationFailureInput, 'error' | 'migration'>,
  files: { written: string[]; notWritten: string[] },
  now: Date
): string {
  if (input.error instanceof MigrationRefusal) return refusalReport(input.error, files, now);
  // Without its DETAIL, its SQL, or the values its message quotes (utils/dbErrorText.ts).
  const error = publicDbError(input.error);
  const migration = input.migration;
  const lines: string[] = [
    'Nuggets: a database migration failed',
    '',
    `Written ${now.toISOString()} by Nuggets ${oneLine(appVersion(), 80)} (commit ${oneLine(appCommit(), 80)}), as the backend started.`,
    '',
  ];
  const field = (label: string, value: string | undefined) => {
    if (value) lines.push(`${`${label}:`.padEnd(12)}${value}`);
  };

  if (migration) {
    field('Migration', migration.filename);
    lines.push(
      migration.noTransaction
        ? '            It runs outside a transaction (-- nuggets:no-transaction): the statements before the failing one stay applied, and it runs again from its start next time.'
        : '            It runs in one transaction, which was rolled back: the database is as it was before it.'
    );
  } else {
    field('Migration', 'none: the runner stopped before it ran one (reading the applied migrations, loading the baseline, checking the migration history, or waiting for another runner).');
  }
  if (error) {
    field('Error code', `${oneLine(error.code, 20)} (SQLSTATE)`);
    field('Message', oneLine(error.message));
    field('Object', namedObject(error));
    field('In', error.where ? oneLine(error.where) : undefined);
    field('Hint', error.hint ? oneLine(error.hint) : undefined);
    const line = migration ? failedLine(migration, error.position) : null;
    field('At', line ? `line ${line} of ${migration!.filename}` : undefined);
  } else {
    field('Message', oneLine(dbErrorLine(input.error)));
  }
  lines.push(
    '',
    "Left out: the database's DETAIL for the error, and the SQL it ran. What the message or its",
    'hint quotes is shown as "…" unless it is a name the Object line gives, and what they hold in',
    'parentheses as (…). A value a RAISE wrote unquoted can still be there: read this before you post it.',
    ''
  );

  lines.push(...filesLines(files));
  lines.push(
    '',
    'To report it, open an issue with this report, the files and the log of the failed start.',
    'Each failed start replaces these files.',
    ''
  );
  return lines.join('\n');
}

/** The files written with a report, and those that weren't, as lines. */
function filesLines(files: { written: string[]; notWritten: string[] }): string[] {
  const lines: string[] = [];
  if (files.written.length) {
    lines.push('Written with this report, in this directory:');
    for (const file of files.written) {
      const what = file === FAILURE_SCHEMA_FILE
        ? "the database's schema (pg_dump --schema-only), without a row"
        : 'the migrations the database has applied (the rows of schema_migrations)';
      lines.push(`  ${file}: ${what}`);
    }
  }
  if (files.notWritten.length) lines.push(`Not written (the backend's log says why): ${files.notWritten.join(', ')}`);
  return lines;
}

/**
 * The report for a database the runner refused (MigrationRefusal): no migration failed and
 * nothing was changed, and the refusal says what to do, so it says that rather than ask for
 * an issue. Its message is the runner's own (versions, names and checksums), with no row of
 * the database in it.
 */
function refusalReport(refusal: MigrationRefusal, files: { written: string[]; notWritten: string[] }, now: Date): string {
  return [
    'Nuggets: the migration runner refused this database, and changed nothing in it',
    '',
    `Written ${now.toISOString()} by Nuggets ${oneLine(appVersion(), 80)} (commit ${oneLine(appCommit(), 80)}), as the backend started.`,
    '',
    'Why, and what to do:',
    '',
    ...refusal.message.split('\n').map((line) => `  ${oneLine(line, 2000)}`),
    '',
    'The backend starts once the database is one this release can migrate. From a release before',
    'v2.4.0, go to v2.4.0 first and wait until it is ready (GET /api/ready answers 200), then to this one.',
    '',
    ...filesLines(files),
    '',
    'Each refused start replaces these files.',
    '',
  ].join('\n');
}

/**
 * Write the report and the two files to the backups directory. Never throws: what it
 * couldn't write is in `notWritten`, and the files of that name left from an earlier
 * failure are removed, so the directory never pairs this report with an older file.
 */
export async function writeMigrationFailureFiles(input: MigrationFailureInput): Promise<MigrationFailureFiles> {
  const dir = input.dir ?? backupsDirectory();
  const now = input.now ?? new Date();
  const written: string[] = [];
  const notWritten: { file: string; reason: string }[] = [];

  const attempt = async (file: string, write: (filePath: string) => Promise<unknown>) => {
    const filePath = path.join(dir, file);
    try {
      await write(filePath);
      written.push(file);
    } catch (err) {
      notWritten.push({ file, reason: reasonOf(err) });
      await fsp.rm(filePath, { force: true }).catch(() => {});
    }
  };

  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    const reason = reasonOf(err);
    return { dir, written, notWritten: [FAILURE_MIGRATIONS_FILE, FAILURE_SCHEMA_FILE, FAILURE_REPORT_FILE].map((file) => ({ file, reason })) };
  }

  await attempt(FAILURE_MIGRATIONS_FILE, async (filePath) => {
    // The migration pool's own query builder; not destroyed, which would end the pool.
    const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool: input.pool }) });
    const migrations = await db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${LISTING_TIMEOUT}, true), set_config('lock_timeout', ${LISTING_TIMEOUT}, true)`.execute(trx);
      return appliedMigrations(trx);
    });
    await writePrivateFile(filePath, migrationsListing(migrations, now));
  });
  await attempt(FAILURE_SCHEMA_FILE, (filePath) =>
    writeSchemaDump(filePath, { location: input.location, credentials: input.credentials })
  );
  await attempt(FAILURE_REPORT_FILE, (filePath) =>
    writePrivateFile(filePath, failureReport(input, { written: [...written], notWritten: notWritten.map((n) => n.file) }, now))
  );
  return { dir, written, notWritten };
}

/**
 * The migrate script's failure path: write the files and log where they are, or why one
 * isn't there. Never throws, so the migration's own error is what the script exits with.
 */
export async function reportMigrationFailure(input: MigrationFailureInput): Promise<void> {
  try {
    const result = await writeMigrationFailureFiles(input);
    for (const { file, reason } of result.notWritten) {
      logger.error({ file: path.join(result.dir, file), reason }, 'Could not write a migration failure file');
    }
    if (result.written.length) {
      logger.error(
        { dir: result.dir, files: result.written.map((file) => path.join(result.dir, file)) },
        input.error instanceof MigrationRefusal
          ? 'The migration runner refused this database: its report, the schema and the applied migrations are in the backups directory (BACKUPS_PATH on the host)'
          : 'A migration failed: its report, the schema and the applied migrations are in the backups directory (BACKUPS_PATH on the host), to attach to an issue with this log'
      );
    }
  } catch (err) {
    logger.error({ err }, 'Could not write the migration failure files');
  }
}
