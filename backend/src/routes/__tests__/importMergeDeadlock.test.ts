import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createBudgetRoutes } from '../budgets.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A bank sync that makes a budget period, against a merge of a budget item its transactions
 * have. Making a period takes the ledger's budget item rows lock alone; a merge
 * holds it shared while it waits for its item's transactions (lockTransactions). The sync
 * locked its transactions first (lockRowsToWrite) and then waited for that lock to make the
 * period of one of them: the merge waited for the sync's rows, the sync for the merge's lock, a
 * deadlock Postgres broke by failing one (the merge a 409, or the sync's period not made). Now
 * the sync makes its periods before it locks a transaction (preparePeriods), so it waits for the
 * merge and both finish.
 *
 * And a period the sync fails to make (here a lock it can't get in time) is looked up in a
 * savepoint: the lookup answers null and the sync's transaction carries on (AccountSyncer's
 * call has no savepoint of its own, so a failed statement left the account's sync aborted).
 */
describe('A bank sync making a budget period while a merge waits for its transactions', () => {
  let app: Express;
  let tenant: TestTenant;
  let nextMonthDay: string;
  let n = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const importer = () => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    return { periods, importer: new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher()) };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Import vs merge deadlock');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    // This month's period; next month's isn't made yet, so the sync makes it.
    await one(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
              d, (d + interval '1 month - 1 day')::date
         FROM (SELECT date_trunc('month', app_today())::date AS d) m
       RETURNING id`
    );
    nextMonthDay = (await one<{ d: string }>(`SELECT to_char(date_trunc('month', app_today()) + interval '1 month 4 days', 'YYYY-MM-DD') AS d`)).d;
    // The import user, who makes a period a sync needs.
    await one(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_user_id', $1) RETURNING id`, [String(tenant.userId)]);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  // First: next month's period isn't made yet (the case below makes it).
  it("answers null for a period it can't make, and the sync's transaction carries on", async () => {
    const holder = await tenant.pool.connect();
    try {
      // A period being made elsewhere: the ledger's budget item rows lock, held alone.
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [0x42505257, tenant.tenantId]);
      const { periods } = importer();
      const after = await withTenant(tenant.tenantId, async () => {
        await sql`SET LOCAL lock_timeout = '200ms'`.execute(getDb());
        // Waited for, past the lock timeout: a failed statement, in the lookup's savepoint.
        const waited = await periods.findBudgetPeriodForDate(nextMonthDay, { create: 'wait' });
        // A row's lookup (a caller holding transactions' locks): only finds one, at once.
        const started = Date.now();
        const tried = await periods.findBudgetPeriodForDate(nextMonthDay);
        const triedMs = Date.now() - started;
        // Before, the next statement failed: "current transaction is aborted".
        const { rows } = await sql<{ ok: number }>`SELECT 1 AS ok`.execute(getDb());
        return { waited, tried, triedMs, ok: rows[0]?.ok };
      });
      expect(after).toMatchObject({ waited: null, tried: null, ok: 1 });
      expect(after.triedMs).toBeLessThan(150);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    const made = await one<{ n: string }>(`SELECT COUNT(*) AS n FROM budget_period WHERE start_date = date_trunc('month', $1::date)`, [nextMonthDay]);
    expect(Number(made.n)).toBe(0);
  });

  it('waits for the merge rather than deadlock with it, and both finish', async () => {
    const importId = `SF-merge-deadlock-${++n}-${Date.now()}`;
    const account = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                             import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_match_merchants)
       VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, true, false, false) RETURNING id`,
      [`Deadlock ${n}`, importId]
    );
    const item = (name: string) => one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id, uuid`, [name]
    );
    const into = await item(`Kept ${n}`);
    const merged = await item(`Merged ${n}`);
    // S's transaction, imported before, dated next month: no period yet, so the sync makes one.
    const tx = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, import_transaction_id)
       VALUES ($1, -20, $2, 'expense', 'Groceries', $3, $4) RETURNING id`,
      [account.id, nextMonthDay, merged.id, `${importId}-1`]
    );
    const feed: SimplefinTransaction[] = [
      { id: `${importId}-1`, amount: '-20.00', description: 'Groceries', posted: Date.parse(`${nextMonthDay}T12:00:00Z`) / 1000 },
    ];
    const deadlocks = async () => Number((await one<{ n: string }>('SELECT deadlocks AS n FROM pg_stat_database WHERE datname = current_database()')).n);
    const deadlocksBefore = await deadlocks();

    // The merge, paused on S's row after it has taken the budget item rows lock (shared).
    const gate = await tenant.pool.connect();
    let merging: Promise<request.Response> | undefined;
    let syncing: Promise<unknown> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [merged.id]);
      const gatePid = await pidOf(gate);
      merging = request(app).post(`/api/budgets/items/${merged.uuid}/merge`).send({ into_uuid: into.uuid }).then((r) => r);
      let mergePid = 0;
      await waitUntil(async () => {
        [mergePid = 0] = await waitersOf(gatePid);
        return mergePid !== 0;
      });
      // The sync of S's transaction: it waits for the merge's lock to make next month's period.
      const { importer: run } = importer();
      syncing = withTenant(tenant.tenantId, () => run.importTransactions(account.id, feed));
      syncing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(mergePid)).length > 0);
      // The merge goes on to S's transactions.
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    const [mergedRes, synced] = await Promise.all([merging!, syncing!]);
    expect(mergedRes.status, JSON.stringify(mergedRes.body)).toBe(200);
    expect(synced).toMatchObject({ updated: 1, failed: 0 });
    // The transaction is the target's now, in next month's period, which the sync made.
    const row = await one<{ budget_item_id: number; period_day: string | null }>(
      `SELECT t.budget_item_id, to_char(bp.start_date, 'YYYY-MM-DD') AS period_day
         FROM transactions t LEFT JOIN budget_period bp ON bp.id = t.budget_period_id WHERE t.id = $1`,
      [tx.id]
    );
    expect(row).toEqual({ budget_item_id: into.id, period_day: `${nextMonthDay.slice(0, 7)}-01` });
    // No deadlock was broken (the counter is the database's, so other files' can show here too).
    await new Promise((r) => setTimeout(r, 1500));
    if (process.env.SHOW_ROUNDS) process.stderr.write(`deadlocks: ${await deadlocks() - deadlocksBefore}\n`);
  }, 60_000);
});
