import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * PUT /api/transactions/:uuid had no body schema. A transaction_date of null, '',
 * 'garbage' or '2026-02-30' reached the UPDATE, a 500. transactionUpdateSchema checks each
 * field for what it is (400 VALIDATION_ERROR, naming it, nothing written); text and references
 * take null for none, and the amount, type, statuses and date never do, which is what the
 * frontend's TransactionEdit and TransactionBulkEdit types now say. The bodies the app and the
 * MCP tools send still save.
 */
describe('PUT /api/transactions/:uuid body', () => {
  let tenant: TestTenant;
  let app: Express;
  let uuid = '';
  let itemId = 0;
  let periodId = 0;
  let merchantId = 0;

  const stored = async () =>
    (
      await tenant.pool.query(
        `SELECT transaction_date::text AS transaction_date, amount::text AS amount, type, status, review_status, notes,
                budget_item_id, merchant_id
           FROM transactions WHERE uuid = $1`,
        [uuid],
      )
    ).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction update body');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    const account = (
      await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Body', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    uuid = (
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, type, transaction_date, notes) VALUES ($1, -5, 'expense', '2026-06-01', 'keep') RETURNING uuid`,
        [account],
      )
    ).rows[0].uuid;
    itemId = (await tenant.pool.query(`INSERT INTO budget_items (name, expense_type) VALUES ('Food', 'Expense') RETURNING id`)).rows[0].id;
    periodId = (
      await tenant.pool.query(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('June 2026', 'June', 2026, 6, '2026-06-01', '2026-06-30') RETURNING id`,
      )
    ).rows[0].id;
    merchantId = (await tenant.pool.query(`INSERT INTO merchants (name) VALUES ('Shop') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it.each([null, '', 'garbage', '2026-02-30', 20260601])('refuses a transaction_date of %j with 400 VALIDATION_ERROR, nothing written', async (value) => {
    const before = await stored();
    const res = await request(app).put(`/api/transactions/${uuid}`).send({ transaction_date: value, notes: 'changed' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'transaction_date' }] });
    expect(await stored()).toEqual(before);
  });

  it.each(['amount', 'type', 'status', 'review_status'])('refuses %s as null: it is never none', async (field) => {
    const res = await request(app).put(`/api/transactions/${uuid}`).send({ [field]: null });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field }] });
  });

  it.each([
    ['notes', 7],
    ['merchant_id', true],
    ['budget_item_id', [1]],
    ['assigned_to', { id: 1 }],
  ])('refuses %s of the wrong kind (%j)', async (field, value) => {
    const res = await request(app).put(`/api/transactions/${uuid}`).send({ [field]: value });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field }] });
  });

  it('takes null (or empty text) for none in the text and reference fields', async () => {
    const res = await request(app).put(`/api/transactions/${uuid}`).send({
      notes: null, description: '', external_link: null, external_transaction_id: null,
      merchant_id: null, budget_item_id: '', budget_period_id: null, budget_period_item_id: null, assigned_to: null,
    });
    expect(res.status).toBe(200);
    expect(await stored()).toMatchObject({ notes: null, budget_item_id: null, merchant_id: null });
  });

  it("saves the bodies the app's whole-form save and the MCP tools send", async () => {
    // Save Changes: the form's fields, its account and the merchant box's text among them.
    const whole = await request(app).put(`/api/transactions/${uuid}`).send({
      amount: -7.25, transaction_date: '2026-06-02', type: 'expense', status: 'pending', review_status: 'needs review',
      account_id: 1, budget_item_id: itemId, merchant_id: merchantId, budget_period_id: periodId, assigned_to: null,
      notes: 'n', external_transaction_id: '', external_link: '', merchant_name: 'Shop',
    });
    expect(whole.status, JSON.stringify(whole.body)).toBe(200);
    // classify_transaction, accept_task and update_transaction.
    for (const body of [
      { budget_item_id: itemId, budget_period_id: periodId, merchant_id: null },
      { budget_item_id: String(itemId), review_status: 'reviewed', notes: 'ok' },
      { description: 'Shop', amount: 9, transaction_date: '2026-06-03', notes: 'x', assigned_to: null, external_transaction_id: null, external_link: 'https://example.com/o/1' },
    ]) {
      const res = await request(app).put(`/api/transactions/${uuid}`).send(body);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    }
    expect(await stored()).toMatchObject({ transaction_date: '2026-06-03', amount: '-9.00', review_status: 'reviewed' });
  });

  it('refuses a bulk edit setting a status to null, and takes the bodies the app and bulk_classify send', async () => {
    for (const field of ['review_status', 'status']) {
      const res = await request(app).put('/api/transactions/bulk').send({ transactionUuids: [uuid], updates: { [field]: null } });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: `updates.${field}` }] });
    }
    const ok = await request(app).put('/api/transactions/bulk').send({
      transactionUuids: [uuid], updates: { review_status: 'flagged', budget_item_id: itemId, budget_period_id: null, assigned_to: '' },
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });
});
