import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool, PoolClient } from 'pg';
import { createGoalRoutes } from '../goals.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import AccountBalanceService from '../../services/AccountBalanceService.js';
import { fixMissingBudgetPeriodItemIds } from '../../services/maintenance/budgetPeriodItemRepair.js';

/**
 * An envelope's remaining, a goal's balance history and auto-tagging read only
 * their own rows now. Each is checked against what it computed before, on the same
 * data (the old function bodies are recreated as session-temporary functions), and
 * on edge cases the shortcuts must not change: an event filed under another item's
 * period item, periods created out of order, split children, future-dated rows, and
 * another ledger's rows (requires Postgres).
 */

/** calculate_remaining_for_period_item as it was before it read only its own rows. */
const LEGACY_REMAINING = `
CREATE FUNCTION pg_temp.legacy_remaining(p_budget_period_item_id integer) RETURNS numeric LANGUAGE plpgsql AS $f$
DECLARE
    budget_amount DECIMAL(12, 2) := 0.00;
    actual_amount DECIMAL(12, 2) := 0.00;
    remaining_amount DECIMAL(12, 2) := 0.00;
    target_budget_item_id INTEGER;
    target_start_date DATE;
    is_rollover_item BOOLEAN := false;
    is_income_item BOOLEAN := false;
    item_expense_type VARCHAR(50);
    first_budget_period_start_date DATE;
BEGIN
    SELECT bpi.budget_item_id, bp.start_date, bi.rollover, bi.expense_type
    INTO target_budget_item_id, target_start_date, is_rollover_item, item_expense_type
    FROM budget_period_items bpi
    JOIN budget_items bi ON bpi.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON bp.id = bpi.budget_period_id
    WHERE bpi.id = p_budget_period_item_id;
    is_income_item := (item_expense_type = 'Income');
    SELECT MIN(start_date) INTO first_budget_period_start_date FROM budget_period;
    IF is_rollover_item THEN
        SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount
                                 WHEN transaction_type IN ('remove', 'move_out') THEN -amount ELSE 0 END), 0.00)
        INTO budget_amount
        FROM budget_period_transactions bpt
        JOIN budget_period_items bpi ON bpt.budget_period_item_id = bpi.id
        JOIN budget_period bp ON bp.id = bpi.budget_period_id
        WHERE bpt.budget_item_id = target_budget_item_id
          AND bpt.type IN ('budget_update', 'starting_balance', 'transfer')
          AND bp.start_date <= target_start_date;
        SELECT COALESCE(SUM(t.amount), 0.00) INTO actual_amount
        FROM transactions t
        JOIN budget_period bp ON bp.id = t.budget_period_id
        WHERE t.budget_item_id = target_budget_item_id
          AND t.type IN ('expense', 'income')
          AND t.transaction_date >= first_budget_period_start_date
          AND bp.start_date <= target_start_date;
    ELSE
        budget_amount := calculate_budget_for_period_item(p_budget_period_item_id);
        actual_amount := calculate_actual_for_period_item(p_budget_period_item_id);
    END IF;
    IF is_income_item THEN
        remaining_amount := actual_amount - budget_amount;
    ELSE
        remaining_amount := budget_amount + actual_amount;
    END IF;
    RETURN remaining_amount;
END;
$f$`;

/** apply_transaction_auto_tag as it was before, one transaction at a time. */
const LEGACY_AUTO_TAG = `
CREATE FUNCTION pg_temp.legacy_auto_tag(p_transaction_id integer) RETURNS void LANGUAGE plpgsql AS $f$
DECLARE
  v_budget_item_tag_id INTEGER;
  v_merchant_tag_id INTEGER;
  v_final_tag_id INTEGER;
BEGIN
  DELETE FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = p_transaction_id AND type = 'auto';
  SELECT bi.transaction_auto_tag_id INTO v_budget_item_tag_id
    FROM transactions t INNER JOIN budget_items bi ON t.budget_item_id = bi.id
   WHERE t.id = p_transaction_id AND bi.transaction_auto_tag_id IS NOT NULL;
  SELECT m.transaction_auto_tag_id INTO v_merchant_tag_id
    FROM transactions t INNER JOIN merchants m ON t.merchant_id = m.id
   WHERE t.id = p_transaction_id AND m.transaction_auto_tag_id IS NOT NULL;
  v_final_tag_id := COALESCE(v_merchant_tag_id, v_budget_item_tag_id);
  IF v_final_tag_id IS NOT NULL THEN
    INSERT INTO taggings (tag_id, taggable_type, taggable_id, type, user_id)
    VALUES (v_final_tag_id, 'transaction', p_transaction_id, 'auto', NULL)
    ON CONFLICT (tenant_id, tag_id, taggable_type, taggable_id) DO NOTHING;
  END IF;
END;
$f$`;

/** The goal routes' old history queries: one balance per account per date. */
function legacyGoalHistorySql(perAccount: boolean) {
  const series = `
    SELECT generate_series(app_today() - ($2::int * (CASE $3 WHEN 'day' THEN make_interval(days => 1)
                                                            WHEN 'week' THEN make_interval(weeks => 1)
                                                            WHEN 'year' THEN make_interval(years => 1)
                                                            ELSE make_interval(months => 1) END)),
                           app_today(),
                           CASE $3 WHEN 'day' THEN make_interval(days => 1) WHEN 'week' THEN make_interval(weeks => 1)
                                   WHEN 'year' THEN make_interval(years => 1) ELSE make_interval(months => 1) END)::DATE AS date_point`;
  return perAccount
    ? `WITH date_series AS (${series})
       SELECT date_point::text AS date, calculate_account_balance_as_of($1::int, date_point) AS balance
         FROM date_series ORDER BY date_point ASC`
    : `WITH date_series AS (${series})
       SELECT date_point::text AS date,
              COALESCE((SELECT SUM(calculate_account_balance_as_of(u.account_id, ds.date_point))
                          FROM UNNEST($1::int[]) AS u(account_id)), 0) AS balance
         FROM date_series ds ORDER BY date_point ASC`;
}

describe('Budget and goal history read only their own rows', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let other: TestTenant;
  let client: PoolClient;
  const stamp = Date.now();
  const year = 4000 + Math.floor(Math.random() * 4000);
  const accounts: Record<'checking' | 'savings' | 'empty' | 'card', { id: number; uuid: string }> = {} as never;
  let otherAccountId: number;
  let goalUuid = '';
  const tags: number[] = [];
  const merchants: number[] = [];
  const items: { id: number; rollover: boolean }[] = [];

  const one = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0];

  beforeAll(async () => {
    tenant = await createTestTenant('Budget and goal history');
    other = await createTestTenant('Budget and goal history, other ledger');
    pool = tenant.pool;
    client = await pool.connect();
    await client.query(LEGACY_REMAINING);
    await client.query(LEGACY_AUTO_TAG);

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/goals', createGoalRoutes());

    for (const [key, type] of [['checking', 'Asset'], ['savings', 'Asset'], ['empty', 'Asset'], ['card', 'Liability']] as const) {
      accounts[key] = await one(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', $2) RETURNING id, uuid`,
        [`${key} ${stamp}`, type],
      );
    }
    otherAccountId = (await other.pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Other ledger', 'checking', 'cash', 'Asset') RETURNING id`,
    )).rows[0].id;
    await other.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       SELECT $1, 100, date '2026-01-01' + g, 'income', 'other' FROM generate_series(0, 300, 7) g`,
      [otherAccountId],
    );

    for (let k = 0; k < 3; k++) tags.push((await one(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`auto ${k} ${stamp}`])).id);
    for (let k = 0; k < 4; k++) {
      merchants.push((await one(
        `INSERT INTO merchants (name, transaction_auto_tag_id) VALUES ($1, $2) RETURNING id`,
        [`Merchant ${k} ${stamp}`, k < 2 ? tags[k] : null],
      )).id);
    }

    // Twelve months, created newest first (ids don't follow the calendar).
    const periods: { id: number; start: string }[] = [];
    for (let m = 12; m >= 1; m--) {
      const start = `${year}-${String(m).padStart(2, '0')}-01`;
      periods.push(await one(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ($1, $1, $2, $3, $4::date, ($4::date + interval '1 month - 1 day')::date) RETURNING id, start_date::text AS start`,
        [`P ${m} ${stamp}`, year, m, start],
      ));
    }
    periods.sort((a, b) => a.start.localeCompare(b.start));

    // Envelopes, monthly items, an income item, an envelope goal; one with an auto tag.
    const specs = [
      { name: 'Envelope A', rollover: true, expense: 'Expense', tag: tags[2] },
      { name: 'Envelope B', rollover: true, expense: 'Expense', tag: null },
      { name: 'Monthly C', rollover: false, expense: 'Expense', tag: null },
      { name: 'Income D', rollover: false, expense: 'Income', tag: null },
      { name: 'Envelope income E', rollover: true, expense: 'Income', tag: null },
    ];
    for (const spec of specs) {
      items.push({
        id: (await one(
          `INSERT INTO budget_items (name, expense_type, rollover, status, transaction_auto_tag_id) VALUES ($1, $2, $3, 'paused', $4) RETURNING id`,
          [`${spec.name} ${stamp}`, spec.expense, spec.rollover, spec.tag],
        )).id,
        rollover: spec.rollover,
      });
    }
    for (const period of periods) {
      for (const item of items) {
        await pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [period.id, item.id]);
      }
    }
    const bpi = async (itemId: number, periodId: number) =>
      (await one('SELECT id FROM budget_period_items WHERE budget_item_id = $1 AND budget_period_id = $2', [itemId, periodId])).id;

    // Events: a starting balance, monthly budgets, adjustments both ways, transfers.
    for (const [p, period] of periods.entries()) {
      for (const [i, item] of items.entries()) {
        const own = await bpi(item.id, period.id);
        const event = (txType: string, type: string, amount: number, periodItem = own, budgetItem = item.id) =>
          pool.query(
            `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount)
             VALUES ($1, $2, $3, $4, $5)`,
            [periodItem, budgetItem, txType, type, amount],
          );
        if (p === 0) await event('add', 'starting_balance', 75 + i);
        await event('add', 'budget_update', 100 + 10 * i);
        if ((p + i) % 3 === 0) await event('remove', 'budget_update', 12.34);
        if ((p + i) % 4 === 0) await event('move_out', 'transfer', 5.5);
        if ((p + i) % 5 === 0) await event('move_in', 'transfer', 7.25);
        // An event of this item filed under another item's period item, in another
        // period: the remaining must place it by that period item's period.
        if (p === 4 && i === 0) await event('add', 'budget_update', 33, await bpi(items[1].id, periods[8].id));
      }
    }

    // Spending and income through the year, some outside every period, some split.
    let n = 0;
    for (const period of periods) {
      for (const item of items) {
        for (let k = 0; k < 3; k++) {
          n++;
          const income = item.id === items[3].id || item.id === items[4].id;
          await pool.query(
            `INSERT INTO transactions (account_id, merchant_id, budget_item_id, budget_period_id, amount, transaction_date, type, description)
             VALUES ($1, $2, $3, $4, $5, $6::date + $7::int, $8, 'tx')`,
            [income ? accounts.checking.id : (n % 2 ? accounts.checking.id : accounts.card.id), merchants[n % 4], item.id, period.id,
              income ? 1000 + n : -(10 + n * 0.37), period.start, k * 9, income ? 'income' : 'expense'],
          );
        }
      }
    }
    // A transaction dated before the first period, and one with no period
    await pool.query(
      `INSERT INTO transactions (account_id, budget_item_id, budget_period_id, amount, transaction_date, type)
       VALUES ($1, $2, $3, -50, $4::date - 10, 'expense'), ($1, $2, NULL, -20, $4::date + 40, 'expense')`,
      [accounts.checking.id, items[0].id, periods[1].id, periods[0].start],
    );
    // A split: the parent has no budget item; its children count. One statement, so the
    // splits are there when the database checks they add up, at COMMIT.
    await pool.query(
      `WITH parent AS (
         INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent, budget_period_id)
         VALUES ($1, -90, $2, 'expense', true, $3) RETURNING id
       )
       INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id, budget_item_id, budget_period_id)
       SELECT $1, v.amount, $2, 'expense', parent.id, v.item, $3
         FROM parent, (VALUES (-60::numeric, $4::int), (-30::numeric, $5::int)) AS v(amount, item)`,
      [accounts.savings.id, periods[5].start, periods[5].id, items[0].id, items[1].id],
    );
    // Balance history: deposits around today and a future-dated one. (An amount can't be
    // NULL.)
    await pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       SELECT $1, (g % 7) * 3.5 + 1, app_today() - g, 'income', 'deposit' FROM generate_series(0, 900, 3) g`,
      [accounts.savings.id],
    );
    await pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, 400, app_today() + 5, 'income', 'future'),
              ($2, -45.67, app_today() - 1, 'expense', 'card'), ($2, -12.01, app_today() - 1, 'expense', 'card')`,
      [accounts.savings.id, accounts.card.id],
    );

    goalUuid = (await one(
      `INSERT INTO budget_items (name, expense_type, type, status) VALUES ($1, 'Savings', 'Goal', 'paused') RETURNING id, uuid`,
      [`Goal ${stamp}`],
    )).uuid;
    const goalId = (await one('SELECT id FROM budget_items WHERE uuid = $1', [goalUuid])).id;
    for (const account of [accounts.checking, accounts.savings, accounts.empty, accounts.card]) {
      await pool.query('INSERT INTO budget_item_accounts (budget_item_id, account_id) VALUES ($1, $2)', [goalId, account.id]);
    }
  }, 120_000);

  afterAll(async () => {
    client?.release(true);
    await tenant.cleanup();
    await other.cleanup();
  });

  it("an envelope's remaining is what it was, for every item in every period", async () => {
    const rows = (await client.query(
      `SELECT bpi.id, bi.rollover, calculate_remaining_for_period_item(bpi.id)::text AS now,
              pg_temp.legacy_remaining(bpi.id)::text AS before
         FROM budget_period_items bpi JOIN budget_items bi ON bi.id = bpi.budget_item_id
        WHERE bpi.budget_item_id = ANY($1::int[])`,
      [items.map((item) => item.id)],
    )).rows;
    expect(rows).toHaveLength(items.length * 12);
    for (const row of rows) expect(row.now, `period item ${row.id}`).toBe(row.before);
    // The fixture exercises the rollover branch with real money.
    expect(rows.some((row) => row.rollover && Number(row.now) !== 0)).toBe(true);
    // ... and the summary agrees with the items.
    const summary = (await client.query(
      `SELECT s.remaining_amount::text AS remaining, pg_temp.legacy_remaining(bpi.id)::text AS before
         FROM budget_period_items bpi, LATERAL get_budget_period_summary(bpi.budget_period_id) s
        WHERE bpi.budget_item_id = $1 AND s.budget_item_id = bpi.budget_item_id`,
      [items[0].id],
    )).rows;
    expect(summary).toHaveLength(12);
    for (const row of summary) expect(row.remaining).toBe(row.before);
  });

  it('account_balances_as_of is calculate_account_balance_as_of at each date', async () => {
    const ids = [accounts.checking.id, accounts.savings.id, accounts.empty.id, accounts.card.id, otherAccountId, accounts.savings.id, null];
    const rows = (await client.query(
      `WITH dates AS (SELECT ARRAY(SELECT d::date FROM generate_series(app_today() - 1000, app_today() + 10, interval '1 day') d) || ARRAY[NULL::date, app_today()] AS ds)
       SELECT b.account_id, b.as_of, b.balance::text AS now, calculate_account_balance_as_of(b.account_id, b.as_of)::text AS before
         FROM dates, account_balances_as_of($1::int[], dates.ds) b`,
      [ids],
    )).rows;
    // One row per distinct account per distinct date; another ledger's account has no balance here.
    expect(rows).toHaveLength(5 * 1011);
    for (const row of rows) expect(row.now, `${row.account_id} ${row.as_of}`).toBe(row.before);
    expect(rows.filter((row) => row.account_id === otherAccountId).every((row) => row.now === '0')).toBe(true);
    expect(rows.some((row) => row.account_id === accounts.savings.id && Number(row.now) > 0)).toBe(true);
  });

  it("a goal's balance history is what it was, summed and per account", async () => {
    const ids = [accounts.checking.id, accounts.savings.id, accounts.empty.id, accounts.card.id];
    for (const [period, limit] of [['day', 45], ['week', 20], ['month', 36], ['year', 3], ['day', 0]] as const) {
      const total = await request(app).get(`/api/goals/${goalUuid}/balance-history`).query({ period, limit }).expect(200);
      const expected = (await client.query(legacyGoalHistorySql(false), [ids, limit, period])).rows
        .map((row) => ({ date: row.date, balance: parseFloat(row.balance) }));
      expect(total.body.history, `${period} ${limit}`).toEqual(expected);

      const byAccount = await request(app).get(`/api/goals/${goalUuid}/account-balance-history`).query({ period, limit }).expect(200);
      expect(byAccount.body.accounts.map((a: { account_id: number }) => a.account_id).sort()).toEqual([...ids].sort());
      for (const account of byAccount.body.accounts) {
        const legacy = (await client.query(legacyGoalHistorySql(true), [account.account_id, limit, period])).rows
          .map((row) => ({ date: row.date, balance: parseFloat(row.balance) }));
        expect(account.history, `${period} ${limit} account ${account.account_id}`).toEqual(legacy);
      }
    }
    // Defaults: a month a point for 36 months.
    const defaults = await request(app).get(`/api/goals/${goalUuid}/balance-history`).expect(200);
    expect(defaults.body.history).toHaveLength(37);
    // A step that isn't one of the four is refused, where it was read as a month.
    const quarter = await request(app).get(`/api/goals/${goalUuid}/balance-history`).query({ period: 'quarter' }).expect(400);
    expect(quarter.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'period' }] });
  });

  it("bounds a goal history's limit instead of failing on it", async () => {
    const junk = await request(app).get(`/api/goals/${goalUuid}/balance-history`).query({ limit: 'abc' }).expect(200);
    expect(junk.body.history).toHaveLength(37);
    const huge = await request(app).get(`/api/goals/${goalUuid}/account-balance-history`).query({ period: 'day', limit: 1000000 }).expect(200);
    expect(huge.body.accounts[0].history).toHaveLength(3661);
  });

  it("an account's month-end balance history is what it was", async () => {
    const history = await withTenant(tenant.tenantId, () => new AccountBalanceService().getBalanceHistory(accounts.savings.id, 40));
    const legacy = (await client.query(
      `SELECT d.balance_date::text AS balance_date, calculate_account_balance_as_of($1, d.balance_date) AS balance
         FROM (SELECT CASE WHEN g.n = 0 THEN app_today()
                           ELSE (date_trunc('month', app_today()) - make_interval(months => g.n - 1))::date - 1 END AS balance_date
                 FROM generate_series(0, 39) AS g(n)) d
        ORDER BY d.balance_date DESC`,
      [accounts.savings.id],
    )).rows;
    expect(history).toEqual(legacy.map((row) => ({ account_id: accounts.savings.id, balance_date: row.balance_date, balance: Number(row.balance) })));
  });

  it('auto-tags many transactions at once as it did one at a time', async () => {
    const txIds: number[] = (await client.query('SELECT id FROM transactions ORDER BY id')).rows.map((r) => r.id);
    // Muddle the auto tags first: a stale one, and a manual tag that is also a merchant's auto tag.
    await client.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, type) VALUES ($1, 'transaction', $2, 'auto') ON CONFLICT DO NOTHING`,
      [tags[1], txIds[2]],
    );
    await client.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, type) VALUES ($1, 'transaction', $2, 'manual') ON CONFLICT DO NOTHING`,
      [tags[0], txIds[5]],
    );
    const snapshot = async () => (await client.query(
      `SELECT taggable_id, tag_id, type FROM taggings WHERE taggable_type = 'transaction' ORDER BY taggable_id, tag_id, type`,
    )).rows;

    await client.query('BEGIN');
    await client.query('SELECT pg_temp.legacy_auto_tag(id) FROM unnest($1::int[]) AS ids(id)', [txIds]);
    const legacy = await snapshot();
    await client.query('ROLLBACK');

    await client.query('BEGIN');
    const count = (await client.query('SELECT apply_transaction_auto_tags($1::int[]) AS count', [txIds])).rows[0].count;
    const now = await snapshot();
    await client.query('ROLLBACK');

    expect(count).toBe(txIds.length);
    expect(now).toEqual(legacy);
    expect(now.filter((row) => row.type === 'auto').length).toBeGreaterThan(10);
  });

  it("moves a tag's last_used_at forward once per insert, never back", async () => {
    const tag = (await one(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`last used ${stamp}`])).id;
    const [a, b, c] = (await client.query('SELECT id FROM transactions ORDER BY id LIMIT 3')).rows.map((r) => r.id);
    const lastUsed = async () => (await one('SELECT last_used_at FROM tags WHERE id = $1', [tag])).last_used_at as Date | null;
    await pool.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id, created_at)
       VALUES ($1, 'transaction', $2, '2026-03-01T00:00:00Z'), ($1, 'transaction', $3, '2026-05-01T00:00:00Z')`,
      [tag, a, b],
    );
    expect((await lastUsed())?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    const updatedAt = (await one('SELECT updated_at FROM tags WHERE id = $1', [tag])).updated_at;
    await pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, created_at) VALUES ($1, 'transaction', $2, '2026-04-01T00:00:00Z')`, [tag, c]);
    expect((await lastUsed())?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    // Not rewritten when it doesn't move.
    expect((await one('SELECT updated_at FROM tags WHERE id = $1', [tag])).updated_at).toEqual(updatedAt);
    // A tagging of something else doesn't count.
    await pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id, created_at) VALUES ($1, 'budget_item', $2, '2027-01-01T00:00:00Z')`, [tag, items[0].id]);
    expect((await lastUsed())?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  it('fills missing period items in one statement and counts the ones it cannot', async () => {
    // A transaction whose period item didn't exist when it was saved, and one that still has none.
    const item = (await one(`INSERT INTO budget_items (name, status) VALUES ($1, 'paused') RETURNING id`, [`Late item ${stamp}`])).id;
    const period = (await one('SELECT id, start_date::text AS start FROM budget_period WHERE year = $1 AND month_number = 6', [year]));
    const late = (await one(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, budget_item_id, budget_period_id)
       VALUES ($1, -5, $2, 'expense', $3, $4) RETURNING id, budget_period_item_id`,
      [accounts.checking.id, period.start, item, period.id],
    ));
    expect(late.budget_period_item_id).toBeNull();
    const orphanItem = (await one(`INSERT INTO budget_items (name, status) VALUES ($1, 'paused') RETURNING id`, [`Orphan item ${stamp}`])).id;
    await pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, budget_item_id, budget_period_id) VALUES ($1, -6, $2, 'expense', $3, $4)`,
      [accounts.checking.id, period.start, orphanItem, period.id],
    );
    const periodItem = (await one('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period.id, item])).id;

    const result = await withTenant(tenant.tenantId, () => fixMissingBudgetPeriodItemIds());
    expect(result).toEqual({ updated: 1, errors: 1 });
    expect((await one('SELECT budget_period_item_id FROM transactions WHERE id = $1', [late.id])).budget_period_item_id).toBe(periodItem);
  });
});
