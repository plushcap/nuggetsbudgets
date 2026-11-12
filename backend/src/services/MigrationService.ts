import { Pool, PoolClient } from 'pg';
import { Kysely, PostgresDialect, sql } from 'kysely';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { DB } from '../db/schema.generated.js';
import { createLogger } from '../utils/logger.js';
import { splitSqlStatements } from '../utils/splitSqlStatements.js';
import { config } from '../config.js';
import { dbErrorForLog } from '../utils/dbErrorText.js';
import { oneRow } from '../utils/present.js';
import {
  BASELINE,
  BASELINE_FINGERPRINT_PATH,
  V2_4_0_CUTOVER_PATH,
  editedHistoryMessage,
  migrationHistory,
  mixedHistoryMessage,
  olderHistoryMessage,
  unknownHistoryMessage,
  type MigrationHistory,
} from '../db/baseline.js';
import { V2_4_0_MIGRATIONS } from '../db/v240Migrations.js';
import { compareFingerprints, parseFingerprint, schemaFingerprint, type SchemaDrift } from '../db/schemaFingerprint.js';

/**
 * The runner won't migrate this database as it stands, and has changed nothing: its history
 * is one it can't upgrade, an applied migration's file was edited or is gone, or a file isn't
 * newer than the baseline. Its message says what was found and what to do; `migrate status`
 * reports the same one.
 */
export class MigrationRefusal extends Error {
  constructor(message: string, readonly history?: MigrationHistory['kind']) {
    super(message);
    this.name = 'MigrationRefusal';
  }
}

const logger = createLogger({ service: 'MigrationService' });

export interface Migration {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  appliedAt?: Date;
}

export interface MigrationFile {
  version: string;
  name: string;
  filename: string;
  fullPath: string;
  upSql: string;
  downSql?: string;
  checksum: string;
  /** `-- nuggets:no-transaction`: each statement runs on its own, outside a transaction. */
  noTransaction: boolean;
}

export interface MigrationStatus {
  /** False when the database has no schema_migrations table yet (an empty database). */
  initialized: boolean;
  /**
   * What its history is (db/baseline.ts): empty (migrate loads the baseline), at the
   * baseline, v2.4.0's (migrate cuts it over), or one migrate refuses (`refusal` says why).
   * Absent for a standalone runner.
   */
  history?: MigrationHistory['kind'];
  /** Why migrate refuses this database (MigrationRefusal: the same message migrate gives). */
  refusal?: string;
  /** The baseline first, when the database has its row, then the migration files applied. */
  applied: { version: string; name: string; appliedAt: string }[];
  /** The baseline first, when migrate would load it or cut the database over to it, then the files not applied. */
  pending: { version: string; name: string }[];
}

export interface MigrationServiceOptions {
  /** The migration files' directory (default: ./migrations). */
  migrationsDir?: string;
  /**
   * The baseline schema (backend/init.sql) `migrate()` loads into an empty database before
   * applying migrations. Without it, an empty database is refused.
   */
  baselinePath?: string;
  /**
   * The SQL that turns a v2.4.0 database's schema into the baseline's (default:
   * backend/upgrade/from-v2.4.0.sql). Its SHA-256 must be the baseline's checksum.
   */
  cutoverPath?: string;
  /** A fresh baseline's schema fingerprint, a cut-over database is compared with (default: upgrade/baseline-fingerprint.txt). */
  fingerprintPath?: string;
  /**
   * Whether that comparison counts the fixed roles' privileges (default true). A restore
   * leaves the backup's privileges out and gives the database this code's after migrating
   * it (BackupService), so a restore's comparison doesn't.
   */
  compareGrants?: boolean;
  /**
   * A runner over a migrations directory of its own (the runner's tests): its database's
   * history is that directory's migrations alone, from nothing, with no baseline row, no
   * v2.4.0 cutover and no refusal of another history.
   */
  standalone?: boolean;
  /** How long one statement may wait for a table lock (Postgres `lock_timeout`). */
  lockTimeout?: string;
  /** How many times a migration that timed out waiting for a lock is tried again. */
  lockRetries?: number;
  /** Milliseconds to wait before retry `attempt` (1-based) after a lock timeout. */
  retryDelayMs?: (attempt: number) => number;
  /** How long to wait for another runner to release the migration lock. */
  runnerLockWaitMs?: number;
  /** How often to try for the migration lock while another runner holds it. */
  runnerLockPollMs?: number;
}

/** A line of its own in a migration's UP part: run its statements one at a time, outside a transaction. */
const NO_TRANSACTION_DIRECTIVE = /^--\s*nuggets:no-transaction\s*$/im;
const DOWN_MARKER = /^--\s*===\s*DOWN\s*===\s*$/im;
/** SQLSTATE lock_not_available: lock_timeout expired. */
const LOCK_NOT_AVAILABLE = '55P03';

const DEFAULT_LOCK_TIMEOUT = '5s';
const DEFAULT_LOCK_RETRIES = 4;
const DEFAULT_RUNNER_LOCK_WAIT_SECONDS = 600;

/**
 * MigrationService
 *
 * Applies the timestamped SQL migrations in backend/migrations, records them in
 * schema_migrations, and rolls them back.
 *
 * - Version tracking by the file's 14-digit timestamp; a checksum of each applied file's
 *   UP part (line endings normalized) detects a migration edited after it ran.
 * - An empty database is first given the baseline schema (init.sql), so a plain Postgres
 *   needs nothing loaded beforehand. The baseline is one schema_migrations row of
 *   its own (db/baseline.ts), with no file; every migration file is newer than it.
 * - A database whose history is exactly v2.4.0's migrations (db/v240Migrations.ts) is cut
 *   over to the baseline: upgrade/from-v2.4.0.sql, then their rows replaced by the
 *   baseline's, in one transaction. One with another history (an older release, or
 *   migrations this code doesn't know) is refused, unchanged.
 * - Each migration runs in its own transaction, unless its UP part has a
 *   `-- nuggets:no-transaction` line: then each statement runs on its own (for
 *   `CREATE INDEX CONCURRENTLY` and the like, which a transaction refuses).
 * - A statement waits at most `lock_timeout` for a table lock, so a migration can't queue
 *   behind a long query and block everything behind it; a migration that timed out is
 *   retried a few times.
 * - migrate and rollback hold an advisory lock, so two runners never interleave; one that
 *   finds the lock taken says who holds it, and gives up after a while.
 *
 * Migration File Format:
 * - Filename: YYYYMMDDHHMMSS_description.sql
 * - Content sections separated by -- === DOWN === marker
 *
 * Example migration file:
 * ```sql
 * -- Add user_preferences table
 * CREATE TABLE user_preferences (
 *   id SERIAL PRIMARY KEY,
 *   user_id INTEGER REFERENCES users(id)
 * );
 *
 * -- === DOWN ===
 * DROP TABLE IF EXISTS user_preferences;
 * ```
 */
/** SQLSTATEs of a statement that makes an object a database already has (42P07 a table, 42723 a function, …). */
const DUPLICATE_OBJECT = new Set(['42P06', '42P07', '42701', '42710', '42723']);

/**
 * A failure loading the baseline into an empty database. The migrate script's lines and its
 * failure report leave out what an error quotes (utils/dbErrorText.ts), as SQL can quote a
 * row's values there. A duplicate object's message quotes only the name of what is in the
 * way (`function "app_today" already exists`), which the operator needs, so that one keeps
 * it, with what to do; any other error is left as it is, and redacted as before.
 */
export function baselineLoadError(database: string, error: unknown): unknown {
  const e = (error ?? {}) as { code?: unknown; message?: unknown };
  if (typeof e.code !== 'string' || typeof e.message !== 'string' || !DUPLICATE_OBJECT.has(e.code)) return error;
  return new Error(
    `Loading the baseline into database "${database}" failed, and was rolled back: ${e.code}: ${e.message}. Something ` +
      'the baseline creates is in it already (left by an earlier install, or made by hand): drop it, or point DB_NAME ' +
      'at an empty database.',
    { cause: error }
  );
}

/**
 * Why the runner refuses a database with no migration history whose public schema holds
 * objects all the same: the baseline loads only into an empty one.
 */
function leftoversMessage(database: string, objects: { label: string; count: number }): string {
  return (
    `Database "${database}" has no Nuggets migration history (schema_migrations is missing or empty), but its public ` +
    `schema isn't empty: ${objects.count} object(s), ${objects.label}. Nuggets loads its schema only into an empty ` +
    "database. If this is a Nuggets database whose schema_migrations was dropped or emptied, restore a backup; " +
    'otherwise point DB_NAME at an empty database, or drop those objects. Nothing was changed.'
  );
}

export class MigrationService {
  private migrationsDir: string;
  private db: Kysely<DB>;
  private options: Required<Omit<MigrationServiceOptions, 'migrationsDir' | 'baselinePath'>> & { baselinePath: string | undefined };
  /** The migration the last migrate() stopped at, for the migrate script's report. */
  private lastFailed: MigrationFile | null = null;
  /** What the last cutover's comparison with a fresh baseline found (cutoverDrift). */
  private lastDrift: SchemaDrift | null = null;
  /** Whether the last migrate() cut a v2.4.0 database over (cutOver). */
  private lastCutOver = false;

  // Fixed key for the session-level advisory lock that serializes migrate() and
  // rollback() across processes (e.g. multiple backend containers starting at once). The
  // value is arbitrary but must be stable; it fits in a Postgres bigint.
  private static readonly MIGRATION_LOCK_KEY = 4242042042;

  constructor(
    private pool: Pool,
    migrationsPathOrOptions?: string | MigrationServiceOptions
  ) {
    const options: MigrationServiceOptions =
      typeof migrationsPathOrOptions === 'string' ? { migrationsDir: migrationsPathOrOptions } : migrationsPathOrOptions ?? {};
    this.migrationsDir = options.migrationsDir || path.join(process.cwd(), 'migrations');
    const settings = config();
    const waitSeconds = Number(settings.MIGRATION_LOCK_WAIT_SECONDS);
    const retries = Number(settings.MIGRATION_LOCK_RETRIES);
    this.options = {
      baselinePath: options.baselinePath,
      cutoverPath: options.cutoverPath ?? V2_4_0_CUTOVER_PATH,
      fingerprintPath: options.fingerprintPath ?? BASELINE_FINGERPRINT_PATH,
      compareGrants: options.compareGrants ?? true,
      standalone: options.standalone ?? false,
      lockTimeout: options.lockTimeout ?? (settings.MIGRATION_LOCK_TIMEOUT || DEFAULT_LOCK_TIMEOUT),
      lockRetries: options.lockRetries ?? (Number.isInteger(retries) && retries >= 0 ? retries : DEFAULT_LOCK_RETRIES),
      retryDelayMs: options.retryDelayMs ?? ((attempt) => Math.min(30_000, 2_000 * 2 ** (attempt - 1))),
      runnerLockWaitMs:
        options.runnerLockWaitMs ?? (waitSeconds > 0 ? waitSeconds : DEFAULT_RUNNER_LOCK_WAIT_SECONDS) * 1000,
      runnerLockPollMs: options.runnerLockPollMs ?? 1000,
    };
    this.db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
  }

  /**
   * The migrations table, with its comments. The baseline (init.sql) creates it; this
   * creates it for a runner with no baseline to load.
   */
  private async ensureMigrationsTable(): Promise<void> {
    await sql`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version VARCHAR(14) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        checksum VARCHAR(64) NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        execution_time_ms INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at
      ON schema_migrations(applied_at);

      COMMENT ON TABLE schema_migrations IS
      'Tracks applied database migrations for version control';

      COMMENT ON COLUMN schema_migrations.version IS
      'Migration version in format YYYYMMDDHHMMSS';

      COMMENT ON COLUMN schema_migrations.checksum IS
      'SHA256 checksum of migration file content to detect modifications';
    `.execute(this.db);
  }

  /**
   * SHA256 of a migration's UP part. Line endings are normalized first, so a checkout that
   * turned LF into CRLF (Windows, core.autocrlf) hashes the same as the LF file.
   */
  static checksum(content: string): string {
    return crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
  }

  /**
   * Parse a migration file into up and down sections
   */
  static parseMigration(content: string): { upSql: string; downSql: string | undefined; noTransaction: boolean } {
    const match = content.match(DOWN_MARKER);
    let upSql = content.trim();
    let downSql: string | undefined;
    if (match && match.index !== undefined) {
      upSql = content.substring(0, match.index).trim();
      downSql = content.substring(match.index + match[0].length).trim() || undefined;
    }
    return { upSql, downSql, noTransaction: NO_TRANSACTION_DIRECTIVE.test(upSql) };
  }

  /**
   * Get all migration files from the migrations directory
   */
  private async getMigrationFiles(): Promise<MigrationFile[]> {
    if (!fs.existsSync(this.migrationsDir)) {
      logger.warn({ migrationsDir: this.migrationsDir }, 'Migrations directory not found');
      return [];
    }

    const files = fs.readdirSync(this.migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .filter(f => /^\d{14}_/.test(f)) // Must start with 14-digit timestamp
      .sort(); // Chronological order

    // schema_migrations holds one row per version: of two files with one, one would never run
    // (or be taken for the other, edited).
    const byVersion = new Map<string, string[]>();
    for (const f of files) byVersion.set(f.slice(0, 14), [...(byVersion.get(f.slice(0, 14)) ?? []), f]);
    const shared = [...byVersion].filter(([, names]) => names.length > 1);
    if (shared.length > 0) {
      throw new MigrationRefusal(
        `Migrations share a version, and schema_migrations records one per version: ${shared
          .map(([version, names]) => `${names.join(' and ')} (${version})`)
          .join('; ')}. Give all but one a new version (npm run migrate:create makes one, and rename the file). ` +
          'Nothing was changed.'
      );
    }

    return files.map(filename => {
      const fullPath = path.join(this.migrationsDir, filename);
      const version = filename.substring(0, 14);
      // The baseline holds every migration up to its version (v2.4.0's among them).
      if (!this.options.standalone && version <= BASELINE.version) {
        throw new MigrationRefusal(
          `Migration ${filename} is not newer than the baseline (${BASELINE.version}), which holds the schema up to it: ` +
          'give it a newer timestamp (npm run migrate:create makes one).'
        );
      }
      const name = filename.substring(15, filename.length - 4).replace(/_/g, ' ');

      const { upSql, downSql, noTransaction } = MigrationService.parseMigration(fs.readFileSync(fullPath, 'utf8'));

      return {
        version,
        name,
        filename,
        fullPath,
        upSql,
        ...(downSql !== undefined && { downSql }),
        checksum: MigrationService.checksum(upSql),
        noTransaction,
      };
    });
  }

  /** Whether schema_migrations exists (it doesn't in a database nothing has been loaded into). */
  private async hasMigrationsTable(): Promise<boolean> {
    const { rows } = await sql<{ exists: boolean }>`
      SELECT to_regclass('public.schema_migrations') IS NOT NULL AS exists
    `.execute(this.db);
    return oneRow(rows, 'to_regclass').exists;
  }

  /**
   * Get applied migrations from database. Read-only: none when there's no table yet.
   */
  private async getAppliedMigrations(): Promise<Migration[]> {
    if (!(await this.hasMigrationsTable())) return [];

    const rows = await this.db
      .selectFrom('schema_migrations')
      .select(['version', 'name', 'checksum'])
      .select('applied_at as appliedAt')
      .orderBy('version')
      .execute();

    // `filename` isn't stored in schema_migrations; callers match applied rows
    // to files by version, so it's intentionally absent here (as before).
    return rows as unknown as Migration[];
  }

  /**
   * Get pending migrations that haven't been applied yet, oldest first.
   *
   * One older than the newest applied migration still runs (now, after the ones its
   * version predates), but with a warning naming it: it was written against the schema
   * as it was before them, and this is how a branch merged with main ends up applying
   * main's migrations after its own newer ones.
   */
  async getPendingMigrations(): Promise<MigrationFile[]> {
    const allMigrations = await this.getMigrationFiles();
    const appliedMigrations = await this.getAppliedMigrations();
    const appliedVersions = new Set(appliedMigrations.map(m => m.version));
    const pending = allMigrations.filter(m => !appliedVersions.has(m.version));

    const newestApplied = appliedMigrations.reduce((newest, m) => (m.version > newest ? m.version : newest), '');
    const olderThanApplied = pending.filter(m => m.version < newestApplied);
    if (olderThanApplied.length > 0) {
      logger.warn(
        { newestApplied, migrations: olderThanApplied.map(m => `${m.version} - ${m.name}`) },
        'Pending migrations older than the newest applied one: they run now, after migrations their versions predate'
      );
    }
    return pending;
  }

  /**
   * Why migrate (or, with `rollback`, a rollback) would refuse a database with these rows and
   * these files, or null: the one check migrate, rollback and status share. Unless
   * standalone, the history first (db/baseline.ts): one it can't upgrade, or an edited
   * v2.4.0 migration; a v2.4.0 one migrate cuts over (a rollback refuses it until then).
   * Then each applied migration but the baseline's row has its file, unedited.
   */
  private refusalFor(applied: Migration[], files: MigrationFile[], rollback = false): MigrationRefusal | null {
    if (!this.options.standalone) {
      const history = migrationHistory(applied);
      switch (history.kind) {
        case 'older':
          return new MigrationRefusal(olderHistoryMessage(history), history.kind);
        case 'unknown':
          return new MigrationRefusal(unknownHistoryMessage(history), history.kind);
        case 'mixed':
          return new MigrationRefusal(mixedHistoryMessage(history), history.kind);
        case 'edited':
          return new MigrationRefusal(editedHistoryMessage(history), history.kind);
        case 'v2.4.0':
          return rollback
            ? new MigrationRefusal(
                `This database still has v2.4.0's ${V2_4_0_MIGRATIONS.length} migrations: run migrate, which cuts it over to the ` +
                  `baseline (${BASELINE.version}), first.`,
                history.kind
              )
            : null;
        default:
          break;
      }
    }

    const migrationMap = new Map(files.map(m => [m.version, m]));
    for (const row of applied) {
      // The baseline's own row has no file.
      if (!this.options.standalone && row.version === BASELINE.version) continue;
      const current = migrationMap.get(row.version);
      if (!current) {
        return new MigrationRefusal(
          `Migration ${row.version} (${row.name}) was applied but file is missing!\n` +
          `This could indicate a corrupted migration history.`
        );
      }
      if (current.checksum !== row.checksum) {
        return new MigrationRefusal(
          `Migration ${row.version} (${row.name}) has been modified!\n` +
          `Applied checksum: ${row.checksum}\n` +
          `Current checksum: ${current.checksum}\n` +
          `Never modify migrations that have been applied to production.`
        );
      }
    }
    return null;
  }

  /**
   * What is in public apart from schema_migrations and what extensions made there: relations,
   * functions and types (not an array's or a table's row type), at most ten of them named.
   */
  private async leftovers(): Promise<{ label: string; count: number; database: string }> {
    const { rows } = await sql<{ label: string; database: string }>`
      SELECT o.label, current_database() AS database FROM (
        SELECT CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence'
                              WHEN 'f' THEN 'foreign table' ELSE 'table' END || ' public.' || quote_ident(c.relname) AS label
          FROM pg_class c
         WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
           AND c.relname <> 'schema_migrations'
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
        UNION ALL
        SELECT 'function public.' || quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')'
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
        UNION ALL
        SELECT 'type public.' || quote_ident(t.typname)
          FROM pg_type t
         WHERE t.typnamespace = 'public'::regnamespace AND t.typelem = 0 AND t.typrelid = 0
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
      ) o ORDER BY 1
    `.execute(this.db);
    const database = rows[0]?.database
      ?? oneRow((await sql<{ db: string }>`SELECT current_database() AS db`.execute(this.db)).rows, 'current_database()').db;
    const shown = rows.slice(0, 10).map((r) => r.label).join(', ');
    return { label: rows.length > 10 ? `${shown} and ${rows.length - 10} more` : shown, count: rows.length, database };
  }

  /**
   * Why migrate (with `rollback`, a rollback) would refuse this database as it stands, or
   * null: the one check migrate, rollback, status and the server's start share. A migration
   * file the runner can't take; a database with no history whose public schema isn't empty;
   * then what refusalFor finds in its history.
   */
  private async findRefusal(rollback = false): Promise<MigrationRefusal | null> {
    let files: MigrationFile[];
    try {
      files = await this.getMigrationFiles();
    } catch (error) {
      if (error instanceof MigrationRefusal) return error;
      throw error;
    }
    const applied = await this.getAppliedMigrations();
    if (applied.length === 0) {
      const objects = await this.leftovers();
      return objects.count > 0 ? new MigrationRefusal(leftoversMessage(objects.database, objects), 'empty') : null;
    }
    return this.refusalFor(applied, files, rollback);
  }

  /** Refuse (MigrationRefusal) what findRefusal finds. */
  private async validateMigrations(rollback = false): Promise<void> {
    const refusal = await this.findRefusal(rollback);
    if (refusal) throw refusal;
  }

  /**
   * Run `work`, and again after a pause when it failed because a statement waited longer
   * than lock_timeout for a lock. Trying again is safe: a transactional migration's try is
   * atomic, and a no-transaction one is written to run again from its first statement.
   */
  private async retryOnLockTimeout<T>(what: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (error) {
        if ((error as { code?: string }).code !== LOCK_NOT_AVAILABLE || attempt > this.options.lockRetries) {
          throw error;
        }
        const delayMs = this.options.retryDelayMs(attempt);
        logger.warn(
          { ...what, attempt, retries: this.options.lockRetries, delayMs, lockTimeout: this.options.lockTimeout },
          'A statement waited longer than lock_timeout for a lock (another session holds it); trying again'
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /** Run SQL on one connection inside a transaction, with lock_timeout set for it. */
  private async inTransaction(client: PoolClient, script: string, after?: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try {
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [this.options.lockTimeout]);
      await client.query(script);
      if (after) await after();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  /**
   * Run a migration's SQL (its UP or DOWN part), then `record` (which writes
   * schema_migrations), on one connection. A transactional migration is one transaction,
   * retried whole after a lock timeout; a no-transaction one runs statement by statement,
   * starts again from its first statement after a lock timeout, and is recorded once all of
   * them succeeded.
   */
  private async execute(
    migration: MigrationFile,
    script: string,
    record: (client: PoolClient) => Promise<void>
  ): Promise<void> {
    const client = await this.pool.connect();
    // A migration's RAISE WARNING (a check it left NOT VALID, rows it couldn't fix) and
    // NOTICE (a count it fixed) reach only the database server's log otherwise; an operator
    // reads the upgrade in the backend's. Postgres sends them to this connection.
    const onNotice = (notice: { severity?: string | undefined; message?: string | undefined }) => {
      const entry = { version: migration.version, name: migration.name, severity: notice.severity, message: notice.message };
      if (notice.severity === 'NOTICE' || notice.severity === 'INFO' || notice.severity === 'LOG' || notice.severity === 'DEBUG') {
        logger.debug(entry, 'Migration notice');
      } else {
        logger.warn(entry, 'Migration warning');
      }
    };
    client.on('notice', onNotice);
    try {
      if (!migration.noTransaction) {
        await this.retryOnLockTimeout({ version: migration.version }, () =>
          this.inTransaction(client, script, () => record(client))
        );
        return;
      }
      await client.query(`SELECT set_config('lock_timeout', $1, false)`, [this.options.lockTimeout]);
      const statements = splitSqlStatements(script);
      // After a lock timeout the script starts again from its first statement, not from the
      // one that timed out: a CREATE INDEX CONCURRENTLY that timed out leaves an invalid index
      // behind, which that statement's IF NOT EXISTS would then skip, and the migration would
      // be recorded with the index unusable. Such a script drops the index first, and is
      // written to run again from the top (CONTRIBUTING.md), as it does after any failure.
      const where = { version: migration.version, statement: 0, of: statements.length };
      await this.retryOnLockTimeout(where, async () => {
        for (const [index, statement] of statements.entries()) {
          where.statement = index + 1;
          await client.query(statement);
        }
      });
      await record(client);
    } finally {
      client.off('notice', onNotice);
      // Not back to the pool: the script may have changed session settings (search_path,
      // lock_timeout, row_security, ...).
      client.release(true);
    }
  }

  /**
   * Run a single migration
   */
  private async runMigration(migration: MigrationFile): Promise<number> {
    const startTime = Date.now();

    try {
      logger.info(
        { version: migration.version, name: migration.name, noTransaction: migration.noTransaction || undefined },
        'Running migration'
      );
      await this.execute(migration, migration.upSql, async (client) => {
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum, execution_time_ms) VALUES ($1, $2, $3, $4)',
          [migration.version, migration.name, migration.checksum, Date.now() - startTime]
        );
      });

      const executionTime = Date.now() - startTime;
      logger.info({ version: migration.version, executionTimeMs: executionTime }, 'Migration completed');

      return executionTime;
    } catch (error) {
      this.lastFailed = migration;
      // Without the error's DETAIL, its SQL, or what its message quotes or lists: this line
      // is meant to be posted on an issue (utils/dbErrorText.ts).
      logger.error({ err: dbErrorForLog(error), version: migration.version, name: migration.name }, 'Migration failed');
      if (migration.noTransaction) {
        logger.error(
          { version: migration.version },
          'This migration runs outside a transaction, so the statements before the failing one stay applied; it is not recorded, and runs again from the start next time'
        );
      }
      throw error;
    }
  }

  /**
   * Rollback a single migration
   */
  private async rollbackMigration(migration: MigrationFile): Promise<void> {
    if (!migration.downSql) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) has no DOWN section.\n` +
        `Cannot rollback this migration.`
      );
    }

    try {
      logger.info({ version: migration.version, name: migration.name }, 'Rolling back migration');
      await this.execute(migration, migration.downSql, async (client) => {
        await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
      });
      logger.info({ version: migration.version }, 'Rollback completed');
    } catch (error) {
      logger.error({ err: dbErrorForLog(error), version: migration.version, name: migration.name }, 'Rollback failed');
      throw error;
    }
  }

  /**
   * Run `work` holding the migration advisory lock. Another runner that holds it is
   * waited for, with a log line every 30 s naming it, for at most runnerLockWaitMs.
   */
  private async withRunnerLock<T>(work: () => Promise<T>): Promise<T> {
    const lockConn = await this.pool.connect();
    try {
      const startedAt = Date.now();
      let lastLog = -Infinity;
      for (;;) {
        const { rows } = await lockConn.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
          MigrationService.MIGRATION_LOCK_KEY,
        ]);
        if (oneRow(rows, 'pg_try_advisory_lock').locked) break;

        const waitedMs = Date.now() - startedAt;
        const holder = await this.runnerLockHolder(lockConn);
        if (waitedMs >= this.options.runnerLockWaitMs) {
          throw new Error(
            `Another migration runner has held the migration lock for longer than ${Math.round(
              this.options.runnerLockWaitMs / 1000
            )} s (${holder}); giving up. If it is stuck, end that session (pg_terminate_backend) and start again.`
          );
        }
        if (waitedMs - lastLog >= 30_000) {
          lastLog = waitedMs;
          logger.warn({ holder, waitedSeconds: Math.round(waitedMs / 1000) }, 'Waiting for another migration runner to finish');
        }
        await new Promise((resolve) => setTimeout(resolve, this.options.runnerLockPollMs));
      }

      try {
        return await work();
      } finally {
        await lockConn
          .query('SELECT pg_advisory_unlock($1)', [MigrationService.MIGRATION_LOCK_KEY])
          .catch((error) => logger.warn({ err: error }, 'Failed to release migration advisory lock'));
      }
    } finally {
      lockConn.release();
    }
  }

  /** Who holds the migration advisory lock, for the log. */
  private async runnerLockHolder(conn: PoolClient): Promise<string> {
    const key = BigInt(MigrationService.MIGRATION_LOCK_KEY);
    const { rows } = await conn.query<{ pid: number; application_name: string | null; client_addr: string | null; state: string | null; xact_start: Date | null }>(
      `SELECT l.pid, a.application_name, a.client_addr::text AS client_addr, a.state, a.xact_start
         FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.granted AND l.objsubid = 1
          AND l.classid = $1::bigint::oid AND l.objid = $2::bigint::oid`,
      [String(key >> 32n), String(key & 0xffffffffn)]
    );
    const h = rows[0];
    if (!h) return 'holder unknown';
    return `pid ${h.pid}${h.application_name ? `, ${h.application_name}` : ''}${h.client_addr ? ` from ${h.client_addr}` : ''}${h.state ? `, ${h.state}` : ''}`;
  }

  /**
   * Give an empty database the baseline schema (init.sql), so migrate() can then apply
   * the migrations newer than it. Runs under the runner lock, as the migration (owner)
   * role, in one transaction. A database with tables but no migration history isn't one
   * Nuggets made, and is refused rather than loaded into.
   */
  private async ensureBaseline(): Promise<void> {
    // migrate() refused a database with no history but objects in public already (findRefusal).
    if ((await this.getAppliedMigrations()).length > 0) return;
    const database = oneRow((await sql<{ db: string }>`SELECT current_database() AS db`.execute(this.db)).rows, 'current_database()').db;

    const baselinePath = this.options.baselinePath;
    if (!baselinePath) {
      // A runner over a directory of its own: the migrations start from nothing, and
      // migrate() creates schema_migrations.
      if (this.options.standalone) return;
      throw new Error(`Database "${database}" is empty, and this runner has no baseline schema to load into it`);
    }
    if (!fs.existsSync(baselinePath)) {
      throw new Error(`Database "${database}" is empty and the baseline schema to load into it is missing: ${baselinePath}`);
    }
    const baseline = fs.readFileSync(baselinePath, 'utf8');
    if (!/CREATE TABLE public\.schema_migrations\b/.test(baseline)) {
      throw new Error(`${baselinePath} is not the Nuggets baseline schema (it creates no schema_migrations table)`);
    }

    logger.info({ database, baselinePath }, 'Empty database: loading the baseline schema');
    const startTime = Date.now();
    const client = await this.pool.connect();
    try {
      await this.retryOnLockTimeout({ baseline: baselinePath }, () =>
        // A schema_migrations left empty by an older runner's `status` would collide with
        // the baseline's own; it holds nothing, so it goes.
        this.inTransaction(client, `DROP TABLE IF EXISTS public.schema_migrations;\n${baseline}`)
      );
    } catch (error) {
      throw baselineLoadError(database, error);
    } finally {
      // init.sql sets session settings (search_path, row_security): don't reuse this connection.
      client.release(true);
    }
    logger.info({ database, executionTimeMs: Date.now() - startTime }, 'Baseline schema loaded');
  }

  /**
   * The SQL that cuts a v2.4.0 database over to the baseline, as a migration of the
   * baseline's version (for the log and the failure report), refused when it isn't the
   * file the baseline's checksum names.
   */
  private cutoverMigration(): MigrationFile {
    const fullPath = this.options.cutoverPath;
    let content: string;
    try {
      content = fs.readFileSync(fullPath, 'utf8');
    } catch (error) {
      throw new Error(`The SQL that cuts a v2.4.0 database over to the baseline can't be read (${fullPath}): ${(error as Error).message}`, {
        cause: error,
      });
    }
    const checksum = MigrationService.checksum(content);
    if (checksum !== BASELINE.checksum) {
      throw new MigrationRefusal(
        `${fullPath} has been modified: its checksum is ${checksum}, the baseline's ${BASELINE.checksum}. ` +
        'It is what v2.4.0 databases are cut over with, and never changes. Nothing was changed.'
      );
    }
    return {
      version: BASELINE.version,
      name: 'cutover from v2.4.0',
      filename: `${path.basename(path.dirname(fullPath))}/${path.basename(fullPath)}`,
      fullPath,
      upSql: content,
      checksum,
      noTransaction: false,
    };
  }

  /**
   * A database whose history is exactly v2.4.0's: in one transaction, turn its schema into
   * the baseline's (upgrade/from-v2.4.0.sql) and replace v2.4.0's rows in schema_migrations
   * with the baseline's one. Another history the runner can't upgrade is refused before
   * anything changes; an empty one or the baseline's needs nothing here.
   */
  private async ensureAtBaseline(): Promise<void> {
    if (migrationHistory(await this.getAppliedMigrations()).kind !== 'v2.4.0') return;

    const cutover = this.cutoverMigration();
    const versions = V2_4_0_MIGRATIONS.map((m) => m.version);
    logger.info(
      { migrations: versions.length, newest: versions.at(-1), baseline: BASELINE.version, cutover: cutover.filename },
      "A v2.4.0 database: cutting it over to the baseline (its schema made the baseline's, v2.4.0's migrations recorded as the baseline's one row)"
    );
    const startTime = Date.now();
    try {
      await this.execute(cutover, cutover.upSql, async (client) => {
        // Qualified: the cutover leaves search_path empty for the rest of the transaction.
        const deleted = await client.query('DELETE FROM public.schema_migrations WHERE version = ANY($1::varchar[])', [versions]);
        if (deleted.rowCount !== versions.length) {
          throw new Error(`Expected to replace v2.4.0's ${versions.length} schema_migrations rows, found ${deleted.rowCount}; nothing was changed`);
        }
        await client.query(
          'INSERT INTO public.schema_migrations (version, name, checksum, execution_time_ms) VALUES ($1, $2, $3, $4)',
          [BASELINE.version, BASELINE.name, BASELINE.checksum, Date.now() - startTime]
        );
      });
    } catch (error) {
      this.lastFailed = cutover;
      logger.error({ err: dbErrorForLog(error), cutover: cutover.filename }, 'The cutover to the baseline failed: the database is as it was (v2.4.0)');
      throw error;
    }
    logger.info({ baseline: BASELINE.version, executionTimeMs: Date.now() - startTime }, 'Cut over to the baseline');
    this.lastCutOver = true;
    await this.reportDrift();
  }

  /**
   * After a cutover: compare the database's schema with a fresh v3.0.0 baseline's (its
   * per-object fingerprint, upgrade/baseline-fingerprint.txt), and log a warning naming each
   * object missing, extra or different. The cutover makes comments, functions and the
   * extensions the baseline's; what else differs was so before it (an older upgrade path, a
   * change by hand). It never refuses: the database was cut over all the same.
   */
  private async reportDrift(): Promise<void> {
    try {
      const counted = (fingerprint: Map<string, string>) =>
        this.options.compareGrants ? fingerprint : new Map([...fingerprint].filter(([key]) => !key.startsWith('privileges ')));
      const expected = counted(parseFingerprint(fs.readFileSync(this.options.fingerprintPath, 'utf8')));
      const drift = compareFingerprints(expected, counted(await schemaFingerprint(this.pool)));
      this.lastDrift = drift;
      const count = drift.missing.length + drift.extra.length + drift.changed.length;
      if (count === 0) {
        logger.info({ objects: expected.size }, 'The cut-over schema is a fresh baseline\'s');
        return;
      }
      const first = (keys: string[]) => keys.slice(0, 50);
      logger.warn(
        {
          missing: first(drift.missing),
          extra: first(drift.extra),
          changed: first(drift.changed),
          missingCount: drift.missing.length,
          extraCount: drift.extra.length,
          changedCount: drift.changed.length,
        },
        `The cut-over schema differs from a fresh baseline's in ${count} object(s) (missing, extra or changed; the first 50 ` +
          'of each are named). It was cut over all the same: the differences were there before (an older upgrade path, or a ' +
          'change by hand). Compare with a fresh install before relying on them (Settings → Utilities downloads the schema).'
      );
    } catch (error) {
      logger.warn({ err: error }, 'Could not compare the cut-over schema with a fresh baseline\'s; it was cut over all the same');
    }
  }

  /**
   * What the last migrate() found when it compared a cut-over database with a fresh
   * baseline; null when it cut none over, or couldn't compare (the log says why).
   */
  get cutoverDrift(): SchemaDrift | null {
    return this.lastDrift;
  }

  /** Whether the last migrate() cut a v2.4.0 database over to the baseline. */
  get cutOver(): boolean {
    return this.lastCutOver;
  }

  /**
   * Run all pending migrations, after loading the baseline schema into an empty database,
   * or cutting a v2.4.0 database over to it.
   */
  async migrate(): Promise<void> {
    this.lastFailed = null;
    this.lastDrift = null;
    this.lastCutOver = false;
    // Serialize the whole run with a session-level advisory lock so concurrent
    // starters (e.g. multiple containers) can't race: the first holds the lock
    // and applies pending migrations; the rest wait, then find nothing pending.
    await this.withRunnerLock(async () => {
      // Before anything changes: what this runner can't migrate is refused as it is.
      await this.validateMigrations();
      await this.ensureBaseline();
      if (!this.options.standalone) await this.ensureAtBaseline();
      // Its comments too, which databases from older baselines got only from here.
      await this.ensureMigrationsTable();

      logger.info('Checking for pending migrations');

      await this.validateMigrations();
      const pending = await this.getPendingMigrations();

      if (pending.length === 0) {
        logger.info('No pending migrations - database is up to date');
        return;
      }

      logger.info({ pendingCount: pending.length, migrations: pending.map(m => `${m.version} - ${m.name}`) }, 'Found pending migrations');

      let successCount = 0;
      const totalStartTime = Date.now();

      for (const migration of pending) {
        try {
          await this.runMigration(migration);
          successCount++;
        } catch (error) {
          logger.error({ err: dbErrorForLog(error) }, 'Migration failed - stopping migration process');
          throw error;
        }
      }

      const totalTime = Date.now() - totalStartTime;
      logger.info({ successCount, totalTimeMs: totalTime }, 'Successfully applied migrations');
    });
  }

  /**
   * The migration the last migrate() failed in, or null: it succeeded, or failed before it
   * ran one (the runner lock, the baseline, the history refused, an applied migration
   * edited or missing). A failed cutover from v2.4.0 is the baseline's version, its file
   * upgrade/from-v2.4.0.sql.
   */
  get failedMigration(): MigrationFile | null {
    return this.lastFailed;
  }

  /**
   * Rollback the last N migrations. Holds the runner lock, refuses when an applied
   * migration was edited or its file is gone, and checks that every one of the N has a
   * DOWN part before rolling any back.
   */
  async rollback(count: number = 1): Promise<void> {
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`Rollback count must be a positive whole number, not ${count}`);
    }
    logger.info({ count }, 'Rolling back migrations');

    await this.withRunnerLock(async () => {
      await this.validateMigrations(true);
      const applied = await this.getAppliedMigrations();

      if (applied.length === 0) {
        logger.info('No migrations to rollback');
        return;
      }

      const toRollback = applied.slice(-count).reverse();
      const allMigrations = await this.getMigrationFiles();
      const migrationMap = new Map(allMigrations.map(m => [m.version, m]));
      const irreversible = toRollback.filter(m => !migrationMap.get(m.version)?.downSql);
      if (irreversible.length > 0) {
        throw new Error(
          `Cannot roll back ${toRollback.length} migration(s): ${irreversible
            .map(m => `${m.version} (${m.name})`)
            .join(', ')} has no DOWN section. Nothing was rolled back.`
        );
      }

      logger.info({
        rollbackCount: toRollback.length,
        migrations: toRollback.map(m => `${m.version} - ${m.name}`)
      }, 'Rolling back migrations');

      for (const applied of toRollback) {
        await this.rollbackMigration(migrationMap.get(applied.version)!);
      }

      logger.info({ rollbackCount: toRollback.length }, 'Successfully rolled back migrations');
    });
  }

  /**
   * Which migrations are applied and which are pending. Read-only: on an empty database
   * it reports every migration pending and creates nothing.
   */
  async getStatus(): Promise<MigrationStatus> {
    const initialized = await this.hasMigrationsTable();
    const appliedMigrations = await this.getAppliedMigrations();
    let allMigrations: MigrationFile[];
    try {
      allMigrations = await this.getMigrationFiles();
    } catch (error) {
      // A file the runner refuses (not newer than the baseline): migrate stops at it too.
      if (!(error instanceof MigrationRefusal)) throw error;
      return {
        initialized,
        ...(!this.options.standalone && { history: migrationHistory(appliedMigrations).kind }),
        refusal: error.message,
        applied: [],
        pending: [],
      };
    }
    const appliedByVersion = new Map(appliedMigrations.map(m => [m.version, m]));
    const appliedAt = (version: string) => {
      const at = appliedByVersion.get(version)?.appliedAt;
      return at ? new Date(at).toISOString() : 'unknown';
    };

    const applied = allMigrations
      .filter(m => appliedByVersion.has(m.version))
      .map(m => ({ version: m.version, name: m.name, appliedAt: appliedAt(m.version) }));
    const pending = allMigrations.filter(m => !appliedByVersion.has(m.version)).map(m => ({ version: m.version, name: m.name }));
    const refusal = await this.findRefusal();
    if (this.options.standalone) return { initialized, ...(refusal && { refusal: refusal.message }), applied, pending };

    const history = migrationHistory(appliedMigrations);
    const baseline = { version: BASELINE.version, name: BASELINE.name };
    return {
      initialized,
      history: history.kind,
      ...(refusal && { refusal: refusal.message }),
      applied: history.kind === 'baseline' || history.kind === 'mixed'
        ? [{ ...baseline, appliedAt: appliedAt(BASELINE.version) }, ...applied]
        : applied,
      pending: history.kind === 'empty' || history.kind === 'v2.4.0' ? [baseline, ...pending] : pending,
    };
  }

  /**
   * Log the migration status
   */
  async status(): Promise<MigrationStatus> {
    const status = await this.getStatus();
    // What migrate would refuse, first: with no file and no row it knows, the lists are empty.
    if (status.refusal) {
      logger.error({ history: status.history }, `migrate refuses this database: ${status.refusal}`);
      return status;
    }
    if (status.applied.length === 0 && status.pending.length === 0) {
      logger.info('No migration files found');
      return status;
    }
    logger.info({
      history: status.history,
      initialized: status.initialized,
      appliedCount: status.applied.length,
      pendingCount: status.pending.length,
      totalCount: status.applied.length + status.pending.length,
      applied: status.applied,
      pending: status.pending,
    }, !status.initialized
      ? 'Migration status: empty database (migrate loads the baseline schema first)'
      : status.history === 'v2.4.0'
        ? 'Migration status: a v2.4.0 database (migrate cuts it over to the baseline first)'
        : 'Migration status');
    return status;
  }
}
