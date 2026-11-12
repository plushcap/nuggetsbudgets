import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { BASELINE } from '../db/baseline.js';
import { generateTimestamp } from '../scripts/migrate.js';

/**
 * A migration's version (its 14-digit timestamp prefix) is schema_migrations' primary
 * key, so two files with one version would leave one of them never applied. Work done
 * in parallel picks timestamps independently and has collided before. The baseline's
 * row holds a version of its own, and the schema up to it: every file is newer.
 */
describe('migration files', () => {
  const dir = path.join(getDirname(import.meta.url), '../../migrations');

  it('each have a version of their own, newer than the baseline', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    const byVersion = new Map<string, string[]>();
    for (const file of files) {
      const version = /^(\d{14})_/.exec(file)?.[1];
      expect(version, `${file} starts with a 14-digit version`).toBeDefined();
      expect(version! > BASELINE.version, `${file} is newer than the baseline (${BASELINE.version})`).toBe(true);
      byVersion.set(version!, [...(byVersion.get(version!) ?? []), file]);
    }
    expect([...byVersion.values()].filter((group) => group.length > 1)).toEqual([]);
  });

  it("get a version from `migrate create` that the runner takes: UTC now, or after the newest it knows", () => {
    // The repository's own directory: the baseline is the newest, dated after the day it was made.
    expect(generateTimestamp(new Date('2026-11-11T05:00:00Z'))).toBe('20261113050000');
    expect(generateTimestamp(new Date('2026-12-01T10:20:30Z'))).toBe('20261201102030');
    const own = mkdtempSync(path.join(tmpdir(), 'nuggets-create-'));
    try {
      writeFileSync(path.join(own, '20261201000000_newest.sql'), 'SELECT 1;\n');
      writeFileSync(path.join(own, 'README.md'), 'not a migration\n');
      expect(generateTimestamp(new Date('2026-11-11T05:00:00Z'), own)).toBe('20261201050000');
      expect(generateTimestamp(new Date('2026-12-02T00:00:00Z'), own)).toBe('20261202000000');
    } finally {
      rmSync(own, { recursive: true, force: true });
    }
  });

  it('are all the directory holds, with the file that keeps it in git', () => {
    const other = readdirSync(dir).filter((f) => !/^\d{14}_.*\.sql$/.test(f));
    expect(other).toEqual(['.gitkeep']);
  });
});
