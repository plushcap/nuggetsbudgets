import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTagsRoutes } from '../tags.js';
import { addDays, calendarDateIn } from '../../utils/calendarDate.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// The tag reports filtered and bucketed on transactions.synced_transactiondate,
// which is when the row was written (DEFAULT CURRENT_TIMESTAMP), not the
// transaction's date. A transaction dated in March 2020 but written today must
// count in March 2020, not today. A bad date is a 400, not a 500.
describe('Tag reports go by the transaction date', () => {
  let app: Express;
  let tenant: TestTenant;
  let tagUuid = '';
  // A range around now, when the row is written.
  const writtenToday = { start_date: addDays(calendarDateIn('UTC'), -2), end_date: addDays(calendarDateIn('UTC'), 2) };
  const march = { start_date: '2020-03-01', end_date: '2020-03-31' };

  beforeAll(async () => {
    tenant = await createTestTenant('Tag report dates');
    const tag = (
      await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO tags (name) VALUES ('Garden') RETURNING id, uuid`)
    ).rows[0];
    tagUuid = tag.uuid;
    const accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    const transactionId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status)
         VALUES ($1, -40.00, 'Seeds', '2020-03-15', 'expense', 'cleared') RETURNING id`,
        [accountId]
      )
    ).rows[0].id;
    await tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tag.id, transactionId]);

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('summarizes a range by transaction date', async () => {
    const inMarch = await request(app).get(`/api/tags/${tagUuid}/summary`).query(march).expect(200);
    expect(inMarch.body).toMatchObject({ transaction_count: '1', total_amount: '-40.00' });

    const today = await request(app).get(`/api/tags/${tagUuid}/summary`).query(writtenToday).expect(200);
    expect(today.body).toMatchObject({ transaction_count: '0', total_amount: '0.00' });
  });

  it('lists a range by transaction date, and answers the transaction date', async () => {
    const inMarch = await request(app).get(`/api/tags/${tagUuid}/transactions`).query(march).expect(200);
    expect(inMarch.body.total).toBe(1);
    expect(inMarch.body.transactions[0].transaction_date).toBe('2020-03-15');

    const today = await request(app).get(`/api/tags/${tagUuid}/transactions`).query(writtenToday).expect(200);
    expect(today.body.total).toBe(0);
  });

  it.each([
    ['month', '2020-03-01'],
    ['week', '2020-03-15'], // a Sunday: weeks start on Sunday
    ['day', '2020-03-15'],
  ])('buckets the time series by transaction date (%s)', async (bucket, bucketDate) => {
    const res = await request(app).get(`/api/tags/${tagUuid}/timeseries`).query({ bucket }).expect(200);
    expect(res.body.series).toEqual([{ bucket_date: bucketDate, income: 0, expenses: 40 }]);
  });

  it('breaks a range down by transaction date', async () => {
    const inMarch = await request(app).get(`/api/tags/${tagUuid}/breakdown`).query(march).expect(200);
    expect(inMarch.body.breakdown).toEqual([expect.objectContaining({ is_parent: true, count: 1, net: -40 })]);

    const today = await request(app).get(`/api/tags/${tagUuid}/breakdown`).query(writtenToday).expect(200);
    expect(today.body.breakdown).toEqual([]);
  });

  it.each(['summary', 'transactions', 'timeseries', 'breakdown'])('answers 400 for a date that is not YYYY-MM-DD (%s)', async (route) => {
    await request(app).get(`/api/tags/${tagUuid}/${route}`).query({ start_date: 'not-a-date' }).expect(400);
    await request(app).get(`/api/tags/${tagUuid}/${route}`).query({ end_date: '2020-02-30' }).expect(400);
  });
});
