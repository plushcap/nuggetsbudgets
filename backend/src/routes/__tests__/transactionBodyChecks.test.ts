import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The bulk edit's and the split's bodies go through validateBody. A uuid in
 * transactionUuids that isn't one failed casting in the lookup (a 500), and a split amount
 * too large for the column was "at most 2 decimal places" or a 500 depending on the path.
 * Each is 400 VALIDATION_ERROR, naming the field, before anything is read.
 */
describe('the bulk edit and split bodies', () => {
  let app: Express;
  let tenant: TestTenant;
  let row: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction body checks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    const account = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Body checks', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
    row = (
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -20, '2026-05-02', 'expense', 'Checked') RETURNING id, uuid`,
        [account]
      )
    ).rows[0];
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const refused = (res: request.Response, field: string) =>
    expect({ status: res.status, code: res.body.code, field: res.body.details?.[0]?.field }).toEqual({ status: 400, code: 'VALIDATION_ERROR', field });

  it("refuses a create naming an account, merchant, budget item or period by something that isn't a uuid", async () => {
    const { uuid: accountUuid } = (await tenant.pool.query<{ uuid: string }>(`SELECT uuid FROM accounts WHERE name = 'Body checks'`)).rows[0]!;
    const body = { account_uuid: accountUuid, amount: -5, transaction_date: '2026-05-03', type: 'expense' };
    // Each failed the uuid lookup: a 500.
    refused(await request(app).post('/api/transactions').send({ ...body, account_uuid: 'not-a-uuid' }), 'account_uuid');
    for (const field of ['merchant_uuid', 'budget_item_uuid', 'budget_period_uuid']) {
      refused(await request(app).post('/api/transactions').send({ ...body, [field]: 'not-a-uuid' }), field);
    }
    const ok = await request(app).post('/api/transactions').send(body);
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('refuses a bulk edit naming something that is not a uuid, or updates that are not an object', async () => {
    refused(await request(app).put('/api/transactions/bulk').send({ transactionUuids: ['not-a-uuid'], updates: { review_status: 'reviewed' } }), 'transactionUuids.0');
    refused(await request(app).put('/api/transactions/bulk').send({ transactionUuids: [row.uuid], updates: ['review_status'] }), 'updates');
    const ok = await request(app).put('/api/transactions/bulk').send({ transactionUuids: [row.uuid], updates: { review_status: 'reviewed' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('refuses a split amount that is not whole cents a transaction can hold', async () => {
    refused(await request(app).post(`/api/transactions/${row.uuid}/split`).send({ splits: [{ amount: -1e15 }, { amount: 1e15 - 20 }] }), 'splits.0.amount');
    refused(await request(app).post(`/api/transactions/${row.uuid}/split`).send({ splits: [{ amount: '-10' }, { amount: -10 }] }), 'splits.0.amount');
    const ok = await request(app).post(`/api/transactions/${row.uuid}/split`).send({ splits: [{ amount: -12.5 }, { amount: -7.5 }] });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});
