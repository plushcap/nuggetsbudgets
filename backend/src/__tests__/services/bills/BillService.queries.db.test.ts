import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../../db/withTenant.js';
import { BillService, type Occurrence, type OccurrenceFilter } from '../../../services/bills/BillService.js';
import { containsPattern } from '../../../utils/likePattern.js';
import { addDays } from '../../../utils/calendarDate.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';

/**
 * BillService's occurrence query and payment search moved from raw SQL (a filter fragment
 * appended by each of loadOccurrences' 7 callers, and one hand-written search) to Kysely.
 * This runs each filter the callers use, and the search in both of its
 * modes, both ways on one ledger and compares the rows: the reference queries below are the
 * raw SQL as it was. The other ledger's rows must never show up in either.
 */
describe('BillService queries: Kysely and the raw SQL they replaced give the same rows', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  const service = new BillService();
  const today = '2026-11-15';
  const ids = { power: 0, water: 0, sameA: 0, sameB: 0, groceries: 0 };
  const occurrenceUuids: string[] = [];
  const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

  type Private = {
    occurrenceRows(filter: OccurrenceFilter): Promise<unknown[]>;
    candidateRows(occurrence: Occurrence, words: string | undefined, today: string): Promise<unknown[]>;
    occurrenceByUuid(uuid: string, today: string): Promise<Occurrence>;
  };
  const internals = service as unknown as Private;

  /** The occurrence query as it was, with a caller's fragment. */
  const referenceOccurrences = async (fragment: ReturnType<typeof sql>) =>
    (
      await sql`
        SELECT o.id, o.uuid, o.budget_item_id, bi.uuid AS bill_uuid, bi.name AS bill_name,
               bi.recurring_amount_varies AS bill_varies, c.name AS category,
               to_char(o.due_date, 'YYYY-MM-DD') AS due_date, o.expected_amount, o.resolution,
               to_char(o.manual_paid_date, 'YYYY-MM-DD') AS manual_paid_date, o.manual_paid_amount, o.note
          FROM bill_occurrences o
          JOIN budget_items bi ON bi.id = o.budget_item_id
          LEFT JOIN categories c ON c.id = bi.category_id
         WHERE o.tenant_id = ${currentTenant} ${fragment}
         ORDER BY o.due_date, bi.name
      `.execute(getDb())
    ).rows;

  /** The payment search as it was. */
  const referenceCandidates = async (occurrence: Occurrence, words: string | undefined) => {
    const like = words ? containsPattern(words) : '';
    const filter = words
      ? sql`t.transaction_date >= ${addDays(today, -400)}::date
            AND (t.description ILIKE ${like} OR m.name ILIKE ${like} OR bi.name ILIKE ${like})`
      : sql`t.budget_item_id = ${occurrence.billId}
            AND t.transaction_date >= ${addDays(occurrence.due_date, -120)}::date`;
    return (
      await sql`
        SELECT t.uuid, to_char(t.transaction_date, 'YYYY-MM-DD') AS date, t.amount, t.description,
               a.name AS account, bi.name AS budget_item,
               to_char(lo.due_date, 'YYYY-MM-DD') AS linked_due_date,
               COALESCE(l.bill_occurrence_id = ${occurrence.id} AND l.matched_by <> 'excluded', false) AS linked_here
          FROM transactions t
          LEFT JOIN accounts a ON a.id = t.account_id
          LEFT JOIN merchants m ON m.id = t.merchant_id
          LEFT JOIN budget_items bi ON bi.id = t.budget_item_id
          LEFT JOIN bill_occurrence_transactions l ON l.transaction_id = t.id
          LEFT JOIN bill_occurrences lo ON lo.id = l.bill_occurrence_id AND l.matched_by <> 'excluded'
         WHERE t.tenant_id = ${currentTenant}
           AND t.amount < 0
           AND NOT COALESCE(t.is_split_parent, false)
           AND ${filter}
         ORDER BY t.transaction_date DESC, t.id DESC
         LIMIT 50
      `.execute(getDb())
    ).rows;
  };
  beforeAll(async () => {
    tenant = await createTestTenant('Bill queries');
    other = await createTestTenant('Bill queries (other ledger)');
    const q = async (t: TestTenant, text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0];

    for (const t of [tenant, other]) {
      const account = (await q(t, `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Bills checking', 'checking', 'cash', 'Asset') RETURNING id`)).id;
      const category = (await q(t, `INSERT INTO categories (name, icon) VALUES ('Utilities', 'Bolt') RETURNING id`)).id;
      const merchant = (await q(t, `INSERT INTO merchants (name) VALUES ('City 50% Power') RETURNING id`)).id;
      const bill = async (name: string, varies: boolean, categoryId: number | null) =>
        (
          await q(
            t,
            `INSERT INTO budget_items (name, expense_type, type, subtype, isbill, recurring_payment, recurring_payment_amount,
                                       recurring_payment_frequency, recurring_next_payment_date, recurring_amount_varies, category_id)
             VALUES ($1, 'Expense', 'Monthly', 'Fixed', true, true, 80, 1, '2026-01-05', $2, $3) RETURNING id`,
            [name, varies, categoryId]
          )
        ).id as number;
      const power = await bill('Power', true, category);
      const water = await bill('Water', false, null);
      const sameA = await bill('Same name', false, category);
      const sameB = await bill('Same name', false, null);
      const groceries = (await q(t, `INSERT INTO budget_items (name, expense_type, type) VALUES ('Groceries', 'Expense', 'Monthly') RETURNING id`)).id;
      if (t === tenant) Object.assign(ids, { power, water, sameA, sameB, groceries });

      const occurrence = async (billId: number, due: string, extra: { resolution?: string; paidDate?: string; paidAmount?: number; note?: string } = {}) => {
        const row = await q(
          t,
          `INSERT INTO bill_occurrences (budget_item_id, due_date, expected_amount, resolution, manual_paid_date, manual_paid_amount, note)
           VALUES ($1, $2, -80, $3, $4, $5, $6) RETURNING id, uuid`,
          [billId, due, extra.resolution ?? null, extra.paidDate ?? null, extra.paidAmount ?? null, extra.note ?? null]
        );
        if (t === tenant) occurrenceUuids.push(row.uuid);
        return row.id as number;
      };
      const txn = async (budgetItemId: number | null, date: string, amount: number, description: string, opts: { merchant?: number; splitParent?: boolean } = {}) =>
        (
          await q(
            t,
            `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, merchant_id, is_split_parent)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
            [account, amount, date, amount < 0 ? 'expense' : 'income', description, budgetItemId, opts.merchant ?? null, opts.splitParent ?? false]
          )
        ).id as number;
      const link = (occurrenceId: number, transactionId: number, matchedBy: string) =>
        t.pool.query(`INSERT INTO bill_occurrence_transactions (bill_occurrence_id, transaction_id, matched_by) VALUES ($1, $2, $3)`, [
          occurrenceId,
          transactionId,
          matchedBy,
        ]);

      const powerOct = await occurrence(power, '2026-10-05');
      const powerNov = await occurrence(power, '2026-11-05', { note: 'Called them' });
      await occurrence(power, '2026-12-05');
      await occurrence(power, '2027-01-05');
      await occurrence(water, '2026-09-20', { resolution: 'skipped' });
      await occurrence(water, '2026-11-20', { resolution: 'paid_manually', paidDate: '2026-11-18', paidAmount: -79.5 });
      await occurrence(water, '2027-02-20');
      await occurrence(sameA, '2026-11-01');
      await occurrence(sameB, '2026-11-02');
      await occurrence(sameA, '2026-06-01');
      // On the filters' edges: a month's first day after (out), a window's last day (in).
      await occurrence(sameB, '2026-12-01');
      await occurrence(water, '2026-12-16');

      await link(powerOct, await txn(power, '2026-10-04', -80, 'Power October', { merchant }), 'auto');
      await link(powerNov, await txn(power, '2026-11-06', -60, 'Power November part'), 'manual');
      await link(powerNov, await txn(power, '2026-11-07', -15, 'Power refund taken'), 'excluded');
      await txn(power, '2026-11-08', -20, 'Power November rest');
      await txn(power, '2026-07-01', -80, 'Power long ago');
      await txn(power, '2026-11-09', 12, 'Power credit');
      // A split parent (never a candidate) and its one split (one), in one statement: the
      // database checks at COMMIT that the splits add up.
      await t.pool.query(
        `WITH p AS (INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, is_split_parent)
                    VALUES ($1, -30, '2026-11-10', 'expense', 'Power split', $2, true) RETURNING id)
         INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id, parent_transaction_id)
         SELECT $1, -30, '2026-11-10', 'expense', 'Power split part', $2, id FROM p`,
        [account, power]
      );
      await txn(groceries, '2026-11-11', -42, 'Corner shop 50%');
      await txn(null, '2025-10-01', -9, 'Power too old for a search');
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  it('loads the same occurrence rows for each filter the callers use', async () => {
    const cases: Array<[string, OccurrenceFilter, ReturnType<typeof sql>]> = [
      ['forecast history (bills)', { billIds: [ids.power, ids.water] }, sql`AND o.budget_item_id = ANY(${[ids.power, ids.water]})`],
      ['open (bills, unresolved)', { billIds: [ids.water, ids.sameA], unresolved: true }, sql`AND o.budget_item_id = ANY(${[ids.water, ids.sameA]}) AND o.resolution IS NULL`],
      ['month', { dueFrom: '2026-11-01', dueBefore: '2026-12-01' }, sql`AND o.due_date >= ${'2026-11-01'}::date AND o.due_date < ${'2026-12-01'}::date`],
      ['forecast window', { dueFrom: '2026-11-01', dueBefore: '2027-03-01' }, sql`AND o.due_date >= ${'2026-11-01'}::date AND o.due_date < ${'2027-03-01'}::date`],
      ['one bill', { billIds: [ids.sameB] }, sql`AND o.budget_item_id = ${ids.sameB}`],
      ['notification window', { dueFrom: '2026-09-16', dueThrough: '2026-12-16' }, sql`AND o.due_date >= ${'2026-09-16'}::date AND o.due_date <= ${'2026-12-16'}::date`],
      ['all', {}, sql``],
    ];
    for (const uuid of occurrenceUuids) cases.push([`by uuid ${uuid}`, { uuid }, sql`AND o.uuid = ${uuid}::uuid`]);

    await withTenant(tenant.tenantId, async () => {
      for (const [label, filter, fragment] of cases) {
        const reference = await referenceOccurrences(fragment);
        expect(await internals.occurrenceRows(filter), label).toEqual(reference);
      }
      // Something to compare: every occurrence of this ledger, and none of the other's.
      expect(await internals.occurrenceRows({})).toHaveLength(12);
    });
  });

  it('finds the same payment candidates, by bill and by words', async () => {
    await withTenant(tenant.tenantId, async () => {
      // Power's November due date (the second made), which one payment is linked to.
      const occurrence = await internals.occurrenceByUuid(occurrenceUuids[1]!, today);
      expect(occurrence.due_date).toBe('2026-11-05');
      for (const words of [undefined, 'power', '50%', 'groceries', 'nothing like it']) {
        const reference = await referenceCandidates(occurrence, words);
        expect(await internals.candidateRows(occurrence, words, today), String(words)).toEqual(reference);
      }
      // The search finds something: by bill, the bill's money out since 120 days before.
      expect((await internals.candidateRows(occurrence, undefined, today)).length).toBeGreaterThan(2);
      expect(await internals.candidateRows(occurrence, '50%', today)).toHaveLength(2);
    });
  });
});
