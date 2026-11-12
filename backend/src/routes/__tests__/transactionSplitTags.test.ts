import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { answerProblem, transactionWithSplitsResponseSchema } from '@nuggets/shared';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * GET /api/transactions/:uuid listed a split parent's splits without their tags, so
 * the detail page never showed them, and re-editing the splits sent `tag_ids: []`, which
 * replaced the splits with untagged ones.
 */
describe("A split's tags in GET /api/transactions/:uuid", () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountId: number;
  let parentUuid: string;
  const tags: Record<'trip' | 'kids' | 'gift', { id: number; uuid: string }> = {
    trip: { id: 0, uuid: '' },
    kids: { id: 0, uuid: '' },
    gift: { id: 0, uuid: '' },
  };

  /** Each split's tag names, in the order the splits are listed. */
  const storedSplitTags = async () =>
    (
      await pool.query(
        `SELECT ARRAY(SELECT tg.name FROM taggings x JOIN tags tg ON tg.id = x.tag_id
                       WHERE x.taggable_type = 'transaction' AND x.taggable_id = c.id ORDER BY tg.name) AS tags
           FROM transactions c JOIN transactions p ON p.id = c.parent_transaction_id
          WHERE p.uuid = $1 ORDER BY c.id`,
        [parentUuid],
      )
    ).rows.map((r) => r.tags as string[]);

  beforeAll(async () => {
    tenant = await createTestTenant('Split tags');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());

    accountId = (
      await pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Split tags checking', 'checking', 'cash', 'Asset') RETURNING id`,
      )
    ).rows[0].id;
    for (const [key, name] of [['trip', 'Trip'], ['kids', 'Kids'], ['gift', 'Gift']] as const) {
      tags[key] = (await pool.query(`INSERT INTO tags (name, color) VALUES ($1, '#123456') RETURNING id, uuid`, [name])).rows[0];
    }
    parentUuid = (
      await pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -40, '2026-06-12', 'expense', 'Shop') RETURNING uuid`,
        [accountId],
      )
    ).rows[0].uuid;
    const split = await request(app)
      .post(`/api/transactions/${parentUuid}/split`)
      .send({
        splits: [
          { amount: -25, tag_ids: [tags.trip.id, tags.kids.id] },
          { amount: -10, tag_ids: [tags.gift.id] },
          { amount: -5 },
        ],
      });
    expect(split.status).toBe(200);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it("lists each split with its own tags, as the answer's schema requires", async () => {
    const res = await request(app).get(`/api/transactions/${parentUuid}`);
    expect(res.status).toBe(200);
    expect(answerProblem(transactionWithSplitsResponseSchema, res.body)).toBeNull();
    const children = res.body.split_children as { amount: number; tags: { id: number; uuid: string; name: string }[] }[];
    expect(children.map((c) => c.amount)).toEqual([-25, -10, -5]);
    expect(children.map((c) => c.tags.map((t) => t.name))).toEqual([['Kids', 'Trip'], ['Gift'], []]);
    expect(children[0]?.tags.map((t) => t.uuid)).toEqual([tags.kids.uuid, tags.trip.uuid]);
    // The parent's own tags stay its own: none here.
    expect(res.body.tags).toEqual([]);
  });

  it('answers the split as GET /:uuid does: each split with its names and tags', async () => {
    const item = (await pool.query(`INSERT INTO budget_items (name) VALUES ('Split groceries') RETURNING id, uuid`)).rows[0];
    const res = await request(app)
      .post(`/api/transactions/${parentUuid}/split`)
      .send({
        splits: [
          { amount: -25, budget_item_id: item.id, tag_ids: [tags.trip.id, tags.kids.id] },
          { amount: -10, tag_ids: [tags.gift.id] },
          { amount: -5 },
        ],
      });
    expect(res.status).toBe(200);
    expect(answerProblem(transactionWithSplitsResponseSchema, res.body)).toBeNull();
    const children = res.body.split_children as { budget_item_name: string | null; budget_item_uuid: string | null; tags: { name: string }[] }[];
    expect(children.map((c) => [c.budget_item_name, c.budget_item_uuid])).toEqual([['Split groceries', item.uuid], [null, null], [null, null]]);
    expect(children.map((c) => c.tags.map((t) => t.name))).toEqual([['Kids', 'Trip'], ['Gift'], []]);
    expect(res.body.account_name).toBe('Split tags checking');
    // The same answer GET /:uuid gives.
    expect(res.body).toEqual((await request(app).get(`/api/transactions/${parentUuid}`)).body);
  });

  it('keeps the tags when the splits are sent back as the answer lists them', async () => {
    const before = (await request(app).get(`/api/transactions/${parentUuid}`)).body;
    // What the detail page's split editor sends when the splits are re-edited unchanged.
    const splits = (before.split_children as { amount: number; budget_item_id: number | null; tags: { id: number }[] }[]).map((c) => ({
      amount: c.amount,
      budget_item_id: c.budget_item_id,
      tag_ids: c.tags.map((t) => t.id),
    }));
    const res = await request(app).post(`/api/transactions/${parentUuid}/split`).send({ splits });
    expect(res.status).toBe(200);
    expect(await storedSplitTags()).toEqual([['Kids', 'Trip'], ['Gift'], []]);
  });
});
