import type { Pool } from 'pg';
import { readdirSync } from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.js';
import { oneRow } from '../utils/present.js';
import { BASELINE } from './baseline.js';
import { MigrationService } from '../services/MigrationService.js';

const logger = createLogger({ service: 'SchemaCheck' });

const MIGRATION_FILE = /^\d{14}_.*\.sql$/;
const defaultMigrationsDir = () => path.join(process.cwd(), 'migrations');

/**
 * The versions of the migrations this code ships, oldest first ([] when there is no
 * migrations directory to read). /api/ready reports any of them not in schema_migrations
 * as pending (ApplicationLifecycleService), as the migration runner would apply it.
 */
export function migrationFileVersions(migrationsDir: string = defaultMigrationsDir()): string[] {
  try {
    return readdirSync(migrationsDir)
      .filter((f) => MIGRATION_FILE.test(f))
      .map((f) => f.slice(0, 14))
      .sort();
  } catch {
    // No migrations directory next to the code: nothing to compare against.
    return [];
  }
}

/**
 * The schema versions this code ships, oldest first: the baseline's (db/baseline.ts), then
 * the migration files'. /api/ready reports any of them not in schema_migrations as pending
 * (ApplicationLifecycleService): a v2.4.0 database not cut over yet lacks the baseline's.
 */
export function shippedSchemaVersions(migrationsDir: string = defaultMigrationsDir()): string[] {
  return [...new Set([BASELINE.version, ...migrationFileVersions(migrationsDir)])].sort();
}

export class SchemaNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaNotReadyError';
  }
}

/**
 * The server never creates or changes the schema: the migration runner does, as the
 * database owner, before the server starts (docker-entrypoint.sh runs
 * `node dist/scripts/migrate.js migrate` unless RUN_MIGRATIONS=false), and it loads the
 * baseline into an empty database first. This checks that it ran, so a database
 * without the schema stops the server at startup with what to do, instead of failing
 * each request with "relation ... does not exist". Pending migrations are logged, not
 * refused: they may be applied separately. Until they are, /api/ready reports the server
 * not ready.
 */
export async function assertSchemaMigrated(
  pool: Pool,
  migrationsDir: string = defaultMigrationsDir()
): Promise<{ pending: string[]; refusal?: string }> {
  const { rows } = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.schema_migrations') IS NOT NULL AS present`
  );
  if (!oneRow(rows, 'the schema check').present) {
    throw new SchemaNotReadyError(
      'The database has no Nuggets schema yet. Run the migrations as the database owner ' +
      '(MIGRATION_DB_USER): `node dist/scripts/migrate.js migrate`, which loads the baseline into an ' +
      'empty database. The container does this on start unless RUN_MIGRATIONS=false.'
    );
  }
  const applied = new Set(
    (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version)
  );
  if (applied.size === 0) {
    throw new SchemaNotReadyError(
      'The database has an empty migration history. Run `node dist/scripts/migrate.js migrate` as the database owner.'
    );
  }

  // Every file not applied, as the runner sees it, not only the ones newer than the newest;
  // and the baseline, which a v2.4.0 database not cut over yet lacks.
  const pending = shippedSchemaVersions(migrationsDir).filter((version) => !applied.has(version));

  // A history the runner would refuse (a release before v2.4.0, migrations it doesn't know,
  // an edited one): running the migrations wouldn't help, so say what migrate would say.
  let refusal: string | undefined;
  try {
    refusal = (await new MigrationService(pool, { migrationsDir }).getStatus()).refusal;
  } catch (err) {
    logger.warn({ err }, 'Could not check the migration history');
  }
  if (refusal) {
    logger.error(
      { latestApplied: [...applied].sort().at(-1), pendingCount: pending.length },
      `The migration runner refuses this database, so the migrations can't bring it up to this code: ${refusal}`
    );
    return { pending, refusal };
  }
  if (pending.length > 0) {
    logger.warn(
      { latestApplied: [...applied].sort().at(-1), pendingCount: pending.length, pending },
      'The database is behind this code: run the migrations (node dist/scripts/migrate.js migrate)'
    );
  }
  return { pending };
}
