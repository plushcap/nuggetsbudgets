import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { withTenant } from '../db/withTenant.js';
import { GoalService } from '../services/GoalService.js';

/**
 * calculate_remaining_for_period_items answers, for many period items in one
 * statement, what calculate_remaining_for_period_item answers for each. Checked over random
 * ledgers, under RLS (the ledger's own connection), for every period item each has:
 *
 * - periods created out of date order, with gaps between months, and items with no period
 *   item in some of them;
 * - envelopes (rollover) of expense, savings and income, and monthly items, which the plural
 *   function hands to the per-item one;
 * - budget events of every type and direction, some filed under another item's period item
 *   and some under no item;
 * - spending of every kind: expenses, incomes, a split's children, a transaction with no
 *   period, one dated before the first period, and types that don't count (a starting
 *   balance);
 *
 * then a goal over the envelopes, whose progress history (GoalService.progressAt) is checked
 * against one calculate_remaining_for_period_item call per envelope per point, as it was
 * computed before. Another ledger's rows don't count, and its period items have no answer.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

/** A seeded random number generator, so a failure can be run again. */
const randomFrom = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};

describeDb('calculate_remaining_for_period_items', () => {
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    a = await createTestTenant('Remaining A');
    b = await createTestTenant('Remaining B');
  }, 60_000);

  afterAll(async () => {
    await a?.cleanup();
    await b?.cleanup();
  }, 60_000);

  /**
   * A random ledger's periods (from `startYear`: a ledger has one period per month, so two
   * seeds in one ledger start years apart), items, events and spending in `t`.
   */
  const seedTenant = async (t: TestTenant, seed: number, startYear: number) => {
    const random = randomFrom(seed);
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    /** From 0.01 to `max`, in cents. */
    const cents = (max: number) => ((Math.floor(random() * max * 100) + 1) / 100).toFixed(2);
    const q = async <T>(text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows as T[];
    const tag = `Seed ${seed}`;

    // 14 monthly periods, some months skipped, created in shuffled order.
    const months: Array<{ year: number; month: number }> = [];
    for (let m = 0; months.length < 14; m += random() < 0.2 ? 2 : 1) {
      months.push({ year: startYear + Math.floor(m / 12), month: (m % 12) + 1 });
    }
    months.sort(() => random() - 0.5);
    const periods: Array<{ id: number; start: string }> = [];
    for (const { year, month } of months) {
      const [row] = await q<{ id: number; start: string }>(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         SELECT $1, to_char(d, 'FMMonth'), $2, $3, d::date, (d + interval '1 month - 1 day')::date
           FROM make_date($2, $3, 1) AS d
         RETURNING id, start_date::text AS start`,
        [`${tag} ${year}-${month}`, year, month]
      );
      periods.push(row);
    }

    const kinds: Array<{ expense_type: string; rollover: boolean }> = [
      { expense_type: 'Savings', rollover: true },
      { expense_type: 'Expense', rollover: true },
      { expense_type: 'Savings', rollover: true },
      { expense_type: 'Income', rollover: true },
      { expense_type: 'Expense', rollover: false },
      { expense_type: 'Income', rollover: false },
    ];
    const items: Array<{ id: number; expense_type: string; rollover: boolean }> = [];
    for (const [i, kind] of kinds.entries()) {
      const [row] = await q<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover) VALUES ($1, $2, $3) RETURNING id`, [
        `${tag} item ${i}`,
        kind.expense_type,
        kind.rollover,
      ]);
      items.push({ id: row.id, ...kind });
    }
    // Each item has a period item in most periods, not all.
    const periodItems: Array<{ id: number; itemId: number; periodId: number }> = [];
    for (const item of items) {
      for (const period of periods) {
        if (random() < 0.15) continue;
        const [row] = await q<{ id: number }>('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [
          period.id,
          item.id,
        ]);
        periodItems.push({ id: row.id, itemId: item.id, periodId: period.id });
      }
    }

    // Budget events: mostly under the item's own period item, some under another item's, some for no item.
    const events: unknown[][] = [];
    for (let i = 0; i < 260; i++) {
      const item = pick(items);
      const own = periodItems.filter((p) => p.itemId === item.id);
      const filedUnder = random() < 0.15 || own.length === 0 ? pick(periodItems) : pick(own);
      events.push([
        filedUnder.id,
        random() < 0.05 ? null : item.id,
        pick(['budget_update', 'budget_update', 'starting_balance', 'transfer']),
        pick(['add', 'add', 'remove', 'move_in', 'move_out']),
        cents(400),
      ]);
    }
    await t.pool.query(
      `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, type, transaction_type, amount)
       SELECT * FROM unnest($1::int[], $2::int[], $3::text[], $4::text[], $5::numeric[])`,
      [0, 1, 2, 3, 4].map((col) => events.map((e) => e[col]))
    );

    // Spending: an account's expenses and incomes in the items, dated in a period or before
    // the first, some with no period.
    const [account] = await q<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id`,
      [`${tag} checking`]
    );
    const first = [...periods].sort((x, y) => (x.start < y.start ? -1 : 1))[0];
    const spending: unknown[][] = [];
    for (let i = 0; i < 320; i++) {
      const item = pick(items);
      const period = pick(periods);
      const income = random() < 0.3;
      const date = random() < 0.05 ? `${Number(first.start.slice(0, 4)) - 1}-06-15` : `${period.start.slice(0, 8)}${String(1 + Math.floor(random() * 27)).padStart(2, '0')}`;
      spending.push([
        account.id,
        income ? cents(900) : `-${cents(300)}`,
        date,
        income ? 'income' : random() < 0.05 ? 'starting balance' : 'expense',
        item.id,
        random() < 0.05 ? null : period.id,
      ]);
    }
    await t.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, budget_item_id, budget_period_id, description)
       SELECT a, m, d, ty, i, p, 'Random spending' FROM unnest($1::int[], $2::numeric[], $3::date[], $4::text[], $5::int[], $6::int[]) AS u(a, m, d, ty, i, p)`,
      [0, 1, 2, 3, 4, 5].map((col) => spending.map((s) => s[col]))
    );
    // A split: the parent has no item, its children count. One statement.
    const envelopes = items.filter((i) => i.rollover && i.expense_type !== 'Income');
    await t.pool.query(
      `WITH parent AS (
         INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent, budget_period_id, description)
         VALUES ($1, -90, $2, 'expense', true, $3, 'Split') RETURNING id
       )
       INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id, budget_item_id, budget_period_id, description)
       SELECT $1, v.amount, $2, 'expense', parent.id, v.item, $3, 'Split child'
         FROM parent, (VALUES (-60::numeric, $4::int), (-30::numeric, $5::int)) AS v(amount, item)`,
      [account.id, periods[3].start, periods[3].id, envelopes[0].id, envelopes[1].id]
    );
    return { periods, items, periodItems };
  };

  /** Every period item's remaining both ways, as text, on `t`'s connection. */
  const bothWays = async (t: TestTenant, ids: number[]) =>
    (
      await t.pool.query<{ id: number; one: string; many: string | null }>(
        `SELECT u.id, calculate_remaining_for_period_item(u.id)::text AS one, r.remaining::text AS many
           FROM unnest($1::int[]) AS u(id)
           LEFT JOIN calculate_remaining_for_period_items($1::int[]) r ON r.budget_period_item_id = u.id
          ORDER BY u.id`,
        [ids]
      )
    ).rows;

  it('answers each period item as calculate_remaining_for_period_item does, over random ledgers', async () => {
    for (const [seed, startYear] of [[4813, 2001], [19, 2004], [2026, 2007]]) {
      const { periodItems } = await seedTenant(a, seed, startYear);
      const rows = await bothWays(
        a,
        periodItems.map((p) => p.id)
      );
      expect(rows).toHaveLength(periodItems.length);
      for (const row of rows) expect(row.many, `seed ${seed}, period item ${row.id}`).toBe(row.one);
      // The ledgers have money in their envelopes, and items of every kind.
      expect(rows.filter((row) => Number(row.one) !== 0).length).toBeGreaterThan(periodItems.length / 2);
    }
    // Everything at once too, across the three seeds' periods ...
    const all = (await a.pool.query<{ id: number }>('SELECT id FROM budget_period_items')).rows.map((r) => r.id);
    for (const row of await bothWays(a, all)) expect(row.many, `period item ${row.id}`).toBe(row.one);
    // ... and whatever plan the planner picks: the same answer with each kind of join or
    // scan turned off.
    const client = await a.pool.connect();
    try {
      for (const off of [['hashjoin', 'mergejoin'], ['nestloop'], ['indexscan', 'indexonlyscan', 'bitmapscan'], ['seqscan'], ['hashagg', 'sort']]) {
        await client.query('BEGIN');
        for (const setting of off) await client.query(`SET LOCAL enable_${setting} = off`);
        const many = (
          await client.query<{ id: number; remaining: string }>(
            'SELECT budget_period_item_id AS id, remaining::text FROM calculate_remaining_for_period_items($1::int[]) ORDER BY 1',
            [all]
          )
        ).rows;
        await client.query('ROLLBACK');
        const one = (await bothWays(a, all)).map((row) => ({ id: row.id, remaining: row.one }));
        expect(many, off.join(', ')).toEqual(one);
      }
    } finally {
      client.release();
    }
  }, 120_000);

  it('answers once per period item, nothing for an unknown one or another ledger\'s', async () => {
    const { periodItems } = await seedTenant(b, 5, 2001);
    const theirs = periodItems.map((p) => p.id);
    const mine = (await a.pool.query<{ id: number }>('SELECT id FROM budget_period_items ORDER BY id LIMIT 3')).rows.map((r) => r.id);
    const answer = async (ids: Array<number | null>) =>
      (
        await a.pool.query<{ budget_period_item_id: number }>(
          'SELECT budget_period_item_id FROM calculate_remaining_for_period_items($1::int[]) ORDER BY 1',
          [ids]
        )
      ).rows.map((r) => r.budget_period_item_id);
    expect(await answer([mine[0], mine[0], mine[1], null, -1, 2147483647, ...theirs])).toEqual([mine[0], mine[1]]);
    expect(await answer([])).toEqual([]);
    // B's own figures don't see A's rows either.
    for (const row of await bothWays(b, theirs)) expect(row.many, `period item ${row.id}`).toBe(row.one);
  }, 120_000);

  it("draws a goal's envelope history as one calculate_remaining_for_period_item call per envelope per point did", async () => {
    const { periods, items } = await seedTenant(a, 4242, 2010);
    const envelopes = items.filter((i) => i.rollover);
    const [goal] = (
      await a.pool.query<{ id: number }>(
        `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date) VALUES ('Envelope goal', 'Savings', 'Goal', 'Goal', 1000, '2030-01-01') RETURNING id`
      )
    ).rows;
    // Linked since before the first period, so every point counts them.
    for (const envelope of envelopes) {
      await a.pool.query(`INSERT INTO goal_budget_items (goal_id, budget_item_id, valid_from) VALUES ($1, $2, '2000-01-01')`, [goal.id, envelope.id]);
    }
    // Each period's last day and a day inside it, and a day in no period.
    const dates = periods.flatMap((p) => [`${p.start.slice(0, 8)}12`]).concat('1999-12-31');
    const ends = (
      await a.pool.query<{ end: string }>('SELECT end_date::text AS end FROM budget_period WHERE id = ANY($1)', [periods.map((p) => p.id)])
    ).rows.map((r) => r.end);
    const asked = [...dates, ...ends];
    const points = await withTenant(a.tenantId, () => new GoalService().progressAt(goal.id, asked));
    const expected = (
      await a.pool.query<{ as_of: string; total: string }>(
        `SELECT d.as_of::text, round(COALESCE(SUM(calculate_remaining_for_period_item(bpi.id)), 0), 2)::text AS total
           FROM unnest($1::date[]) AS d(as_of)
           LEFT JOIN budget_period bp ON d.as_of BETWEEN bp.start_date AND bp.end_date
           LEFT JOIN budget_period_items bpi ON bpi.budget_period_id = bp.id AND bpi.budget_item_id = ANY($2::int[])
          GROUP BY d.as_of ORDER BY d.as_of`,
        [asked, envelopes.map((e) => e.id)]
      )
    ).rows;
    expect(points.map((p) => [p.snapshot_date, p.total_from_budget_items])).toEqual(expected.map((e) => [e.as_of, e.total]));
    expect(expected.filter((e) => Number(e.total) !== 0).length).toBeGreaterThan(20);
  }, 120_000);
});
