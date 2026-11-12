import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import {
  BASELINE,
  editedHistoryMessage,
  migrationHistory,
  mixedHistoryMessage,
  nextMigrationVersion,
  olderHistoryMessage,
  unknownHistoryMessage,
} from '../db/baseline.js';
import { V2_4_0_MIGRATIONS, V2_4_0_NEWEST_VERSION } from '../db/v240Migrations.js';
import { baselineLoadError } from '../services/MigrationService.js';
import { driftLines } from '../db/schemaFingerprint.js';
import { migrationFailedLine } from '../scripts/migrate.js';

/**
 * The baseline (init.sql) and the history the migration runner reads from a database's
 * schema_migrations rows: what it loads, cuts over, applies migrations on, or refuses
 * (MigrationService; v240CutoverMigration.test.ts runs each on a database).
 */
const INIT_SQL = readFileSync(path.join(getDirname(import.meta.url), '../../init.sql'), 'utf8');
const v240Rows = () => V2_4_0_MIGRATIONS.map((m) => ({ ...m }));

describe("v2.4.0's migration record", () => {
  it("is v2.4.0's 161 migrations, oldest first, each with a version of its own and a SHA-256", () => {
    expect(V2_4_0_MIGRATIONS).toHaveLength(161);
    const versions = V2_4_0_MIGRATIONS.map((m) => m.version);
    expect(new Set(versions).size).toBe(161);
    expect([...versions].sort()).toEqual(versions);
    expect(versions[0]).toBe('20251024152915');
    expect(versions.at(-1)).toBe(V2_4_0_NEWEST_VERSION);
    for (const m of V2_4_0_MIGRATIONS) {
      expect(m.version, m.name).toMatch(/^\d{14}$/);
      expect(m.checksum, m.version).toMatch(/^[0-9a-f]{64}$/);
      expect(m.name, m.version).not.toBe('');
    }
  });

  it('is older than the baseline, whose version sorts after every one of them', () => {
    expect(BASELINE.version).toMatch(/^\d{14}$/);
    expect(V2_4_0_MIGRATIONS.every((m) => m.version < BASELINE.version)).toBe(true);
  });
});

describe("a database's migration history", () => {
  it('is empty with no rows, and at the baseline with its row (whatever else)', () => {
    expect(migrationHistory([])).toEqual({ kind: 'empty' });
    expect(migrationHistory([{ ...BASELINE }])).toEqual({ kind: 'baseline' });
    expect(migrationHistory([{ ...BASELINE }, { version: '20261201000000', name: 'later', checksum: 'x' }])).toEqual({ kind: 'baseline' });
  });

  it("is v2.4.0's with exactly its rows and checksums, in any order", () => {
    expect(migrationHistory(v240Rows())).toEqual({ kind: 'v2.4.0' });
    expect(migrationHistory(v240Rows().reverse())).toEqual({ kind: 'v2.4.0' });
  });

  it('is an edited one when a v2.4.0 checksum differs, naming the migration', () => {
    const rows = v240Rows();
    rows[40] = { ...rows[40]!, checksum: 'f'.repeat(64) };
    const history = migrationHistory(rows);
    expect(history).toEqual({ kind: 'edited', migration: V2_4_0_MIGRATIONS[40], applied: 'f'.repeat(64) });
    const message = editedHistoryMessage(history as Extract<typeof history, { kind: 'edited' }>);
    expect(message).toContain(`Migration ${V2_4_0_MIGRATIONS[40]!.version} (${V2_4_0_MIGRATIONS[40]!.name}) has been modified!`);
    expect(message).toContain(V2_4_0_MIGRATIONS[40]!.checksum);
  });

  it("is an older release's with some of v2.4.0's migrations, and the refusal says what it found and to upgrade to v2.4.0 first", () => {
    const older = v240Rows().slice(0, 150);
    const history = migrationHistory(older);
    expect(history).toEqual({ kind: 'older', count: 150, newest: { version: older[149]!.version, name: older[149]!.name } });
    const message = olderHistoryMessage(history as Extract<typeof history, { kind: 'older' }>);
    expect(message).toContain(`has 150 migration(s), the newest ${older[149]!.version} (${older[149]!.name})`);
    expect(message).toContain('from a release before v2.4.0');
    expect(message).toMatch(/Upgrade to v2\.4\.0 first .*then to this release\. Nothing was changed\.$/);
  });

  it('is an unknown one with a migration neither v2.4.0 nor this release has, named, to roll back or restore past', () => {
    for (const version of ['20261112300000', '20250101000000']) {
      const rows = [...v240Rows(), { version, name: 'my own', checksum: 'a'.repeat(64) }];
      const history = migrationHistory(rows);
      expect(history).toEqual({ kind: 'unknown', count: 162, unknown: [{ version, name: 'my own' }] });
      const message = unknownHistoryMessage(history as Extract<typeof history, { kind: 'unknown' }>);
      expect(message).toContain(`has 162 migration(s), and 1 of them neither v2.4.0 nor this release has: ${version} (my own).`);
      expect(message).toContain('roll them back with the build that has their files (node dist/scripts/migrate.js rollback)');
      expect(message).toContain('or restore a backup made before they were applied');
      // v2.4.0 refuses such a database too.
      expect(message).not.toMatch(/Upgrade to v2\.4\.0/);
    }
    // With an older release's rows too, and more than ten unknown: the first ten, and how many more.
    const many = Array.from({ length: 12 }, (_, i) => ({ version: `2025010100${String(i).padStart(4, '0')}`, name: `own ${i}`, checksum: 'x' }));
    const history = migrationHistory([...v240Rows().slice(0, 20), ...many]);
    expect(history).toMatchObject({ kind: 'unknown', count: 32 });
    const message = unknownHistoryMessage(history as Extract<typeof history, { kind: 'unknown' }>);
    expect(message).toContain('12 of them neither v2.4.0 nor this release has: 20250101000000 (own 0), ');
    expect(message).toContain('20250101000009 (own 9) and 2 more.');
    // Rows only newer than the baseline, but without its row: not a database Nuggets made.
    expect(migrationHistory([{ version: '20261201000000', name: 'later', checksum: 'x' }])).toMatchObject({ kind: 'unknown' });
  });

  it("is a mixed one with the baseline's row and rows older than it, named", () => {
    const stray = V2_4_0_MIGRATIONS.at(-1)!;
    const history = migrationHistory([{ ...BASELINE }, { ...stray }]);
    expect(history).toEqual({ kind: 'mixed', older: [{ version: stray.version, name: stray.name }] });
    const message = mixedHistoryMessage(history as Extract<typeof history, { kind: 'mixed' }>);
    expect(message).toContain(`has the baseline's row (${BASELINE.version}) and 1 migration(s) older than it: ${stray.version} (${stray.name}).`);
    expect(message).toContain('Restore a backup made before they were. Nothing was changed.');
  });
});

describe('a failure loading the baseline', () => {
  const dbError = (code: string, message: string) => Object.assign(new Error(message), { code, severity: 'ERROR' });

  it("keeps a duplicate object's message whole, naming what is in the way, with what to do", () => {
    const error = baselineLoadError('nuggets_db', dbError('42723', 'function "app_today" already exists with same argument types'));
    expect(migrationFailedLine(error)).toBe(
      'Migration failed: Loading the baseline into database "nuggets_db" failed, and was rolled back: 42723: function "app_today" ' +
        'already exists with same argument types. Something the baseline creates is in it already (left by an earlier install, ' +
        'or made by hand): drop it, or point DB_NAME at an empty database.'
    );
    for (const code of ['42P07', '42710', '42P06', '42701']) {
      expect(migrationFailedLine(baselineLoadError('nuggets_db', dbError(code, 'relation "tags" already exists'))), code).toContain('"tags"');
    }
  });

  it('leaves any other error as it is, redacted as a migration\'s', () => {
    // An event trigger, say, that raises with a row's value in it.
    const raised = dbError('P0001', 'payee "Rent to J. Smith" is not allowed');
    expect(baselineLoadError('nuggets_db', raised)).toBe(raised);
    expect(migrationFailedLine(baselineLoadError('nuggets_db', raised))).toBe('Migration failed: P0001: payee "…" is not allowed');
    const plain = new Error('connection terminated');
    expect(baselineLoadError('nuggets_db', plain)).toBe(plain);
  });
});

describe("a cutover's comparison, as the restore command prints it", () => {
  it('says there is no difference, or names each, or that it could not compare', () => {
    expect(driftLines({ missing: [], extra: [], changed: [] })).toEqual(["Its schema is a fresh baseline's."]);
    expect(driftLines(null)).toEqual(["Its schema couldn't be compared with a fresh baseline's (the log says why)."]);
    expect(driftLines({ missing: ['index public.a'], extra: [], changed: ['policy public.tags.p', 'view public.v'] })).toEqual([
      "Its schema differs from a fresh baseline's in 3 object(s), as it did before the cutover (which went on all the same):",
      '  missing: index public.a',
      '  changed: policy public.tags.p, view public.v',
    ]);
    const many = Array.from({ length: 52 }, (_, i) => `index public.i${i}`);
    expect(driftLines({ missing: [], extra: many, changed: [] })[1]).toMatch(/, index public\.i49 and 2 more$/);
  });
});

describe("a new migration's version", () => {
  it('is UTC now, when that is newer than the baseline and every migration file', () => {
    expect(nextMigrationVersion(new Date('2026-12-01T10:20:30.999Z'), [])).toBe('20261201102030');
    expect(nextMigrationVersion(new Date('2026-12-01T10:20:30Z'), ['20261130000000'])).toBe('20261201102030');
  });

  it("is the newest version's day at now's time of day while now is not later, so branches made on one day differ", () => {
    // The day the squash was made: the baseline is dated two days on.
    expect(nextMigrationVersion(new Date('2026-11-11T05:00:00Z'), [])).toBe('20261113050000');
    expect(nextMigrationVersion(new Date('2026-11-11T05:00:01Z'), [])).toBe('20261113050001');
    expect(nextMigrationVersion(new Date('2026-11-12T17:42:09Z'), [])).toBe('20261113174209');
    // Not newer at that time of day: the next day.
    expect(nextMigrationVersion(new Date('2026-11-13T00:00:00Z'), [])).toBe('20261114000000');
    expect(nextMigrationVersion(new Date('2026-11-11T05:00:00Z'), ['20261113000001', '20261113235959'])).toBe('20261114050000');
    expect(nextMigrationVersion(new Date('2026-12-31T23:59:59Z'), ['20261231235959'])).toBe('20270101235959');
    // Whatever the newest, the result is newer than it.
    for (const now of ['2026-01-01T00:00:00Z', '2026-11-13T00:00:01Z', '2030-06-15T12:00:00Z']) {
      const version = nextMigrationVersion(new Date(now), ['20261201000000']);
      expect(version > '20261201000000' && version > BASELINE.version, now).toBe(true);
    }
  });
});

describe('the baseline, init.sql', () => {
  it("seeds schema_migrations with the baseline's row", () => {
    const seed = INIT_SQL.slice(INIT_SQL.indexOf('INSERT INTO public.schema_migrations'));
    expect(seed).toContain(`('${BASELINE.version}', '${BASELINE.name}', '${BASELINE.checksum}')`);
  });

  it('creates no extension, and starts the first ledger and the SMTP settings as v2.4.0 left them', () => {
    expect(INIT_SQL).not.toMatch(/CREATE EXTENSION/i);
    // The first ledger was renamed from 'Budget 1'; no SES host is seeded.
    expect(INIT_SQL).toMatch(/INSERT INTO public\.tenants \(.*\) VALUES \('1'::integer, '1'::integer, 'Ledger 1'/);
    expect(INIT_SQL).not.toContain("'Budget 1'");
    expect(INIT_SQL).toMatch(/'notification_smtp_host'::character varying\(100\), ''::character varying\(500\)/);
    expect(INIT_SQL).not.toMatch(/amazonaws\.com/);
  });
});
