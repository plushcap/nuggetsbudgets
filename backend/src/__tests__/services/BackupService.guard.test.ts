import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Pool } from 'pg';
import { BackupService, RestoreRefusedError } from '../../services/BackupService.js';
import { BASELINE } from '../../db/baseline.js';
import { V2_4_0_NEWEST_VERSION } from '../../db/v240Migrations.js';

/**
 * Pure-unit tests for the restore compatibility guard (assertRestorable +
 * getCodeSchemaVersion). These need no database and no Docker secrets:
 * BackupService's constructor only fire-and-forgets a mkdir, EncryptionService
 * has no constructor side effects, and the guard reads the migrations dir off
 * disk plus an in-memory manifest.
 *
 * The migrate after a restore brings a backup forward from the baseline, or from v2.4.0's
 * schema by the cutover, and from nothing older: the migrations before the baseline aren't
 * shipped. So a backup older than v2.4.0's, or one that doesn't say, is refused before
 * anything is touched. BackupService.roundTrip.db.test.ts restores a v2.4.0 backup.
 */
describe('BackupService restore compatibility guard', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The guard of a service whose code ships these migration files (none: the baseline only). */
  function guardWith(...versions: string[]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'nuggets-migrations-'));
    dirs.push(dir);
    for (const v of versions) writeFileSync(path.join(dir, `${v}_test.sql`), 'SELECT 1;\n');
    writeFileSync(path.join(dir, 'README.md'), 'not a migration\n');
    return new BackupService({} as unknown as Pool, { migrationsDir: dir }) as unknown as {
      assertRestorable: (m: unknown) => void;
      getCodeSchemaVersion: () => string;
    };
  }
  const manifest = (schemaVersion: string | null) => ({
    manifestVersion: 1,
    appVersion: 'test',
    schemaVersion,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it("knows this code's latest schema version: the newest migration file, else the baseline", () => {
    expect(guardWith().getCodeSchemaVersion()).toBe(BASELINE.version);
    expect(guardWith('20261201000000', '20261202000000').getCodeSchemaVersion()).toBe('20261202000000');
    // The repository's own migrations directory.
    const shipped = (new BackupService({} as unknown as Pool) as unknown as { getCodeSchemaVersion: () => string }).getCodeSchemaVersion();
    expect(shipped >= BASELINE.version).toBe(true);
  });

  it('refuses a backup NEWER than this code (unsupported downgrade)', () => {
    expect(() => guardWith().assertRestorable(manifest('99999999999999'))).toThrow(/NEWER than this application/i);
    expect(() => guardWith().assertRestorable(manifest('20261201000000'))).toThrow(RestoreRefusedError);
    expect(() => guardWith('20261201000000').assertRestorable(manifest('20261201000000'))).not.toThrow();
  });

  it("refuses a backup older than v2.4.0's schema: it is restored on v2.4.0, then upgraded", () => {
    for (const older of ['00000000000000', '20261111150000', '20261112100100']) {
      expect(() => guardWith().assertRestorable(manifest(older)), older).toThrow(RestoreRefusedError);
      expect(() => guardWith().assertRestorable(manifest(older)), older).toThrow(/Restore it on Nuggets v2\.4\.0/);
    }
    // Nor a version no release had, between v2.4.0's and the baseline.
    expect(() => guardWith().assertRestorable(manifest('20261112300000'))).toThrow(/neither v2\.4\.0's/);
  });

  it("refuses a backup that doesn't record its schema version", () => {
    expect(() => guardWith().assertRestorable(null)).toThrow(RestoreRefusedError);
    expect(() => guardWith().assertRestorable(null)).toThrow(/doesn't record its schema version.*Restore it on Nuggets v2\.4\.0/);
    expect(() => guardWith().assertRestorable(manifest(null))).toThrow(/doesn't record its schema version/);
  });

  it("allows a v2.4.0 backup: the migrate after the restore cuts it over", () => {
    expect(V2_4_0_NEWEST_VERSION).toBe('20261112200000');
    expect(() => guardWith().assertRestorable(manifest(V2_4_0_NEWEST_VERSION))).not.toThrow();
    expect(() => guardWith('20261201000000').assertRestorable(manifest(V2_4_0_NEWEST_VERSION))).not.toThrow();
  });

  it('allows a backup at the baseline or newer, up to this code', () => {
    expect(() => guardWith().assertRestorable(manifest(BASELINE.version))).not.toThrow();
    const guard = guardWith('20261201000000', '20261202000000');
    expect(() => guard.assertRestorable(manifest(BASELINE.version))).not.toThrow();
    expect(() => guard.assertRestorable(manifest('20261201000000'))).not.toThrow();
    expect(() => guard.assertRestorable(manifest(guard.getCodeSchemaVersion()))).not.toThrow();
  });
});
