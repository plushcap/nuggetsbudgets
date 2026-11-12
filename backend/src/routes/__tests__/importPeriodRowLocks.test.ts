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
import { bulkUpdateTransactions } from '../../services/transactions/update.js';
import { BudgetItemTypeChange } from '../../services/budgetItems/BudgetItemTypeChange.js';
import { createBudgetRoutes } from '../budgets.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/** pg_advisory_xact_lock's class for the ledger's budget item rows lock (BudgetService.lockBudgetItemRows). */
const BUDGET_ITEM_ROWS_LOCK = 0x42505257;

/**
 * A bank sync's budget periods once it has locked transactions.
 *
 * The sync makes its periods before it locks a transaction (preparePeriods). When
 * that couldn't make one (an archive or a merge held the budget item rows lock past the lock
 * timeout), each row's lookup tried again, holding the account's transaction locks: the try got
 * the lock once the merge was done, and making the period (create_budget_period_with_items)
 * takes FOR KEY SHARE on every active budget item, which waits for a write holding one FOR
 * UPDATE, itself waiting for one of the transactions the sync held. A deadlock, which Postgres
 * broke by failing that write. A row's lookup now only finds a period. (The write is stood in
 * for by a connection holding an item FOR UPDATE, as an item edit does.)
 *
 * And a row a sync left without a period, because its period couldn't be made then, was given
 * one only by a later sync of the same row (while the bank still sends it) or by a period
 * created with its month's transactions taken in, which the import's never is. A sync now gives
 * the account's imported rows the period made since it last wrote them.
 */
describe("A bank sync's budget periods once it holds transaction locks", () => {
  let tenant: TestTenant;
  let budgetApp: Express;
  let thisMonthDay: string;
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
  const dayAhead = async (months: number) =>
    (await one<{ d: string }>(`SELECT to_char(date_trunc('month', app_today()) + make_interval(months => $1, days => 4), 'YYYY-MM-DD') AS d`, [months])).d;
  const periodOf = async (txId: number) =>
    (await one<{ day: string | null }>(
      `SELECT to_char(bp.start_date, 'YYYY-MM-DD') AS day FROM transactions t LEFT JOIN budget_period bp ON bp.id = t.budget_period_id WHERE t.id = $1`,
      [txId]
    )).day;
  const periodsOfMonth = async (day: string) =>
    Number((await one<{ n: string }>(`SELECT COUNT(*) AS n FROM budget_period WHERE start_date = date_trunc('month', $1::date)`, [day])).n);

  const importer = () => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    return { periods, importer: new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher()) };
  };
  const account = async () => {
    const importId = `SF-period-locks-${++n}-${Date.now()}`;
    const row = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                             import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_match_merchants)
       VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, true, false, false) RETURNING id`,
      [`Period locks ${n}`, importId]
    );
    return { id: row.id, importId };
  };
  const feedRow = (id: string, amount: string, day: string): SimplefinTransaction =>
    ({ id, amount, description: 'Shop', posted: Date.parse(`${day}T12:00:00Z`) / 1000 }) as SimplefinTransaction;
  /** The budget item rows lock, held alone by another connection: no period can be made. */
  const holdPeriods = async () => {
    const holder = await tenant.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [BUDGET_ITEM_ROWS_LOCK, tenant.tenantId]);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      },
    };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Import period row locks');
    budgetApp = express();
    budgetApp.use(express.json());
    budgetApp.use(tenant.context());
    budgetApp.use('/api/budgets', createBudgetRoutes());
    // This month's period; the months after it aren't made yet.
    await one(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), extract(month FROM d)::int, extract(year FROM d)::int,
              d, (d + interval '1 month - 1 day')::date
         FROM (SELECT date_trunc('month', app_today())::date AS d) m
       RETURNING id`
    );
    thisMonthDay = await dayAhead(0);
    // The import user, who makes the periods a sync needs.
    await one(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_user_id', $1) RETURNING id`, [String(tenant.userId)]);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("makes no period for a row while it holds the account's transaction locks", async () => {
    const nextMonthDay = await dayAhead(1);
    const { id: accountId, importId } = await account();
    const item = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ('Groceries', 'Expense', false, 'Monthly') RETURNING id`
    );
    // Imported before, dated next month, with no period yet; the write below waits for it.
    const tx = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, import_transaction_id, is_import, import_provider)
       VALUES ($1, -20, $2, 'expense', 'Groceries', $3, $4, true, 'simplefin') RETURNING id`,
      [accountId, nextMonthDay, item.id, `${importId}-T`]
    );
    // First in the feed, a new row whose insert waits for `latch` (the same SimpleFin id, not
    // committed): the sync pauses there, after it has locked the account's transactions.
    const feed = [feedRow(`${importId}-0`, '-5.00', thisMonthDay), feedRow(`${importId}-T`, '-20.00', nextMonthDay)];

    const held = await holdPeriods();
    const edit = await tenant.pool.connect();
    const latch = await tenant.pool.connect();
    let editing: Promise<unknown> | undefined;
    let syncing: Promise<unknown> | undefined;
    try {
      // A write holding the item FOR UPDATE (as an item edit did, and an item delete does).
      await edit.query('BEGIN');
      await edit.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [item.id]);
      await latch.query('BEGIN');
      await latch.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id)
         VALUES ($1, -5, $2, 'expense', 'Latch', $3)`,
        [accountId, thisMonthDay, `${importId}-0`]
      );
      const latchPid = await pidOf(latch);

      const { periods, importer: run } = importer();
      // preparePeriods can't make next month's period (the lock is held past a short timeout,
      // as behind a merge); then the lock is free again, as when the merge is done.
      const prepare = periods.preparePeriods.bind(periods);
      vi.spyOn(periods, 'preparePeriods').mockImplementation(async (days) => {
        await prepare(days);
        await sql`SET LOCAL lock_timeout = '30s'`.execute(getDb());
        await held.release();
      });
      syncing = withTenant(tenant.tenantId, async () => {
        await sql`SET LOCAL lock_timeout = '300ms'`.execute(getDb());
        return run.importTransactions(accountId, feed);
      });
      syncing.catch(() => undefined);
      let syncPid = 0;
      await waitUntil(async () => {
        [syncPid = 0] = await waitersOf(latchPid);
        return syncPid !== 0;
      });
      // It goes on to the item's transactions, and waits for the sync's lock.
      const editPid = await pidOf(edit);
      editing = edit.query('SELECT id FROM transactions WHERE id = $1 FOR UPDATE', [tx.id]);
      editing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(syncPid)).includes(editPid));
      // The sync goes on to the row dated next month.
      await latch.query('ROLLBACK');

      expect(await syncing).toMatchObject({ imported: 1, updated: 1, failed: 0 });
      // Before, the row's lookup made the period, waited for the edit's item lock, and the edit
      // was failed: "deadlock detected".
      await expect(editing).resolves.toBeDefined();
      await edit.query('COMMIT');
    } finally {
      await held.release();
      await latch.query('ROLLBACK').catch(() => undefined);
      latch.release();
      await edit.query('ROLLBACK').catch(() => undefined);
      edit.release();
    }
    // The period wasn't made, so the row has none yet (the next sync gives it one, below).
    expect(await periodOf(tx.id)).toBeNull();
    expect(await periodsOfMonth(nextMonthDay)).toBe(0);
  }, 60_000);

  // A row the sync inserts with a budget item checks its foreign key with FOR KEY
  // SHARE on the item, which waits for an item edit: updateBudgetItem holds the item FOR UPDATE,
  // so that a change of kind reads the item's money whole (budgetItemTypeChangeRaces.test.ts).
  // An edit that then waited for one of the sync's rows deadlocked with it, and Postgres failed
  // one side: the edit's 409, or the sync's row. None of the edit's own writes waits for a sync's
  // row today, so one is stood in for, inside the real edit, after its UPDATE
  // (BudgetItemTypeChange.after). The sync now matches its new rows and locks their item before
  // any transaction (lockNamedReferences), so it waits for the edit holding none of the
  // edit's rows, and both finish.
  it("an item edit that then waits for a sync's row: the sync waits for the edit first, and both finish", async () => {
    const { id: accountId, importId } = await account();
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id, uuid`,
      [`Groceries ${++n}`]
    );
    const tx = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, import_transaction_id, is_import, import_provider)
       VALUES ($1, -20, $2, 'expense', 'Groceries', $3, $4, true, 'simplefin') RETURNING id`,
      [accountId, thisMonthDay, item.id, `${importId}-T`]
    );
    await one('UPDATE accounts SET import_auto_assign_budget_item = true WHERE id = $1 RETURNING id', [accountId]);
    // The row of the item the edit waits for, and a new row the sync inserts with the item.
    const feed = [
      { ...feedRow(`${importId}-T`, '-20.00', thisMonthDay), description: 'Groceries' },
      { ...feedRow(`${importId}-N`, '-7.00', thisMonthDay), description: 'Groceries' },
    ];
    const periods = new BudgetPeriodResolver(new BudgetService());
    const matcher = new BudgetItemMatcher();
    vi.spyOn(matcher, 'findBudgetItemMatch').mockImplementation(async (_merchant, description) =>
      description === 'Groceries' ? { budgetItemId: item.id, confidence: 1, method: 'description-rule' } : { budgetItemId: null, confidence: 0, method: 'none' }
    );
    const run = new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), matcher);

    // The edit, through its route, paused after its UPDATE (it holds the item FOR UPDATE); then
    // its stand-in write waits for the sync's row of the item.
    const after = BudgetItemTypeChange.prototype.after;
    let editPid = 0;
    let paused!: () => void;
    const editPaused = new Promise<void>((resolve) => (paused = resolve));
    let goOn!: () => void;
    const goingOn = new Promise<void>((resolve) => (goOn = resolve));
    const spy = vi.spyOn(BudgetItemTypeChange.prototype, 'after').mockImplementation(async function (this: BudgetItemTypeChange, userId: number) {
      editPid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0]!.pid;
      paused();
      await goingOn;
      await sql`SELECT id FROM transactions WHERE id = ${tx.id} FOR NO KEY UPDATE`.execute(getDb());
      return after.call(this, userId);
    });
    try {
      const editing = request(budgetApp).put(`/api/budgets/items/${item.uuid}`).send({ description: 'Edited' }).then((r) => r);
      await editPaused;
      const syncing = withTenant(tenant.tenantId, async () => {
        await sql`SET LOCAL lock_timeout = '30s'`.execute(getDb());
        return run.importTransactions(accountId, feed);
      });
      syncing.catch(() => undefined);
      // The sync waits for the edit's item, before it locks the row the edit then waits for.
      await waitUntil(async () => (await waitersOf(editPid)).length > 0);
      goOn();
      const [edited, synced] = await Promise.all([editing, syncing]);
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect((await one<{ description: string | null }>('SELECT description FROM budget_items WHERE id = $1', [item.id])).description).toBe('Edited');
      expect(synced).toMatchObject({ imported: 1, updated: 1, failed: 0 });
      const inserted = await one<{ budget_item_id: number }>('SELECT budget_item_id FROM transactions WHERE account_id = $1 AND import_transaction_id = $2', [accountId, `${importId}-N`]);
      expect(inserted.budget_item_id).toBe(item.id);
    } finally {
      goOn();
      spy.mockRestore();
    }
  }, 60_000);

  it('gives a row the period made since a sync left it without one, though the bank no longer sends it', async () => {
    const laterDay = await dayAhead(2);
    const { id: accountId, importId } = await account();
    const other = await account();
    const { importer: run } = importer();
    const sync = (id: number, feed: SimplefinTransaction[], lockTimeout = '15s') =>
      withTenant(tenant.tenantId, async () => {
        await sql`SET LOCAL lock_timeout = ${sql.lit(lockTimeout)}`.execute(getDb());
        return run.importTransactions(id, feed);
      });
    const idOf = async (accountRow: number, importTransactionId: string) =>
      (await one<{ id: number }>('SELECT id FROM transactions WHERE account_id = $1 AND import_transaction_id = $2', [accountRow, importTransactionId])).id;

    // A sync while no period can be made (the lock held past its timeout, as behind a merge):
    // the row is imported without one, on this account and on another.
    const held = await holdPeriods();
    try {
      expect(await sync(accountId, [feedRow(`${importId}-R`, '-12.00', laterDay)], '300ms')).toMatchObject({ imported: 1, failed: 0 });
      expect(await sync(other.id, [feedRow(`${other.importId}-R`, '-13.00', laterDay)], '300ms')).toMatchObject({ imported: 1, failed: 0 });
    } finally {
      await held.release();
    }
    const row = await idOf(accountId, `${importId}-R`);
    const otherRow = await idOf(other.id, `${other.importId}-R`);
    expect(await periodOf(row)).toBeNull();
    // Rows of the month a sync leaves alone: a reconciled one, one entered by hand, a split.
    const leftAlone = [
      (await one<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, status, import_transaction_id, is_import, import_provider, import_imported_at)
         VALUES ($1, -14, $2, 'expense', 'Reconciled', 'reconciled', $3, true, 'simplefin', now() - interval '1 hour') RETURNING id`,
        [accountId, laterDay, `${importId}-REC`]
      )).id,
      (await one<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -15, $2, 'expense', 'By hand') RETURNING id`,
        [accountId, laterDay]
      )).id,
      (await one<{ id: number }>(
        `WITH parent AS (
           INSERT INTO transactions (account_id, amount, transaction_date, type, description, is_split_parent, import_transaction_id, is_import, import_provider, import_imported_at)
           VALUES ($1, -16, $2, 'expense', 'Split', true, $3, true, 'simplefin', now() - interval '1 hour') RETURNING id
         )
         INSERT INTO transactions (account_id, amount, transaction_date, type, description, parent_transaction_id)
         SELECT $1, -16, $2, 'expense', 'Split part', id FROM parent RETURNING parent_transaction_id AS id`,
        [accountId, laterDay, `${importId}-SPLIT`]
      )).id,
    ];

    // The month's period is made by something that takes in no transactions (another account's
    // sync, the next month's first sync), and the bank no longer sends the row.
    const [year, month] = laterDay.split('-').map(Number) as [number, number];
    expect(await withTenant(tenant.tenantId, () => new BudgetService().createBudgetPeriod(year, month, tenant.userId))).toMatchObject({ created: true });
    // An imported row the sync wrote after the period was made, with no period (the account
    // didn't assign them then), is left alone too.
    const afterwards = (await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, is_import, import_provider, import_imported_at)
       VALUES ($1, -17, $2, 'expense', 'Later', $3, true, 'simplefin', now() + interval '1 second') RETURNING id`,
      [accountId, laterDay, `${importId}-LATER`]
    )).id;
    leftAlone.push(afterwards);

    expect(await sync(accountId, [feedRow(`${importId}-S`, '-3.00', thisMonthDay)])).toMatchObject({ imported: 1, failed: 0 });
    // Before, it stayed without one: only a sync of the row itself gave it its period.
    expect(await periodOf(row)).toBe(`${laterDay.slice(0, 7)}-01`);
    for (const id of leftAlone) expect(await periodOf(id), `row ${id}`).toBeNull();
    // Another account's rows wait for that account's sync.
    expect(await periodOf(otherRow)).toBeNull();
  }, 60_000);

  // The sweep keyed on the import's last write alone, which taking a row out of its
  // period doesn't move, so every sync put the period back.
  it('leaves a row a member took out of its period out of it', async () => {
    const laterDay = await dayAhead(2);
    const { id: accountId, importId } = await account();
    const { importer: run } = importer();
    let k = 0;
    const sync = () =>
      withTenant(tenant.tenantId, async () => {
        await sql`SET LOCAL lock_timeout = '15s'`.execute(getDb());
        return run.importTransactions(accountId, [feedRow(`${importId}-S${++k}`, '-3.00', thisMonthDay)]);
      });
    // Imported an hour ago, before its month's period was made, which is made now (or was, by
    // the case above).
    const row = await one<{ id: number; uuid: string }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, is_import, import_provider, import_imported_at, updated_at)
       VALUES ($1, -12, $2, 'expense', 'Shop', $3, true, 'simplefin', now() - interval '1 hour', now() - interval '1 hour') RETURNING id, uuid`,
      [accountId, laterDay, `${importId}-R`]
    );
    const [year, month] = laterDay.split('-').map(Number) as [number, number];
    await withTenant(tenant.tenantId, () => new BudgetService().createBudgetPeriod(year, month, tenant.userId));
    await sync();
    expect(await periodOf(row.id)).toBe(`${laterDay.slice(0, 7)}-01`);
    // A member takes it out of its period (PUT /transactions/bulk with budget_period_id null).
    await withTenant(tenant.tenantId, () => bulkUpdateTransactions([row.uuid], { budget_period_id: null }));
    expect(await periodOf(row.id)).toBeNull();
    await sync();
    await sync();
    expect(await periodOf(row.id)).toBeNull();
  }, 60_000);
});
