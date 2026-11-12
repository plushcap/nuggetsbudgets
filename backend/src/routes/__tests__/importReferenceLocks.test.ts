import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Long enough that the deadlock detector (1 s) decides a race, short enough for a test.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '5000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A bank sync against a write that holds a budget item or a merchant it names and then waits for
 * one of the sync's transactions. The sync locked the account's transactions first
 * (lockRowsToWrite) and only then, inserting a row, took the item's or the merchant's key lock
 * (its foreign key): an item edit (FOR UPDATE) or a merchant merge (the source FOR UPDATE, then its
 * transactions) holding it waited for the sync's row, the sync for them, a deadlock Postgres broke
 * by failing one side (the merge's 409, or the edit's; or the sync's row, saved at the next sync).
 * The sync now locks the items and merchants its new rows will name before any transaction
 * (lockNamedReferences), so it waits for the write holding none of its rows, and both finish.
 */
describe('A bank sync against a write holding a budget item or merchant it names', () => {
  let app: Express;
  let tenant: TestTenant;
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
    return new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher());
  };
  const day = '2026-03-10';
  const posted = Date.parse(`${day}T12:00:00Z`) / 1000;

  /** An account a sync imports into, with one imported row the feed sends again (the row the sync locks). */
  const account = async (opts: { matchMerchants: boolean; assignItems: boolean }) => {
    const importId = `SF-ref-locks-${++n}-${Date.now()}`;
    const acct = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                             import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_match_merchants)
       VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, false, $3, $4) RETURNING id`,
      [`Ref locks ${n}`, importId, opts.assignItems, opts.matchMerchants]
    );
    const held = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, import_amount, is_import)
       VALUES ($1, -12.00, $2, 'expense', 'Earlier', $3, -12.00, true) RETURNING id`,
      [acct.id, day, `${importId}-held`]
    );
    return { id: acct.id, importId, heldRow: held.id };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Import reference locks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  it('waits for an edit holding the budget item a new row matches, which then waits for one of its rows', async () => {
    const acct = await account({ matchMerchants: false, assignItems: true });
    const item = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`Coffee ${n}`]
    );
    await one(
      `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'espresso bar', true) RETURNING id`,
      [item.id]
    );
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-held`, amount: '-12.00', description: 'Earlier', posted },
      { id: `${acct.importId}-new`, amount: '-4.50', description: 'Espresso Bar 12', posted },
    ];

    // The edit: the item FOR UPDATE, as updateBudgetItem holds it.
    const edit = await tenant.pool.connect();
    let syncing: Promise<unknown> | undefined;
    let editsRow: unknown;
    try {
      await edit.query('BEGIN');
      await edit.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [item.id]);
      const editPid = await pidOf(edit);
      syncing = withTenant(tenant.tenantId, () => importer().importTransactions(acct.id, feed));
      syncing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(editPid)).length > 0);
      // The edit then waits for one of the sync's rows: before, the sync held it already.
      try {
        await edit.query('SELECT id FROM transactions WHERE id = $1 FOR NO KEY UPDATE', [acct.heldRow]);
        editsRow = 'locked';
      } catch (err) {
        editsRow = (err as { code?: string }).code;
      }
      await edit.query('COMMIT');
    } finally {
      await edit.query('ROLLBACK').catch(() => undefined);
      edit.release();
    }
    expect(editsRow).toBe('locked');
    expect(await syncing).toMatchObject({ imported: 1, updated: 1, failed: 0 });
    const added = await one<{ budget_item_id: number | null }>(
      'SELECT budget_item_id FROM transactions WHERE account_id = $1 AND import_transaction_id = $2', [acct.id, `${acct.importId}-new`]
    );
    expect(added.budget_item_id).toBe(item.id);
  }, 30_000);

  it('waits for a merge of the merchant a new row matches, which then waits for one of its rows, and both finish', async () => {
    const acct = await account({ matchMerchants: true, assignItems: false });
    const source = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [`Corner Deli ${n}`]);
    const target = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [`Deli ${n}`]);
    // The sync's held row is the source's: the merge locks it.
    await tenant.pool.query('UPDATE transactions SET merchant_id = $1 WHERE id = $2', [source.id, acct.heldRow]);
    // A budget item of the source's, which the merge moves before its transactions: held below, it pauses the merge there.
    const pause = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, rollover, type, merchant_id) VALUES ($1, 'Expense', false, 'Monthly', $2) RETURNING id`,
      [`Lunch ${n}`, source.id]
    );
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-held`, amount: '-12.00', description: 'Earlier', posted },
      { id: `${acct.importId}-new`, amount: '-9.25', description: 'CORNER DELI 0042', payee: `Corner Deli ${n}`, posted },
    ];

    const gate = await tenant.pool.connect();
    let merging: Promise<request.Response> | undefined;
    let syncing: Promise<unknown> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [pause.id]);
      const gatePid = await pidOf(gate);
      // The merge: the source FOR UPDATE, then waits on the paused budget item.
      merging = request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: target.uuid }).then((r) => r);
      let mergePid = 0;
      await waitUntil(async () => {
        [mergePid = 0] = await waitersOf(gatePid);
        return mergePid !== 0;
      });
      // The sync of a new row the source's name matches: it waits for the merge's lock on the source.
      syncing = withTenant(tenant.tenantId, () => importer().importTransactions(acct.id, feed));
      syncing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(mergePid)).length > 0);
      // The merge goes on to the source's transactions, the sync's held row among them.
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    const [merged, synced] = await Promise.all([merging!, syncing!]);
    expect(merged.status, JSON.stringify(merged.body)).toBe(200);
    expect(synced).toMatchObject({ imported: 1, updated: 1, failed: 0 });
    // The held row moved to the target; the new row has a merchant of the name the bank sent.
    const rows = await tenant.pool.query<{ import_transaction_id: string; merchant: string | null }>(
      `SELECT t.import_transaction_id, m.name AS merchant FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
        WHERE t.account_id = $1 ORDER BY t.id`,
      [acct.id]
    );
    expect(rows.rows).toEqual([
      { import_transaction_id: `${acct.importId}-held`, merchant: `Deli ${n}` },
      { import_transaction_id: `${acct.importId}-new`, merchant: `Corner Deli ${n}` },
    ]);
  }, 30_000);

  /** Whether another session can take `id` FOR UPDATE at once. */
  const itemFree = async (id: number) => {
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE NOWAIT', [id]);
      return true;
    } catch {
      return false;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  // The sync locked every item an active rule names, whatever its text, so an edit of
  // any of them waited for a whole first import. It locks the items its new rows match.
  it('locks only the items its new rows match, not every item a rule names', async () => {
    const acct = await account({ matchMerchants: false, assignItems: true });
    const item = (name: string) =>
      one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`${name} ${n}`]);
    const matched = await item('Coffee');
    const other = await item('Bread');
    await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'flat white cafe', true) RETURNING id`, [matched.id]);
    await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'corner bakery', true) RETURNING id`, [other.id]);
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-held`, amount: '-12.00', description: 'Earlier', posted },
      { id: `${acct.importId}-new`, amount: '-4.50', description: 'Flat White Cafe 7', posted },
    ];
    // The sync paused on its transactions, its new row's references locked.
    const gate = await tenant.pool.connect();
    let syncing: Promise<unknown> | undefined;
    let free: { matched: boolean; other: boolean };
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM transactions WHERE id = $1 FOR NO KEY UPDATE', [acct.heldRow]);
      const gatePid = await pidOf(gate);
      syncing = withTenant(tenant.tenantId, () => importer().importTransactions(acct.id, feed));
      syncing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(gatePid)).length > 0);
      free = { matched: await itemFree(matched.id), other: await itemFree(other.id) };
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    expect(free).toEqual({ matched: false, other: true });
    expect(await syncing).toMatchObject({ imported: 1, updated: 1, failed: 0 });
  }, 30_000);

  // A rule re-pointed while the sync waited for its rows (FOR NO KEY UPDATE, which the
  // sync's FOR KEY SHARE doesn't block) had the row matched again, as it was written, to an item the
  // sync never locked, which an edit held while it waited for one of the sync's rows. The row now
  // takes the match made, and locked, before the sync's transactions.
  it('gives a new row the item it locked, though a rule is re-pointed while it runs, and an edit of the other item finishes', async () => {
    const acct = await account({ matchMerchants: false, assignItems: true });
    const item = (name: string) =>
      one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`${name} ${n}`]);
    const x = await item('Coffee X');
    const w = await item('Treats W');
    const rule = await one<{ id: number }>(
      `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'gelato stand', true) RETURNING id`, [x.id]
    );
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-held`, amount: '-12.00', description: 'Earlier', posted },
      { id: `${acct.importId}-new`, amount: '-4.50', description: 'Gelato Stand 3', posted },
    ];
    const gate = await tenant.pool.connect();
    const edit = await tenant.pool.connect();
    let syncing: Promise<unknown> | undefined;
    let editsRow: unknown;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM transactions WHERE id = $1 FOR NO KEY UPDATE', [acct.heldRow]);
      const gatePid = await pidOf(gate);
      syncing = withTenant(tenant.tenantId, () => importer().importTransactions(acct.id, feed));
      syncing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(gatePid)).length > 0);
      await tenant.pool.query('UPDATE budget_item_matching_rules SET budget_item_id = $1 WHERE id = $2', [w.id, rule.id]);
      // An edit of W holds it, as updateBudgetItem does, then waits for one of the sync's rows.
      await edit.query('BEGIN');
      await edit.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [w.id]);
      const editPid = await pidOf(edit);
      await gate.query('COMMIT');
      let settled = false;
      void syncing.then(() => (settled = true), () => (settled = true));
      await waitUntil(async () => settled || (await waitersOf(editPid)).length > 0);
      try {
        await edit.query('SELECT id FROM transactions WHERE id = $1 FOR NO KEY UPDATE', [acct.heldRow]);
        editsRow = 'locked';
      } catch (err) {
        editsRow = (err as { code?: string }).code;
      }
      await edit.query('COMMIT').catch(() => undefined);
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      await edit.query('ROLLBACK').catch(() => undefined);
      gate.release();
      edit.release();
    }
    expect(editsRow).toBe('locked');
    expect(await syncing).toMatchObject({ imported: 1, updated: 1, failed: 0 });
    const added = await one<{ budget_item_id: number | null }>(
      'SELECT budget_item_id FROM transactions WHERE account_id = $1 AND import_transaction_id = $2', [acct.id, `${acct.importId}-new`]
    );
    expect(added.budget_item_id).toBe(x.id);
  }, 30_000);

  const countingImporter = () => {
    const matcher = new BudgetItemMatcher();
    const calls = vi.spyOn(matcher, 'findBudgetItemMatch');
    const periods = new BudgetPeriodResolver(new BudgetService());
    return { calls, sync: new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), matcher) };
  };

  // Every sync matched its new rows twice, the second time under the locks to find
  // what had changed while it waited for them, which made a 1,500-row first import 40-50% slower.
  it('matches each new row once when nothing it named changed while it waited for the locks', async () => {
    const acct = await account({ matchMerchants: true, assignItems: true });
    const item = await one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`Produce ${n}`]);
    await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'green grocer', true) RETURNING id`, [item.id]);
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-held`, amount: '-12.00', description: 'Earlier', posted },
      ...[1, 2, 3].map((i) => ({ id: `${acct.importId}-new-${i}`, amount: `-${i}.25`, description: `GREEN GROCER ${i}`, payee: `Green Grocer ${n}`, posted })),
    ];
    const { calls, sync } = countingImporter();
    expect(await withTenant(tenant.tenantId, () => sync.importTransactions(acct.id, feed))).toMatchObject({ imported: 3, updated: 1, failed: 0 });
    expect(calls).toHaveBeenCalledTimes(3);
    const items = await tenant.pool.query<{ budget_item_id: number | null }>(
      `SELECT budget_item_id FROM transactions WHERE account_id = $1 AND import_transaction_id LIKE '%-new-%'`, [acct.id]
    );
    expect(items.rows).toEqual([{ budget_item_id: item.id }, { budget_item_id: item.id }, { budget_item_id: item.id }]);
  }, 30_000);

  // Guards the skip above: what changes while the sync waits for its locks still has the rows
  // matched again (the sync before it, which always matched again, gave the same rows, in three
  // matches where this takes two).
  it('matches again, and locks, when a rule it matched is re-pointed or an item it matched archived while it waited', async () => {
    const acct = await account({ matchMerchants: false, assignItems: true });
    const item = (name: string) =>
      one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`${name} ${n}`]);
    const x = await item('Snacks X');
    const w = await item('Snacks W');
    const archived = await item('Fares A');
    const rule = await one<{ id: number }>(
      `INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'pretzel cart', true) RETURNING id`, [x.id]
    );
    await one(`INSERT INTO budget_item_matching_rules (budget_item_id, method, matching_text, is_active) VALUES ($1, 'contains', 'ferry pier', true) RETURNING id`, [archived.id]);
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-held`, amount: '-12.00', description: 'Earlier', posted },
      { id: `${acct.importId}-new`, amount: '-4.50', description: 'Pretzel Cart 9', posted },
      { id: `${acct.importId}-fare`, amount: '-6.50', description: 'Ferry Pier 2', posted },
    ];
    // An edit holds X: the sync, its rows matched (to X and A), waits for it.
    const edit = await tenant.pool.connect();
    const { calls, sync } = countingImporter();
    let syncing: Promise<unknown> | undefined;
    try {
      await edit.query('BEGIN');
      await edit.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [x.id]);
      const editPid = await pidOf(edit);
      syncing = withTenant(tenant.tenantId, () => sync.importTransactions(acct.id, feed));
      syncing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(editPid)).length > 0);
      // Meanwhile the rule is re-pointed to W and A is archived; the edit commits.
      await tenant.pool.query('UPDATE budget_item_matching_rules SET budget_item_id = $1 WHERE id = $2', [w.id, rule.id]);
      await tenant.pool.query(`UPDATE budget_items SET status = 'archived' WHERE id = $1`, [archived.id]);
      await edit.query('COMMIT');
    } finally {
      await edit.query('ROLLBACK').catch(() => undefined);
      edit.release();
    }
    expect(await syncing).toMatchObject({ imported: 2, updated: 1, failed: 0 });
    // Matched twice: the second match gives the rule's item now, and none for the archived one's.
    expect(calls).toHaveBeenCalledTimes(4);
    const added = await tenant.pool.query<{ import_transaction_id: string; budget_item_id: number | null }>(
      `SELECT import_transaction_id, budget_item_id FROM transactions WHERE account_id = $1 AND import_transaction_id <> $2 ORDER BY import_transaction_id`,
      [acct.id, `${acct.importId}-held`]
    );
    expect(added.rows).toEqual([
      { import_transaction_id: `${acct.importId}-fare`, budget_item_id: null },
      { import_transaction_id: `${acct.importId}-new`, budget_item_id: w.id },
    ]);
  }, 30_000);
});
