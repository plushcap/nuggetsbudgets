import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// get_tag_transaction_summary joined every in-scope tagging and then
// SUM()ed the amounts, so a transaction tagged with a tag and its sub-tag counted once
// per tagging: a $200 dinner tagged "Food" and "Food › Restaurants" was $400 in Food's
// total (its COUNT(DISTINCT) was right). Each transaction counts once.
describe('Tag summary counts a transaction once', () => {
  let app: Express;
  let tenant: TestTenant;
  let foodUuid = '';
  let restaurantsUuid = '';

  beforeAll(async () => {
    tenant = await createTestTenant('Tag summary distinct');
    const food = (await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO tags (name) VALUES ('Food') RETURNING id, uuid`)).rows[0];
    const restaurants = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO tags (name, parent_id) VALUES ('Restaurants', $1) RETURNING id, uuid`,
        [food.id]
      )
    ).rows[0];
    foodUuid = food.uuid;
    restaurantsUuid = restaurants.uuid;
    const accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    const insert = async (amount: string, description: string) =>
      (
        await tenant.pool.query<{ id: number }>(
          `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
           VALUES ($1, $2, $3, '2026-03-15', 'expense', 'cleared') RETURNING id`,
          [accountId, amount, description]
        )
      ).rows[0].id;
    const tag = (tagId: number, transactionId: number) =>
      tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tagId, transactionId]);

    // A dinner carrying both the tag and its sub-tag, a refund carrying both, and a
    // grocery run carrying only the parent.
    const dinner = await insert('-200.00', 'Dinner');
    await tag(food.id, dinner);
    await tag(restaurants.id, dinner);
    const refund = await insert('15.00', 'Refund');
    await tag(food.id, refund);
    await tag(restaurants.id, refund);
    await tag(food.id, await insert('-30.00', 'Groceries'));

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('sums each transaction once across a tag and its sub-tags', async () => {
    const res = await request(app).get(`/api/tags/${foodUuid}/summary`).expect(200);
    expect(res.body).toMatchObject({
      transaction_count: '3',
      total_amount: '-215.00',
      income_amount: '15.00',
      expense_amount: '-230.00',
    });
  });

  it('agrees with the time series and the transaction list', async () => {
    const series = await request(app).get(`/api/tags/${foodUuid}/timeseries`).query({ bucket: 'month' }).expect(200);
    expect(series.body.series).toEqual([{ bucket_date: '2026-03-01', income: 15, expenses: 230 }]);
    const list = await request(app).get(`/api/tags/${foodUuid}/transactions`).expect(200);
    expect(list.body.total).toBe(3);
  });

  it('summarizes a sub-tag on its own', async () => {
    const res = await request(app).get(`/api/tags/${restaurantsUuid}/summary`).expect(200);
    expect(res.body).toMatchObject({ transaction_count: '2', total_amount: '-185.00' });
  });

  it('summarizes a tag with no transactions as zero', async () => {
    const empty = (await tenant.pool.query<{ uuid: string }>(`INSERT INTO tags (name) VALUES ('Empty') RETURNING uuid`)).rows[0];
    const res = await request(app).get(`/api/tags/${empty.uuid}/summary`).expect(200);
    expect(res.body).toMatchObject({ transaction_count: '0', total_amount: '0.00', income_amount: '0.00', expense_amount: '0.00' });
  });
});
