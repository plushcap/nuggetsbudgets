import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import type { Facts } from './conditions.js';
import { daysBetween } from './schedule.js';
import { budgetExpenseType, budgetItemFactKind, budgetItemStatus, transactionReviewStatus, transactionType } from '@nuggets/shared';

/**
 * Loading what notification rules judge: each subject's facts (as listed in
 * `notificationFacts` in @nuggets/shared) plus what its message needs.
 * Everything runs on getDb(), inside the tenant's transaction.
 */

// Every query here also runs under RLS; naming the tenant as well keeps a role
// that bypasses RLS (the CI database role is a superuser) from mixing tenants.
const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

/** pg returns NUMERIC as a string. */
function money(value: string | number | null): number {
  return value === null ? 0 : Number(value);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface BudgetItemSubject {
  /** budget_period_items.uuid — one alert per item per period. */
  periodItemUuid: string;
  itemUuid: string;
  name: string;
  periodName: string;
  facts: Facts;
}

/**
 * Every active budget item in each budget period that contains `today`, with
 * its figures from the event-sourced calculate_* functions.
 */
export async function loadBudgetItemSubjects(today: string): Promise<BudgetItemSubject[]> {
  // Set-returning, function-heavy: kept as raw sql.
  const { rows } = await sql<{
    period_item_uuid: string;
    item_uuid: string;
    name: string;
    category: string | null;
    expense_type: string | null;
    rollover: boolean | null;
    isbill: boolean | null;
    period_name: string;
    start_date: string;
    end_date: string;
    budgeted: string;
    actual: string;
    remaining: string;
  }>`
    SELECT bpi.uuid AS period_item_uuid,
           bi.uuid AS item_uuid,
           bi.name,
           c.name AS category,
           bi.expense_type,
           bi.rollover,
           bi.isbill,
           bp.name AS period_name,
           to_char(bp.start_date, 'YYYY-MM-DD') AS start_date,
           to_char(bp.end_date, 'YYYY-MM-DD') AS end_date,
           calculate_budget_for_period_item(bpi.id) AS budgeted,
           calculate_actual_for_period_item(bpi.id) AS actual,
           calculate_remaining_for_period_item(bpi.id) AS remaining
      FROM budget_period_items bpi
      JOIN budget_items bi ON bi.id = bpi.budget_item_id
      JOIN budget_period bp ON bp.id = bpi.budget_period_id
      LEFT JOIN categories c ON c.id = bi.category_id
     WHERE bpi.tenant_id = ${currentTenant}
       AND bp.start_date <= ${today}::date
       AND bp.end_date >= ${today}::date
       AND COALESCE(bi.status, ${sql.lit(budgetItemStatus.enum.active)}) = ${sql.lit(budgetItemStatus.enum.active)}
  `.execute(getDb());

  return rows.map((row) => {
    const income = row.expense_type === budgetExpenseType.enum.Income;
    const budgeted = money(row.budgeted);
    // Amounts are pre-signed: spending is negative, income positive.
    const actual = money(row.actual);
    const used = income ? actual : -actual;
    const remaining = money(row.remaining);
    const periodDays = daysBetween(row.start_date, row.end_date) + 1;
    return {
      periodItemUuid: row.period_item_uuid,
      itemUuid: row.item_uuid,
      name: row.name,
      periodName: row.period_name,
      facts: {
        name: row.name,
        category: row.category,
        kind: income ? budgetItemFactKind.enum.income : budgetItemFactKind.enum.expense,
        envelope: row.rollover === true,
        bill: row.isbill === true,
        budgeted,
        spent: income ? null : used,
        received: income ? used : null,
        remaining,
        percent_used: budgeted > 0 ? round1((used / budgeted) * 100) : null,
        over_budget: !income && remaining < 0,
        days_left: daysBetween(today, row.end_date),
        percent_of_period: round1(((daysBetween(row.start_date, today) + 1) / periodDays) * 100),
      },
    };
  });
}

export interface TransactionSubject {
  uuid: string;
  assignedTo: number | null;
  transactionDate: string;
  facts: Facts;
}

/**
 * Transactions added to Nuggets since `since` (not their transaction date:
 * a bank import of last month's purchases is news when it arrives), or the
 * one with `uuid`. Split parents are left out; their children carry the amounts.
 */
export async function loadTransactionSubjects(
  which: { since: Date } | { uuid: string },
  now: Date
): Promise<TransactionSubject[]> {
  let query = getDb()
    .selectFrom('transactions as t')
    .leftJoin('merchants as m', 'm.id', 't.merchant_id')
    .leftJoin('accounts as a', 'a.id', 't.account_id')
    .leftJoin('budget_items as bi', 'bi.id', 't.budget_item_id')
    .select([
      't.uuid',
      't.amount',
      't.type',
      't.description',
      't.review_status',
      't.is_import',
      't.import_pending',
      't.created_at',
      't.assigned_to',
      sql<string>`to_char(t.transaction_date, 'YYYY-MM-DD')`.as('transaction_date'),
      'm.name as merchant',
      'a.name as account',
      'bi.name as budget_item',
    ])
    .where('t.tenant_id', '=', currentTenant)
    .where('t.is_split_parent', '=', false);
  query = 'uuid' in which ? query.where('t.uuid', '=', which.uuid) : query.where('t.created_at', '>=', which.since);
  const rows = await query.execute();

  return rows.map((row) => {
    const amount = money(row.amount);
    const addedAt = row.created_at ? new Date(row.created_at) : now;
    return {
      uuid: row.uuid,
      assignedTo: row.assigned_to,
      transactionDate: row.transaction_date,
      facts: {
        amount,
        size: Math.abs(amount),
        direction: amount >= 0 ? 'in' : 'out',
        type: row.type,
        description: row.description,
        merchant: row.merchant,
        account: row.account,
        budget_item: row.budget_item,
        has_budget_item: row.budget_item !== null,
        review_status: row.review_status,
        from_bank_sync: row.is_import === true,
        pending: row.import_pending === true,
        days_since_added: Math.floor((now.getTime() - addedAt.getTime()) / 86_400_000),
      },
    };
  });
}

/**
 * The review backlog of each of `userIds`: transactions assigned to them that
 * need review (top-level only, as the Tasks page counts them). A person with
 * none gets a count of 0.
 */
export async function loadReviewFacts(userIds: number[], today: string): Promise<Map<number, Facts>> {
  const byUser = new Map<number, Facts>(
    userIds.map((id) => [id, { unreviewed_count: 0, unreviewed_total: 0, oldest_unreviewed_days: null }])
  );
  if (userIds.length === 0) return byUser;

  const rows = await getDb()
    .selectFrom('transactions')
    .select((eb) => [
      'assigned_to',
      eb.fn.countAll().as('count'),
      sql<string>`COALESCE(SUM(ABS(amount)), 0)`.as('total'),
      sql<string | null>`to_char(MIN(transaction_date), 'YYYY-MM-DD')`.as('oldest'),
    ])
    .where('tenant_id', '=', currentTenant)
    .where('review_status', '=', transactionReviewStatus.enum['needs review'])
    .where('parent_transaction_id', 'is', null)
    .where('assigned_to', 'in', userIds)
    .groupBy('assigned_to')
    .execute();

  for (const row of rows) {
    if (row.assigned_to === null) continue;
    byUser.set(row.assigned_to, {
      unreviewed_count: Number(row.count),
      unreviewed_total: money(row.total),
      oldest_unreviewed_days: row.oldest ? daysBetween(row.oldest, today) : null,
    });
  }
  return byUser;
}

export interface WeekSummary {
  moneyIn: number;
  moneyOut: number;
  overBudget: string[];
  toReview: number;
}

/**
 * What the weekly digest reports for the seven days ending `lastDay`: income
 * and spending by transaction date, budget items over budget today, and how
 * many transactions need review.
 */
export async function loadWeekSummary(lastDay: string, today: string): Promise<WeekSummary> {
  const firstDay = sql<string>`(${lastDay}::date - 6)`;
  const flows = await getDb()
    .selectFrom('transactions')
    .select([
      sql<string>`COALESCE(SUM(amount) FILTER (WHERE type = ${sql.lit(transactionType.enum.income)} AND amount > 0), 0)`.as('money_in'),
      sql<string>`COALESCE(-SUM(amount) FILTER (WHERE type = ${sql.lit(transactionType.enum.expense)} AND amount < 0), 0)`.as('money_out'),
    ])
    .where('tenant_id', '=', currentTenant)
    .where('is_split_parent', '=', false)
    .where(sql<boolean>`transaction_date BETWEEN ${firstDay} AND ${lastDay}::date`)
    .executeTakeFirstOrThrow();

  const toReview = await getDb()
    .selectFrom('transactions')
    .select((eb) => eb.fn.countAll().as('count'))
    .where('tenant_id', '=', currentTenant)
    .where('review_status', '=', transactionReviewStatus.enum['needs review'])
    .where('parent_transaction_id', 'is', null)
    .executeTakeFirstOrThrow();

  const items = await loadBudgetItemSubjects(today);
  return {
    moneyIn: money(flows.money_in),
    moneyOut: money(flows.money_out),
    overBudget: items.filter((item) => item.facts.over_budget === true).map((item) => item.name),
    toReview: Number(toReview.count),
  };
}
