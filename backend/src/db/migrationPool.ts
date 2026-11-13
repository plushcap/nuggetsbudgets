import { Pool } from 'pg';
import { createLogger } from '../utils/logger.js';
import { getDbLocation, getOwnerCredentials } from './dbConfig.js';
// Also, as a side effect, `date` columns read as 'YYYY-MM-DD' strings.
import { sessionOptions } from './pgSession.js';
import { handleConnectionErrors } from './connectionErrors.js';

const logger = createLogger({ service: 'MigrationPool' });

/**
 * A dedicated pg Pool for DDL / migrations that connects as the SCHEMA OWNER.
 *
 * Why this exists: the request-serving pool (db.ts) connects as the non-owner
 * `nuggets_app` role (NOSUPERUSER NOBYPASSRLS) so policies actually apply to it.
 * Migrations still need the owner, so the migration runner uses its OWN
 * credential here:
 *
 *   MIGRATION_DB_USER and the db_password secret   (MIGRATION_DB_USER falls back to DB_USER)
 *
 * The fallback is for a single-role setup, where DB_USER is the owner.
 * This pool also drops the serving statement/query timeouts because DDL,
 * backfills and index builds can legitimately run long.
 */
export function createMigrationPool(database?: string): Pool {
  const location = getDbLocation();
  const { host, port } = location;
  database ??= location.database;
  const { user, password } = getOwnerCredentials();

  logger.info({ host, port, database, user }, 'Creating migration pool (schema-owner credentials)');

  const pool = new Pool({
    host,
    port,
    database,
    user,
    password,
    // Migrations are short-lived and serialized by an advisory lock; a small
    // pool is plenty.
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 30000,
    // Each migration statement sets its own lock_timeout (MIGRATION_LOCK_TIMEOUT).
    // No statement timeout: long DDL/backfills must not be killed mid-migration.
    statement_timeout: 0,
    // Sessions run UTC, whatever the server's default zone, named nuggets-migrate
    // in pg_stat_activity and the server's logs.
    options: sessionOptions('nuggets-migrate'),
  });
  // A session the server ends (a restart, pg_terminate_backend) fails its query; its
  // connection's 'error' must not be uncaught.
  return handleConnectionErrors(pool, (err) => logger.warn({ err, database }, 'A migration database connection failed'));
}
