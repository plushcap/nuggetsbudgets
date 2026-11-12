import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A bank sync and a row a member took out of its budget period. A sync gives a row with no
 * period its month's: one the bank still sends (the existing row's UPDATE, COALESCE) and one it
 * imported before that period was made (the sweep, periodsMadeSince). The first gave a cleared
 * period back on every sync; the second judged a clear by updated_at, its request's start time,
 * so a clear by a request that began before the period was made, after a sync had swept the row,
 * was undone by the next sync. A row remembers the period it was taken out of
 * (budget_period_cleared_from, and its first day) and a sync leaves it out of every one, but for its
 * own month's period deleted and made again; a row that never had one still gets it.
 */
describe('A bank sync and a row taken out of its budget period', () => {
  let tenant: TestTenant;
  let n = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const sync = (accountId: number, feed: SimplefinTransaction[]) => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    const importer = new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher());
    return withTenant(tenant.tenantId, () => importer.importTransactions(accountId, feed));
  };
  const posted = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
  const period = (year: number, month: number) =>
    one<{ id: number }>(
      `INSERT INTO budget_period (name, month, month_number, year, start_date, end_date)
       SELECT to_char(d, 'FMMonth YYYY'), to_char(d, 'FMMonth'), $2, $1, d, (d + interval '1 month - 1 day')::date
         FROM (SELECT make_date($1, $2, 1) AS d) m
       RETURNING id`,
      [year, month]
    );
  const account = async () => {
    const importId = `SF-cleared-${++n}-${Date.now()}`;
    const row = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                             import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_match_merchants)
       VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, true, false, false) RETURNING id`,
      [`Cleared ${n}`, importId]
    );
    return { id: row.id, importId };
  };
  const periodOf = async (id: number) => (await one<{ budget_period_id: number | null }>('SELECT budget_period_id FROM transactions WHERE id = $1', [id])).budget_period_id;

  beforeAll(async () => {
    tenant = await createTestTenant('Import cleared period');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it("leaves a row the bank still sends out of the period a member took it out of, and gives one that never had one its period", async () => {
    const january = await period(2031, 1);
    const acct = await account();
    const feed: SimplefinTransaction[] = [
      { id: `${acct.importId}-cleared`, amount: '-20.00', description: 'CLEARED', posted: posted('2031-01-15') },
      { id: `${acct.importId}-never`, amount: '-30.00', description: 'NEVER HAD ONE', posted: posted('2031-01-16') },
    ];
    expect(await sync(acct.id, feed.slice(0, 1))).toMatchObject({ imported: 1, failed: 0 });
    const cleared = await one<{ id: number; budget_period_id: number }>(
      'SELECT id, budget_period_id FROM transactions WHERE import_transaction_id = $1', [feed[0]!.id]
    );
    expect(cleared.budget_period_id).toBe(january.id);
    // Imported while the account didn't assign periods: it never had one.
    await tenant.pool.query('UPDATE accounts SET import_auto_assign_budget_period = false WHERE id = $1', [acct.id]);
    expect(await sync(acct.id, feed.slice(1))).toMatchObject({ imported: 1, failed: 0 });
    const never = await one<{ id: number; budget_period_id: number | null }>(
      'SELECT id, budget_period_id FROM transactions WHERE import_transaction_id = $1', [feed[1]!.id]
    );
    expect(never.budget_period_id).toBeNull();
    await tenant.pool.query('UPDATE accounts SET import_auto_assign_budget_period = true WHERE id = $1', [acct.id]);

    // A member takes the first out of its period.
    await tenant.pool.query('UPDATE transactions SET budget_period_id = NULL WHERE id = $1', [cleared.id]);
    for (let round = 0; round < 2; round++) {
      expect(await sync(acct.id, feed)).toMatchObject({ updated: 2, failed: 0 });
      expect({ cleared: await periodOf(cleared.id), never: await periodOf(never.id) }).toEqual({ cleared: null, never: january.id });
    }
    // Put back in it by a member, it stays there.
    await tenant.pool.query('UPDATE transactions SET budget_period_id = $1 WHERE id = $2', [january.id, cleared.id]);
    expect(await sync(acct.id, feed)).toMatchObject({ updated: 2, failed: 0 });
    expect(await periodOf(cleared.id)).toBe(january.id);
  });

  it("doesn't sweep a row back into its period when a request that began before the period was made cleared it", async () => {
    const acct = await account();
    // Imported an hour ago with no period: its month had none.
    const swept = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, import_amount,
                                 is_import, import_imported_at, updated_at, created_at)
       VALUES ($1, -40.00, '2031-02-12', 'expense', 'SWEPT', $2, -40.00, true, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour')
       RETURNING id`,
      [acct.id, `${acct.importId}-swept`]
    );
    // What the bank sends now: another row of the month (the swept one left the feed).
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-other`, amount: '-5.00', description: 'OTHER', posted: posted('2031-02-20') }];

    // The member's request begins (its transaction's time is now), then the month's period is made.
    const member = await tenant.pool.connect();
    try {
      await member.query('BEGIN');
      await member.query('SELECT now()');
      const february = await period(2031, 2);
      // A sync sweeps the row into the period made since it was imported.
      expect(await sync(acct.id, feed)).toMatchObject({ imported: 1, failed: 0 });
      expect(await periodOf(swept.id)).toBe(february.id);
      // The member's request takes it out of it and commits (its updated_at: the request's start).
      await member.query('UPDATE transactions SET budget_period_id = NULL WHERE id = $1', [swept.id]);
      await member.query('COMMIT');
    } finally {
      await member.query('ROLLBACK').catch(() => undefined);
      member.release();
    }
    // The next sync leaves it out.
    expect(await sync(acct.id, feed)).toMatchObject({ updated: 1, failed: 0 });
    expect(await periodOf(swept.id)).toBeNull();
  });

  it("puts a row whose period was deleted in the month's period made again", async () => {
    const march = await period(2031, 3);
    const acct = await account();
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-deleted`, amount: '-7.00', description: 'DELETED', posted: posted('2031-03-03') }];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1 });
    const row = await one<{ id: number }>('SELECT id FROM transactions WHERE import_transaction_id = $1', [feed[0]!.id]);
    expect(await periodOf(row.id)).toBe(march.id);
    const { uuid } = await one<{ uuid: string }>('SELECT uuid FROM budget_period WHERE id = $1', [march.id]);
    await withTenant(tenant.tenantId, () => new BudgetService().deletePeriod(uuid));
    expect(await periodOf(row.id)).toBeNull();
    const again = await period(2031, 3);
    expect(await sync(acct.id, feed)).toMatchObject({ updated: 1, failed: 0 });
    expect(await periodOf(row.id)).toBe(again.id);
  });

  // The sync skipped only the remembered period, so a row moved to another month's
  // period and then taken out of it got its own month's back.
  it("leaves out of every period a row a member moved to another month's period and then took out", async () => {
    const may = await period(2031, 5);
    const june = await period(2031, 6);
    const acct = await account();
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-moved`, amount: '-9.00', description: 'MOVED', posted: posted('2031-05-20') }];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1 });
    const row = await one<{ id: number }>('SELECT id FROM transactions WHERE import_transaction_id = $1', [feed[0]!.id]);
    expect(await periodOf(row.id)).toBe(may.id);
    await tenant.pool.query('UPDATE transactions SET budget_period_id = $1 WHERE id = $2', [june.id, row.id]);
    await tenant.pool.query('UPDATE transactions SET budget_period_id = NULL WHERE id = $1', [row.id]);
    expect(await sync(acct.id, feed)).toMatchObject({ updated: 1, failed: 0 });
    expect(await periodOf(row.id)).toBeNull();
  });

  it("doesn't sweep into its month's period a row taken out of another one", async () => {
    const july = await period(2031, 7);
    const acct = await account();
    const swept = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, import_amount,
                                 is_import, import_imported_at, updated_at, created_at, budget_period_id)
       VALUES ($1, -11.00, '2031-08-12', 'expense', 'ELSEWHERE', $2, -11.00, true, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', $3)
       RETURNING id`,
      [acct.id, `${acct.importId}-elsewhere`, july.id]
    );
    // A member takes it out of July's (an hour ago), then August's period is made.
    await tenant.pool.query(`UPDATE transactions SET budget_period_id = NULL WHERE id = $1`, [swept.id]);
    await tenant.pool.query(`UPDATE transactions SET updated_at = now() - interval '1 hour' WHERE id = $1`, [swept.id]);
    await period(2031, 8);
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-other`, amount: '-3.00', description: 'OTHER', posted: posted('2031-08-20') }];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1, failed: 0 });
    expect(await periodOf(swept.id)).toBeNull();
  });

  // This case: once the other month's period was deleted, the row went
  // back to its own month's, as a row whose own period was deleted and made again does.
  it("leaves out a row taken out of another month's period once that period is deleted", async () => {
    await period(2033, 9);
    const october = await period(2033, 10);
    const acct = await account();
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-r8f2`, amount: '-9.00', description: 'R8F2', posted: posted('2033-09-20') }];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1 });
    const row = await one<{ id: number }>('SELECT id FROM transactions WHERE import_transaction_id = $1', [feed[0]!.id]);
    await tenant.pool.query('UPDATE transactions SET budget_period_id = $1 WHERE id = $2', [october.id, row.id]);
    await tenant.pool.query('UPDATE transactions SET budget_period_id = NULL WHERE id = $1', [row.id]);
    expect(await sync(acct.id, feed)).toMatchObject({ updated: 1, failed: 0 });
    expect(await periodOf(row.id)).toBeNull();
    const { uuid } = await one<{ uuid: string }>('SELECT uuid FROM budget_period WHERE id = $1', [october.id]);
    await withTenant(tenant.tenantId, () => new BudgetService().deletePeriod(uuid));
    expect(await sync(acct.id, feed)).toMatchObject({ updated: 1, failed: 0 });
    expect(await periodOf(row.id)).toBeNull();
  });

  it("doesn't sweep into its month's period, made later, a row taken out of another month's that is gone", async () => {
    const december = await period(2033, 12);
    const acct = await account();
    // November's row, imported an hour ago with no period (its month had none), moved to December's
    // and taken out of it by a member, then December's period deleted.
    const row = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, import_amount,
                                 is_import, import_imported_at, updated_at, created_at, budget_period_id)
       VALUES ($1, -13.00, '2033-11-12', 'expense', 'GONE ELSEWHERE', $2, -13.00, true, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', $3)
       RETURNING id`,
      [acct.id, `${acct.importId}-gone-elsewhere`, december.id]
    );
    await tenant.pool.query('UPDATE transactions SET budget_period_id = NULL WHERE id = $1', [row.id]);
    await tenant.pool.query(`UPDATE transactions SET updated_at = now() - interval '1 hour' WHERE id = $1`, [row.id]);
    const { uuid } = await one<{ uuid: string }>('SELECT uuid FROM budget_period WHERE id = $1', [december.id]);
    await withTenant(tenant.tenantId, () => new BudgetService().deletePeriod(uuid));
    // November's period is made, and a sync sweeps rows into periods made since they were imported.
    await period(2033, 11);
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-other`, amount: '-3.00', description: 'OTHER', posted: posted('2033-11-20') }];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1, failed: 0 });
    expect(await periodOf(row.id)).toBeNull();
  });

  it("sweeps into its month's period made again a row whose own period was deleted", async () => {
    const april = await period(2034, 4);
    const acct = await account();
    const row = await one<{ id: number }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, import_transaction_id, import_amount,
                                 is_import, import_imported_at, updated_at, created_at, budget_period_id)
       VALUES ($1, -17.00, '2034-04-12', 'expense', 'OWN DELETED', $2, -17.00, true, now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', $3)
       RETURNING id`,
      [acct.id, `${acct.importId}-own-deleted`, april.id]
    );
    const { uuid } = await one<{ uuid: string }>('SELECT uuid FROM budget_period WHERE id = $1', [april.id]);
    await withTenant(tenant.tenantId, () => new BudgetService().deletePeriod(uuid));
    await tenant.pool.query(`UPDATE transactions SET updated_at = now() - interval '1 hour' WHERE id = $1`, [row.id]);
    const again = await period(2034, 4);
    const feed: SimplefinTransaction[] = [{ id: `${acct.importId}-other`, amount: '-3.00', description: 'OTHER', posted: posted('2034-04-20') }];
    expect(await sync(acct.id, feed)).toMatchObject({ imported: 1, failed: 0 });
    expect(await periodOf(row.id)).toBe(again.id);
  });
});
