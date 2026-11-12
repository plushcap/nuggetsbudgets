import * as path from 'path';
import { getDirname } from '../utils/esm-compat.js';
import { V2_4_0_MIGRATIONS, type RecordedMigration } from './v240Migrations.js';

/**
 * The baseline: the schema init.sql holds, recorded in schema_migrations as one row of its
 * own. v3.0.0 made it of the whole migration history up to v2.4.0 (whose 161 files are
 * gone), and every migration since is newer than it. The migration runner's file checks
 * skip its row (it has no file); readiness, the schema check and the backup guard count it
 * as a migration this code ships.
 *
 * Its checksum is the SHA-256 of the SQL that cuts a v2.4.0 database over to it
 * (backend/upgrade/from-v2.4.0.sql, MigrationService.checksum), which never changes.
 */
export const BASELINE: RecordedMigration = {
  version: '20261113000000',
  name: 'v3.0.0 baseline',
  checksum: '56dca272e15a60624154fbdd653c2a4087bf20ac4a061f858e4970aafec5e6d9',
};

/** The SQL that turns a v2.4.0 database's schema into the baseline's: backend/upgrade (dist/db → ../../upgrade). */
export const V2_4_0_CUTOVER_PATH = path.join(getDirname(import.meta.url), '../../upgrade/from-v2.4.0.sql');

/** The fingerprint of a fresh baseline's schema, which a cut-over database is compared with (db/schemaFingerprint.ts). */
export const BASELINE_FINGERPRINT_PATH = path.join(getDirname(import.meta.url), '../../upgrade/baseline-fingerprint.txt');

/** A schema_migrations row: its version and name. */
export interface NamedVersion {
  version: string;
  name: string;
}

/** What a database's schema_migrations rows say it is. */
export type MigrationHistory =
  /** No rows: an empty database (the runner loads the baseline into it). */
  | { kind: 'empty' }
  /** The baseline's row (and the migrations applied since). */
  | { kind: 'baseline' }
  /** Exactly v2.4.0's migrations: the runner cuts it over to the baseline. */
  | { kind: 'v2.4.0' }
  /** v2.4.0's versions, but a checksum differs: one was edited after it ran. */
  | { kind: 'edited'; migration: RecordedMigration; applied: string }
  /** Some of v2.4.0's migrations and nothing else: a release before v2.4.0. */
  | { kind: 'older'; count: number; newest: NamedVersion }
  /** Without the baseline's row, migrations neither v2.4.0 nor this release has (`unknown`). */
  | { kind: 'unknown'; count: number; unknown: NamedVersion[] }
  /** The baseline's row, and rows older than it (`older`), which no database at the baseline has. */
  | { kind: 'mixed'; older: NamedVersion[] };

/** The history `rows` (a database's schema_migrations) make. */
export function migrationHistory(rows: readonly { version: string; name: string; checksum: string }[]): MigrationHistory {
  if (rows.length === 0) return { kind: 'empty' };
  const named = (row: NamedVersion): NamedVersion => ({ version: row.version, name: row.name });
  const byVersion = (a: NamedVersion, b: NamedVersion) => a.version.localeCompare(b.version);
  if (rows.some((row) => row.version === BASELINE.version)) {
    const older = rows.filter((row) => row.version < BASELINE.version).map(named).sort(byVersion);
    return older.length > 0 ? { kind: 'mixed', older } : { kind: 'baseline' };
  }
  const applied = new Map(rows.map((row) => [row.version, row]));
  const v240 = new Set(V2_4_0_MIGRATIONS.map((m) => m.version));
  const unknown = [...applied.values()].filter((row) => !v240.has(row.version)).map(named).sort(byVersion);
  if (unknown.length > 0) return { kind: 'unknown', count: applied.size, unknown };
  if (applied.size === v240.size) {
    const edited = V2_4_0_MIGRATIONS.find((m) => applied.get(m.version)?.checksum !== m.checksum);
    return edited ? { kind: 'edited', migration: edited, applied: applied.get(edited.version)!.checksum } : { kind: 'v2.4.0' };
  }
  const newest = [...applied.values()].map(named).sort(byVersion).at(-1)!;
  return { kind: 'older', count: applied.size, newest };
}

/** At most ten versions, with their names, then how many more. */
function listed(versions: readonly NamedVersion[]): string {
  const shown = versions.slice(0, 10).map((v) => `${v.version} (${v.name})`).join(', ');
  return versions.length > 10 ? `${shown} and ${versions.length - 10} more` : shown;
}

/** Why the runner refuses a database from a release before v2.4.0, for a person: what it found and what to do. */
export function olderHistoryMessage(history: Extract<MigrationHistory, { kind: 'older' }>): string {
  return (
    `This release upgrades a database from v2.4.0 or from its own baseline (${BASELINE.version}) only. Its schema_migrations ` +
    `has ${history.count} migration(s), the newest ${history.newest.version} (${history.newest.name}), and v2.4.0 has ` +
    `${V2_4_0_MIGRATIONS.length}: it is from a release before v2.4.0. Upgrade to v2.4.0 first (it migrates the database ` +
    'as it starts), then to this release. Nothing was changed.'
  );
}

/**
 * Why the runner refuses a database with migrations neither v2.4.0 nor this release has.
 * v2.4.0 refuses it too (it has no file for them), so the way on is to take them off.
 */
export function unknownHistoryMessage(history: Extract<MigrationHistory, { kind: 'unknown' }>): string {
  return (
    `This release upgrades a database from v2.4.0 or from its own baseline (${BASELINE.version}) only. Its schema_migrations ` +
    `has ${history.count} migration(s), and ${history.unknown.length} of them neither v2.4.0 nor this release has: ` +
    `${listed(history.unknown)}. Neither release can migrate it while they are applied: roll them back with the build ` +
    'that has their files (node dist/scripts/migrate.js rollback), or restore a backup made before they were applied, ' +
    'then upgrade. Nothing was changed.'
  );
}

/** Why the runner refuses a database with the baseline's row and rows older than it. */
export function mixedHistoryMessage(history: Extract<MigrationHistory, { kind: 'mixed' }>): string {
  return (
    `This database's schema_migrations has the baseline's row (${BASELINE.version}) and ${history.older.length} ` +
    `migration(s) older than it: ${listed(history.older)}. The baseline holds the schema up to its version, so a database ` +
    'at it has no older rows: they were added since. Restore a backup made before they were. Nothing was changed.'
  );
}

/**
 * The version `npm run migrate:create` gives a new migration: UTC now, when that is newer
 * than every version it knows (the baseline's, a migration file's), which the runner
 * requires. While it isn't (before the day the baseline is dated, say), the newest version's
 * day at UTC now's time of day, a day later while that isn't newer: branches made on one day
 * get different versions, as they would from the clock, rather than each the newest plus a
 * second. The runner refuses two files with one version all the same.
 */
export function nextMigrationVersion(now: Date, known: readonly string[]): string {
  const stamp = (d: Date) => d.toISOString().replace(/\D/g, '').slice(0, 14);
  const newest = [BASELINE.version, ...known].filter((v) => /^\d{14}$/.test(v)).sort().at(-1)!;
  const current = stamp(now);
  if (current > newest) return current;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(newest)!;
  const candidate = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds()));
  while (stamp(candidate) <= newest) candidate.setUTCDate(candidate.getUTCDate() + 1);
  return stamp(candidate);
}

/** Why the runner refuses a v2.4.0 history with an edited migration. */
export function editedHistoryMessage(history: Extract<MigrationHistory, { kind: 'edited' }>): string {
  return (
    `Migration ${history.migration.version} (${history.migration.name}) has been modified!\n` +
    `Applied checksum: ${history.applied}\n` +
    `v2.4.0's checksum: ${history.migration.checksum}\n` +
    'Never modify migrations that have been applied to production. Nothing was changed.'
  );
}
