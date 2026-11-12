import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Pool } from 'pg';

const warn = vi.hoisted(() => vi.fn());
vi.mock('../utils/logger.js', () => {
  const quiet = () => undefined;
  const createLogger = () => ({ trace: quiet, debug: quiet, info: quiet, warn, error: quiet, fatal: quiet });
  return { createLogger, default: createLogger() };
});

import { MigrationRefusal, MigrationService } from '../services/MigrationService.js';
import { BASELINE } from '../db/baseline.js';

/** A pool whose database has schema_migrations rows for `applied`, and nothing else. */
function poolWithApplied(applied: string[]): Pool {
  const client = {
    async query(text: string) {
      if (text.includes('to_regclass')) return { command: 'SELECT', rowCount: 1, rows: [{ exists: true }] };
      if (text.includes('schema_migrations')) {
        return {
          command: 'SELECT',
          rowCount: applied.length,
          rows: applied.map((version) => ({ version, name: version, checksum: 'x', appliedAt: new Date() })),
        };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() {},
  };
  return { connect: async () => client } as unknown as Pool;
}

/**
 * A pending migration older than the newest applied one is applied anyway (a branch
 * merged with main gets main's migrations after its own newer ones), so the runner names
 * it in a warning. It doesn't refuse it.
 */
describe('pending migrations older than the newest applied one', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nuggets-migrations-'));
    for (const name of ['20260101000000_first', '20260201000000_merged_from_main', '20260301000000_branch', '20260401000000_newest']) {
      writeFileSync(path.join(dir, `${name}.sql`), 'SELECT 1;\n\n-- === DOWN ===\nSELECT 1;\n');
    }
    warn.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are still pending, with a warning that names them', async () => {
    const service = new MigrationService(poolWithApplied(['20260101000000', '20260301000000']), { migrationsDir: dir, standalone: true });
    const pending = await service.getPendingMigrations();
    expect(pending.map((m) => m.version)).toEqual(['20260201000000', '20260401000000']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({
      newestApplied: '20260301000000',
      migrations: ['20260201000000 - merged from main'],
    });
  });

  it('give no warning when every pending one is newer', async () => {
    const service = new MigrationService(poolWithApplied(['20260101000000', '20260201000000']), { migrationsDir: dir, standalone: true });
    expect((await service.getPendingMigrations()).map((m) => m.version)).toEqual(['20260301000000', '20260401000000']);
    const fresh = new MigrationService(poolWithApplied([]), { migrationsDir: dir, standalone: true });
    expect(await fresh.getPendingMigrations()).toHaveLength(4);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * In Nuggets' own runner (not standalone) the baseline's row is one of the applied, with no
 * file, and every migration file is newer than it.
 */
describe('pending migrations after the baseline', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nuggets-migrations-'));
    warn.mockClear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('are the files the database lacks, the baseline counted as the newest applied', async () => {
    for (const name of ['20261201000000_first', '20261202000000_second']) {
      writeFileSync(path.join(dir, `${name}.sql`), 'SELECT 1;\n\n-- === DOWN ===\nSELECT 1;\n');
    }
    const service = new MigrationService(poolWithApplied([BASELINE.version, '20261201000000']), { migrationsDir: dir });
    expect((await service.getPendingMigrations()).map((m) => m.version)).toEqual(['20261202000000']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuse two files with one version, naming both, before anything runs', async () => {
    // migrate create on two branches the same second, or a file copied: one would never run.
    writeFileSync(path.join(dir, '20261201050000_mine.sql'), 'SELECT 1;\n');
    writeFileSync(path.join(dir, '20261201050000_theirs.sql'), 'SELECT 2;\n');
    writeFileSync(path.join(dir, '20261202000000_other.sql'), 'SELECT 3;\n');
    for (const standalone of [false, true]) {
      const service = new MigrationService(poolWithApplied(standalone ? [] : [BASELINE.version]), { migrationsDir: dir, standalone });
      const refused = service.getPendingMigrations();
      await expect(refused).rejects.toBeInstanceOf(MigrationRefusal);
      await expect(service.getPendingMigrations()).rejects.toThrow(
        'Migrations share a version, and schema_migrations records one per version: 20261201050000_mine.sql and 20261201050000_theirs.sql (20261201050000).'
      );
    }
  });

  it('refuse a file that is not newer than the baseline', async () => {
    writeFileSync(path.join(dir, '20261112200000_tenant_settings_money_format.sql'), 'SELECT 1;\n');
    const service = new MigrationService(poolWithApplied([BASELINE.version]), { migrationsDir: dir });
    await expect(service.getPendingMigrations()).rejects.toThrow(/is not newer than the baseline \(20261113000000\)/);
    rmSync(path.join(dir, '20261112200000_tenant_settings_money_format.sql'));
    writeFileSync(path.join(dir, `${BASELINE.version}_same_as_the_baseline.sql`), 'SELECT 1;\n');
    await expect(service.getPendingMigrations()).rejects.toThrow(/is not newer than the baseline/);
  });
});
