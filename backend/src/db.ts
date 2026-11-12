import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';
import type { DB } from './db/schema.generated.js';
import dotenv from 'dotenv';
import { initializeSecrets } from './utils/docker-secrets.js';
import { servingRolePassword } from './db/servingRole.js';
import { createLogger } from './utils/logger.js';
import { refuseSetting } from './utils/productionConfig.js';
// Also, as a side effect, `date` columns read as 'YYYY-MM-DD' strings.
import { sessionOptions } from './db/pgSession.js';
import { handleConnectionErrors } from './db/connectionErrors.js';
import { getDbLocation } from './db/dbConfig.js';
import { config, strictSetting } from './config.js';

const logger = createLogger({ service: 'Database' });

// Load environment variables
dotenv.config();

// Initialize Docker secrets
const secrets = initializeSecrets();
const location = getDbLocation();

/**
 * The app pool's size and lock guardrail, from the environment, checked at
 * startup with the rest of the configuration (index.ts):
 * - DB_POOL_MAX (default 20): connections the backend may hold. Postgres allows 100 by
 *   default, and migrations and backups need a few of their own.
 * - DB_LOCK_TIMEOUT_MS (default 15000; 0 turns it off): how long a statement waits for a
 *   lock before it fails. Without it a request stuck behind a long lock (a migration, a
 *   long transaction) waited the whole statement_timeout, holding its connection, while
 *   the requests behind it queued.
 */
export function poolSettings(env: NodeJS.ProcessEnv = process.env): { max: number; lockTimeoutMs: number } {
  return {
    max: strictSetting('DB_POOL_MAX', env, refuseSetting),
    lockTimeoutMs: strictSetting('DB_LOCK_TIMEOUT_MS', env, refuseSetting),
  };
}

// An invalid setting doesn't throw here, at import: index.ts's startup check reports it
// with every other problem and refuses to start. Until then the defaults stand.
const { max, lockTimeoutMs } = (() => {
  try {
    return poolSettings();
  } catch (err) {
    logger.error({ err }, 'Invalid database pool setting; using the defaults');
    return poolSettings({});
  }
})();

const pool = new Pool({
  ...location,
  user: config().DB_USER,
  // The serving role (nuggets_app) has the app_db_password secret; only a
  // single-role setup uses the owner's db_password. index.ts refuses to serve as a role
  // RLS doesn't apply to (db/servingRole.ts).
  password: servingRolePassword(secrets),
  // Add connection pool settings
  max,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // Notice a connection whose server end went away (a restarted database, a dropped
  // network) rather than hold it until a query on it hangs.
  keepAlive: true,
  keepAliveInitialDelayMillis: 30000,
  // Add retry logic
  statement_timeout: 30000,
  query_timeout: 30000,
  lock_timeout: lockTimeoutMs,
  // A transaction left waiting this long is ended by the server, which frees its
  // connection and locks. Nothing should wait on the network inside one; the
  // limit is generous because a streamed export writes to a slow client inside one.
  idle_in_transaction_session_timeout: 300000,
  // Sessions run UTC, whatever the server's default zone, and are named
  // nuggets-backend in pg_stat_activity and the server's logs.
  options: sessionOptions('nuggets-backend'),
});

// Log database configuration on initialization
logger.info({
  ...location,
  user: config().DB_USER,
  maxConnections: max,
  idleTimeout: 30000,
  connectionTimeout: 5000,
  statementTimeoutMs: 30000,
  lockTimeoutMs,
  idleInTransactionTimeoutMs: 300000,
}, 'Database pool initialized');

// Fires on every NEW physical connection the pool opens. With idleTimeout the
// pool routinely closes idle connections and reopens them (every ~30s once the
// schedulers tick), so this is normal churn — keep it at debug to avoid flooding
// production logs with a "Connected" line every half-minute.
pool.on('connect', () => {
  logger.debug('Connected to PostgreSQL database');
});

// A connection that fails (the server ended its session: a restart, a restore's swap,
// idle_in_transaction_session_timeout) is logged, idle in the pool or checked out by a
// request, rather than left an uncaught exception that stops the server
// (db/connectionErrors.ts). A query running on it fails as itself.
handleConnectionErrors(pool, (err: Error) => {
  logger.error({ err }, 'Unexpected error on a database connection');
});

// NOTE: Process shutdown (including closing this pool) is owned by
// ApplicationLifecycleService.gracefulShutdown so SIGINT and SIGTERM behave
// identically and don't race a separate handler here. Do not add a
// process.on('SIGINT') pool-teardown in this module.

// Typed query builder (Kysely) sharing the SAME pg Pool as raw pool.query(...).
// Adoption is additive: raw SQL and `db` run on one pool, one connection
// lifecycle, one transaction model — convert call sites opportunistically.
// Generated row types live in ./db/schema.generated.ts (run `npm run db:codegen`
// against a fully-migrated database after writing a migration).
export const db = new Kysely<DB>({
  dialect: new PostgresDialect({ pool }),
});

export default pool;