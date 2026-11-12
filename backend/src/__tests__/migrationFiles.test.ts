import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { MigrationService } from '../services/MigrationService.js';
import { BASELINE, V2_4_0_CUTOVER_PATH } from '../db/baseline.js';

const MIGRATIONS_DIR = path.join(getDirname(import.meta.url), '../../migrations');
const migrationFiles = () => readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{14}_.*\.sql$/.test(f)).sort();

describe('migration checksums', () => {
  // A Windows checkout with core.autocrlf turns every LF into CRLF; the checksum of
  // the migration it reads must still match the one schema_migrations holds.
  it('are the same for a CRLF copy of a migration', () => {
    for (const file of migrationFiles()) {
      const lf = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      expect(lf.includes('\r'), `${file} is checked in with LF line endings`).toBe(false);
      const crlf = lf.replace(/\n/g, '\r\n');
      const fromLf = MigrationService.parseMigration(lf);
      const fromCrlf = MigrationService.parseMigration(crlf);
      expect(MigrationService.checksum(fromCrlf.upSql), file).toBe(MigrationService.checksum(fromLf.upSql));
      expect(fromCrlf.downSql === undefined, `${file}: the DOWN marker is found in CRLF too`).toBe(fromLf.downSql === undefined);
    }
  });

  it("match the checksums the baseline seeds, its own row first, so a fresh install validates", () => {
    const baseline = readFileSync(path.join(MIGRATIONS_DIR, '../init.sql'), 'utf8');
    const seeded = [...baseline.matchAll(/\(\s*'(\d{14})',\s*'((?:[^']|'')*)',\s*'([0-9a-f]{64})'\s*\)/g)];
    // The baseline's row, then a row for each migration folded into init.sql since.
    expect(seeded[0]?.slice(1)).toEqual([BASELINE.version, BASELINE.name, BASELINE.checksum]);
    const files = new Map(migrationFiles().map((f) => [f.slice(0, 14), f]));
    for (const [, version, , checksum] of seeded.slice(1)) {
      const file = files.get(version!);
      expect(file, `the baseline seeds ${version}, which has a migration file`).toBeDefined();
      const { upSql } = MigrationService.parseMigration(readFileSync(path.join(MIGRATIONS_DIR, file!), 'utf8'));
      expect(MigrationService.checksum(upSql), file).toBe(checksum);
    }
  });

  // The baseline's checksum is the cutover's: the runner refuses to cut a v2.4.0 database
  // over with any other file. It never changes, whatever the checkout's line endings.
  it("of the v2.4.0 cutover is the baseline's", () => {
    const cutover = readFileSync(V2_4_0_CUTOVER_PATH, 'utf8');
    expect(cutover.includes('\r\n'), 'upgrade/from-v2.4.0.sql is checked in with LF line endings').toBe(false);
    expect(MigrationService.checksum(cutover)).toBe(BASELINE.checksum);
    expect(MigrationService.checksum(cutover.replace(/\n/g, '\r\n'))).toBe(BASELINE.checksum);
  });
});

describe('parseMigration', () => {
  it('splits UP from DOWN and reads the no-transaction directive', () => {
    expect(MigrationService.parseMigration('CREATE TABLE a (id int);\n-- === DOWN ===\nDROP TABLE a;\n')).toEqual({
      upSql: 'CREATE TABLE a (id int);',
      downSql: 'DROP TABLE a;',
      noTransaction: false,
    });
    expect(
      MigrationService.parseMigration('-- nuggets:no-transaction\nCREATE INDEX CONCURRENTLY i ON a (id);\n')
    ).toMatchObject({ noTransaction: true, downSql: undefined });
    // Only as a line of its own in the UP part.
    expect(MigrationService.parseMigration('-- see nuggets:no-transaction in CONTRIBUTING\nSELECT 1;').noTransaction).toBe(false);
    expect(MigrationService.parseMigration('SELECT 1;\n-- === DOWN ===\n-- nuggets:no-transaction\nSELECT 2;').noTransaction).toBe(false);
  });
});

describe('migration DOWN sections', () => {
  // CI rolls back every migration newer than the baseline, re-applies them and compares the
  // schema (ci-cd.yml, check-migrations.sh rollback). The baseline (init.sql) has no DOWN
  // part, and never will; every migration after it needs one, so the rollback check keeps
  // covering them.
  const NEWEST_WITHOUT_DOWN = BASELINE.version;

  it('exist in every migration newer than the baseline', () => {
    const missing = migrationFiles()
      .filter((f) => f.slice(0, 14) > NEWEST_WITHOUT_DOWN)
      .filter((f) => !MigrationService.parseMigration(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')).downSql);
    expect(missing, 'add a -- === DOWN === part that undoes the migration').toEqual([]);
  });
});
