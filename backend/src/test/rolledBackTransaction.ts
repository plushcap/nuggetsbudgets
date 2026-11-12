import type { Pool, PoolClient } from 'pg';
import { errorCode } from '../utils/errors.js';
import { holdSchemaChangeLock } from './schemaLock.js';

const LOCK_NOT_AVAILABLE = '55P03';
const DEADLOCK = '40P01';

/**
 * Run `fn` on one of `pool`'s connections in a transaction that is always rolled back,
 * collecting the NOTICEs and WARNINGs the server sends: for a migration test, which
 * changes the schema back to an older install's, runs a migration's SQL and checks the
 * result, with no other session ever seeing any of it.
 *
 * Other test files run alongside, so the DDL waits for a lock at most 500ms
 * (lock_timeout, under the 1s deadlock_timeout) and then gives up and starts over, up to
 * 5 times: a file holding one of these tables while it waits for another of them is let
 * through instead of either side being picked to fail with a deadlock.
 */
export async function inRolledBackTransaction(
  pool: Pool,
  fn: (client: PoolClient, notices: string[]) => Promise<void>
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    const notices: string[] = [];
    const onNotice = (notice: { message?: string | undefined }) => notices.push(notice.message ?? '');
    client.on('notice', onNotice);
    try {
      await client.query('BEGIN');
      // Before the lock_timeout: no test ledger is created or deleted meanwhile (schemaLock.ts).
      await holdSchemaChangeLock(client);
      await client.query(`SET LOCAL lock_timeout = '500ms'`);
      await fn(client, notices);
      return;
    } catch (err) {
      const code = errorCode(err);
      if (attempt >= 5 || (code !== LOCK_NOT_AVAILABLE && code !== DEADLOCK)) throw err;
    } finally {
      await client.query('ROLLBACK');
      client.off('notice', onNotice);
      client.release();
    }
    await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
  }
}
