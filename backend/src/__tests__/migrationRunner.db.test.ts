import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { MigrationService } from '../services/MigrationService.js';
import { assertSchemaMigrated, SchemaNotReadyError } from '../db/schemaReady.js';
import { getDirname } from '../utils/esm-compat.js';
import { BASELINE as BASELINE_ROW } from '../db/baseline.js';

/**
 * The migration runner, on databases of its own that this file creates and drops:
 * it loads the baseline into an empty database, so a plain Postgres needs nothing loaded
 * beforehand; `status` is read-only. Over migration directories of their own (standalone
 * runners, with no baseline row or v2.4.0 cutover: v240CutoverMigration.test.ts has those)
 * it runs `-- nuggets:no-transaction` migrations statement by statement; a statement that
 * waits too long for a lock is retried; rollback holds the runner lock, validates checksums
 * and rolls back all or nothing; a second runner waits for the first, and gives up.
 *
 * Runs as the owner (DATABASE_URL), which needs CREATEDB, as the migration role does
 * the DDL. Nothing here touches the shared test database.
 */

const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ownerUrl ? describe : describe.skip;

const BACKEND = path.join(getDirname(import.meta.url), '../..');
const MIGRATIONS_DIR = path.join(BACKEND, 'migrations');
const BASELINE = path.join(BACKEND, 'init.sql');

function urlFor(database: string): string {
  const url = new URL(ownerUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

describeDb('migration runner', () => {
  const created: string[] = [];
  const pools: Pool[] = [];
  let admin: Pool;
  let fixtures: string;

  /** A new empty database (dropped in afterAll) and a pool on it. */
  async function emptyDatabase(): Promise<Pool> {
    const name = `nuggets_migrate_test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const pool = new Pool({ connectionString: urlFor(name), max: 6 });
    pools.push(pool);
    return pool;
  }

  /** A migrations directory holding these files. */
  function migrationsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(fixtures, 'm-'));
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
    return dir;
  }

  /** Tables in public. */
  async function tables(pool: Pool): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`);
    return rows[0].n;
  }

  beforeAll(() => {
    admin = new Pool({ connectionString: ownerUrl, max: 2 });
    fixtures = mkdtempSync(path.join(tmpdir(), 'nuggets-migrations-'));
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    for (const name of created) {
      // A pool's end() resolves before its connections have closed; one that DROP ... FORCE
      // ended instead would raise an error nothing listens for.
      for (let i = 0; i < 50; i++) {
        const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin?.end();
    rmSync(fixtures, { recursive: true, force: true });
    // Nine databases, and each DROP DATABASE waits for a checkpoint: past the default 10 s
    // hook timeout on a loaded machine.
  }, 120_000);

  it('loads the baseline into an empty database and applies every migration', async () => {
    const pool = await emptyDatabase();
    const service = new MigrationService(pool, { migrationsDir: MIGRATIONS_DIR, baselinePath: BASELINE });

    // Read-only on an empty database: the baseline and every migration pending, nothing created.
    const before = await service.getStatus();
    expect(before.initialized).toBe(false);
    expect(before.history).toBe('empty');
    expect(before.applied).toEqual([]);
    expect(before.pending[0]).toEqual({ version: BASELINE_ROW.version, name: BASELINE_ROW.name });
    expect(await tables(pool)).toBe(0);
    await expect(assertSchemaMigrated(pool)).rejects.toBeInstanceOf(SchemaNotReadyError);

    await service.migrate();

    const after = await service.getStatus();
    expect(after.initialized).toBe(true);
    expect(after.pending).toEqual([]);
    expect(after.applied.map((m) => m.version)).toEqual(before.pending.map((m) => m.version));
    const { rows } = await pool.query(
      `SELECT to_regclass('public.tenants') IS NOT NULL AS tenants, to_regclass('public.system_settings') IS NOT NULL AS settings`
    );
    expect(rows[0]).toEqual({ tenants: true, settings: true });
    await expect(assertSchemaMigrated(pool, MIGRATIONS_DIR)).resolves.toEqual({ pending: [] });

    // Nothing left to do the second time.
    await service.migrate();
    expect((await service.getStatus()).pending).toEqual([]);
  }, 60_000);

  it('loads the baseline over an empty schema_migrations an older runner left behind', async () => {
    const pool = await emptyDatabase();
    // What `migrate status` used to create before failing on a plain Postgres.
    await pool.query(`CREATE TABLE schema_migrations (version varchar(14) PRIMARY KEY, name varchar(255) NOT NULL,
      checksum varchar(64) NOT NULL, applied_at timestamp NOT NULL DEFAULT now(), execution_time_ms int,
      created_at timestamp NOT NULL DEFAULT now())`);
    const service = new MigrationService(pool, { migrationsDir: MIGRATIONS_DIR, baselinePath: BASELINE });
    await service.migrate();
    expect((await service.getStatus()).pending).toEqual([]);
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'schema_migrations' AND column_name = 'applied_at'`
    );
    expect(rows[0].data_type).toBe('timestamp with time zone');
  }, 60_000);

  it('refuses a database that has tables but no migration history, and loads nothing', async () => {
    const pool = await emptyDatabase();
    await pool.query('CREATE TABLE someone_elses (id int)');
    const service = new MigrationService(pool, { migrationsDir: MIGRATIONS_DIR, baselinePath: BASELINE });
    await expect(service.migrate()).rejects.toThrow(/has no Nuggets migration history .* but its public schema isn't empty: 1 object\(s\), table public\.someone_elses\./);
    expect(await tables(pool)).toBe(1);
  });

  it('refuses an empty database when the baseline file is missing', async () => {
    const pool = await emptyDatabase();
    const service = new MigrationService(pool, {
      migrationsDir: MIGRATIONS_DIR,
      baselinePath: path.join(fixtures, 'no-such-init.sql'),
    });
    await expect(service.migrate()).rejects.toThrow(/baseline schema to load into it is missing/);
    expect(await tables(pool)).toBe(0);
  });

  it('runs a no-transaction migration statement by statement, and rolls it back', async () => {
    const pool = await emptyDatabase();
    const dir = migrationsDir({
      '20990101000000_table.sql': 'CREATE TABLE t (id int, v text);\n-- === DOWN ===\nDROP TABLE t;\n',
      '20990101000001_concurrent_index.sql': [
        '-- nuggets:no-transaction',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id);',
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS t_v_idx ON t (v) WHERE v <> ';';",
        '-- === DOWN ===',
        'DROP INDEX CONCURRENTLY IF EXISTS t_v_idx;',
        'DROP INDEX CONCURRENTLY IF EXISTS t_id_idx;',
      ].join('\n'),
    });
    const service = new MigrationService(pool, { migrationsDir: dir, standalone: true });
    await service.migrate();
    const indexes = async () =>
      (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 't' ORDER BY 1`)).rows.map((r) => r.indexname);
    expect(await indexes()).toEqual(['t_id_idx', 't_v_idx']);
    expect((await service.getStatus()).applied.map((m) => m.version)).toEqual(['20990101000000', '20990101000001']);

    await service.rollback(1);
    expect(await indexes()).toEqual([]);
    expect((await service.getStatus()).pending.map((m) => m.version)).toEqual(['20990101000001']);

    // The same index in an ordinary (transactional) migration is refused by Postgres.
    const inTransaction = migrationsDir({
      '20990101000000_table.sql': 'CREATE TABLE t (id int, v text);\n',
      '20990101000001_concurrent_index.sql': 'CREATE INDEX CONCURRENTLY t_id_idx ON t (id);\n',
    });
    const other = await emptyDatabase();
    await expect(new MigrationService(other, { migrationsDir: inTransaction, standalone: true }).migrate()).rejects.toThrow(
      /cannot run inside a transaction block/
    );
  });

  it('retries a migration that timed out waiting for a lock, and gives up after the retries', async () => {
    const pool = await emptyDatabase();
    const dir = migrationsDir({
      '20990101000000_table.sql': 'CREATE TABLE t (id int);\n',
      '20990101000001_alter.sql': 'ALTER TABLE t ADD COLUMN v text;\n',
    });
    const options = { migrationsDir: dir, standalone: true, lockTimeout: '100ms', lockRetries: 2, retryDelayMs: () => 50 };
    await new MigrationService(pool, { ...options, migrationsDir: migrationsDir({ '20990101000000_table.sql': 'CREATE TABLE t (id int);\n' }) }).migrate();

    // A session holding a lock on t past every retry: the migration fails with lock_not_available.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE t IN ACCESS SHARE MODE');
      await expect(new MigrationService(pool, options).migrate()).rejects.toMatchObject({ code: '55P03' });
      await holder.query('ROLLBACK');

      // Released after the first try: the retry applies it.
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE t IN ACCESS SHARE MODE');
      const release = new Promise<void>((resolve) =>
        setTimeout(() => holder.query('ROLLBACK').then(() => resolve()), 180)
      );
      await new MigrationService(pool, { ...options, retryDelayMs: () => 200 }).migrate();
      await release;
    } finally {
      holder.release();
    }
    const { rows } = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 't' ORDER BY 1`);
    expect(rows.map((r) => r.column_name)).toEqual(['id', 'v']);
  });

  it('starts a no-transaction migration again from the top after a lock timeout, so no invalid index is left', async () => {
    const pool = await emptyDatabase();
    const table = { '20990101000000_table.sql': 'CREATE TABLE t (id int);\n' };
    const options = { standalone: true, lockTimeout: '100ms', lockRetries: 2 };
    await new MigrationService(pool, { ...options, migrationsDir: migrationsDir(table) }).migrate();
    const dir = migrationsDir({
      ...table,
      '20990101000001_concurrent_index.sql': [
        '-- nuggets:no-transaction',
        'DROP INDEX CONCURRENTLY IF EXISTS t_id_idx;',
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS t_id_idx ON t (id);',
      ].join('\n'),
    });

    // A write to t open while the index is built: CREATE INDEX CONCURRENTLY waits for it past
    // lock_timeout, leaving the index it began behind, invalid. The write ends before the retry.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('INSERT INTO t VALUES (1)');
      const release = new Promise<void>((resolve) =>
        setTimeout(() => holder.query('COMMIT').then(() => resolve()), 180)
      );
      await new MigrationService(pool, { ...options, migrationsDir: dir, retryDelayMs: () => 200 }).migrate();
      await release;
    } finally {
      holder.release();
    }
    const { rows } = await pool.query(
      `SELECT i.indisvalid, i.indisready FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 't_id_idx'`
    );
    expect(rows).toEqual([{ indisvalid: true, indisready: true }]);
  });

  it('rolls back all or nothing, and not over an edited migration', async () => {
    const pool = await emptyDatabase();
    const files = {
      '20990101000000_a.sql': 'CREATE TABLE a (id int);\n',
      '20990101000001_b.sql': 'CREATE TABLE b (id int);\n-- === DOWN ===\nDROP TABLE b;\n',
      '20990101000002_c.sql': 'CREATE TABLE c (id int);\n-- === DOWN ===\nDROP TABLE c;\n',
    };
    const dir = migrationsDir(files);
    const service = new MigrationService(pool, { migrationsDir: dir, standalone: true });
    await service.migrate();

    // a has no DOWN part: rolling back three refuses before touching b or c.
    await expect(service.rollback(3)).rejects.toThrow(/20990101000000 \(a\) has no DOWN section\. Nothing was rolled back/);
    expect(await tables(pool)).toBe(4); // schema_migrations, a, b and c
    expect((await service.getStatus()).pending).toEqual([]);

    // An applied migration edited since: refused.
    writeFileSync(path.join(dir, '20990101000002_c.sql'), 'CREATE TABLE c (id bigint);\n-- === DOWN ===\nDROP TABLE c;\n');
    await expect(service.rollback(1)).rejects.toThrow(/has been modified/);
    writeFileSync(path.join(dir, '20990101000002_c.sql'), files['20990101000002_c.sql']);

    // The same file with CRLF line endings is not an edit.
    writeFileSync(path.join(dir, '20990101000002_c.sql'), files['20990101000002_c.sql'].replace(/\n/g, '\r\n'));
    await service.rollback(2);
    expect((await service.getStatus()).pending.map((m) => m.version)).toEqual(['20990101000001', '20990101000002']);
    await expect(service.rollback(0)).rejects.toThrow(/positive whole number/);
  });

  it('waits for another runner holding the lock, and gives up after a while', async () => {
    const pool = await emptyDatabase();
    const dir = migrationsDir({ '20990101000000_a.sql': 'CREATE TABLE a (id int);\n' });
    const holder = await pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(4242042042)');
      const service = new MigrationService(pool, { migrationsDir: dir, standalone: true, runnerLockWaitMs: 300, runnerLockPollMs: 50 });
      await expect(service.migrate()).rejects.toThrow(/Another migration runner has held the migration lock.*pid \d+/);
      await expect(service.rollback(1)).rejects.toThrow(/Another migration runner/);
      // status doesn't need the lock.
      expect((await service.getStatus()).pending).toHaveLength(1);

      // Released while waiting: the waiting runner goes ahead.
      const waiting = new MigrationService(pool, { migrationsDir: dir, standalone: true, runnerLockWaitMs: 5000, runnerLockPollMs: 50 }).migrate();
      setTimeout(() => void holder.query('SELECT pg_advisory_unlock(4242042042)'), 200);
      await waiting;
    } finally {
      holder.release();
    }
    expect(await tables(pool)).toBe(2);
  });
});
