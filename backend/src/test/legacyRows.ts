import { Pool, type QueryResultRow } from 'pg';

/**
 * Write a fixture row the way an older install has it: with a value the database no
 * longer takes, such as an account classification or a transaction type from
 * before today's enums, which the app still keeps on a row that has one.
 *
 * Runs `text` as the schema owner (DATABASE_URL, a superuser in CI and the cloud test
 * environment) with triggers off for this one transaction (session_replication_role =
 * replica), so the triggers that refuse such a value don't fire. RLS doesn't apply to the
 * owner, so `text` sets tenant_id itself.
 */
export async function insertLegacyRow<T extends QueryResultRow>(text: string, params: unknown[]): Promise<T> {
  const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
  try {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      const res = await client.query<T>(text, params);
      await client.query('COMMIT');
      return res.rows[0];
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await owner.end();
  }
}
