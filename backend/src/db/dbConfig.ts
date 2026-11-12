import { envSecret, initializeSecrets } from '../utils/docker-secrets.js';
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
 * The schema owner: the role migrations run as, and backups and restores connect as
 * (MIGRATION_DB_USER with MIGRATION_DB_PASSWORD or the db_password secret). Not DB_USER's
 * password: with the role split that is the serving role's.
 * BACKUP_DB_USER / BACKUP_DB_PASSWORD override it for backups, restores and the schema
 * download (Settings → Utilities) only.
 */
export function getOwnerCredentials(env: NodeJS.ProcessEnv = process.env, forBackups = false): DbCredentials {
  const settings = configFor(env);
  const user = (forBackups ? settings.BACKUP_DB_USER : undefined) || settings.MIGRATION_DB_USER || settings.DB_USER;
  const password =
    (forBackups ? envSecret('BACKUP_DB_PASSWORD', env) : undefined) ||
    envSecret('MIGRATION_DB_PASSWORD', env) ||
    initializeSecrets().dbPassword;
  return { user, password };
}
