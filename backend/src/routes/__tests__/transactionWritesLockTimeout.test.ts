import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The app pool's lock_timeout (DB_LOCK_TIMEOUT_MS, 15 s by default), short here so a wait
// for a held lock ends in this test's time. db.ts reads it as it's imported, so it is set
// before any import; put back for whatever runs in this process next.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '1000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/withTenant.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';
import { fixMissingBudgetPeriodItemIds } from '../../services/maintenance/budgetPeriodItemRepair.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A write of several transactions that waits too long for one of them. Each locks
 * its rows in id order first (lockTransactions); behind Delete Transactions, which
 * holds a range FOR UPDATE, that lock waited past the pool's lock_timeout and failed with
 * 55P03, which answered a generic 500: a bulk edit, a delete, a merchant rule applied, a
 * merchant or budget item merged, a budget period created or deleted. Each answers 409
 * TRANSACTION_BUSY now, nothing saved, as a tag or a note on one does, and goes
 * through when tried again. A bank sync stops that account's sync instead, rolled back, to
 * be imported by the next: written one by one it waited that long again for each held row.
 */
describe('a write of several transactions that waits too long for one of them', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction writes lock timeout');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Busy checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  type Row = { id: number; uuid: string };
  const one = async <T = Row>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const add = (date: string, columns: Record<string, unknown> = {}) => {
    const names = Object.keys(columns);
    return one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description${names.map((n) => `, ${n}`).join('')})
       VALUES ($1, -12, $2, 'expense', 'Busy fixture'${names.map((_, i) => `, $${i + 3}`).join('')}) RETURNING id, uuid`,
      [accountId, date, ...Object.values(columns)]
    );
  };

  /** Run `fn` while another connection holds transaction `id` FOR UPDATE, as Delete Transactions does. */
  const whileDeleting = async <T>(id: number, fn: () => Promise<T>): Promise<T> => {
    const holder: PoolClient = await tenant.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE', [id]);
      return await fn();
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  };

  const expectBusy = (res: request.Response, what: string, verb: 'saved' | 'deleted' = 'saved') => {
    expect({ what, status: res.status, body: res.body }).toMatchObject({
      status: 409,
      body: {
        code: 'TRANSACTION_BUSY',
        error: `Another change to these transactions was being saved at the same time, so nothing was ${verb}. Try again.`,
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/lock|timeout|55P03/i);
  };

  const columnOf = async (id: number, column: string) => (await tenant.pool.query(`SELECT ${column} AS v FROM transactions WHERE id = $1`, [id])).rows[0]?.v;

  it('a bulk edit answers 409 TRANSACTION_BUSY, changing nothing, and goes through when tried again', async () => {
    const first = await add('2022-06-01');
    const second = await add('2022-06-02');
    const send = () => request(app).put('/api/transactions/bulk').send({ transactionUuids: [first.uuid, second.uuid], updates: { review_status: 'flagged' } });

    expectBusy(await whileDeleting(second.id, send), 'bulk edit');
    expect([await columnOf(first.id, 'review_status'), await columnOf(second.id, 'review_status')]).not.toContain('flagged');

    const retried = await send();
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(retried.body.updated).toBe(2);
  });

  it('deleting a transaction answers 409 TRANSACTION_BUSY, deleting nothing', async () => {
    const row = await add('2022-06-03');
    expectBusy(await whileDeleting(row.id, () => request(app).delete(`/api/transactions/${row.uuid}`)), 'delete', 'deleted');
    expect(await columnOf(row.id, 'id')).toBe(row.id);
    const retried = await request(app).delete(`/api/transactions/${row.uuid}`);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });

  it("applying a merchant's rules, and merging a merchant, answer 409 TRANSACTION_BUSY", async () => {
    const from = await one(`INSERT INTO merchants (name) VALUES ('Busy from') RETURNING id, uuid`);
    const to = await one(`INSERT INTO merchants (name) VALUES ('Busy to') RETURNING id, uuid`);
    const row = await add('2022-06-04', { merchant_id: from.id });

    expectBusy(await whileDeleting(row.id, () => request(app).post(`/api/merchants/${to.uuid}/apply-rules`).send({ transactionIds: [row.id] })), 'apply rules');
    expect(await columnOf(row.id, 'merchant_id')).toBe(from.id);

    expectBusy(await whileDeleting(row.id, () => request(app).post(`/api/merchants/${from.uuid}/merge`).send({ targetMerchantUuid: to.uuid })), 'merchant merge');
    expect(await columnOf(row.id, 'merchant_id')).toBe(from.id);
    expect((await tenant.pool.query('SELECT 1 FROM merchants WHERE id = $1', [from.id])).rowCount).toBe(1);

    const retried = await request(app).post(`/api/merchants/${from.uuid}/merge`).send({ targetMerchantUuid: to.uuid });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await columnOf(row.id, 'merchant_id')).toBe(to.id);
  });

  it('merging a budget item answers 409 TRANSACTION_BUSY, archiving nothing', async () => {
    const item = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Busy item', 'Expense') RETURNING id, uuid`);
    const into = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Busy into', 'Expense') RETURNING id, uuid`);
    const row = await add('2022-06-05', { budget_item_id: item.id });
    const send = () => request(app).post(`/api/budgets/items/${item.uuid}/merge`).send({ into_uuid: into.uuid });

    expectBusy(await whileDeleting(row.id, send), 'budget item merge');
    expect(await columnOf(row.id, 'budget_item_id')).toBe(item.id);
    expect((await one<{ status: string }>('SELECT status FROM budget_items WHERE id = $1', [item.id])).status).not.toBe('archived');

    const retried = await send();
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect(await columnOf(row.id, 'budget_item_id')).toBe(into.id);
  });

  // The repair caught the 409 and fell back to one row at a time, waiting the lock timeout
  // again for each held row, then answered 200 having fixed nothing.
  it('repairing transactions without a period item answers 409 TRANSACTION_BUSY, at once', async () => {
    const period = await one(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date) VALUES ('Busy repair', 'January', 1, 2017, '2017-01-01', '2017-01-31') RETURNING id, uuid`
    );
    const item = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Busy repair item', 'Expense') RETURNING id, uuid`);
    const rows = [];
    for (const day of ['2017-01-03', '2017-01-04', '2017-01-05']) rows.push(await add(day, { budget_item_id: item.id, budget_period_id: period.id }));
    await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, item.id]);
    const repair = () => withTenant(tenant.tenantId, () => fixMissingBudgetPeriodItemIds());

    const started = Date.now();
    const outcome = await whileDeleting(rows[0].id, () => repair().then(() => null, (err: unknown) => err));
    expect(outcome).toBeInstanceOf(ControlPlaneError);
    expect(outcome).toMatchObject({ status: 409, code: 'TRANSACTION_BUSY' });
    expect(Date.now() - started, 'one lock timeout, not one per row').toBeLessThan(2500);
    expect(await columnOf(rows[1].id, 'budget_period_item_id')).toBeNull();

    expect(await repair()).toEqual({ updated: 3, errors: 0 });
  });

  it('creating and deleting a budget period answer 409 TRANSACTION_BUSY', async () => {
    const row = await add('2021-02-10');
    const create = () => request(app).post('/api/budget-periods').send({ year: 2021, month: 2, auto_rollover: false });
    const periodOf = async () => (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM budget_period WHERE year = 2021 AND month_number = 2')).rows[0];

    expectBusy(await whileDeleting(row.id, create), 'budget period create');
    expect(await periodOf()).toBeUndefined();
    expect(await columnOf(row.id, 'budget_period_id')).toBeNull();

    const created = await create();
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body.transactions_associated).toBe(1);
    const period = (await periodOf())!;

    expectBusy(await whileDeleting(row.id, () => request(app).delete(`/api/budget-periods/${period.uuid}`)), 'budget period delete');
    expect(await periodOf()).toEqual(period);
    expect(await columnOf(row.id, 'budget_period_id')).not.toBeNull();

    const deleted = await request(app).delete(`/api/budget-periods/${period.uuid}`);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(await periodOf()).toBeUndefined();
  });

  it("a bank sync stops that account's sync, writing nothing, rather than wait for each held row", async () => {
    const importId = `SF-busy-${Date.now()}`;
    const linked = (
      await one<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item)
         VALUES ('Busy synced', 'checking', 'cash', 'Asset', $1, 'simplefin', true, false, false) RETURNING id`,
        [importId]
      )
    ).id;
    const postedOn = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
    const feed: SimplefinTransaction[] = [
      { id: `${importId}-1`, amount: '-11.00', description: 'FIRST', posted: postedOn('2022-07-05') },
      { id: `${importId}-2`, amount: '-22.00', description: 'SECOND', posted: postedOn('2022-07-06') },
    ];
    const sync = (transactions: SimplefinTransaction[]) => {
      const periods = new BudgetPeriodResolver(new BudgetService());
      const importer = new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher());
      return withTenant(tenant.tenantId, () => importer.importTransactions(linked, transactions));
    };
    expect(await sync(feed)).toMatchObject({ imported: 2, failed: 0 });
    const rows = (await tenant.pool.query<{ id: number }>('SELECT id FROM transactions WHERE account_id = $1 ORDER BY id', [linked])).rows;

    // The bank has a third transaction now, and has renamed the second.
    const next: SimplefinTransaction[] = [
      feed[0]!,
      { ...feed[1]!, description: 'SECOND RENAMED' },
      { id: `${importId}-3`, amount: '-33.00', description: 'THIRD', posted: postedOn('2022-07-07') },
    ];
    const started = Date.now();
    const outcome = await whileDeleting(rows[1]!.id, () => sync(next).then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    ));
    const took = Date.now() - started;

    expect('error' in outcome, JSON.stringify(outcome)).toBe(true);
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(ControlPlaneError);
    expect(error).toMatchObject({ status: 409, code: 'TRANSACTION_BUSY' });
    // One wait for the lock, not one more for each held row.
    expect(took).toBeLessThan(1900);
    const after = await tenant.pool.query<{ import_description: string }>('SELECT import_description FROM transactions WHERE account_id = $1 ORDER BY id', [linked]);
    expect(after.rows.map((r) => r.import_description)).toEqual(['FIRST', 'SECOND']);

    // The next sync imports them.
    expect(await sync(next)).toMatchObject({ imported: 1, updated: 2, failed: 0 });
  });
});
