import type { Response } from 'express';
import { createWriteStream } from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { sql, type Kysely } from 'kysely';
import { escapeLiteral } from 'pg';
import type { DB } from '../db/schema.generated.js';
import { getDbLocation, getOwnerCredentials, type DbCredentials, type DbLocation } from '../db/dbConfig.js';
import { spawnPgTool, stopPgTool } from '../utils/pgTools.js';
import { appCommit, appVersion } from '../utils/appVersion.js';
import { isCalendarDate } from '../utils/calendarDate.js';
import { contentDisposition } from '../utils/uploadSafety.js';

/**
 * The two files a deployment admin downloads from Settings → Utilities to report a failed
 * migration: the database's schema (`pg_dump --schema-only`, no rows) and the
 * migrations it has applied (`schema_migrations`). Neither holds a ledger's data.
 *
 * The migrate script writes the same two files to the backups directory when a migration
 * fails on startup (services/migrationFailureFiles.ts), before the server exists.
 * So this module loads without the app's serving pool: the two functions that use it
 * (the deployment's today, the app's connection) import it when they run.
 */

/** The longest a schema download's pg_dump may run; it is stopped after it. */
export const SCHEMA_DUMP_TIME_LIMIT_MS = 60_000;
/** The most a schema download may send. Nuggets' schema is about half a megabyte. */
export const SCHEMA_DUMP_MAX_BYTES = 32 * 1024 * 1024;
/** How long pg_dump waits for a table's lock (a migration or a restore holding it) before it fails. */
const LOCK_WAIT_TIMEOUT = '15s';
/** How much of pg_dump's stderr the log gets. */
const MAX_STDERR_CHARS = 16 * 1024;
/** How long a stopped pg_dump has to exit on SIGTERM before it gets SIGKILL. */
const KILL_GRACE_MS = 5_000;

/** A value from the environment as it may stand in a file name: letters, digits, `.`, `_`, `-`. */
export function fileNamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|-+$/g, '').slice(0, 40) || 'unknown';
}

/** `nuggets-schema-1.0.0-2026-11-03.sql`: this build's version and the deployment's today. */
export async function downloadFileName(kind: 'schema' | 'migrations'): Promise<string> {
  const { appToday } = await import('../utils/appDate.js');
  const today = await appToday();
  return `nuggets-${kind}-${fileNamePart(appVersion())}-${isCalendarDate(today) ? today : 'undated'}.sql`;
}

/** A value from the environment as it may stand in a one-line SQL comment: printable ASCII. */
const commentText = (value: string): string => value.replace(/[^\x20-\x7e]/g, '?').slice(0, 80);

/** The comment lines a download starts with: what it is, and which build made it when. */
function fileHeader(title: string, now: Date): string {
  return [
    `-- ${title}`,
    `-- Nuggets ${commentText(appVersion())} (commit ${commentText(appCommit())}), exported ${now.toISOString()}.`,
    '--',
    '',
  ].join('\n');
}

/** Every occurrence of `secret` in `text` replaced, so a log line can't carry it. */
export function withoutSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

/**
 * pg_dump's stderr as the log may have it: its own messages (`pg_dump: error: …`) with the
 * password taken out, and none of the SQL it ran. The SQL of a query that failed (its
 * `detail: Query was:` lines, and a single-row query's "instead of one:" text) is left out,
 * and so is every line not prefixed by pg_dump: the server's continuation lines
 * (`LINE 1: SELECT …`, the caret under it, `QUERY:`, `CONTEXT:`) quote the query. No query
 * goes in a log line (CLAUDE.md, Logging); pg_dump's own catalog queries hold no ledger's
 * data, but they are left out all the same.
 */
export function stderrForLog(stderr: string, password: string): string {
  const kept: string[] = [];
  let leftOut = false;
  for (const line of withoutSecret(stderr, password).split('\n')) {
    if (/^pg_dump: detail: Query was:/.test(line)) {
      kept.push('pg_dump: detail: Query was: [left out]');
    } else if (/^pg_dump: /.test(line)) {
      // pg_dump's "query returned N rows instead of one: <the query>".
      kept.push(line.replace(/( instead of one:).*$/, '$1 [query left out]'));
    } else if (line.trim()) {
      leftOut = true;
    }
  }
  if (leftOut) kept.push('[other lines left out]');
  return kept.join('\n').trim();
}

/** pg_dump's arguments for the schema of `location`'s database, connecting as `user`. */
export function schemaDumpArgs(location: DbLocation, user: string): string[] {
  return [
    '-h', location.host,
    '-p', String(location.port),
    '-U', user,
    '-d', location.database,
    '--schema-only',
    // Statistics hold sample values from the rows; --schema-only leaves them out, and this
    // says so whatever a later pg_dump's default.
    '--no-statistics',
    // A subscription's connection string can hold a password. Nuggets has none.
    '--no-subscriptions',
    '--no-password',
    `--lock-wait-timeout=${LOCK_WAIT_TIMEOUT}`,
    // As backups do: pg-boss's schema holds only its job queue's state.
    '--exclude-schema=pgboss',
  ];
}

/** Why a schema dump ended without a whole file. */
export type SchemaDumpFailure = 'failed' | 'timeout' | 'too-large' | 'aborted' | 'shutdown';

/**
 * A schema dump that didn't finish. Its message is for the server log (how pg_dump ended,
 * and its stderr with the password taken out), never for an answer.
 */
export class SchemaDumpError extends Error {
  constructor(
    message: string,
    readonly reason: SchemaDumpFailure,
    /** Whether part of the file had been sent: then the connection was cut, not answered. */
    readonly afterOutput: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'SchemaDumpError';
  }
}

/** The running schema dumps' stop functions, for a shutdown (stopSchemaDownloads). */
const runningDumps = new Set<(reason: SchemaDumpFailure, why: string) => void>();
/** A shutdown has begun: no schema dump starts. */
let refusingDumps = false;

/**
 * At the start of a shutdown: no schema dump starts from now on, and each running one is
 * stopped (its answer is a 503, or its connection is cut). A dump can take longer than a
 * shutdown may, and the admin can make it again once the server is back. Returns how many
 * it stopped.
 */
export function stopSchemaDownloads(): number {
  refusingDumps = true;
  const stops = [...runningDumps];
  for (const stop of stops) stop('shutdown', 'the server is shutting down');
  return stops.length;
}

export interface SchemaDumpOptions {
  /** Undefined: the server's own (getDbLocation). */
  location?: DbLocation | undefined;
  /** The role pg_dump connects as. Undefined: the schema owner, as backups use. */
  credentials?: DbCredentials | undefined;
  timeLimitMs?: number;
  maxBytes?: number;
  /** How long a stopped pg_dump has to exit on SIGTERM before it gets SIGKILL. */
  killGraceMs?: number;
}

/**
 * Stream a schema-only pg_dump of the app's database into `res`, as the download
 * `fileName`. Nothing is written to disk.
 *
 * The answer's headers wait for pg_dump's first output, so a dump that fails before it
 * writes anything rejects with nothing sent, and the caller answers in the error shape.
 * pg_dump writes a plain-format dump only once it has read the whole catalog, so that is
 * nearly every failure: it can't connect, a role or a lock problem. One that ends after
 * its output began (an error midway, the time limit, the size cap) cuts the connection,
 * so the browser's download fails rather than keep a cut-off file; the promise then
 * rejects with `afterOutput` set. A caller that has gone away, or goes, stops pg_dump.
 *
 * The time limit holds whatever pg_dump does: a stopped one gets SIGTERM, then SIGKILL
 * after `killGraceMs`, and the promise settles when it is stopped, not when it exits.
 */
export function streamSchemaDump(res: Response, fileName: string, options: SchemaDumpOptions = {}): Promise<{ bytes: number }> {
  if (refusingDumps) {
    return Promise.reject(new SchemaDumpError('pg_dump was not started: the server is shutting down', 'shutdown', false));
  }
  // The caller went away while the route was getting ready (the file name): start nothing.
  if (res.destroyed || res.writableEnded) {
    return Promise.reject(new SchemaDumpError('pg_dump was not started: the client had closed the connection', 'aborted', false));
  }
  const location = options.location ?? getDbLocation();
  const credentials = options.credentials ?? getOwnerCredentials();
  const timeLimitMs = options.timeLimitMs ?? SCHEMA_DUMP_TIME_LIMIT_MS;
  const maxBytes = options.maxBytes ?? SCHEMA_DUMP_MAX_BYTES;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const header = fileHeader('Nuggets database schema: pg_dump --schema-only, with no rows.', new Date());

  return new Promise((resolve, reject) => {
    const child = spawnPgTool('pg_dump', schemaDumpArgs(location, credentials.user), credentials.password, 'download');
    let stderr = '';
    let bytes = 0;
    let stopped = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    /** Why it ended, for the log: how, and pg_dump's stderr with the password taken out. */
    const failure = (ending: string, reason: SchemaDumpFailure, cause?: unknown) => {
      const detail = stderrForLog(stderr, credentials.password);
      return new SchemaDumpError(`pg_dump ${ending}${detail ? `: ${detail}` : ''}`, reason, res.headersSent, cause ? { cause } : undefined);
    };
    const cut = () => {
      if (res.headersSent && !res.destroyed) res.destroy();
    };
    const settle = (error: SchemaDumpError | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      runningDumps.delete(stop);
      res.off('close', onClose);
      if (error) reject(error);
      else resolve({ bytes });
    };
    const stop = (reason: SchemaDumpFailure, why: string) => {
      if (stopped) return;
      stopped = true;
      stopPgTool(child, 'SIGTERM');
      // One that ignores SIGTERM, or hangs in it (its cancel request to an unreachable
      // server), still goes.
      killTimer = setTimeout(() => stopPgTool(child, 'SIGKILL'), killGraceMs);
      killTimer.unref();
      cut();
      settle(failure(`was stopped: ${why}`, reason));
    };
    runningDumps.add(stop);
    const timer = setTimeout(() => stop('timeout', `it took longer than ${timeLimitMs} ms`), timeLimitMs);
    // The caller went away (closed the tab, cancelled): there is no one to send the rest to.
    const onClose = () => {
      if (!res.writableFinished) stop('aborted', 'the client closed the connection');
    };
    res.on('close', onClose);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });

    child.stdout.on('data', (chunk: Buffer) => {
      if (stopped) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop('too-large', `its output passed ${maxBytes} bytes`);
        return;
      }
      if (!res.headersSent) {
        res.status(200);
        res.setHeader('Content-Type', 'application/sql; charset=utf-8');
        res.setHeader('Content-Disposition', contentDisposition('attachment', fileName));
        res.setHeader('Cache-Control', 'no-store');
        res.write(header);
      }
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once('drain', () => child.stdout.resume());
      }
    });

    child.on('error', (error) => {
      stopped = true;
      cut();
      settle(failure(`could not start: ${error.message}`, 'failed', error));
    });

    child.on('close', (code, signal) => {
      clearTimeout(killTimer);
      if (settled) return;
      if (code === 0 && res.headersSent) {
        res.end();
        settle(null);
        return;
      }
      cut();
      settle(failure(code === 0 ? 'wrote nothing' : signal ? `was ended by ${signal}` : `exited with code ${code}`, 'failed'));
    });
  });
}

/** Where a file is written before it is renamed over `filePath`: next to it, hidden, this process's. */
function scratchPathFor(filePath: string): string {
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
}

/**
 * Write `content` to `filePath`, readable by its owner only (0600). It is written to a new
 * file next to it, then renamed over it: a reader never sees half of it, and a file or
 * link already at `filePath` is replaced, not written through.
 */
export async function writePrivateFile(filePath: string, content: string): Promise<void> {
  const scratch = scratchPathFor(filePath);
  await fsp.rm(scratch, { force: true });
  try {
    await fsp.writeFile(scratch, content, { mode: 0o600, flag: 'wx' });
    await fsp.rename(scratch, filePath);
  } catch (err) {
    await fsp.rm(scratch, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Write a schema-only pg_dump of the app's database to `filePath`, readable by its owner
 * only (0600): the download's file, with its header, as the migrate script leaves it when
 * a migration fails. pg_dump runs as for the download (the backup role), within
 * the same time limit and size cap. It writes to a new file next to `filePath`, renamed
 * over it only once pg_dump has exited cleanly, so a dump that fails leaves no file of
 * its own. Rejects with a SchemaDumpError whose message is for the log; settles once
 * pg_dump has exited.
 */
export async function writeSchemaDump(filePath: string, options: SchemaDumpOptions = {}): Promise<{ bytes: number }> {
  const location = options.location ?? getDbLocation();
  const credentials = options.credentials ?? getOwnerCredentials();
  const timeLimitMs = options.timeLimitMs ?? SCHEMA_DUMP_TIME_LIMIT_MS;
  const maxBytes = options.maxBytes ?? SCHEMA_DUMP_MAX_BYTES;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const scratch = scratchPathFor(filePath);
  await fsp.rm(scratch, { force: true });

  const out = createWriteStream(scratch, { mode: 0o600, flags: 'wx' });
  const opened = new Promise<void>((resolve, reject) => {
    out.once('open', () => resolve());
    out.once('error', reject);
  });
  const closed = new Promise<void>((resolve) => out.once('close', () => resolve()));
  try {
    await opened;
  } catch (err) {
    throw new SchemaDumpError(`the schema file could not be created: ${(err as Error).message}`, 'failed', false, { cause: err });
  }
  out.write(fileHeader('Nuggets database schema: pg_dump --schema-only, with no rows.', new Date()));

  const dumped = new Promise<{ bytes: number }>((resolve, reject) => {
    const child = spawnPgTool('pg_dump', schemaDumpArgs(location, credentials.user), credentials.password, 'download');
    let stderr = '';
    let bytes = 0;
    let failed: SchemaDumpError | null = null;
    let killTimer: NodeJS.Timeout | undefined;

    const failure = (ending: string, reason: SchemaDumpFailure, cause?: unknown) => {
      const detail = stderrForLog(stderr, credentials.password);
      return new SchemaDumpError(`pg_dump ${ending}${detail ? `: ${detail}` : ''}`, reason, false, cause ? { cause } : undefined);
    };
    const stop = (reason: SchemaDumpFailure, why: string) => {
      if (failed) return;
      failed = failure(`was stopped: ${why}`, reason);
      stopPgTool(child, 'SIGTERM');
      // One that ignores SIGTERM still goes; this waits for it to exit.
      killTimer = setTimeout(() => stopPgTool(child, 'SIGKILL'), killGraceMs);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop('timeout', `it took longer than ${timeLimitMs} ms`), timeLimitMs);
    out.on('error', (err) => stop('failed', `the schema file could not be written: ${err.message}`));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk;
    });
    child.stdout.on('data', (chunk: Buffer) => {
      if (failed) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        stop('too-large', `its output passed ${maxBytes} bytes`);
        return;
      }
      if (!out.write(chunk)) {
        child.stdout.pause();
        out.once('drain', () => child.stdout.resume());
      }
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(failed ?? failure(`could not start: ${error.message}`, 'failed', error));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failed) reject(failed);
      else if (code === 0 && bytes > 0) resolve({ bytes });
      else reject(failure(code === 0 ? 'wrote nothing' : signal ? `was ended by ${signal}` : `exited with code ${code}`, 'failed'));
    });
  });

  try {
    const result = await dumped;
    out.end();
    await closed;
    // A write that failed after pg_dump's last output.
    if (out.errored) throw new SchemaDumpError(`the schema file could not be written: ${out.errored.message}`, 'failed', false);
    await fsp.rename(scratch, filePath);
    return result;
  } catch (err) {
    out.destroy();
    await closed;
    await fsp.rm(scratch, { force: true }).catch(() => {});
    throw err;
  }
}

export interface AppliedMigration {
  version: string;
  name: string;
  checksum: string;
  /** When it ran, in UTC: `YYYY-MM-DD HH:MM:SS.ffffff+00`. */
  applied_at: string;
}

/**
 * The migrations the database has applied, oldest first, as the migration runner reads
 * them (MigrationService.getAppliedMigrations); null when it has no schema_migrations
 * table. The table has no tenant_id (no RLS), and the serving role may read it. `db` is
 * the app's connection (globalDb) unless given: the migrate script passes its own.
 */
export async function appliedMigrations(db?: Kysely<DB>): Promise<AppliedMigration[] | null> {
  const executor = db ?? (await import('../db/withTenant.js')).globalDb;
  const { rows } = await sql<{ present: boolean }>`
    SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present
  `.execute(executor);
  if (!rows[0]?.present) return null;
  return executor
    .selectFrom('schema_migrations')
    .select(['version', 'name', 'checksum'])
    // In UTC whatever the session's zone; the cast also reads a drifted naive column.
    .select(sql<string>`to_char(applied_at::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00'`.as('applied_at'))
    .orderBy('version')
    .execute();
}

/**
 * The applied migrations as SQL: a header, then one INSERT per migration, oldest first.
 * Loaded after the schema file into an empty database, it gives that database this one's
 * migration history, so the next `migrate` tries what this database's did.
 */
export function migrationsListing(migrations: AppliedMigration[] | null, now: Date = new Date()): string {
  const lines = [fileHeader('Nuggets applied migrations: the rows of schema_migrations.', now)];
  if (migrations === null) {
    lines.push('-- This database has no schema_migrations table: no migration has been recorded in it.', '');
    return lines.join('\n');
  }
  const oldest = migrations[0];
  const newest = migrations.at(-1);
  const range = oldest && newest ? ` (oldest ${commentText(oldest.version)}, newest ${commentText(newest.version)})` : '';
  lines.push(
    `-- Migrations applied: ${migrations.length}${range}.`,
    '-- Each row: the migration\'s version and name, the SHA-256 of its UP part when it ran',
    '-- (compare it with the file\'s), and when it ran (UTC).',
    '',
  );
  for (const m of migrations) {
    const values = [m.version, m.name, m.checksum, m.applied_at].map((value) => escapeLiteral(String(value)).trim()).join(', ');
    lines.push(`INSERT INTO public.schema_migrations (version, name, checksum, applied_at) VALUES (${values});`);
  }
  lines.push('');
  return lines.join('\n');
}
