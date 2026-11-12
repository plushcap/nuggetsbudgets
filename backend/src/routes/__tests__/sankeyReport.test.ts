import { answerProblem, sankeyResponseSchema } from '@nuggets/shared';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * GET /api/reports/sankey/:rootTagUuid through the real app: the report's
 * numbers are the sums of the tagged budget items' transactions (or allocations) in the
 * window, rolled up the tag tree, with untagged items in their own node, and nothing from
 * another ledger.
 *
 * Ledger A's namespace "Cash Flow": Income ← Salary; Living → Food ← Groceries, Dining;
 * Living ← Rent; Living ← Vacation (an envelope, so its allocation counts, not its
 * spending). Misc is untagged. Ledger B has the same shape with other amounts, which must
 * not show.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

interface Sankey {
  nodes: Array<{ id: string; label: string; level: number }>;
  links: Array<{ source: string; target: string; value: number }>;
  totals: {
    by_root_child: Array<{ tag_uuid: string; label: string; total: number }>;
    untagged_total: number;
    balance_check: { income_total: number; outflow_total: number; unallocated_residual: number };
  };
  _drilldown: Record<string, Array<{ budget_item_name: string; contribution: number; rule_applied: string }>>;
}

describeDb('Sankey report', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let session: string;
  const tags = {} as Record<'root' | 'income' | 'living' | 'food', Ref>;
  let period: Ref;
  let rootB: Ref;

  const one = async <T>(t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;

  /** One ledger's namespace, items and transactions; `scale` makes B's amounts differ. */
  async function seed(t: TestTenant, scale: number) {
    const tag = (name: string, parent: number | null, root = false) =>
      one<Ref>(t, 'INSERT INTO tags (name, parent_id, is_report_root) VALUES ($1, $2, $3) RETURNING id, uuid', [name, parent, root]);
    const root = await tag('Cash Flow', null, true);
    const income = await tag('Income', root.id);
    const living = await tag('Living', root.id);
    const food = await tag('Food', living.id);

    const item = (name: string, expenseType: string, rollover = false) =>
      one<Ref>(t, 'INSERT INTO budget_items (name, expense_type, rollover) VALUES ($1, $2, $3) RETURNING id, uuid', [name, expenseType, rollover]);
    const salary = await item('Salary', 'Income');
    const groceries = await item('Groceries', 'Expense');
    const dining = await item('Dining', 'Expense');
    const rent = await item('Rent', 'Expense');
    const vacation = await item('Vacation', 'Savings', true);
    const misc = await item('Misc', 'Expense');
    const tagItem = (tagId: number, itemId: number) =>
      t.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'budget_item', $2)`, [tagId, itemId]);
    await tagItem(income.id, salary.id);
    await tagItem(food.id, groceries.id);
    await tagItem(food.id, dining.id);
    await tagItem(living.id, rent.id);
    await tagItem(living.id, vacation.id);

    const account = await one<{ id: number }>(
      t,
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
    );
    const spend = (itemId: number, amount: number, day: string, type = amount > 0 ? 'income' : 'expense') =>
      t.pool.query(
        `INSERT INTO transactions (account_id, budget_item_id, amount, transaction_date, type) VALUES ($1, $2, $3, $4, $5)`,
        [account.id, itemId, (amount * scale).toFixed(2), day, type]
      );
    await spend(salary.id, 3000.0, '2026-10-01');
    await spend(salary.id, 0.1, '2026-10-15');
    await spend(groceries.id, -100.1, '2026-10-03');
    await spend(groceries.id, -45.25, '2026-10-20');
    await spend(dining.id, -200.2, '2026-10-05');
    await spend(rent.id, -1500.0, '2026-10-01');
    await spend(vacation.id, -999.99, '2026-10-10'); // an envelope's spending isn't its flow
    await spend(misc.id, -12.34, '2026-10-12');
    // Outside the window.
    await spend(groceries.id, -77.77, '2026-09-30');
    await spend(rent.id, -1500.0, '2026-11-01');
    // A split: its splits count, each to its own item, and its parent doesn't (the
    // database clears a split parent's budget item). One statement: the database checks
    // the splits add up at COMMIT.
    await t.pool.query(
      `WITH parent AS (
         INSERT INTO transactions (account_id, budget_item_id, amount, transaction_date, type, is_split_parent)
         VALUES ($1, $2, $4, '2026-10-25', 'expense', true) RETURNING id
       )
       INSERT INTO transactions (account_id, budget_item_id, amount, transaction_date, type, parent_transaction_id)
       SELECT $1, v.item, v.amount, '2026-10-25', 'expense', parent.id
         FROM parent, (VALUES ($2::int, $5::numeric), ($3::int, $6::numeric)) AS v(item, amount)`,
      [account.id, groceries.id, dining.id, (-60 * scale).toFixed(2), (-40 * scale).toFixed(2), (-20 * scale).toFixed(2)]
    );
    return { root, income, living, food, items: { salary, groceries, dining, rent, vacation, misc } };
  }

  beforeAll(async () => {
    h = await startRouteHarness('Sankey');
    a = await createTestTenant('Sankey A');
    b = await createTestTenant('Sankey B');
    session = await h.signIn(a.userId, a.tenantId);

    const seeded = await seed(a, 1);
    Object.assign(tags, { root: seeded.root, income: seeded.income, living: seeded.living, food: seeded.food });
    rootB = (await seed(b, 7)).root;

    // October's period, and an allocation for the envelope through the budget route.
    period = await one<Ref>(
      a,
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ('October 2026', 'October', 2026, 10, '2026-10-01', '2026-10-31') RETURNING id, uuid`
    );
    const vacationItem = await one<{ uuid: string }>(
      a,
      `INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING uuid`,
      [period.id, seeded.items.vacation.id]
    );
    const allocated = await h.call(session, 'put', `/api/budgets/period-items/${vacationItem.uuid}/budget`, { amount: 250.5 });
    expect(allocated.status, allocated.text).toBe(200);
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  const report = async (query: string, root = tags.root.uuid) => {
    const res = await h.call(session, 'get', `/api/reports/sankey/${root}?${query}`);
    expect(res.status, res.text).toBe(200);
    return res.body as Sankey;
  };
  const link = (r: Sankey, source: string, target: string) =>
    r.links.find((l) => l.source === source && l.target === target)?.value;
  const node = (ref: Ref) => `tag:${ref.uuid}`;

  it("sums each tag's items' transactions in the window and rolls them up the tree", async () => {
    const r = await report('start_date=2026-10-01&end_date=2026-10-31');

    // Food: groceries 100.10 + 45.25 + split 40, dining 200.20 + split 20.
    expect(link(r, node(tags.living), node(tags.food))).toBe(405.55);
    // Living: Food + rent 1500 + the envelope's allocation 250.50 (not its 999.99 of spending).
    expect(link(r, node(tags.root), node(tags.living))).toBe(2156.05);
    // Income flows into the root.
    expect(link(r, node(tags.income), node(tags.root))).toBe(3000.1);
    expect(link(r, node(tags.root), 'untagged')).toBe(12.34);
    expect(r.links).toHaveLength(4);

    expect(Object.fromEntries(r.totals.by_root_child.map((c) => [c.label, c.total]))).toEqual({ Income: 3000.1, Living: 2156.05 });
    expect(r.totals.untagged_total).toBe(12.34);
    expect(r.totals.balance_check).toEqual({ income_total: 3000.1, outflow_total: 2168.39, unallocated_residual: 831.71 });

    const vacation = r._drilldown[tags.living.uuid].find((d) => d.budget_item_name === 'Vacation');
    expect(vacation).toEqual(expect.objectContaining({ contribution: 250.5, rule_applied: 'rollover_allocation' }));
    expect(r._drilldown.untagged.map((d) => d.budget_item_name)).toEqual(['Misc']);
  });

  it('counts what the envelope spent instead with flow_measure_override=actual', async () => {
    const r = await report('start_date=2026-10-01&end_date=2026-10-31&flow_measure_override=actual');
    expect(link(r, node(tags.root), node(tags.living))).toBe(2905.54); // 405.55 + 1500 + 999.99
  });

  it("reads a budget period's dates and allocations by its uuid", async () => {
    const r = await report(`budget_period_uuid=${period.uuid}`);
    expect(link(r, node(tags.root), node(tags.living))).toBe(2156.05);
  });

  it('leaves the untagged node out when asked', async () => {
    const r = await report('start_date=2026-10-01&end_date=2026-10-31&include_untagged=false');
    expect(r.nodes.map((n) => n.id)).not.toContain('untagged');
    expect(r.links.some((l) => l.target === 'untagged')).toBe(false);
  });

  /**
   * Whole answers, pinned before the report moved to services/reports/: each uuid
   * as a placeholder numbered in the order it first appears, the request id as <requestId>.
   */
  it('answers the whole report, and its refusals, as pinned', async () => {
    const uuids = new Map<string, string>();
    const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const placeholders = (text: string) =>
      text.replace(UUID, (u) => {
        if (!uuids.has(u)) uuids.set(u, `<uuid:${uuids.size + 1}>`);
        return uuids.get(u)!;
      });
    // Keys too: the drilldown is keyed by tag uuid.
    const normalize = (value: unknown, key = ''): unknown => {
      if (Array.isArray(value)) return value.map((v) => normalize(v, key));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [placeholders(k), normalize(v, k)]));
      if (key === 'requestId') return '<requestId>';
      return typeof value === 'string' ? placeholders(value) : value;
    };
    const answer = async (query: string, root = tags.root.uuid) => {
      const res = await h.call(session, 'get', `/api/reports/sankey/${root}${query}`);
      // A report is exactly what the shared schema names.
      if (res.status === 200) expect.soft(answerProblem(sankeyResponseSchema, res.body), query).toBeNull();
      return normalize({ status: res.status, body: res.body });
    };
    expect.soft(await answer('?start_date=2026-10-01&end_date=2026-10-31&direction=rl&include_transfers=true')).toMatchSnapshot('window');
    expect.soft(await answer(`?budget_period_uuid=${period.uuid}&flow_measure_override=allocated&include_untagged=false`)).toMatchSnapshot('period');
    expect.soft(await answer('?start_date=2026-10-01')).toMatchSnapshot('open-ended');
    expect.soft(await answer('')).toMatchSnapshot('no window');
    expect.soft(await answer('?start_date=2026-10-01&end_date=2026-10-31&flow_measure_override=planned')).toMatchSnapshot('unknown measure');
    expect.soft(await answer('?budget_period_uuid=01900000-0000-7000-8000-000000000001')).toMatchSnapshot('unknown period');
    expect.soft(await answer('?start_date=2026-10-01&end_date=2026-10-31', '01900000-0000-7000-8000-000000000002')).toMatchSnapshot('unknown root');
    expect.soft(await answer('?start_date=2026-10-01&end_date=2026-10-31', tags.food.uuid)).toMatchSnapshot('not a root');
    expect.soft(await answer('?start_date=2026-10-01', 'not-a-uuid')).toMatchSnapshot('malformed root');
  });

  it('refuses a query value that is not one, rather than reach SQL with it or echo it', async () => {
    for (const query of [
      'start_date=2026-13-01', // a 500 (Postgres refused the date)
      'start_date=2026-10-01&end_date=yesterday',
      'budget_period_uuid=not-a-uuid', // a 500 (Postgres refused the uuid)
      'start_date=2026-10-01&direction=sideways', // echoed back
      'start_date=2026-10-01&include_untagged=no', // read as true
    ]) {
      const res = await h.call(session, 'get', `/api/reports/sankey/${tags.root.uuid}?${query}`);
      expect(res.status, `${query}: ${res.text}`).toBe(400);
      expect(res.body.code, query).toBe('VALIDATION_ERROR');
    }
  });

  it("answers 404 for another ledger's namespace, and 400 for a tag that isn't a namespace root", async () => {
    const theirs = await h.call(session, 'get', `/api/reports/sankey/${rootB.uuid}?start_date=2026-10-01&end_date=2026-10-31`);
    expect(theirs.status).toBe(404);
    const notRoot = await h.call(session, 'get', `/api/reports/sankey/${tags.food.uuid}?start_date=2026-10-01&end_date=2026-10-31`);
    expect(notRoot.status).toBe(400);
    const noWindow = await h.call(session, 'get', `/api/reports/sankey/${tags.root.uuid}`);
    expect(noWindow.status).toBe(400);
  });
});
