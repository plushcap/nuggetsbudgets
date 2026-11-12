import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import pool from '../db.js';
import { getDb, withTenant } from '../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { takeConcurrentQueries } from '../test/pgConcurrentQueryGuard.js';

/**
 * The test setup's guard against overlapping queries on one connection
 * (src/test/pgConcurrentQueryGuard.ts): it records each, on a pg client and on a Kysely
 * transaction, leaves the queries' results as they were, and records nothing for queries
 * run one after another or on separate pool connections. Each test takes what it caused,
 * so the guard's afterEach finds nothing left.
 */
describe('the concurrent-query guard', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('concurrent query guard');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('records two queries at once on one pg client, and both still answer', async () => {
    const client = await pool.connect();
    try {
      const answers = await Promise.all([client.query('SELECT 1 AS n'), client.query('SELECT 2 AS n')]);
      expect(answers.map((a) => a.rows[0].n)).toEqual([1, 2]);
    } finally {
      client.release();
    }
    const found = takeConcurrentQueries();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^pg client\.query\(\): SELECT 2 AS n\n/);
    expect(found[0]).toContain('pgConcurrentQueryGuard.db.test.ts');
  });

  it('records a Promise.all over getDb() in a tenant transaction', async () => {
    const answers = await withTenant(tenant.tenantId, () =>
      Promise.all([sql<{ n: number }>`SELECT 1 AS n`.execute(getDb()), sql<{ n: number }>`SELECT 2 AS n`.execute(getDb())])
    );
    expect(answers.map((a) => a.rows[0].n)).toEqual([1, 2]);
    const found = takeConcurrentQueries();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^a query on a Kysely transaction \(getDb\(\)\)\n/);
  });

  it('records nothing for queries one after another, or at once on separate pool connections', async () => {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      await client.query('SELECT 2');
    } finally {
      client.release();
    }
    await withTenant(tenant.tenantId, async () => {
      await sql`SELECT 1`.execute(getDb());
      await sql`SELECT 2`.execute(getDb());
    });
    await Promise.all([pool.query('SELECT 1'), pool.query('SELECT 2'), pool.query('SELECT 3')]);
    expect(takeConcurrentQueries()).toEqual([]);
  });
});
