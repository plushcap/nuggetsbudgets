import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { updateBudgetItem } from '../../services/budgetItems/BudgetItemEditor.js';
import { BudgetItemTypeChange } from '../../services/budgetItems/BudgetItemTypeChange.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A change of a budget item's kind and a write of the same item's money at the same time.
 * The change reads the item's money (the carry-over a monthly item takes into its new
 * envelope, read before the UPDATE and again after; the balance an envelope must not hold to turn
 * monthly) under the item's lock, FOR UPDATE: a transaction written with the item, a budget
 * change and a transfer each check their foreign key to it with FOR KEY SHARE, so they wait for
 * the change, and it for one under way. Locked FOR NO KEY UPDATE (dropped once, then put back),
 * a write committed between the change's two reads was cancelled by its carry-over event (70.00
 * each time below), and an envelope with a transfer of 40.00 still open turned monthly.
 *
 * The change is paused after its UPDATE, before its second read (BudgetItemTypeChange.after);
 * the write is then started and waited for until it has finished or waits for the change.
 */
describe("A change of a budget item's kind and a write of its money at the same time", () => {
  let tenant: TestTenant;
  let accountId: number;
  let prev: number;
  let cur: number;
  let curDay: string;
  let seq = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const remaining = async (periodItemId: number) => (await one<{ r: string }>('SELECT calculate_remaining_for_period_item($1) AS r', [periodItemId])).r;

  beforeAll(async () => {
    tenant = await createTestTenant('Type change races');
    const period = async (offset: number) =>
      (await one<{ id: number }>(
        `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
         SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
                d, (d + interval '1 month - 1 day')::date
           FROM (SELECT (date_trunc('month', app_today()) + make_interval(months => $1))::date AS d) m
         RETURNING id`,
        [offset]
      )).id;
    prev = await period(-1);
    cur = await period(0);
    curDay = (await one<{ d: string }>(`SELECT to_char(date_trunc('month', app_today()) + interval '3 days', 'YYYY-MM-DD') AS d`)).d;
    accountId = (await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
    )).id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  afterEach(() => vi.restoreAllMocks());

  /**
   * An item with rows last month and this month, `budget` and `spent` this month. Nothing last
   * month: an item with money in an earlier period keeps its kind.
   */
  async function item(kind: 'envelope' | 'monthly', budget: number, spent: number) {
    const created = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', $2, $3) RETURNING id, uuid`,
      [`${kind} ${++seq}`, kind === 'envelope', kind === 'envelope' ? 'Envelope' : 'Monthly']
    );
    const rows: number[] = [];
    for (const period of [prev, cur]) {
      const row = (await one<{ id: number }>('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period, created.id])).id;
      rows.push(row);
      if (budget !== 0 && period === cur) {
        await one(
          `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
           VALUES ($1, $2, 'add', 'budget_update', $3) RETURNING id`,
          [row, created.id, budget]
        );
      }
    }
    if (spent !== 0) {
      await one(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
         VALUES ($1, $2, $3, 'expense', 'Shop', $4, $5) RETURNING id`,
        [accountId, -spent, curDay, created.id, cur]
      );
    }
    return { ...created, currentRow: rows[1]! };
  }

  /** Pause the change after its UPDATE, before it reads the carry-over again. */
  function pauseChange() {
    const after = BudgetItemTypeChange.prototype.after;
    let editPid = 0;
    let reached!: () => void;
    const paused = new Promise<void>((resolve) => (reached = resolve));
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    vi.spyOn(BudgetItemTypeChange.prototype, 'after').mockImplementation(async function (this: BudgetItemTypeChange, userId: number) {
      editPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0]!.pid;
      reached();
      await resumed;
      return after.call(this, userId);
    });
    return { paused, resume, editPid: () => editPid };
  }

  const writes = [
    {
      what: 'an expense of 20.00 written with the item',
      want: '50.00',
      write: (m: { id: number }) =>
        tenant.pool.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, budget_period_id)
           VALUES ($1, -20, $2, 'expense', 'Meanwhile', $3, $4)`,
          [accountId, curDay, m.id, cur]
        ),
    },
    {
      what: "a budget change of this month's 100.00 to 150.00",
      want: '120.00',
      write: (m: { currentRow: number }) => withTenant(tenant.tenantId, () => new BudgetService().updateBudgetAmount(m.currentRow, 150, tenant.userId)),
    },
    {
      what: 'a transfer of 40.00 into it',
      want: '110.00',
      write: async (m: { currentRow: number }) => {
        const from = await item('envelope', 100, 0);
        return withTenant(tenant.tenantId, () => new BudgetService().transferBetweenBudgetItems(from.currentRow, m.currentRow, 40, tenant.userId));
      },
    },
  ];

  for (const { what, want, write } of writes) {
    it(`monthly to envelope keeps ${what} made while it runs`, async () => {
      // 100.00 budgeted and 30.00 spent this month: 70.00 left, carried into the envelope.
      const m = await item('monthly', 100, 30);
      expect(await remaining(m.currentRow)).toBe('70.00');
      const { paused, resume, editPid } = pauseChange();
      const changing = withTenant(tenant.tenantId, () => updateBudgetItem(m.uuid, { rollover: true, type: 'Envelope' }, tenant.userId));
      changing.catch(() => undefined);
      await paused;
      let written = false;
      const writing = write(m).then(() => {
        written = true;
      });
      writing.catch(() => undefined);
      // The write waits for the change's lock on the item (with FOR NO KEY UPDATE it committed).
      await waitUntil(async () => written || (await waitersOf(editPid())).length > 0);
      expect(written).toBe(false);
      resume();
      await changing;
      await writing;
      expect(await remaining(m.currentRow)).toBe(want);
    }, 30_000);
  }

  it('an envelope with a transfer into it still being saved stays an envelope: 409, it holds the money', async () => {
    const envelope = await item('envelope', 0, 0);
    const from = await item('envelope', 100, 0);
    let transferPid = 0;
    let transferred!: () => void;
    const transferredNow = new Promise<void>((resolve) => (transferred = resolve));
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => (commit = resolve));
    const transferring = withTenant(tenant.tenantId, async () => {
      await new BudgetService().transferBetweenBudgetItems(from.currentRow, envelope.currentRow, 40, tenant.userId);
      transferPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0]!.pid;
      transferred();
      await committing;
    });
    transferring.catch(() => undefined);
    await transferredNow;
    let settled = false;
    const changing = withTenant(tenant.tenantId, () => updateBudgetItem(envelope.uuid, { rollover: false, type: 'Monthly' }, tenant.userId)).finally(() => {
      settled = true;
    });
    changing.catch(() => undefined);
    // The change waits for the transfer (with FOR NO KEY UPDATE it read 0.00 and went on).
    await waitUntil(async () => settled || (await waitersOf(transferPid)).length > 0);
    expect(settled).toBe(false);
    commit();
    await transferring;
    await expect(changing).rejects.toMatchObject({ status: 409, message: expect.stringContaining('holds $40.00') });
    expect(await one('SELECT rollover, type FROM budget_items WHERE id = $1', [envelope.id])).toEqual({ rollover: true, type: 'Envelope' });
    expect(await remaining(envelope.currentRow)).toBe('40.00');
  }, 30_000);
});
