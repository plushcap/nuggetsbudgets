import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { readFile, readdir, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { MigrationService } from '../services/MigrationService.js';
import {
  FAILURE_MIGRATIONS_FILE,
  FAILURE_REPORT_FILE,
  FAILURE_SCHEMA_FILE,
  writeMigrationFailureFiles,
} from '../services/migrationFailureFiles.js';
import { writeFailureFiles } from '../scripts/migrate.js';
import type { DbCredentials, DbLocation } from '../db/dbConfig.js';

/**
 * A migration that fails on startup leaves its report, the schema and the applied
 * migrations in the backups directory, since the backend then never serves
 * Settings → Utilities. Against a database of its own with a fixture migrations directory,
 * as migrationRunner.db.test.ts does: the migrate script's failure path (writeFailureFiles)
 * after a failed MigrationService.migrate(). Runs the real pg_dump (PG_BIN_DIR or PATH), as
 * adminDatabase.db.test.ts does.
 */

const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ownerUrl ? describe : describe.skip;

/** A value in a row the failing migration's DETAIL would quote, and no file may hold. */
const ROW_VALUE = 'row-value-not-for-export';

const KEPT = [
  `CREATE TABLE kept (id int PRIMARY KEY, label text);`,
  `INSERT INTO kept VALUES (7, '${ROW_VALUE}');`,
  '-- === DOWN ===',
  'DROP TABLE kept;',
  '',
].join('\n');

// Line 5 fails a check constraint, which names its table and constraint, with a DETAIL
// quoting the row ("Failing row contains (-7, row-value-…)").
const FAILS = [
  '-- A migration that meets a row it does not expect.',
  '',
  'CREATE TABLE checked (id int CONSTRAINT checked_positive CHECK (id > 0), label text);',
  '',
  'INSERT INTO checked SELECT -id, label FROM kept;',
  '-- === DOWN ===',
  'DROP TABLE checked;',
  '',
].join('\n');

describeDb('the files a failed migration leaves in the backups directory', () => {
  const created: string[] = [];
  const pools: Pool[] = [];
  let admin: Pool;
  let fixtures: string;

  function urlFor(database: string): string {
    const url = new URL(ownerUrl!);
    url.pathname = `/${database}`;
    return url.toString();
  }

  /** A new empty database, its pool, and how pg_dump reaches it. */
  async function emptyDatabase(): Promise<{ pool: Pool; location: DbLocation; credentials: DbCredentials }> {
    const name = `nuggets_failfiles_test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const pool = new Pool({ connectionString: urlFor(name), max: 4 });
    // DROP DATABASE ... WITH (FORCE) in afterAll ends any connection still closing: its
    // error must not be uncaught.
    pool.on('error', () => {});
    pool.on('connect', (client) => client.on('error', () => {}));
    pools.push(pool);
    const url = new URL(ownerUrl!);
    return {
      pool,
      location: { host: url.hostname, port: Number(url.port || 5432), database: name },
      credentials: { user: decodeURIComponent(url.username), password: decodeURIComponent(url.password) },
    };
  }

  function directory(prefix: string, files: Record<string, string> = {}): string {
    const dir = mkdtempSync(path.join(fixtures, prefix));
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
    return dir;
  }

  beforeAll(() => {
    admin = new Pool({ connectionString: ownerUrl, max: 2 });
    fixtures = mkdtempSync(path.join(tmpdir(), 'nuggets-failfiles-'));
  });

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    for (const name of created) {
      for (let i = 0; i < 200; i++) {
        const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin?.end();
    rmSync(fixtures, { recursive: true, force: true });
  }, 60_000);

  it('writes the report, the schema and the applied migrations, owner-only, with no row in any', async () => {
    const { pool, location, credentials } = await emptyDatabase();
    const migrations = directory('m-', { '20990101000000_kept.sql': KEPT, '20990101000100_fails.sql': FAILS });
    const backups = directory('backups-');
    const service = new MigrationService(pool, { migrationsDir: migrations, standalone: true });

    const failure = await service.migrate().then(() => null, (err: unknown) => err);
    expect(failure).toMatchObject({ code: '23514' });
    expect(service.failedMigration?.filename).toBe('20990101000100_fails.sql');

    await writeFailureFiles(service, failure, { pool, dir: backups, location, credentials });

    expect((await readdir(backups)).sort()).toEqual([FAILURE_REPORT_FILE, FAILURE_MIGRATIONS_FILE, FAILURE_SCHEMA_FILE].sort());
    for (const file of [FAILURE_REPORT_FILE, FAILURE_MIGRATIONS_FILE, FAILURE_SCHEMA_FILE]) {
      expect((await stat(path.join(backups, file))).mode & 0o777, file).toBe(0o600);
      expect(await readFile(path.join(backups, file), 'utf8'), file).not.toContain(ROW_VALUE);
    }

    const report = await readFile(path.join(backups, FAILURE_REPORT_FILE), 'utf8');
    expect(report).toContain('Migration:  20990101000100_fails.sql');
    expect(report).toContain('which was rolled back');
    expect(report).toContain('Error code: 23514 (SQLSTATE)');
    expect(report).toContain('Message:    new row for relation "checked" violates check constraint "checked_positive"');
    expect(report).toContain('Object:     schema public, table checked, constraint checked_positive');
    expect(report).not.toContain('Failing row');
    expect(report).toContain(`  ${FAILURE_SCHEMA_FILE}: `);
    expect(report).toContain(`  ${FAILURE_MIGRATIONS_FILE}: `);
    expect(report).not.toContain('Not written');

    const schema = await readFile(path.join(backups, FAILURE_SCHEMA_FILE), 'utf8');
    expect(schema.startsWith('-- Nuggets database schema: pg_dump --schema-only, with no rows.\n')).toBe(true);
    expect(schema).toMatch(/CREATE TABLE public\.kept \(/);
    expect(schema).toMatch(/CREATE TABLE public\.schema_migrations \(/);
    // Its transaction rolled back: the failed migration's table isn't there.
    expect(schema).not.toMatch(/public\.checked\b/);
    expect(schema).not.toMatch(/^(COPY|INSERT) /m);

    const listing = await readFile(path.join(backups, FAILURE_MIGRATIONS_FILE), 'utf8');
    expect(listing).toContain('-- Migrations applied: 1 (oldest 20990101000000, newest 20990101000000).');
    expect(listing).toMatch(/^INSERT INTO public\.schema_migrations \(version, name, checksum, applied_at\) VALUES \('20990101000000', 'kept', /m);
    expect(listing).not.toContain('20990101000100');
  });

  it("replaces an earlier failure's files, and removes one it couldn't write this time", async () => {
    const { pool, location, credentials } = await emptyDatabase();
    const migrations = directory('m-', { '20990101000000_kept.sql': KEPT, '20990101000100_fails.sql': FAILS });
    const backups = directory('backups-', {
      [FAILURE_REPORT_FILE]: 'an earlier report',
      [FAILURE_SCHEMA_FILE]: 'an earlier schema',
      [FAILURE_MIGRATIONS_FILE]: 'an earlier listing',
    });
    const service = new MigrationService(pool, { migrationsDir: migrations, standalone: true });
    const failure = await service.migrate().then(() => null, (err: unknown) => err);

    // pg_dump can't sign in: the schema isn't written, and the earlier one goes.
    const result = await writeMigrationFailureFiles({
      error: failure,
      migration: service.failedMigration,
      pool,
      dir: backups,
      location,
      credentials: { ...credentials, password: `${credentials.password}-wrong` },
    });
    expect(result.written.sort()).toEqual([FAILURE_REPORT_FILE, FAILURE_MIGRATIONS_FILE].sort());
    expect(result.notWritten.map((n) => n.file)).toEqual([FAILURE_SCHEMA_FILE]);
    expect(result.notWritten[0].reason).not.toContain(`${credentials.password}-wrong`);
    expect((await readdir(backups)).sort()).toEqual([FAILURE_REPORT_FILE, FAILURE_MIGRATIONS_FILE].sort());
    const report = await readFile(path.join(backups, FAILURE_REPORT_FILE), 'utf8');
    expect(report).toContain('20990101000100_fails.sql');
    expect(report).toContain(`Not written (the backend's log says why): ${FAILURE_SCHEMA_FILE}`);
    expect(await readFile(path.join(backups, FAILURE_MIGRATIONS_FILE), 'utf8')).toContain("VALUES ('20990101000000'");
  });

  it('says which line of the file failed, when the database says where in it', async () => {
    const { pool, location, credentials } = await emptyDatabase();
    const migrations = directory('m-', {
      '20990101000100_typo.sql': '\n\nCREATE TABLE t (id int);\n\n-- the column is id\nSELECT\n  idd\nFROM t;\n-- === DOWN ===\nDROP TABLE t;\n',
    });
    const backups = directory('backups-');
    const service = new MigrationService(pool, { migrationsDir: migrations, standalone: true });
    const failure = await service.migrate().then(() => null, (err: unknown) => err);
    expect(failure).toMatchObject({ code: '42703' });
    await writeFailureFiles(service, failure, { pool, dir: backups, location, credentials });
    const report = await readFile(path.join(backups, FAILURE_REPORT_FILE), 'utf8');
    expect(report).toContain('Error code: 42703 (SQLSTATE)');
    // What the message quotes is left out unless the error's own fields name it (42703 names no column).
    expect(report).toContain('Message:    column "…" does not exist');
    expect(report).toContain('At:         line 7 of 20990101000100_typo.sql');
    // The listing of a database with no migration recorded yet.
    expect(await readFile(path.join(backups, FAILURE_MIGRATIONS_FILE), 'utf8')).toContain('-- Migrations applied: 0.');
  });

  it("doesn't throw when the directory can't be written, so the script exits with the migration's error", async () => {
    const { pool, location, credentials } = await emptyDatabase();
    const migrations = directory('m-', { '20990101000100_fails.sql': 'SELECT 1/0;\n-- === DOWN ===\nSELECT 1;\n' });
    const service = new MigrationService(pool, { migrationsDir: migrations, standalone: true });
    const failure = await service.migrate().then(() => null, (err: unknown) => err);
    expect(failure).toMatchObject({ code: '22012' });

    // A file where the directory should be.
    const notADirectory = path.join(fixtures, `file-${randomBytes(4).toString('hex')}`);
    await writeFile(notADirectory, 'x');
    await expect(writeFailureFiles(service, failure, { pool, dir: path.join(notADirectory, 'backups'), location, credentials })).resolves.toBeUndefined();
    const result = await writeMigrationFailureFiles({
      error: failure, migration: service.failedMigration, pool, dir: path.join(notADirectory, 'backups'), location, credentials,
    });
    expect(result.written).toEqual([]);
    expect(result.notWritten.map((n) => n.file).sort()).toEqual([FAILURE_REPORT_FILE, FAILURE_MIGRATIONS_FILE, FAILURE_SCHEMA_FILE].sort());
  });
});
