import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A budget item merge racing a budget transfer between the two items. T holds +50 this
 * month and S is empty; the merge of S into T and a transfer of 5.00 from T to S run at once.
 * The merge read what T should keep as two reads (T's remaining, then S's), so a transfer
 * committed between them was counted twice, and T ended at 55.00 (money from nowhere); a
 * transfer committed after the merge moved S's budget events left S archived holding 5.00.
 * The merge now locks both items' rows in the period before it reads, as a transfer does, and
 * a transfer refuses an archived item, so whichever goes first, the other sees all of it.
 *
 * Whatever the order: T + S still hold 50.00, S (archived) holds nothing, and each item's
 * budget events add up to what it holds.
 */
describe('A budget item merge racing a budget transfer', () => {
  let app: Express;
  let tenant: TestTenant;
  let period: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Merge vs transfer');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    // The period today falls in: the merge keeps T's balance in it.
    period = await one(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
              d, (d + interval '1 month - 1 day')::date
         FROM (SELECT date_trunc('month', app_today())::date AS d) m
       RETURNING id, uuid`
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  async function one<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T> {
    return (await tenant.pool.query(text, params)).rows[0] as T;
  }

  const ROUNDS = 40;

  it(`neither creates money nor leaves it on the archived item (${ROUNDS} rounds)`, async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const into = await one<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', true, 'Envelope') RETURNING id, uuid`,
        [`Target ${round}`]
      );
      const item = await one<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', true, 'Envelope') RETURNING id, uuid`,
        [`Merged ${round}`]
      );
      const intoRow = await one<{ id: number }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, into.id]
      );
      const itemRow = await one<{ id: number }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, item.id]
      );
      await one(
        `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
         VALUES ($1, $2, 'add', 'budget_update', 50) RETURNING id`,
        [intoRow.id, into.id]
      );

      const merge = () => request(app).post(`/api/budgets/items/${item.uuid}/merge`).send({ into_uuid: into.uuid }).then((r) => r);
      const transfer = () => request(app).post(`/api/budget-periods/${period.uuid}/transfer`)
        .send({ fromBudgetPeriodItemId: intoRow.id, toBudgetPeriodItemId: itemRow.id, amount: '5.00' }).then((r) => r);
      // The transfer sent 0 to 18 ms after the merge, so it lands before the merge's reads,
      // between them, or after them.
      const delay = (round % 10) * 2;
      const [merged, transferred] = await Promise.all([
        merge(),
        new Promise<void>((resolve) => setTimeout(resolve, delay)).then(transfer),
      ]);

      const state = await one<{ into_left: string; item_left: string; into_events: string; item_events: string; item_status: string }>(
        `SELECT calculate_remaining_for_period_item($1) AS into_left,
                calculate_remaining_for_period_item($2) AS item_left,
                (SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount ELSE -amount END), 0)
                   FROM budget_period_transactions WHERE budget_item_id = $3) AS into_events,
                (SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount ELSE -amount END), 0)
                   FROM budget_period_transactions WHERE budget_item_id = $4) AS item_events,
                (SELECT status FROM budget_items WHERE id = $4) AS item_status`,
        [intoRow.id, itemRow.id, into.id, item.id]
      );
      const outcome = [
        `merge ${merged.status}${merged.status === 200 ? '' : ` ${merged.body.code}`}`,
        `transfer ${transferred.status}${transferred.status === 200 ? '' : ` ${transferred.body.code}`}`,
        `T ${state.into_left}`, `S ${state.item_left} ${state.item_status}`,
      ].join(', ');
      outcomes.push(outcome);
      // One after the other, either way round: the merge first, and the transfer finds S archived;
      // or the transfer first, and the merge finds S holding 5.00, which it refuses to archive.
      expect([
        'merge 200, transfer 400 BUDGET_ITEM_ARCHIVED, T 50.00, S 0.00 archived',
        'merge 409 CONFLICT, transfer 200, T 45.00, S 5.00 active',
      ]).toContain(outcome);
      // So no money from nowhere, and none left behind on an archived item.
      expect(Number(state.into_left) + Number(state.item_left), outcome).toBe(50);
      // The event log adds up to what each item holds (no spending here).
      expect(Number(state.into_events), outcome).toBe(Number(state.into_left));
      expect(Number(state.item_events), outcome).toBe(Number(state.item_left));
    }
    if (process.env.SHOW_ROUNDS) process.stderr.write(`${outcomes.join('\n')}\n`);
  }, 120_000);

  // A budget change had no archived check, so one after the merge (or held up by
  // it) put money on the archived item.
  it(`a budget change on the merged item: before the merge, or refused (${ROUNDS} rounds)`, async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const into = await one<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', true, 'Envelope') RETURNING id, uuid`,
        [`Budget target ${round}`]
      );
      const item = await one<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', true, 'Envelope') RETURNING id, uuid`,
        [`Budget merged ${round}`]
      );
      await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, into.id]);
      const itemRow = await one<{ id: number; uuid: string }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id, uuid', [period.id, item.id]
      );
      const delay = (round % 10) * 2;
      const [merged, budgeted] = await Promise.all([
        request(app).post(`/api/budgets/items/${item.uuid}/merge`).send({ into_uuid: into.uuid }).then((r) => r),
        new Promise<void>((resolve) => setTimeout(resolve, delay))
          .then(() => request(app).put(`/api/budgets/period-items/${itemRow.uuid}/budget`).send({ amount: 5 }).then((r) => r)),
      ]);
      const state = await one<{ item_left: string; item_status: string }>(
        `SELECT calculate_remaining_for_period_item($1) AS item_left, (SELECT status FROM budget_items WHERE id = $2) AS item_status`,
        [itemRow.id, item.id]
      );
      const outcome = [
        `merge ${merged.status}${merged.status === 200 ? '' : ` ${merged.body.code}`}`,
        `budget ${budgeted.status}${budgeted.status === 200 ? '' : ` ${budgeted.body.code}`}`,
        `S ${state.item_left} ${state.item_status}`,
      ].join(', ');
      outcomes.add(outcome);
      expect([
        'merge 200, budget 400 BUDGET_ITEM_ARCHIVED, S 0.00 archived',
        'merge 409 CONFLICT, budget 200, S 5.00 active',
      ], outcome).toContain(outcome);
    }
    if (process.env.SHOW_ROUNDS) process.stderr.write(`${[...outcomes].join('\n')}\n`);
  }, 120_000);

  // A starting balance had no archived check, so editing the merged item's
  // put money on it (its events went from 0 to 25.00).
  it("refuses a starting balance on the merged item, and its events don't change", async () => {
    const into = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Starting target', 'Expense', true, 'Envelope') RETURNING id, uuid`
    );
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Starting merged', 'Expense', true, 'Envelope') RETURNING id, uuid`
    );
    await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, into.id]);
    await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, item.id]);
    const merged = await request(app).post(`/api/budgets/items/${item.uuid}/merge`).send({ into_uuid: into.uuid });
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);

    const res = await request(app).put(`/api/budgets/items/${item.uuid}`).send({ rollover_starting_balance: '25.00' });
    expect([res.status, res.body.code]).toEqual([400, 'BUDGET_ITEM_ARCHIVED']);
    const events = await one<{ total: string; stored: string | null }>(
      `SELECT (SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount ELSE -amount END), 0)
                 FROM budget_period_transactions WHERE budget_item_id = $1) AS total,
              (SELECT rollover_starting_balance FROM budget_items WHERE id = $1) AS stored`,
      [item.id]
    );
    expect(Number(events.total)).toBe(0);
    // The refusal rolled the request back, the item's own field included.
    expect(Number(events.stored ?? 0)).toBe(0);
  });
});
