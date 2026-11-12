import type { PoolClient } from 'pg';

/**
 * Keeps a migration test's schema change and a test ledger's setup or cleanup apart, so the
 * two never deadlock.
 *
 * The migration tests run a migration's SQL on the shared test database in a transaction
 * they roll back. That DDL locks a table and then the tables it refers to: dropping
 * tenant_settings (as a DOWN part did before v3.0.0) locks it, then takes users and tenants
 * (ACCESS EXCLUSIVE, to drop its foreign keys' triggers). Deleting a test ledger
 * (createTestTenant's cleanup) goes the other way round: `DELETE FROM tenants` (or
 * `users`) locks that table, then each table that refers to it, as its foreign keys check
 * or clear their rows. Running at once, each held a table the other waited for, Postgres
 * failed one of them (40P01), and when that was the cleanup, the file's afterAll failed.
 *
 * So a migration test's transaction takes this lock exclusively as its first statement,
 * and creating or deleting a test ledger takes it shared, before any table: cleanups run
 * alongside each other, and neither side ever waits for the other while it holds a table.
 * A transaction-level lock for the migration test (its ROLLBACK lets go); a session lock
 * on the one connection a cleanup runs on.
 *
 * The lock doesn't keep a schema change from the app's own queries in other files (SELECT
 * app_timezone() deadlocked with one), so the migration tests also run in a project
 * of their own, one file at a time, after the rest (`migrations` in vitest.config.ts).
 * There this lock still orders a file's own ledgers against its schema changes.
 */
const SCHEMA_CHANGE_LOCK_KEY = 4242042485;

/** A migration test's rolled-back transaction: call it right after BEGIN, before any DDL. */
export async function holdSchemaChangeLock(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [SCHEMA_CHANGE_LOCK_KEY]);
}

/** Creating a test ledger: call it right after BEGIN, before any write. */
export async function shareSchemaChangeLockInTransaction(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [SCHEMA_CHANGE_LOCK_KEY]);
}

/** Run `fn` on `client` with the lock held shared: a test ledger's cleanup. */
export async function withSchemaChangeLockShared<T>(client: PoolClient, fn: () => Promise<T>): Promise<T> {
  await client.query('SELECT pg_advisory_lock_shared($1::bigint)', [SCHEMA_CHANGE_LOCK_KEY]);
  try {
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [SCHEMA_CHANGE_LOCK_KEY]).catch(() => undefined);
  }
}
