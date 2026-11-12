import { sql, type NotNull } from 'kysely';
import type {
  BillDueDate,
  BillForecastItem,
  BillForecastMonth,
  BillMonthView,
  BillOccurrence,
  BillPayment,
  BillPaymentCandidate,
  BillRef,
  BillStatus,
  ResolveBillOccurrenceInput,
  UnplacedBillPayment,
} from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { addDays, addMonths, daysBetween, dueDateIn, monthsBetween } from './schedule.js';
import { createLogger } from '../../utils/logger.js';
import { containsPattern } from '../../utils/likePattern.js';
import { requestCents } from '../../utils/decimal.js';
import { centsToAmount } from '../../utils/money.js';
import { billResolution, billPaymentMatch, transactionType } from '@nuggets/shared';

const logger = createLogger({ service: 'BillService' });

// Every query here also runs under RLS; naming the tenant as well keeps a role
// that bypasses RLS (the CI database role is a superuser) from mixing tenants.
const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

/** A transaction within this many days of a due date is matched to it automatically. */
export const paymentWindowDays = 10;
/** Paid within this share of the expected amount counts as fully paid. */
export const paidTolerance = 0.1;
/** Unpaid and due within this many days: "due soon". */
export const dueSoonDays = 7;
/** A varying bill is forecast from the average of this many recent payments. */
const varyingHistory = 3;

/** A bill request the service refuses (a due date or payment that isn't there, a day off schedule): answered `{ error, code, message }` with its status. */
export class BillError extends DomainError {
  constructor(message: string, status: 400 | 404) {
    super(status, defaultErrorCode(status), message);
  }
}

/** pg returns NUMERIC as a string. */
function money(value: string | number | null | undefined): number {
  return value == null ? 0 : Number(value);
}

function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Bill extends BillRef {
  id: number;
  category: string | null;
  anchor: string;
  frequency: number;
  /** Positive. */
  amount: number;
}

interface OccurrenceRow {
  id: number;
  uuid: string;
  budget_item_id: number;
  bill_uuid: string;
  bill_name: string;
  bill_varies: boolean;
  category: string | null;
  due_date: string;
  expected_amount: string;
  resolution: 'skipped' | 'paid_manually' | null;
  manual_paid_date: string | null;
  manual_paid_amount: string | null;
  note: string | null;
}

/**
 * Which occurrences {@link BillService} loads: those every condition given holds for (none
 * given: all of the ledger's).
 */
export interface OccurrenceFilter {
  /** Of these bills (budget items). */
  billIds?: readonly number[];
  /** Neither skipped nor paid by hand (resolution IS NULL). */
  unresolved?: boolean;
  /** The one with this uuid. */
  uuid?: string;
  /** Due on or after this day. */
  dueFrom?: string;
  /** Due before this day. */
  dueBefore?: string;
  /** Due on or before this day. */
  dueThrough?: string;
}

/** A date column as 'YYYY-MM-DD' (to_char, as these queries always read them); null for a null one. */
const dayText = <T extends string | null = string>(column: string) => sql<T>`to_char(${sql.ref(column)}, 'YYYY-MM-DD')`;

/** An occurrence with its payments, its paid total and its status today. */
export interface Occurrence extends BillOccurrence {
  id: number;
  billId: number;
  category: string | null;
}

/** What a `bill` notification rule judges: one due date. */
export interface BillSubject {
  occurrence: Occurrence;
  facts: Record<string, string | number | boolean | null>;
}

/** Status of a due date with `paid` of `expected` paid, on `today`. */
export function billStatus(
  occurrence: { due_date: string; resolution: OccurrenceRow['resolution'] },
  expected: number,
  paid: number,
  today: string,
): BillStatus {
  if (occurrence.resolution === billResolution.enum.skipped) return 'skipped';
  if (occurrence.resolution === billResolution.enum.paid_manually) return 'paid';
  if (paid > 0 && paid >= expected * (1 - paidTolerance)) return 'paid';
  if (paid > 0) return 'partly_paid';
  const days = daysBetween(today, occurrence.due_date);
  if (days < 0) return 'overdue';
  return days <= dueSoonDays ? 'due_soon' : 'upcoming';
}

/**
 * BillService — the payments each bill is due to make (bill_occurrences) and
 * the transactions that paid them (bill_occurrence_transactions).
 *
 * Occurrences are made for the current month and the next whenever bills are
 * looked at or the notification rules run, and for a later month when someone
 * opens it or places a payment on it. Payments in a bill's budget item within
 * {@link paymentWindowDays} of a due date are linked to it automatically; a
 * person can link any transaction to any due date, unlink, skip a due date, or
 * mark it paid by hand. Amounts paid are summed from the transactions.
 *
 * Everything runs on getDb(), inside the request's (or the scheduler's)
 * tenant transaction.
 */
export class BillService {
  /** Active bills with a schedule: an amount, a frequency and an anchor date. */
  async loadBills(): Promise<Bill[]> {
    // A date column reads as its 'YYYY-MM-DD' text (db/pgSession.ts).
    const rows = await getDb()
      .selectFrom('budget_items as bi')
      .leftJoin('categories as c', 'c.id', 'bi.category_id')
      .select([
        'bi.id',
        'bi.uuid',
        'bi.name',
        'c.name as category',
        'bi.recurring_next_payment_date as anchor',
        'bi.recurring_payment_frequency as frequency',
        'bi.recurring_payment_amount as amount',
        'bi.recurring_amount_varies as varies',
      ])
      .where('bi.tenant_id', '=', currentTenant)
      .where('bi.isbill', '=', true)
      .where((eb) => eb(eb.fn.coalesce('bi.status', sql.lit('active')), '=', 'active'))
      .where('bi.recurring_next_payment_date', 'is not', null)
      .where((eb) => eb(eb.fn.coalesce('bi.recurring_payment_frequency', sql.lit(0)), '>=', 1))
      .orderBy('bi.name')
      // The two conditions above: a schedule's anchor and frequency are there.
      .$narrowType<{ anchor: NotNull; frequency: NotNull }>()
      .execute();
    return rows.map((row) => ({
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      varies: row.varies,
      category: row.category,
      anchor: row.anchor,
      frequency: row.frequency,
      amount: Math.abs(money(row.amount)),
    }));
  }

  /**
   * What each bill is expected to cost next: its set amount, or for a varying
   * bill the average paid on its last {@link varyingHistory} fully paid due
   * dates (its set amount until it has any).
   */
  async forecastAmounts(bills: Bill[], today: string): Promise<Map<number, number>> {
    const amounts = new Map(bills.map((bill) => [bill.id, bill.amount]));
    const varying = bills.filter((bill) => bill.varies).map((bill) => bill.id);
    if (varying.length === 0) return amounts;

    const history = await this.loadOccurrences({ billIds: varying }, today);
    const recent = new Map<number, number[]>();
    for (const occurrence of history.sort((a, b) => b.due_date.localeCompare(a.due_date))) {
      if (occurrence.status !== 'paid') continue;
      const list = recent.get(occurrence.billId) ?? [];
      if (list.length < varyingHistory) list.push(occurrence.paid);
      recent.set(occurrence.billId, list);
    }
    for (const [billId, paid] of recent) {
      amounts.set(billId, cents(paid.reduce((sum, value) => sum + value, 0) / paid.length));
    }
    return amounts;
  }

  /**
   * Make the occurrences due in `month` (a month before today's makes none: no
   * back-fill). An occurrence nobody has paid, skipped or linked yet, due today
   * or later, takes the bill's current expected amount.
   */
  async ensureMonth(month: string, today: string, bills?: Bill[], amounts?: Map<number, number>): Promise<void> {
    if (monthsBetween(today.slice(0, 7), month) < 0) return;
    bills ??= await this.loadBills();
    if (bills.length === 0) return;
    amounts ??= await this.forecastAmounts(bills, today);

    for (const bill of bills) {
      const due = dueDateIn(bill.anchor, bill.frequency, month);
      if (!due) continue;
      const expected = -(amounts.get(bill.id) ?? bill.amount);
      await sql`
        INSERT INTO bill_occurrences (budget_item_id, due_date, expected_amount)
        VALUES (${bill.id}, ${due}::date, ${expected})
        ON CONFLICT ON CONSTRAINT bill_occurrences_bill_due_key DO UPDATE
           SET expected_amount = EXCLUDED.expected_amount
         WHERE bill_occurrences.resolution IS NULL
           AND bill_occurrences.due_date >= ${today}::date
           AND bill_occurrences.expected_amount <> EXCLUDED.expected_amount
           AND NOT EXISTS (
                 SELECT 1 FROM bill_occurrence_transactions l
                  WHERE l.bill_occurrence_id = bill_occurrences.id AND l.matched_by <> 'excluded')
      `.execute(getDb());
    }
  }

  /**
   * Bring occurrences and automatic links up to date: make this month's and
   * next month's occurrences, drop automatic links that no longer fit (the
   * transaction moved to another budget item, was split, or its date moved
   * out of the window), link new payments, and keep each bill's last paid
   * date. Safe to run as often as wanted.
   */
  async sync(today: string): Promise<void> {
    const bills = await this.loadBills();
    if (bills.length > 0) {
      const amounts = await this.forecastAmounts(bills, today);
      await this.ensureMonth(today.slice(0, 7), today, bills, amounts);
      await this.ensureMonth(addMonths(today.slice(0, 7), 1), today, bills, amounts);
    }

    await sql`
      DELETE FROM bill_occurrence_transactions l
       USING bill_occurrences o, transactions t
       WHERE l.bill_occurrence_id = o.id
         AND t.id = l.transaction_id
         AND l.tenant_id = ${currentTenant}
         AND l.matched_by = 'auto'
         AND (t.budget_item_id IS DISTINCT FROM o.budget_item_id
              OR COALESCE(t.is_split_parent, false)
              OR abs(t.transaction_date - o.due_date) > ${paymentWindowDays})
    `.execute(getDb());

    await this.linkNewPayments(today);

    // The items of the ledger's bills in id order first, as a zone change and
    // every other write of several items lock them: the UPDATE alone took them in the order it
    // found them. FOR NO KEY UPDATE, what the UPDATE takes.
    await sql`
      SELECT id FROM budget_items
       WHERE tenant_id = ${currentTenant}
         AND id IN (SELECT budget_item_id FROM bill_occurrences WHERE tenant_id = ${currentTenant})
       ORDER BY id FOR NO KEY UPDATE
    `.execute(getDb());
    await sql`
      UPDATE budget_items bi
         SET recurring_last_payment_date = p.last_paid
        FROM (
              SELECT o.budget_item_id,
                     MAX(CASE WHEN o.resolution = 'paid_manually' THEN o.manual_paid_date ELSE x.last_date END) AS last_paid
                FROM bill_occurrences o
                LEFT JOIN LATERAL (
                      SELECT SUM(-t.amount) AS paid, MAX(t.transaction_date) AS last_date
                        FROM bill_occurrence_transactions l
                        JOIN transactions t ON t.id = l.transaction_id
                       WHERE l.bill_occurrence_id = o.id AND l.matched_by <> 'excluded'
                     ) x ON true
               WHERE o.tenant_id = ${currentTenant}
                 AND (o.resolution = 'paid_manually'
                      OR (o.resolution IS NULL AND x.paid > 0 AND x.paid >= -o.expected_amount * ${1 - paidTolerance}))
               GROUP BY o.budget_item_id
             ) p
       WHERE bi.id = p.budget_item_id
         AND bi.tenant_id = ${currentTenant}
         AND p.last_paid IS NOT NULL
         AND bi.recurring_last_payment_date IS DISTINCT FROM p.last_paid
    `.execute(getDb());
  }

  /** Link each unlinked payment in a bill's budget item to its earliest open due date within the window. */
  private async linkNewPayments(today: string): Promise<void> {
    const payments = await getDb()
      .selectFrom('transactions as t')
      .select(['t.id', 't.budget_item_id', 't.transaction_date as date', 't.amount'])
      .where('t.tenant_id', '=', currentTenant)
      .where('t.amount', '<', '0')
      .where('t.type', 'in', [transactionType.enum.expense, transactionType.enum.payment])
      .where((eb) => eb.not(eb.fn.coalesce('t.is_split_parent', sql.lit(false))))
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom('bill_occurrence_transactions as l').select('l.id').whereRef('l.transaction_id', '=', 't.id'))))
      .where((eb) => eb.exists(
        eb.selectFrom('bill_occurrences as o')
          .select('o.id')
          .whereRef('o.budget_item_id', '=', 't.budget_item_id')
          .where('o.resolution', 'is', null)
          .where(sql<number>`abs(o.due_date - t.transaction_date)`, '<=', paymentWindowDays)))
      .orderBy('t.transaction_date')
      .orderBy('t.id')
      // The EXISTS above: a payment's budget item is a bill's, so it is there.
      .$narrowType<{ budget_item_id: NotNull }>()
      .execute();
    if (payments.length === 0) return;

    const billIds = [...new Set(payments.map((payment) => payment.budget_item_id))];
    const open = (await this.loadOccurrences({ billIds, unresolved: true }, today))
      .sort((a, b) => a.due_date.localeCompare(b.due_date));

    let linked = 0;
    for (const payment of payments) {
      const target = open.find((occurrence) =>
        occurrence.billId === payment.budget_item_id
        && occurrence.status !== 'paid'
        && Math.abs(daysBetween(occurrence.due_date, payment.date)) <= paymentWindowDays);
      if (!target) continue;
      await getDb()
        .insertInto('bill_occurrence_transactions')
        .values({ bill_occurrence_id: target.id, transaction_id: payment.id, matched_by: 'auto' })
        .onConflict((oc) => oc.constraint('bill_occurrence_transactions_transaction_key').doNothing())
        .execute();
      target.paid = cents(target.paid - money(payment.amount));
      target.status = billStatus(target, target.expected, target.paid, today);
      linked++;
    }
    if (linked > 0) logger.info({ linked }, 'Linked bill payments');
  }

  /**
   * The ledger's occurrences `filter` names, with their bill and its category, by due date,
   * then bill name (then id, so two bills of one name keep an order).
   */
  private occurrenceRows(filter: OccurrenceFilter): Promise<OccurrenceRow[]> {
    let query = getDb()
      .selectFrom('bill_occurrences as o')
      .innerJoin('budget_items as bi', 'bi.id', 'o.budget_item_id')
      .leftJoin('categories as c', 'c.id', 'bi.category_id')
      .select([
        'o.id',
        'o.uuid',
        'o.budget_item_id',
        'bi.uuid as bill_uuid',
        'bi.name as bill_name',
        'bi.recurring_amount_varies as bill_varies',
        'c.name as category',
        dayText('o.due_date').as('due_date'),
        'o.expected_amount',
        'o.resolution',
        dayText<string | null>('o.manual_paid_date').as('manual_paid_date'),
        'o.manual_paid_amount',
        'o.note',
      ])
      .where('o.tenant_id', '=', currentTenant);
    // One array parameter, however many bills: = ANY($1), not IN ($1, $2, …).
    const { billIds } = filter;
    if (billIds) query = query.where((eb) => eb('o.budget_item_id', '=', eb.fn.any(eb.val([...billIds]))));
    if (filter.unresolved) query = query.where('o.resolution', 'is', null);
    if (filter.uuid !== undefined) query = query.where('o.uuid', '=', filter.uuid);
    if (filter.dueFrom !== undefined) query = query.where('o.due_date', '>=', sql<string>`${filter.dueFrom}::date`);
    if (filter.dueBefore !== undefined) query = query.where('o.due_date', '<', sql<string>`${filter.dueBefore}::date`);
    if (filter.dueThrough !== undefined) query = query.where('o.due_date', '<=', sql<string>`${filter.dueThrough}::date`);
    return query
      .orderBy('o.due_date')
      .orderBy('bi.name')
      .orderBy('o.id')
      // resolution is skipped, paid_manually or null (its CHECK).
      .$narrowType<{ resolution: OccurrenceRow['resolution'] }>()
      .execute();
  }

  /**
   * The occurrences `filter` names ({@link occurrenceRows}), with their payments, paid
   * totals and status on `today`.
   */
  private async loadOccurrences(filter: OccurrenceFilter, today: string): Promise<Occurrence[]> {
    const rows = await this.occurrenceRows(filter);
    if (rows.length === 0) return [];

    const links = await getDb()
      .selectFrom('bill_occurrence_transactions as l')
      .innerJoin('transactions as t', 't.id', 'l.transaction_id')
      .leftJoin('accounts as a', 'a.id', 't.account_id')
      .select(['l.bill_occurrence_id', 'l.matched_by', 't.uuid', 't.transaction_date as date', 't.amount', 't.description', 'a.name as account'])
      .where('l.tenant_id', '=', currentTenant)
      .where('l.matched_by', '<>', billPaymentMatch.enum.excluded)
      // One array parameter, however many due dates: = ANY($1), not IN ($1, $2, …).
      .where((eb) => eb('l.bill_occurrence_id', '=', eb.fn.any(eb.val(rows.map((row) => row.id)))))
      .orderBy('t.transaction_date')
      .orderBy('t.id')
      // matched_by is auto, manual or excluded (its CHECK), and excluded is left out above.
      .$narrowType<{ matched_by: 'auto' | 'manual' }>()
      .execute();

    const paymentsOf = new Map<number, BillPayment[]>();
    for (const link of links) {
      const list = paymentsOf.get(link.bill_occurrence_id) ?? [];
      list.push({
        transaction_uuid: link.uuid,
        date: link.date,
        // Money out is negative; a payment is the positive amount paid.
        amount: cents(-money(link.amount)),
        description: link.description,
        account: link.account,
        matched_by: link.matched_by,
      });
      paymentsOf.set(link.bill_occurrence_id, list);
    }

    return rows.map((row) => {
      const payments = paymentsOf.get(row.id) ?? [];
      const expected = cents(-money(row.expected_amount));
      const paid = row.resolution === billResolution.enum.paid_manually
        ? cents(-money(row.manual_paid_amount))
        : cents(payments.reduce((sum, payment) => sum + payment.amount, 0));
      const status = billStatus(row, expected, paid, today);
      const paidDate = status !== 'paid'
        ? null
        : row.resolution === billResolution.enum.paid_manually
          ? row.manual_paid_date
          : payments.at(-1)?.date ?? null;
      return {
        id: row.id,
        uuid: row.uuid,
        billId: row.budget_item_id,
        category: row.category,
        bill: { uuid: row.bill_uuid, name: row.bill_name, varies: row.bill_varies },
        due_date: row.due_date,
        expected,
        paid,
        status,
        paid_date: paidDate,
        resolution: row.resolution,
        note: row.note,
        payments,
      };
    });
  }

  /** The bills due in `month`, the month's totals, and bill payments no due date took. */
  async monthView(month: string, today: string): Promise<BillMonthView> {
    await this.sync(today);
    await this.ensureMonth(month, today);

    const first = `${month}-01`;
    const next = `${addMonths(month, 1)}-01`;
    const occurrences = await this.loadOccurrences({ dueFrom: first, dueBefore: next }, today);

    const unplaced = await getDb()
      .selectFrom('transactions as t')
      .innerJoin('budget_items as bi', (join) => join.onRef('bi.id', '=', 't.budget_item_id').on('bi.isbill', '=', true))
      .leftJoin('accounts as a', 'a.id', 't.account_id')
      .select([
        't.uuid',
        't.transaction_date as date',
        't.amount',
        't.description',
        'a.name as account',
        'bi.uuid as bill_uuid',
        'bi.name as bill_name',
        'bi.recurring_amount_varies as bill_varies',
      ])
      .where('t.tenant_id', '=', currentTenant)
      .where('t.transaction_date', '>=', first)
      .where('t.transaction_date', '<', next)
      .where('t.amount', '<', '0')
      .where('t.type', 'in', [transactionType.enum.expense, transactionType.enum.payment])
      .where((eb) => eb.not(eb.fn.coalesce('t.is_split_parent', sql.lit(false))))
      .where((eb) => eb.not(eb.exists(
        eb.selectFrom('bill_occurrence_transactions as l').select('l.id').whereRef('l.transaction_id', '=', 't.id'))))
      // Only since bills have been tracked (there's no back-fill): from the
      // first day of the earliest month with a due date.
      .where('t.transaction_date', '>=', (eb) => eb
        .selectFrom('bill_occurrences as o')
        .select(sql<string>`date_trunc('month', MIN(o.due_date))::date`.as('since'))
        .where('o.tenant_id', '=', currentTenant))
      .orderBy('t.transaction_date')
      .orderBy('t.id')
      .execute();

    const counted = occurrences.filter((occurrence) => occurrence.status !== 'skipped');
    const expected = cents(counted.reduce((sum, occurrence) => sum + occurrence.expected, 0));
    const paid = cents(counted.reduce((sum, occurrence) => sum + Math.min(occurrence.paid, occurrence.expected), 0));
    const remaining = cents(counted
      .filter((occurrence) => occurrence.status !== 'paid')
      .reduce((sum, occurrence) => sum + Math.max(0, occurrence.expected - occurrence.paid), 0));

    return {
      month,
      today,
      totals: { expected, paid, remaining },
      occurrences: occurrences.map(({ id: _id, billId: _billId, category: _category, ...occurrence }) => occurrence),
      unplaced: unplaced.map((row): UnplacedBillPayment => ({
        transaction_uuid: row.uuid,
        date: row.date,
        amount: cents(-money(row.amount)),
        description: row.description,
        account: row.account,
        bill: { uuid: row.bill_uuid, name: row.bill_name, varies: row.bill_varies },
      })),
    };
  }

  /**
   * Expected bill spending for `months` months from today's: each bill on each
   * of its due dates, at what was paid (paid months), nothing (skipped), or its
   * expected amount.
   */
  async forecast(months: number, today: string): Promise<BillForecastMonth[]> {
    await this.sync(today);
    const bills = await this.loadBills();
    const amounts = await this.forecastAmounts(bills, today);
    const start = today.slice(0, 7);
    const end = addMonths(start, months);
    const existing = await this.loadOccurrences({ dueFrom: `${start}-01`, dueBefore: `${end}-01` }, today);
    const byKey = new Map(existing.map((occurrence) => [`${occurrence.billId}:${occurrence.due_date}`, occurrence]));

    return Array.from({ length: months }, (_, index) => {
      const month = addMonths(start, index);
      const items = bills.flatMap((bill): BillForecastItem[] => {
        const due = dueDateIn(bill.anchor, bill.frequency, month);
        if (!due) return [];
        const occurrence = byKey.get(`${bill.id}:${due}`);
        const ref = { uuid: bill.uuid, name: bill.name, varies: bill.varies };
        if (occurrence?.status === 'skipped') return [{ bill: ref, due_date: due, amount: 0, basis: 'skipped' }];
        if (occurrence?.status === 'paid') return [{ bill: ref, due_date: due, amount: occurrence.paid, basis: 'paid' }];
        return [{ bill: ref, due_date: due, amount: occurrence?.expected ?? amounts.get(bill.id) ?? bill.amount, basis: 'expected' }];
      }).sort((a, b) => a.due_date.localeCompare(b.due_date));
      return { month, total: cents(items.reduce((sum, item) => sum + item.amount, 0)), items };
    });
  }

  private async occurrenceByUuid(uuid: string, today: string): Promise<Occurrence> {
    const [occurrence] = await this.loadOccurrences({ uuid }, today);
    if (!occurrence) throw new BillError('That bill payment wasn’t found.', 404);
    return occurrence;
  }

  private async transactionId(uuid: string): Promise<number> {
    const row = await getDb()
      .selectFrom('transactions')
      .select('id')
      .where('uuid', '=', uuid)
      .where('tenant_id', '=', currentTenant)
      .executeTakeFirst();
    if (!row) throw new BillError('That transaction wasn’t found.', 404);
    return row.id;
  }

  /** Link a transaction to a due date by hand; a transaction already paying another one moves. */
  private async linkManually(occurrenceId: number, transactionId: number, userId: number): Promise<void> {
    await getDb()
      .insertInto('bill_occurrence_transactions')
      .values({ bill_occurrence_id: occurrenceId, transaction_id: transactionId, matched_by: 'manual', created_by_user_id: userId })
      .onConflict((oc) => oc.constraint('bill_occurrence_transactions_transaction_key').doUpdateSet({
        bill_occurrence_id: occurrenceId,
        matched_by: 'manual',
        created_by_user_id: userId,
        created_at: sql<Date>`NOW()`,
      }))
      .execute();
  }

  async link(occurrenceUuid: string, transactionUuid: string, userId: number, today: string): Promise<BillOccurrence> {
    const occurrence = await this.occurrenceByUuid(occurrenceUuid, today);
    await this.linkManually(occurrence.id, await this.transactionId(transactionUuid), userId);
    logger.info({ userId, occurrence: occurrenceUuid, transaction: transactionUuid }, 'Linked a bill payment');
    return this.publicOccurrence(await this.occurrenceByUuid(occurrenceUuid, today));
  }

  /**
   * Unlink a payment. It's kept as `excluded` so automatic matching doesn't
   * link it again; linking it by hand later replaces that.
   */
  async unlink(occurrenceUuid: string, transactionUuid: string, userId: number, today: string): Promise<BillOccurrence> {
    const occurrence = await this.occurrenceByUuid(occurrenceUuid, today);
    const transactionId = await this.transactionId(transactionUuid);
    const result = await getDb()
      .updateTable('bill_occurrence_transactions')
      .set({ matched_by: 'excluded', created_by_user_id: userId })
      .where('bill_occurrence_id', '=', occurrence.id)
      .where('transaction_id', '=', transactionId)
      .where('matched_by', '<>', billPaymentMatch.enum.excluded)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) throw new BillError('That transaction doesn’t pay this bill.', 404);
    logger.info({ userId, occurrence: occurrenceUuid, transaction: transactionUuid }, 'Unlinked a bill payment');
    return this.publicOccurrence(await this.occurrenceByUuid(occurrenceUuid, today));
  }

  async resolve(occurrenceUuid: string, input: ResolveBillOccurrenceInput, userId: number, today: string): Promise<BillOccurrence> {
    const manual = input.resolution === billResolution.enum.paid_manually;
    // The amount as sent, in cents: 612.405 or "1e2" is refused, not rounded or read as 100.
    const paidCents = manual && input.paid_amount != null ? Number(requestCents(input.paid_amount, 'paid_amount')) : null;
    const occurrence = await this.occurrenceByUuid(occurrenceUuid, today);
    await getDb()
      .updateTable('bill_occurrences')
      .set({
        resolution: input.resolution,
        manual_paid_date: manual ? input.paid_date ?? null : null,
        // Money out, pre-signed like the transactions it stands in for.
        manual_paid_amount: paidCents != null ? centsToAmount(-Math.abs(paidCents)) : null,
        note: input.note?.trim() || null,
        updated_by_user_id: userId,
      })
      .where('id', '=', occurrence.id)
      .execute();
    logger.info({ userId, occurrence: occurrenceUuid, resolution: input.resolution }, 'Resolved a bill payment');
    return this.publicOccurrence(await this.occurrenceByUuid(occurrenceUuid, today));
  }

  private async billByUuid(uuid: string): Promise<Bill> {
    const bill = (await this.loadBills()).find((candidate) => candidate.uuid === uuid);
    if (!bill) throw new BillError('That bill wasn’t found, or has no due date and frequency set.', 404);
    return bill;
  }

  /**
   * The due dates a payment of `billUuid` could go on: earlier ones still open,
   * and the next 12 months of its schedule.
   */
  async dueDates(billUuid: string, today: string): Promise<BillDueDate[]> {
    const bill = await this.billByUuid(billUuid);
    const amounts = await this.forecastAmounts([bill], today);
    const start = today.slice(0, 7);
    const existing = await this.loadOccurrences({ billIds: [bill.id] }, today);
    const byDate = new Map(existing.map((occurrence) => [occurrence.due_date, occurrence]));

    const earlier = existing
      .filter((occurrence) => occurrence.due_date < `${start}-01` && occurrence.status !== 'paid' && occurrence.status !== 'skipped')
      .map((occurrence) => ({ due_date: occurrence.due_date, status: occurrence.status, expected: occurrence.expected }));
    const ahead = Array.from({ length: 12 }, (_, index) => dueDateIn(bill.anchor, bill.frequency, addMonths(start, index)))
      .filter((due): due is string => due !== null)
      .map((due) => {
        const occurrence = byDate.get(due);
        const expected = occurrence?.expected ?? amounts.get(bill.id) ?? bill.amount;
        return { due_date: due, status: occurrence?.status ?? billStatus({ due_date: due, resolution: null }, expected, 0, today), expected };
      });
    return [...earlier, ...ahead];
  }

  /** Place a transaction on one of a bill's due dates (made if it doesn't exist yet). */
  async place(billUuid: string, transactionUuid: string, dueDate: string, userId: number, today: string): Promise<BillOccurrence> {
    const bill = await this.billByUuid(billUuid);
    const onSchedule = dueDateIn(bill.anchor, bill.frequency, dueDate.slice(0, 7)) === dueDate;
    const existing = await getDb()
      .selectFrom('bill_occurrences')
      .select(['id', 'uuid'])
      .where('budget_item_id', '=', bill.id)
      .where('due_date', '=', sql<string>`${dueDate}::date`)
      .executeTakeFirst();
    if (!existing && !onSchedule) throw new BillError(`${bill.name} isn’t due on ${dueDate}.`, 400);

    let occurrence = existing;
    if (!occurrence) {
      const amounts = await this.forecastAmounts([bill], today);
      occurrence = await getDb()
        .insertInto('bill_occurrences')
        .values({ budget_item_id: bill.id, due_date: sql<string>`${dueDate}::date`, expected_amount: -(amounts.get(bill.id) ?? bill.amount) })
        .onConflict((oc) => oc.constraint('bill_occurrences_bill_due_key').doUpdateSet({ updated_at: sql<Date>`NOW()` }))
        .returning(['id', 'uuid'])
        .executeTakeFirstOrThrow();
    }
    await this.linkManually(occurrence.id, await this.transactionId(transactionUuid), userId);
    logger.info({ userId, bill: billUuid, dueDate, transaction: transactionUuid }, 'Placed a bill payment');
    return this.publicOccurrence(await this.occurrenceByUuid(occurrence.uuid, today));
  }

  /**
   * Transactions a person might link to a due date: with no `query`, money out
   * in the bill's own budget item from 120 days before the due date; with one,
   * any money out in the last 400 days whose description, merchant or budget
   * item has those words.
   */
  async candidates(occurrenceUuid: string, query: string | undefined, today: string): Promise<BillPaymentCandidate[]> {
    const occurrence = await this.occurrenceByUuid(occurrenceUuid, today);
    const words = query?.trim();
    const rows = await this.candidateRows(occurrence, words, today);
    return rows
      .filter((row) => !row.linked_here)
      .map((row) => ({
        transaction_uuid: row.uuid,
        date: row.date,
        amount: cents(-money(row.amount)),
        description: row.description,
        account: row.account,
        budget_item: row.budget_item,
        linked_due_date: row.linked_due_date,
      }));
  }

  /**
   * The newest 50 transactions {@link candidates} looks at for `occurrence`: money out, not
   * a split parent, by `words` (in the last 400 days) or else in the bill's own budget item
   * (from 120 days before the due date), each with the due date it is linked to, if any, and
   * whether that is `occurrence`.
   */
  private candidateRows(occurrence: Occurrence, words: string | undefined, today: string) {
    // The words' own %, _ and \ match themselves.
    const like = words ? containsPattern(words) : '';
    let query = getDb()
      .selectFrom('transactions as t')
      .leftJoin('accounts as a', 'a.id', 't.account_id')
      .leftJoin('merchants as m', 'm.id', 't.merchant_id')
      .leftJoin('budget_items as bi', 'bi.id', 't.budget_item_id')
      .leftJoin('bill_occurrence_transactions as l', 'l.transaction_id', 't.id')
      .leftJoin('bill_occurrences as lo', (join) => join.onRef('lo.id', '=', 'l.bill_occurrence_id').on('l.matched_by', '<>', 'excluded'))
      .select([
        't.uuid',
        dayText('t.transaction_date').as('date'),
        't.amount',
        't.description',
        'a.name as account',
        'bi.name as budget_item',
        dayText<string | null>('lo.due_date').as('linked_due_date'),
        sql<boolean>`COALESCE(l.bill_occurrence_id = ${occurrence.id} AND l.matched_by <> 'excluded', false)`.as('linked_here'),
      ])
      .where('t.tenant_id', '=', currentTenant)
      .where('t.amount', '<', sql<string>`0`)
      .where(sql<boolean>`NOT COALESCE(t.is_split_parent, false)`);
    query = words
      ? query
          .where('t.transaction_date', '>=', sql<string>`${addDays(today, -400)}::date`)
          .where((eb) => eb.or([eb('t.description', 'ilike', like), eb('m.name', 'ilike', like), eb('bi.name', 'ilike', like)]))
      : query
          .where('t.budget_item_id', '=', occurrence.billId)
          .where('t.transaction_date', '>=', sql<string>`${addDays(occurrence.due_date, -120)}::date`);
    return query.orderBy('t.transaction_date', 'desc').orderBy('t.id', 'desc').limit(50).execute();
  }

  /**
   * What `bill` notification rules judge: due dates from 60 days back to a
   * month ahead (an overdue bill keeps its facts until it's paid or skipped).
   */
  async subjects(today: string, occurrenceUuid?: string): Promise<BillSubject[]> {
    await this.sync(today);
    const occurrences = await this.loadOccurrences(
      occurrenceUuid ? { uuid: occurrenceUuid } : { dueFrom: addDays(today, -60), dueThrough: addDays(today, 31) },
      today,
    );
    return occurrences.map((occurrence) => ({
      occurrence,
      facts: {
        name: occurrence.bill.name,
        category: occurrence.category,
        amount: occurrence.expected,
        paid: occurrence.status === 'paid',
        partly_paid: occurrence.status === 'partly_paid',
        skipped: occurrence.status === 'skipped',
        days_until_due: daysBetween(today, occurrence.due_date),
        varies: occurrence.bill.varies,
      },
    }));
  }

  private publicOccurrence({ id: _id, billId: _billId, category: _category, ...occurrence }: Occurrence): BillOccurrence {
    return occurrence;
  }
}
