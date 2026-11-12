import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { MigrationRefusal, type MigrationFile } from '../../services/MigrationService.js';

// The migrate script loads these when a migration fails, before any server exists:
// they must not need the app's serving pool, whose role may not sign in yet.
vi.mock('../../db.js', () => {
  throw new Error('db.js (the serving pool) was loaded');
});

const { failedLine, failureReport, FAILURE_MIGRATIONS_FILE, FAILURE_SCHEMA_FILE } = await import('../../services/migrationFailureFiles.js');

/**
 * The report a failed migration leaves in the backups directory, from errors made
 * up here; migrationFailureFiles.db.test.ts writes it from a real failure.
 */

const NOW = new Date('2026-11-03T12:00:00.000Z');
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'failure-report-'));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

async function migration(filename: string, content: string, noTransaction = false): Promise<MigrationFile> {
  const fullPath = path.join(dir, filename);
  await writeFile(fullPath, content);
  const upSql = content.split(/^--\s*===\s*DOWN\s*===\s*$/m)[0].trim();
  return { version: filename.slice(0, 14), name: filename.slice(15, -4), filename, fullPath, upSql, checksum: 'x', noTransaction };
}

describe('failureReport', () => {
  it("names the migration, the error's code, message, object and function, and leaves out its DETAIL", async () => {
    const m = await migration('20261102110300_ledger_references.sql', 'ALTER TABLE t ADD CONSTRAINT c FOREIGN KEY (a) REFERENCES u (id);\n');
    const error = Object.assign(new Error('insert or update on table "t" violates foreign key constraint "c"'), {
      severity: 'ERROR',
      code: '23503',
      detail: 'Key (a)=(4242) is not present in table "u".',
      schema: 'public',
      table: 't',
      constraint: 'c',
      where: 'SQL statement "UPDATE t SET a = 4242"\nPL/pgSQL function public.old_trigger() line 3 at SQL statement',
      hint: 'Drop the old trigger first.',
    });
    const report = failureReport({ error, migration: m }, { written: [FAILURE_SCHEMA_FILE, FAILURE_MIGRATIONS_FILE], notWritten: [] }, NOW);

    expect(report).toContain('Written 2026-11-03T12:00:00.000Z by Nuggets ');
    expect(report).toContain('Migration:  20261102110300_ledger_references.sql');
    expect(report).toContain('It runs in one transaction, which was rolled back');
    expect(report).toContain('Error code: 23503 (SQLSTATE)');
    expect(report).toContain('Message:    insert or update on table "t" violates foreign key constraint "c"');
    expect(report).toContain('Object:     schema public, table t, constraint c');
    expect(report).toContain('In:         PL/pgSQL function public.old_trigger() line 3 at SQL statement');
    expect(report).toContain('Hint:       Drop the old trigger first.');
    expect(report).toContain(`  ${FAILURE_SCHEMA_FILE}: `);
    // The DETAIL and the context's SQL quote values.
    expect(report).not.toContain('4242');
    expect(report).not.toContain('SQL statement "');
    expect(report).not.toContain('Not written');
  });

  it('says what a failure outside a transaction leaves, and which files are missing', async () => {
    const m = await migration('20990101000000_index.sql', '-- nuggets:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (a);\n', true);
    const error = Object.assign(new Error('could not create unique index "i"'), { severity: 'ERROR', code: '23505' });
    const report = failureReport({ error, migration: m }, { written: [], notWritten: [FAILURE_SCHEMA_FILE] }, NOW);
    expect(report).toContain('It runs outside a transaction (-- nuggets:no-transaction): the statements before the failing one stay applied');
    expect(report).toContain(`Not written (the backend's log says why): ${FAILURE_SCHEMA_FILE}`);
    expect(report).not.toContain('Written with this report');
  });

  it('names the cutover from v2.4.0, which runs in one transaction, and the line of its file', async () => {
    // As MigrationService has it: the baseline's version, its file upgrade/from-v2.4.0.sql.
    const content = 'SELECT 1;\n\nCOMMENT ON COLUMN public.t.gone IS \'x\';\n';
    const fullPath = path.join(dir, 'from-v2.4.0.sql');
    await writeFile(fullPath, content);
    const cutover: MigrationFile = {
      version: '20261113000000',
      name: 'cutover from v2.4.0',
      filename: 'upgrade/from-v2.4.0.sql',
      fullPath,
      upSql: content,
      checksum: 'x',
      noTransaction: false,
    };
    const error = Object.assign(new Error('column "gone" of relation "t" does not exist'), {
      severity: 'ERROR',
      code: '42703',
      position: String(content.indexOf('COMMENT') + 1),
    });
    const report = failureReport({ error, migration: cutover }, { written: [], notWritten: [] }, NOW);
    expect(report).toContain('Migration:  upgrade/from-v2.4.0.sql');
    expect(report).toContain('It runs in one transaction, which was rolled back');
    expect(report).toContain('At:         line 3 of upgrade/from-v2.4.0.sql');
  });

  it('says a refused history was refused, with what to do, rather than ask for an issue', () => {
    const refusal = new MigrationRefusal(
      'This release upgrades a database from v2.4.0 or from its own baseline (20261113000000) only. Its schema_migrations has 150 migration(s), the newest 20261105130000 (drop trigram indexes), and v2.4.0 has 161: it is from a release before v2.4.0. Upgrade to v2.4.0 first (it migrates the database as it starts), then to this release. Nothing was changed.',
      'older'
    );
    const report = failureReport({ error: refusal, migration: null }, { written: [FAILURE_MIGRATIONS_FILE], notWritten: [] }, NOW);
    expect(report.split('\n')[0]).toBe('Nuggets: the migration runner refused this database, and changed nothing in it');
    expect(report).toContain('  This release upgrades a database from v2.4.0');
    expect(report).toContain('Upgrade to v2.4.0 first (it migrates the database as it starts), then to this release. Nothing was changed.');
    expect(report).toContain(`  ${FAILURE_MIGRATIONS_FILE}: `);
    expect(report).not.toMatch(/a database migration failed|open an issue/);
  });

  it('reports a failure before any migration ran, and an error that is not the database\'s', () => {
    const report = failureReport(
      { error: new Error('Migration 20260101000000 (a) has been modified!\nApplied checksum: 1'), migration: null },
      { written: [], notWritten: [] },
      NOW
    );
    expect(report).toContain('Migration:  none: the runner stopped before it ran one');
    expect(report).toContain('Message:    Migration 20260101000000 (a) has been modified! Applied checksum: 1');
    expect(report).not.toContain('Error code:');
    expect(failureReport({ error: 'a string', migration: null }, { written: [], notWritten: [] }, NOW)).toContain('Message:    a string');
  });
});

describe('loading', () => {
  it('needs no serving pool: the stand-in above refuses anything that imports it', async () => {
    // Vitest wraps the factory's error in its own.
    await expect(import('../../db/withTenant.js')).rejects.toThrow(/error when mocking a module/);
  });
});

describe('failedLine', () => {
  it("counts the file's lines to the error's position, the trimmed lines before the UP part too", async () => {
    const m = await migration('20990101000000_typo.sql', '\n\n-- one\nSELECT 1;\nSELECT idd FROM t;\n-- === DOWN ===\nSELECT 1;\n');
    const position = m.upSql.indexOf('idd') + 1;
    expect(failedLine(m, position)).toBe(5);
    expect(failedLine(m, String(position))).toBe(5);
    expect(failedLine(m, undefined)).toBeNull();
    expect(failedLine(m, 0)).toBeNull();
    expect(failedLine(m, m.upSql.length + 5)).toBeNull();
    expect(failedLine({ ...m, noTransaction: true }, position)).toBeNull();
    expect(failedLine({ ...m, fullPath: path.join(dir, 'gone.sql') }, position)).toBeNull();
  });
});
