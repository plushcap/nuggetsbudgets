import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../utils/logger.js', () => {
  const quiet = () => undefined;
  const createLogger = () => ({ trace: quiet, debug: log.debug, info: log.info, warn: log.warn, error: quiet, fatal: quiet });
  return { createLogger, default: createLogger() };
});

import { MigrationService } from '../services/MigrationService.js';

/**
 * A migration's RAISE WARNING (a check it left NOT VALID, rows it couldn't fix) reaches
 * the backend's log, where an operator reads the upgrade, not only the database server's.
 * On a database of its own, created and dropped here, as the owner.
 */

const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ownerUrl ? describe : describe.skip;

describeDb('migration notices', () => {
  let admin: Pool;
  let pool: Pool;
  let name: string;
  let fixtures: string;

  beforeAll(async () => {
    admin = new Pool({ connectionString: ownerUrl, max: 1 });
    name = `nuggets_migrate_notice_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(ownerUrl!);
    url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.toString(), max: 2 });
    fixtures = mkdtempSync(path.join(tmpdir(), 'nuggets-migration-notices-'));
  });

  afterAll(async () => {
    await pool?.end();
    // A pool's end() resolves before its connections have closed; one that DROP ... FORCE
    // ended instead would raise an error nothing listens for (as migrationRunner.db.test.ts).
    for (let i = 0; admin && i < 50; i++) {
      const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
      if (rows[0].n === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await admin?.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin?.end();
    if (fixtures) rmSync(fixtures, { recursive: true, force: true });
  });

  beforeEach(() => {
    log.warn.mockClear();
    log.info.mockClear();
    log.debug.mockClear();
  });

  function migrationsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(fixtures, 'm-'));
    for (const [file, content] of Object.entries(files)) writeFileSync(path.join(dir, file), content);
    return dir;
  }

  it("logs a migration's WARNING as a warning naming the migration, and its NOTICE at debug", async () => {
    const dir = migrationsDir({
      '20990101000000_warns.sql': [
        "DO $$ BEGIN RAISE WARNING '3 row(s) break some_check, which is left NOT VALID'; END $$;",
        "DO $$ BEGIN RAISE NOTICE '2 value(s) normalized'; END $$;",
        '-- === DOWN ===',
        "DO $$ BEGIN RAISE WARNING 'rolled back'; END $$;",
      ].join('\n'),
      '20990101000001_quiet_no_transaction.sql': [
        '-- nuggets:no-transaction',
        "DO $$ BEGIN RAISE WARNING 'from a no-transaction migration'; END $$;",
        '-- === DOWN ===',
        'SELECT 1;',
      ].join('\n'),
    });
    // An empty database with no baseline: the runner creates schema_migrations itself.
    const service = new MigrationService(pool, { migrationsDir: dir, standalone: true });
    await service.migrate();

    const warnings = log.warn.mock.calls.filter(([, msg]) => msg === 'Migration warning');
    expect(warnings.map(([entry]) => entry)).toEqual([
      expect.objectContaining({ version: '20990101000000', name: 'warns', message: '3 row(s) break some_check, which is left NOT VALID' }),
      expect.objectContaining({ version: '20990101000001', message: 'from a no-transaction migration' }),
    ]);
    const notices = log.debug.mock.calls.filter(([, msg]) => msg === 'Migration notice');
    expect(notices.map(([entry]) => entry)).toContainEqual(
      expect.objectContaining({ version: '20990101000000', message: '2 value(s) normalized' }),
    );

    log.warn.mockClear();
    await service.rollback(2);
    expect(log.warn.mock.calls.filter(([, msg]) => msg === 'Migration warning').map(([entry]) => entry)).toEqual([
      expect.objectContaining({ version: '20990101000000', message: 'rolled back' }),
    ]);
  });
});
