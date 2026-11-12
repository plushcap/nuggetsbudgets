import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool } from 'pg';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A tag's summary counts the transactions its list shows. get_tag_transaction_summary
 * left out those with status 'deleted', a status no transaction can be given (the database
 * takes pending, cleared or reconciled), so the filter was dead, except on an install that
 * kept a legacy row with it: there the summary alone left it out, while the tag's
 * transaction list, its charts and every balance count it. A migration before v3.0.0
 * dropped the filter. The legacy row is written as the owner with triggers off, as such an
 * install has it.
 */
describe("a tag's summary and its transactions agree", () => {
  let app: Express;
  let tenant: TestTenant;
  let owner: Pool;
  let tag: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Tag summary every status');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
    tag = (await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO tags (name) VALUES ('Every status') RETURNING id, uuid`)).rows[0];
    const account = (
      await tenant.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Every status', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    const tagged = async (amount: number, status: string) => {
      const id = (
        await tenant.pool.query<{ id: number }>(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, $2, '2026-09-10', 'expense', 'Every status') RETURNING id`,
          [account, amount]
        )
      ).rows[0].id;
      await tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tag.id, id]);
      if (status !== 'cleared') {
        const client = await owner.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL session_replication_role = replica');
          await client.query('UPDATE transactions SET status = $1 WHERE id = $2', [status, id]);
          await client.query('COMMIT');
        } finally {
          client.release();
        }
      }
    };
    await tagged(-12.5, 'cleared');
    await tagged(-7.25, 'deleted');
  });

  afterAll(async () => {
    await owner?.end();
    await tenant?.cleanup();
  });

  it('counts a legacy row the list shows, whatever its status', async () => {
    const list = await request(app).get(`/api/tags/${tag.uuid}/transactions`).expect(200);
    expect(list.body.total).toBe(2);
    const summary = await request(app).get(`/api/tags/${tag.uuid}/summary`).expect(200);
    expect(Number(summary.body.transaction_count)).toBe(2);
    expect(Number(summary.body.total_amount)).toBe(-19.75);
    expect(Number(summary.body.expense_amount)).toBe(-19.75);
  });
});
