import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';

/**
 * Archiving a budget item while money moves to it. The archive
 * read the envelope's balance with no lock and then archived it, so a transfer or a budget
 * change that read the item as active and committed after the balance check left the archived
 * item holding money, gone from the budget page. The archive now locks the item's row, then
 * its period rows (FOR NO KEY UPDATE, in id order), before it reads the balance, as a merge
 * does; a transfer or a budget change locks the period rows before it reads the item's status.
 * So one goes after the other: the archive first, and the change finds the item archived; or the
 * change first, and the archive finds the item holding money and refuses.
 *
 * A period created while the archive runs gave the item a row (and its default budget) the
 * archive hadn't seen; period creation now waits for the archive (the ledger's budget item rows
 * lock, BudgetService.lockBudgetItemRows), then leaves the archived item out.
 */
describe('Archiving a budget item while money moves to it', () => {
  let app: Express;
  let tenant: TestTenant;
  let period: { id: number; uuid: string };
  let seq = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedBy = async (pid: number) =>
    (await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0;
  const waitUntil = async (check: () => Promise<boolean>, ms = 5_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const answer = (res: request.Response) => `${res.status}${res.status === 200 ? '' : ` ${res.body.code}`}`;
  /** Send `send()` after `ms` (none when ms <= 0). */
  const after = async (ms: number, send: () => request.Test): Promise<request.Response> => {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    return send().then((r) => r);
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Archive races');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budget-periods', createBudgetPeriodRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    // The period today falls in.
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

  /** Envelope T holding 50.00 and empty envelope S, each with a row in the period. */
  async function twoEnvelopes() {
    seq += 1;
    const make = (name: string) => one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', true, 'Envelope') RETURNING id, uuid`, [name]
    );
    const into = await make(`Funding ${seq}`);
    const item = await make(`Archived ${seq}`);
    const row = (itemId: number) => one<{ id: number; uuid: string }>(
      'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id, uuid', [period.id, itemId]
    );
    const intoRow = await row(into.id);
    const itemRow = await row(item.id);
    await one(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
       VALUES ($1, $2, 'add', 'budget_update', 50) RETURNING id`,
      [intoRow.id, into.id]
    );
    return { into, item, intoRow, itemRow };
  }

  const state = (itemRowId: number, itemId: number) => one<{ left: string; events: string; status: string }>(
    `SELECT calculate_remaining_for_period_item($1) AS left,
            (SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount ELSE -amount END), 0)
               FROM budget_period_transactions WHERE budget_item_id = $2) AS events,
            (SELECT status FROM budget_items WHERE id = $2) AS status`,
    [itemRowId, itemId]
  );

  it('waits for a transfer holding its period row, then reads the money and refuses', async () => {
    const { into, item, intoRow, itemRow } = await twoEnvelopes();
    // A transfer of 5.00 from T to S, as BudgetService runs it: both rows locked, the items read
    // as active, the event written, not yet committed.
    const transfer = await tenant.pool.connect();
    let archiving: Promise<request.Response> | undefined;
    try {
      await transfer.query('BEGIN');
      await transfer.query('SELECT id FROM budget_period_items WHERE id = ANY($1::int[]) ORDER BY id FOR NO KEY UPDATE', [[intoRow.id, itemRow.id]]);
      await transfer.query('SELECT record_transfer_event($1, $2, 5.00, $3, NULL)', [intoRow.id, itemRow.id, 'Transfer: 5']);
      archiving = request(app).post(`/api/budgets/items/${item.uuid}/archive`).then((r) => r);
      // Before the fix the archive didn't wait: it read S as empty and archived it.
      await waitUntil(async () => blockedBy(await pidOf(transfer)));
      await transfer.query('COMMIT');
    } finally {
      await transfer.query('ROLLBACK').catch(() => undefined);
      transfer.release();
    }
    const res = await archiving!;
    expect(answer(res), JSON.stringify(res.body)).toBe('409 CONFLICT');
    expect(res.body.error).toContain('still holds $5.00');
    const s = await state(itemRow.id, item.id);
    expect([s.left, s.status]).toEqual(['5.00', 'active']);
    expect(Number((await state(intoRow.id, into.id)).left)).toBe(45);
  });

  const ROUNDS = 40;

  it(`a transfer to the item and its archive at once: never an archived item holding money (${ROUNDS} rounds)`, async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const { into, item, intoRow, itemRow } = await twoEnvelopes();
      // The transfer sent from 6 ms before the archive to 12 ms after it, so it lands before the
      // archive's balance read, between it and the archiving, or after.
      const lead = (round % 10) * 2 - 6;
      const [archived, transferred] = await Promise.all([
        after(-lead, () => request(app).post(`/api/budgets/items/${item.uuid}/archive`)),
        after(lead, () => request(app).post(`/api/budget-periods/${period.uuid}/transfer`)
          .send({ fromBudgetPeriodItemId: intoRow.id, toBudgetPeriodItemId: itemRow.id, amount: '5.00' })),
      ]);
      const s = await state(itemRow.id, item.id);
      const t = await state(intoRow.id, into.id);
      const outcome = `archive ${answer(archived)}, transfer ${answer(transferred)}, S ${s.left} ${s.status}`;
      outcomes.add(outcome);
      expect([
        // The archive first: the transfer finds S archived.
        'archive 200, transfer 400 BUDGET_ITEM_ARCHIVED, S 0.00 archived',
        // The transfer first: the archive finds S holding 5.00.
        'archive 409 CONFLICT, transfer 200, S 5.00 active',
      ], outcome).toContain(outcome);
      expect(Number(s.left) + Number(t.left), outcome).toBe(50);
      expect(Number(s.events), outcome).toBe(Number(s.left));
    }
    if (process.env.SHOW_ROUNDS) process.stderr.write(`${[...outcomes].join('\n')}\n`);
  }, 120_000);

  it(`a budget change on the item and its archive at once: before the archive, or refused (${ROUNDS} rounds)`, async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      const { item, itemRow } = await twoEnvelopes();
      const lead = (round % 10) * 2 - 6;
      const [archived, budgeted] = await Promise.all([
        after(-lead, () => request(app).post(`/api/budgets/items/${item.uuid}/archive`)),
        after(lead, () => request(app).put(`/api/budgets/period-items/${itemRow.uuid}/budget`).send({ amount: 5 })),
      ]);
      const s = await state(itemRow.id, item.id);
      const outcome = `archive ${answer(archived)}, budget ${answer(budgeted)}, S ${s.left} ${s.status}`;
      outcomes.add(outcome);
      expect([
        'archive 200, budget 400 BUDGET_ITEM_ARCHIVED, S 0.00 archived',
        'archive 409 CONFLICT, budget 200, S 5.00 active',
      ], outcome).toContain(outcome);
    }
    if (process.env.SHOW_ROUNDS) process.stderr.write(`${[...outcomes].join('\n')}\n`);
  }, 120_000);

  it("a period created while the item is being archived leaves it out, with none of its default budget", async () => {
    seq += 1;
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type, default_budget_amount)
       VALUES ($1, 'Expense', false, 'Monthly', 100) RETURNING id, uuid`, [`Archived monthly ${seq}`]
    );
    const row = await one<{ id: number }>('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, item.id]);
    // The archive, paused where it locks the item's period rows: a connection holds the row, as a
    // budget change in flight does (and then changes nothing).
    const gate = await tenant.pool.connect();
    let archiving: Promise<request.Response> | undefined;
    let creating: Promise<request.Response> | undefined;
    let waited: string;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_period_items WHERE id = $1 FOR NO KEY UPDATE', [row.id]);
      const gatePid = await pidOf(gate);
      archiving = request(app).post(`/api/budgets/items/${item.uuid}/archive`).then((r) => r);
      let archivePid = 0;
      await waitUntil(async () => {
        archivePid = (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [gatePid])).rows[0]?.pid ?? 0;
        return archivePid !== 0;
      });
      creating = request(app).post('/api/budget-periods').send({ year: 2301, month: 3, associate_transactions: false }).then((r) => r);
      // Before the fix the period didn't wait: it read the item as active and gave it a row.
      waited = await Promise.race([
        creating.then(() => 'answered while the archive ran'),
        waitUntil(() => blockedBy(archivePid)).then(() => 'waited for the archive'),
      ]);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    const [archived, res] = await Promise.all([archiving!, creating!]);
    expect(archived.status, JSON.stringify(archived.body)).toBe(200);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(waited).toBe('waited for the archive');
    const rows = await one<{ rows: string; events: string }>(
      `SELECT (SELECT COUNT(*) FROM budget_period_items bpi JOIN budget_period bp ON bp.id = bpi.budget_period_id
                WHERE bpi.budget_item_id = $1 AND bp.year = 2301) AS rows,
              (SELECT COUNT(*) FROM budget_period_transactions WHERE budget_item_id = $1) AS events`,
      [item.id]
    );
    expect([Number(rows.rows), Number(rows.events)]).toEqual([0, 0]);
  });

  // The restore read the periods, then inserted a row in each; a period deleted in
  // between failed the insert's foreign key check, a 500 (4 rounds in 30).
  it(`a restore and a period delete at once: one after the other, never a 500 (${ROUNDS} rounds)`, async () => {
    const outcomes = new Set<string>();
    for (let round = 0; round < ROUNDS; round += 1) {
      seq += 1;
      const doomed = await one<{ id: number; uuid: string }>(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         VALUES ($1, 'March', 3, $2, make_date($2, 3, 1), make_date($2, 3, 31)) RETURNING id, uuid`,
        [`March ${2600 + round}`, 2600 + round]
      );
      const item = await one<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, expense_type, rollover, type, status) VALUES ($1, 'Expense', false, 'Monthly', 'archived') RETURNING id, uuid`,
        [`Restored ${seq}`]
      );
      const lead = (round % 10) * 2 - 6;
      const [restored, deleted] = await Promise.all([
        after(-lead, () => request(app).post(`/api/budgets/items/${item.uuid}/restore`)),
        after(lead, () => request(app).delete(`/api/budget-periods/${doomed.uuid}`)),
      ]);
      const state = await one<{ status: string; rows: string; periods: string }>(
        `SELECT (SELECT status FROM budget_items WHERE id = $1) AS status,
                (SELECT COUNT(*) FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2) AS rows,
                (SELECT COUNT(*) FROM budget_period WHERE id = $2) AS periods`,
        [item.id, doomed.id]
      );
      const outcome = `restore ${answer(restored)}, delete ${answer(deleted)}, ${state.status}, rows ${state.rows}, periods ${state.periods}`;
      outcomes.add(outcome);
      // Either way round: the period is gone with any row the restore gave the item in it.
      expect(outcome).toBe('restore 200, delete 200, active, rows 0, periods 0');
    }
    if (process.env.SHOW_ROUNDS) process.stderr.write(`${[...outcomes].join('\n')}\n`);
  }, 120_000);

  // The restore didn't take the ledger's budget item rows lock, so while a
  // period was being created it read the periods without the new one and gave the item no row
  // in it. A transaction put on the item in that month then had no period item, and its
  // spending counted in no budget figure.
  it('a restore while a period is being created waits for it, and gets a row in it', async () => {
    seq += 1;
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type, status) VALUES ($1, 'Expense', false, 'Monthly', 'archived') RETURNING id, uuid`,
      [`Restored during a period ${seq}`]
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let made!: () => void;
    const madeIt = new Promise<void>((resolve) => { made = resolve; });
    // The real period creation, held open (uncommitted) once it has made the period.
    const creating = withTenant(tenant.tenantId, async () => {
      await new BudgetService().createBudgetPeriod(2402, 3, tenant.userId, false);
      made();
      await held;
    });
    await madeIt;
    const restoring = request(app).post(`/api/budgets/items/${item.uuid}/restore`).then((r) => r);
    const first = await Promise.race([
      restoring.then(() => 'answered while the period was being created'),
      new Promise<string>((resolve) => setTimeout(() => resolve('waited'), 1_500)),
    ]);
    release();
    const [restored] = await Promise.all([restoring, creating]);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(first).toBe('waited');
    const rows = await one<{ n: string }>(
      `SELECT COUNT(*) AS n FROM budget_period_items bpi JOIN budget_period bp ON bp.id = bpi.budget_period_id
        WHERE bpi.budget_item_id = $1 AND bp.year = 2402`,
      [item.id]
    );
    expect(Number(rows.n)).toBe(1);
  });
});
