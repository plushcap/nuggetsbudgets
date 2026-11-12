import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Creating a transaction, tagging it, splitting and unsplitting it, and transfers, through
 * their routes: what the other transaction suites leave out. The money rules
 * on edits (signs, cents, splits adding up, a transfer's sides staying equal and opposite)
 * are transactionMoneyInvariants.test.ts; what the schema refuses, tenantInvariants; the
 * list and its filters, transactionsListPagesFirst and transactionListFilters.
 *
 * "Spent" below is calculate_actual_for_period_item, the envelope's actual that the budget
 * pages show. A balance is calculate_account_balance.
 */
describe('Transaction, tag, split and transfer routes', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  type Ref = { id: number; uuid: string };
  let checking: Ref & { name: string };
  let savings: Ref & { name: string };
  let groceries: Ref;
  let dining: Ref;
  let period: Ref;
  let groceriesInPeriod: number;
  let diningInPeriod: number;
  let merchant: Ref;
  let trip: Ref;
  let kids: Ref;

  const one = async <T = Ref>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as T;
  const balanceOf = async (accountId: number) =>
    (await one<{ b: string }>('SELECT calculate_account_balance($1) AS b', [accountId])).b;
  const spent = async (periodItemId: number) =>
    (await one<{ s: string }>('SELECT calculate_actual_for_period_item($1) AS s', [periodItemId])).s;
  const row = (uuid: string) =>
    one<Record<string, unknown> & { id: number }>(
      `SELECT id, account_id, amount, type, merchant_id, transaction_date::text AS transaction_date, budget_item_id,
              budget_period_id, budget_period_item_id, is_split_parent, parent_transaction_id, transfer_transaction_id,
              transfer_source_account_id, status, review_status
         FROM transactions WHERE uuid = $1`,
      [uuid],
    );
  const tagNamesOf = async (transactionId: number) =>
    (await pool.query(
      `SELECT tg.name FROM taggings t JOIN tags tg ON tg.id = t.tag_id
        WHERE t.taggable_type = 'transaction' AND t.taggable_id = $1 ORDER BY tg.name`,
      [transactionId],
    )).rows.map((r) => r.name);
  const childrenOf = async (parentId: number) =>
    (await pool.query(
      `SELECT account_id, amount, type, merchant_id, transaction_date::text AS transaction_date, budget_item_id,
              budget_period_id, budget_period_item_id
         FROM transactions WHERE parent_transaction_id = $1 ORDER BY id`,
      [parentId],
    )).rows;
  const insertExpense = (amount: number, extra: { budget_item_id?: number; budget_period_id?: number; merchant_id?: number } = {}) =>
    one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id, budget_item_id, budget_period_id)
       VALUES ($1, $2, '2026-06-12', 'expense', 'Fixture', $3, $4, $5) RETURNING id, uuid`,
      [checking.id, amount, extra.merchant_id ?? null, extra.budget_item_id ?? null, extra.budget_period_id ?? null],
    );

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction routes');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/transfer', createTransferRoutes());

    checking = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Routes checking', 'checking', 'cash', 'Asset') RETURNING id, uuid, name`,
    );
    savings = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Routes savings', 'savings', 'cash', 'Asset') RETURNING id, uuid, name`,
    );
    groceries = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Groceries', 'Expense') RETURNING id, uuid`);
    dining = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Dining', 'Expense') RETURNING id, uuid`);
    period = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ('June 2026', 'June', 2026, 6, '2026-06-01', '2026-06-30') RETURNING id, uuid`,
    );
    groceriesInPeriod = (await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id, uuid', [period.id, groceries.id])).id;
    diningInPeriod = (await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id, uuid', [period.id, dining.id])).id;
    merchant = await one(`INSERT INTO merchants (name) VALUES ('Corner Market') RETURNING id, uuid`);
    trip = await one(`INSERT INTO tags (name) VALUES ('Trip') RETURNING id, uuid`);
    kids = await one(`INSERT INTO tags (name) VALUES ('Kids') RETURNING id, uuid`);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  describe('POST /api/transactions', () => {
    it("signs the amount for its type, files it in the period's envelope, tags it by uuid, and moves the balance", async () => {
      const before = { balance: await balanceOf(checking.id), spent: await spent(groceriesInPeriod) };
      const res = await request(app)
        .post('/api/transactions')
        .send({
          account_uuid: checking.uuid,
          amount: 45.67, // a magnitude: an expense is stored negative
          transaction_date: '2026-06-03',
          type: 'expense',
          description: 'Weekly shop',
          merchant_uuid: merchant.uuid,
          budget_item_uuid: groceries.uuid,
          budget_period_uuid: period.uuid,
          tag_uuids: [trip.uuid, kids.uuid],
        })
        .expect(201);
      expect(res.body.transaction).toMatchObject({ amount: -45.67, type: 'expense', account_uuid: checking.uuid, merchant_name: 'Corner Market' });

      const stored = await row(res.body.transaction.uuid);
      expect(stored).toMatchObject({
        amount: '-45.67',
        merchant_id: merchant.id,
        budget_item_id: groceries.id,
        budget_period_id: period.id,
        budget_period_item_id: groceriesInPeriod,
        status: 'cleared',
        review_status: 'needs review',
      });
      expect(await tagNamesOf(stored.id)).toEqual(['Kids', 'Trip']);
      expect(Number(await balanceOf(checking.id))).toBeCloseTo(Number(before.balance) - 45.67, 2);
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(Number(before.spent) - 45.67, 2);

      // An income is stored positive whichever sign is sent.
      const income = await request(app)
        .post('/api/transactions')
        .send({ account_uuid: checking.uuid, amount: -100, transaction_date: '2026-06-04', type: 'income', description: 'Refund' })
        .expect(201);
      expect((await row(income.body.transaction.uuid)).amount).toBe('100.00');
    });

    it('answers 404 for an account, merchant or budget item that is not there, and stores nothing', async () => {
      const count = async () => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM transactions WHERE description = 'Nowhere'`)).n);
      const base = { account_uuid: checking.uuid, amount: -5, transaction_date: '2026-06-05', type: 'expense', description: 'Nowhere' };
      const missing = '00000000-0000-0000-0000-000000000000';
      expect((await request(app).post('/api/transactions').send({ ...base, account_uuid: missing })).status).toBe(404);
      expect((await request(app).post('/api/transactions').send({ ...base, merchant_uuid: missing })).status).toBe(404);
      expect((await request(app).post('/api/transactions').send({ ...base, budget_item_uuid: missing })).status).toBe(404);
      expect(await count()).toBe(0);
    });
  });

  describe('tags on a transaction', () => {
    it('adds a tag once however often it is sent, and removes only that tag from only that transaction', async () => {
      const first = await insertExpense(-12);
      const second = await insertExpense(-13);
      const tag = (tx: Ref, t: Ref) => request(app).post(`/api/transactions/${tx.uuid}/tags/${t.uuid}`);
      const untag = (tx: Ref, t: Ref) => request(app).delete(`/api/transactions/${tx.uuid}/tags/${t.uuid}`);

      await tag(first, trip).expect(200);
      await tag(first, trip).expect(200);
      await tag(first, kids).expect(200);
      await tag(second, trip).expect(200);
      expect(await tagNamesOf(first.id)).toEqual(['Kids', 'Trip']);

      await untag(first, trip).expect(200);
      expect(await tagNamesOf(first.id)).toEqual(['Kids']);
      expect(await tagNamesOf(second.id)).toEqual(['Trip']);
      const detail = await request(app).get(`/api/transactions/${first.uuid}`).expect(200);
      expect(detail.body.tags.map((t: { uuid: string }) => t.uuid)).toEqual([kids.uuid]);

      const nowhere = { id: 0, uuid: '00000000-0000-0000-0000-000000000000' };
      expect((await tag(nowhere, trip)).status).toBe(404);
      expect((await tag(first, nowhere)).status).toBe(404);
      expect((await untag(nowhere, kids)).status).toBe(404);
      expect((await untag(first, nowhere)).status).toBe(404);
      expect(await tagNamesOf(first.id)).toEqual(['Kids']);
    });
  });

  describe('splits', () => {
    it("gives the splits the parent's account, date, type and merchant, files each in its envelope, and leaves the money on the parent", async () => {
      const parent = await insertExpense(-100, { merchant_id: merchant.id, budget_item_id: groceries.id, budget_period_id: period.id });
      const before = {
        balance: await balanceOf(checking.id),
        groceries: Number(await spent(groceriesInPeriod)),
        dining: Number(await spent(diningInPeriod)),
      };
      await request(app)
        .post(`/api/transactions/${parent.uuid}/split`)
        .send({
          splits: [
            { amount: -60, budget_item_uuid: groceries.uuid, budget_period_uuid: period.uuid },
            { amount: -40, budget_item_uuid: dining.uuid, budget_period_uuid: period.uuid },
          ],
        })
        .expect(200);

      const inherited = { account_id: checking.id, type: 'expense', merchant_id: merchant.id, transaction_date: '2026-06-12', budget_period_id: period.id };
      expect(await childrenOf(parent.id)).toEqual([
        { ...inherited, amount: '-60.00', budget_item_id: groceries.id, budget_period_item_id: groceriesInPeriod },
        { ...inherited, amount: '-40.00', budget_item_id: dining.id, budget_period_item_id: diningInPeriod },
      ]);
      // The parent carries the money and keeps its period; its envelope moved to the splits.
      expect(await row(parent.uuid)).toMatchObject({
        amount: '-100.00',
        is_split_parent: true,
        budget_item_id: null,
        budget_period_item_id: null,
        budget_period_id: period.id,
      });
      expect(await balanceOf(checking.id)).toBe(before.balance);
      // Groceries had the whole -100; now it has its -60 and Dining the -40.
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(before.groceries + 40, 2);
      expect(Number(await spent(diningInPeriod))).toBeCloseTo(before.dining - 40, 2);
    });

    it('replaces the splits on a re-split; an unsplit leaves an ordinary transaction with its amount, period and balance', async () => {
      const parent = await insertExpense(-100, { budget_item_id: groceries.id, budget_period_id: period.id });
      const before = { balance: await balanceOf(checking.id), groceries: Number(await spent(groceriesInPeriod)) };
      const split = (amounts: number[]) =>
        request(app)
          .post(`/api/transactions/${parent.uuid}/split`)
          .send({ splits: amounts.map((amount) => ({ amount, budget_item_id: groceries.id, budget_period_id: period.id })) })
          .expect(200);

      await split([-70, -30]);
      await split([-25, -25, -50]);
      expect((await childrenOf(parent.id)).map((c) => c.amount)).toEqual(['-25.00', '-25.00', '-50.00']);
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(before.groceries, 2);

      const res = await request(app).delete(`/api/transactions/${parent.uuid}/unsplit`).expect(200);
      expect(res.body).toMatchObject({ uuid: parent.uuid, is_split_parent: false, amount: '-100.00' });
      expect(await childrenOf(parent.id)).toEqual([]);
      // The splits' envelope assignment goes with them: the page tells the user to file the
      // transaction again ("The original budget assignment will need to be reassigned").
      expect(await row(parent.uuid)).toMatchObject({ amount: '-100.00', is_split_parent: false, budget_period_id: period.id, budget_item_id: null });
      expect(await balanceOf(checking.id)).toBe(before.balance);
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(before.groceries + 100, 2);

      // Filed again, it counts in the envelope as a whole: it is no longer a split parent.
      await request(app).put(`/api/transactions/${parent.uuid}`).send({ budget_item_id: groceries.id, budget_period_id: period.id }).expect(200);
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(before.groceries, 2);

      // Nothing left to unsplit.
      expect((await request(app).delete(`/api/transactions/${parent.uuid}/unsplit`)).status).toBe(404);
    });
  });

  describe('POST /api/transfer', () => {
    it('writes two linked sides, one on each account, equal and opposite, and moves both balances', async () => {
      const before = { checking: Number(await balanceOf(checking.id)), savings: Number(await balanceOf(savings.id)) };
      const res = await request(app)
        .post('/api/transfer')
        .send({
          source_account_uuid: checking.uuid,
          destination_account_uuid: savings.uuid,
          amount: 250.25,
          transaction_date: '2026-06-15',
          type: 'transfer',
          description: 'Rainy day',
          budget_period_uuid: period.uuid,
        })
        .expect(200);
      const from = await row(res.body.source_transaction_uuid);
      const to = await row(res.body.destination_transaction_uuid);
      const merchantId = (await one<{ id: number }>('SELECT id FROM merchants WHERE name = $1', [`Transfer: ${savings.name}`])).id;
      const common = { type: 'transfer', transaction_date: '2026-06-15', budget_period_id: period.id, merchant_id: merchantId, review_status: 'reviewed' };
      expect(from).toMatchObject({ ...common, account_id: checking.id, amount: '-250.25', transfer_transaction_id: to.id });
      expect(to).toMatchObject({ ...common, account_id: savings.id, amount: '250.25', transfer_transaction_id: from.id, transfer_source_account_id: checking.id });

      expect(Number(await balanceOf(checking.id))).toBeCloseTo(before.checking - 250.25, 2);
      expect(Number(await balanceOf(savings.id))).toBeCloseTo(before.savings + 250.25, 2);
    });

    it("stays out of an envelope's spending, even filed under its budget item", async () => {
      const before = Number(await spent(groceriesInPeriod));
      const res = await request(app)
        .post('/api/transfer')
        .send({ source_account_uuid: checking.uuid, destination_account_uuid: savings.uuid, amount: 80, transaction_date: '2026-06-16', type: 'payment' })
        .expect(200);
      for (const uuid of [res.body.source_transaction_uuid, res.body.destination_transaction_uuid]) {
        await request(app).put(`/api/transactions/${uuid}`).send({ budget_item_id: groceries.id, budget_period_id: period.id }).expect(200);
        expect((await row(uuid)).budget_period_item_id).toBe(groceriesInPeriod);
      }
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(before, 2);
      // An expense filed there does count.
      await insertExpense(-9.99, { budget_item_id: groceries.id, budget_period_id: period.id });
      expect(Number(await spent(groceriesInPeriod))).toBeCloseTo(before - 9.99, 2);
    });

    it('refuses a transfer to the same account, or to an account that is not there, and writes nothing', async () => {
      const count = async () => Number((await one<{ n: string }>(`SELECT count(*) AS n FROM transactions WHERE description = 'Refused transfer'`)).n);
      const body = { source_account_uuid: checking.uuid, amount: 10, transaction_date: '2026-06-17', type: 'transfer', description: 'Refused transfer' };
      const same = await request(app).post('/api/transfer').send({ ...body, destination_account_uuid: checking.uuid });
      expect(same.status).toBe(400);
      expect(same.body.error).toBe('Cannot transfer to the same account');
      const nowhere = await request(app).post('/api/transfer').send({ ...body, destination_account_uuid: '00000000-0000-0000-0000-000000000000' });
      expect(nowhere.status).toBe(404);
      expect(await count()).toBe(0);
    });
  });
});
