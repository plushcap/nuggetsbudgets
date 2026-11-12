import type { Pool, PoolClient } from 'pg';

/**
 * Run fixture statements in one transaction on one of `pool`'s connections.
 *
 * A split's splits must add up to it, and a transfer's sides must name each other, when
 * the transaction commits (constraint triggers deferred to COMMIT). A fixture that
 * writes a split parent, then its splits, as separate statements on a pool commits
 * between them; write them through `client` here instead.
 */
export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
