import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import type { PoolClient } from 'pg';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A budget period with transactions can't be deleted: the delete is refused (409
 * BUDGET_PERIOD_HAS_TRANSACTIONS) and changes nothing, so no transaction loses its period. A
 * member archives it instead, which hides it from the period pickers and keeps its transactions
 * and budget; restoring shows it again. A period without transactions is deleted, with its items
 * and budget events.
 */
describe('Deleting and archiving a budget period', () => {
  const YEAR = 2035;
  let tenant: TestTenant;
  let app: Express;
  let account: number;
  let item: number;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) =>
    (await tenant.pool.query(text, params)).rows[0] as T;
  /**
   * A period for `month` with an item for the budget item and two budget events on it (the
   * period's default budget, and one more): its id and uuid.
   */
  const periodWithBudget = async (month: number) => {
    const res = await request(app).post('/api/budget-periods').send({ year: YEAR, month, associate_transactions: false });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const period = await one<{ id: number; uuid: string }>('SELECT id, uuid FROM budget_period WHERE id = $1', [res.body.period_id]);
    const periodItem = await one<{ id: number }>(
      'SELECT id FROM budget_period_items WHERE budget_period_id = $1 AND budget_item_id = $2',
      [period.id, item]
    );
    await one(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
       VALUES ($1, $2, 'add', 'budget_update', 25) RETURNING id`,
      [periodItem.id, item]
    );
    return period;
  };
  const transaction = async (month: number, periodId: number | null) =>
    (await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_period_id)
       VALUES ($1, -10, make_date($2, $3, 5), 'expense', 'Shop', $4) RETURNING id`,
      [account, YEAR, month, periodId]
    )).id;
  const counts = async (periodId: number) =>
    one<{ periods: number; items: number; events: number; transactions: number }>(
      `SELECT (SELECT count(*)::int FROM budget_period WHERE id = $1) AS periods,
              (SELECT count(*)::int FROM budget_period_items WHERE budget_period_id = $1) AS items,
              (SELECT count(*)::int FROM budget_period_transactions bpt
                 JOIN budget_period_items bpi ON bpi.id = bpt.budget_period_item_id WHERE bpi.budget_period_id = $1) AS events,
              (SELECT count(*)::int FROM transactions WHERE budget_period_id = $1) AS transactions`,
      [periodId]
    );

  beforeAll(async () => {
    tenant = await createTestTenant('Budget period archive');
    account = (await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Archive checking', 'checking', 'cash', 'Asset') RETURNING id`
    )).id;
    item = (await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, default_budget_amount) VALUES ('Groceries', 'Expense', 'Monthly', 100) RETURNING id`
    )).id;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('refuses to delete a period that has transactions, and changes nothing', async () => {
    const period = await periodWithBudget(1);
    await transaction(1, period.id);
    await transaction(1, period.id);
    const before = await counts(period.id);
    expect(before).toEqual({ periods: 1, items: 1, events: 2, transactions: 2 });

    const res = await request(app).delete(`/api/budget-periods/${period.uuid}`);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({
      code: 'BUDGET_PERIOD_HAS_TRANSACTIONS',
      transaction_count: 2,
      message: `January ${YEAR} has 2 transactions, so it can't be deleted. Archive it to hide it instead.`,
    });
    expect(await counts(period.id)).toEqual(before);
  });

  it('deletes a period that has no transactions, with its items and budget events', async () => {
    const period = await periodWithBudget(2);
    // A transaction of its month that isn't in it doesn't count.
    const outside = await transaction(2, null);
    expect(await counts(period.id)).toEqual({ periods: 1, items: 1, events: 2, transactions: 0 });

    const res = await request(app).delete(`/api/budget-periods/${period.uuid}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      success: true,
      message: `Budget period "February ${YEAR}" deleted successfully`,
      budget_items_deleted: 1,
      budget_transactions_deleted: 2,
    });
    expect(await counts(period.id)).toEqual({ periods: 0, items: 0, events: 0, transactions: 0 });
    expect(await one('SELECT id FROM transactions WHERE id = $1', [outside])).toEqual({ id: outside });
  });

  // A transaction put in the period while the delete runs: the delete waits for it (the foreign
  // key's check holds the period's row), counts it and is refused, so it doesn't lose its period.
  it('waits for a transaction being put in the period, then refuses the delete', async () => {
    const period = await periodWithBudget(3);
    const row = await transaction(3, null);
    const writer: PoolClient = await tenant.pool.connect();
    let deleting: Promise<request.Response> | undefined;
    try {
      await writer.query('BEGIN');
      const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await writer.query('UPDATE transactions SET budget_period_id = $1 WHERE id = $2', [period.id, row]);
      deleting = request(app).delete(`/api/budget-periods/${period.uuid}`).then((r) => r);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [writerPid]);
        if ((waiting.rowCount ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error('the delete never waited for the write');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await writer.query('COMMIT');
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    const res = await deleting!;
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ code: 'BUDGET_PERIOD_HAS_TRANSACTIONS', transaction_count: 1 });
    expect(await counts(period.id)).toEqual({ periods: 1, items: 1, events: 2, transactions: 1 });
  });

  it('archives a period, keeping its transactions and budget, and restores it', async () => {
    const period = await periodWithBudget(4);
    await transaction(4, period.id);
    const before = await counts(period.id);
    const listed = async () => {
      const [list, managed] = await Promise.all([
        request(app).get('/api/budgets/periods'),
        request(app).get('/api/budget-periods/management'),
      ]);
      const inList = (list.body as { uuid: string; archived_at: string | null }[]).find((p) => p.uuid === period.uuid);
      const inManaged = (managed.body.periods as { uuid: string; archived_at: string | null }[]).find((p) => p.uuid === period.uuid);
      return { list: inList?.archived_at, managed: inManaged?.archived_at };
    };
    expect(await listed()).toEqual({ list: null, managed: null });

    const archived = await request(app).post(`/api/budget-periods/${period.uuid}/archive`);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(archived.body).toMatchObject({ success: true, message: `Budget period "April ${YEAR}" archived`, period: { uuid: period.uuid } });
    const archivedAt = archived.body.period.archived_at as string;
    expect(Date.parse(archivedAt)).not.toBeNaN();
    // Still listed (a transaction in it names it), marked archived; nothing in it changed.
    expect(await listed()).toEqual({ list: archivedAt, managed: archivedAt });
    expect(await counts(period.id)).toEqual(before);

    // Archiving it again keeps when it was first archived.
    const again = await request(app).post(`/api/budget-periods/${period.uuid}/archive`);
    expect(again.status).toBe(200);
    expect(again.body.period.archived_at).toBe(archivedAt);

    // An archived period still holds its month, and still can't be deleted with transactions.
    const create = await request(app).post('/api/budgets/periods').send({ year: YEAR, month: 4 });
    expect(create.status).toBe(409);
    expect(create.body).toMatchObject({ code: 'BUDGET_PERIOD_EXISTS' });
    const deleted = await request(app).delete(`/api/budget-periods/${period.uuid}`);
    expect(deleted.status).toBe(409);
    expect(deleted.body).toMatchObject({ code: 'BUDGET_PERIOD_HAS_TRANSACTIONS' });

    const restored = await request(app).post(`/api/budget-periods/${period.uuid}/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toMatchObject({ success: true, message: `Budget period "April ${YEAR}" restored`, period: { archived_at: null } });
    expect(await listed()).toEqual({ list: null, managed: null });
    expect(await counts(period.id)).toEqual(before);
  });

  it('answers 404 for archiving or restoring a period that is not there', async () => {
    const nowhere = '0190a000-0000-7000-8000-000000000000';
    for (const action of ['archive', 'restore']) {
      const res = await request(app).post(`/api/budget-periods/${nowhere}/${action}`);
      expect(res.status, action).toBe(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    }
  });
});
