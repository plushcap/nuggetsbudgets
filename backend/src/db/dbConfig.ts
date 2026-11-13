import { initializeSecrets } from '../utils/docker-secrets.js';
import { configFor } from '../config.js';

/**
 * Where the app's database is: one definition for the serving pool (db.ts), the migration
 * pool and backups. Backups used to read POSTGRES_DB, which the backend's
 * environment never sets, so they always dumped and restored `nuggets_db` whatever
 * DB_NAME said.
 */
export interface DbLocation {
  host: string;
  port: number;
  database: string;
}

export function getDbLocation(env: NodeJS.ProcessEnv = process.env): DbLocation {
  const settings = configFor(env);
  return {
    host: settings.DB_HOST,
    port: settings.DB_PORT,
    // POSTGRES_DB, the name the Postgres image creates, only when DB_NAME isn't set.
    database: settings.DB_NAME || settings.POSTGRES_DB || 'nuggets_db',
  };
}

export interface DbCredentials {
  user: string;
  password: string;
}

/**
 * The schema owner: the role migrations run as, and backups, restores and the schema
 * download (Settings → Utilities) connect as. MIGRATION_DB_USER (else DB_USER, a single-role
 * setup) with the db_password secret, the password Postgres gave the owner. Not DB_USER's
 * password: with the role split that is the serving role's.
 */
export function getOwnerCredentials(env: NodeJS.ProcessEnv = process.env): DbCredentials {
  const settings = configFor(env);
  return { user: settings.MIGRATION_DB_USER || settings.DB_USER, password: initializeSecrets().dbPassword };
}
