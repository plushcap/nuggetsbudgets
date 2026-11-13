/** A manually entered transaction an imported one should be linked to, rather than added beside. */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { rowErrorFields } from '../../utils/logSafeErrors.js';
import type { Savepoint } from './BudgetPeriodResolver.js';
import { transactionStatus, transactionType } from '@nuggets/shared';

const logger = createLogger({ service: 'ImportService' });

export interface ManualMatch {
  id: number;
  description: string;
  transaction_date: string;
  is_manual_entry: boolean;
  status: string;
}

/**
 * How many days before an import's date a manual entry it's linked to may be dated: a week, as
 * a transfer entered the day it is sent can post five business days later, over a weekend.
 */
const DAYS_BEFORE = 7;
/**
 * How many days after it: fewer, as the bank posts after a member enters, not before. A week
 * would take next week's payment of the same amount, entered early, for this week's bank row.
 */
const DAYS_AFTER = 4;

/**
 * A manually entered transaction, which an import may be linked to: not an import, with no
 * SimpleFin id, and never the account's opening balance (a bank transaction isn't one). Nor
 * a split's part (its parent carries the money: a bank row linked to a part drops out of the
 * balance), nor a side of a move between budget periods (two rows of the same account, linked
 * to each other: bookkeeping, never at the bank).
 */
function isManualEntry(table: string): RawBuilder<SqlBool> {
  const column = (name: string) => sql.ref(`${table}.${name}`);
  return sql<SqlBool>`
    (${column('is_import')} = false OR ${column('is_import')} IS NULL)
    AND ${column('import_transaction_id')} IS NULL
    AND ${column('type')} IS DISTINCT FROM ${sql.lit(transactionType.enum['starting balance'])}
    AND ${column('parent_transaction_id')} IS NULL
    -- A scalar subquery, not NOT EXISTS: as an anti-join, the planner put the feed inside a
    -- nested loop when the table's statistics lagged a bulk load (29 s on 100,000 rows).
    AND (SELECT pair.account_id FROM transactions pair WHERE pair.id = ${column('transfer_transaction_id')})
        IS DISTINCT FROM ${column('account_id')}`;
}

/**
 * The days a manual entry may be dated in, for an import dated from `first` to `last`: from
 * DAYS_BEFORE before to DAYS_AFTER after. A balance adjustment only DAYS_AFTER before: the
 * sync dates one the day it runs, so an unrelated bank row a week later of the same amount
 * would take it over, and the next rebalance book it again.
 */
function withinWindow(table: string, first: RawBuilder<unknown>, last: RawBuilder<unknown>): RawBuilder<SqlBool> {
  const column = (name: string) => sql.ref(`${table}.${name}`);
  return sql<SqlBool>`
    ${column('transaction_date')} BETWEEN ${first} - ${DAYS_BEFORE}::int AND ${last} + ${DAYS_AFTER}::int
    AND (${column('type')} IS DISTINCT FROM ${sql.lit(transactionType.enum['balance adjustment'])}
         OR ${column('transaction_date')} >= ${first} - ${DAYS_AFTER}::int)`;
}

/**
 * Every row of the account that findManualTransactionMatch can link one of these imports
 * to: a manual entry of the same amount, dated within the window of its day. A sync locks
 * them, with the rest of what it writes, before it writes anything. It may lock a
 * few it then leaves alone (an import already in the ledger, which is updated instead),
 * which is harmless: rows are locked in id order.
 *
 * The candidates' ids, from one join of the feed to the ledger's manual entries, worked out
 * once (an InitPlan) and then locked by primary key: a correlated EXISTS over the feed ran
 * once for every row of the account (10 s for a 3,000-transaction feed on an account with
 * 100,000 rows, toward the statement timeout; 40 ms this way).
 */
export function manualMatchCandidates(accountId: number, imports: Array<{ amount: string; day: string }>): RawBuilder<SqlBool> {
  return sql<SqlBool>`
    id = ANY(ARRAY(
      SELECT t.id
        FROM unnest(${imports.map((i) => i.amount)}::numeric[], ${imports.map((i) => i.day)}::date[]) AS feed(amount, day)
        JOIN transactions t
          ON t.account_id = ${accountId}
         AND ${withinWindow('t', sql`feed.day`, sql`feed.day`)}
         AND t.amount = feed.amount
       WHERE ${isManualEntry('t')}))`;
}

/**
 * Every manual entry each of `imports` could be linked to (findManualTransactionMatch's
 * criteria and order), nearest its day first, as `i` (the import's index), the entry's id and
 * status, and whether it is dated after today (the balance doesn't count it yet). The
 * rebalance uses it to tell which of a sync's unsaved rows the ledger already has as a manual
 * entry (unsavedRows.ts).
 */
export async function manualEntriesNear(
  accountId: number,
  imports: Array<{ amount: string; day: string }>,
): Promise<Array<{ i: number; id: number; status: string | null; future: boolean }>> {
  if (imports.length === 0) return [];
  const result = await sql<{ i: string; id: number; status: string | null; future: boolean }>`
    SELECT feed.i, t.id, t.status, t.transaction_date > app_today() AS future
      FROM unnest(${imports.map((i) => i.amount)}::numeric[], ${imports.map((i) => i.day)}::date[])
             WITH ORDINALITY AS feed(amount, day, i)
      JOIN transactions t
        ON t.account_id = ${accountId}
       AND ${withinWindow('t', sql`feed.day`, sql`feed.day`)}
       AND t.amount = feed.amount
     WHERE ${isManualEntry('t')}
     ORDER BY feed.i, ABS(t.transaction_date - feed.day), t.id
  `.execute(getDb());
  // ORDINALITY counts from 1 (a bigint, which pg reads as text).
  return result.rows.map((row) => ({ i: Number(row.i) - 1, id: row.id, status: row.status, future: row.future }));
}

/**
 * Whether the account has a manual entry an import of one of these amounts, of a day it
 * doesn't know, could be linked to: one of that amount, not reconciled (an import whose
 * nearest entry is reconciled is added beside it), dated within the import's window of a day
 * in `span`, from its first day to its last or today, whichever is later (an import is never
 * dated after today). Without a span, on any day.
 */
export async function hasManualEntryOfAmount(
  accountId: number,
  amounts: string[],
  span: { first: string; last: string } | null,
): Promise<boolean> {
  if (amounts.length === 0) return false;
  const within = span
    ? sql`AND ${withinWindow('t', sql`${span.first}::date`, sql`GREATEST(${span.last}::date, app_today())`)}`
    : sql``;
  const result = await sql<{ found: boolean }>`
    SELECT EXISTS (
      SELECT 1 FROM transactions t
       WHERE t.account_id = ${accountId}
         AND t.amount = ANY(${amounts}::numeric[])
         AND t.status IS DISTINCT FROM ${sql.lit(transactionStatus.enum.reconciled)}
         ${within}
         AND ${isManualEntry('t')}) AS found
  `.execute(getDb());
  return result.rows[0]?.found === true;
}

/**
 * The manually entered transaction an imported one should be linked to: of the exact same
 * amount, a manual entry (isManualEntry), dated from 7 days before `day` (the import's
 * calendar date, 'YYYY-MM-DD') to 4 after (DAYS_BEFORE, DAYS_AFTER), the nearest first.
 */
export async function findManualTransactionMatch(
  accountId: number,
  amount: string,
  day: string,
  savepoint: Savepoint
): Promise<ManualMatch | null> {
  try {
    return await savepoint(async () => {
      // Look for transactions in the same account with exact amount match and within date range
      // Only consider non-import transactions (manually entered)
      // CASE projection + ORDER BY ABS(date arithmetic) — kept as raw sql
      const result = await sql<ManualMatch>`
        SELECT id, description, transaction_date, status,
               CASE WHEN is_import = false OR is_import IS NULL THEN true ELSE false END as is_manual_entry
        FROM transactions
        WHERE account_id = ${accountId}
          AND amount = ${amount}
          -- The window in SQL, as manualMatchCandidates and manualEntriesNear have it: worked
          -- out in JavaScript, the window past a day near 9999-12-31 was "+010000-…", which Postgres
          -- refused, and the catch answered "no match" for an entry the sync had locked for it.
          AND ${withinWindow('transactions', sql`${day}::date`, sql`${day}::date`)}
          AND ${isManualEntry('transactions')}
        -- id last, so of two as near the same one is linked every time, the one
        -- manualEntriesNear names.
        ORDER BY ABS(transaction_date - ${day}::date) ASC, id
        LIMIT 1
      `.execute(getDb());

      const match = result.rows[0];
      if (match) {
        logger.debug({ accountId, matchId: match.id, transactionDate: match.transaction_date }, 'Found potential manual transaction match');
        return match;
      }
    
      return null;
    });
  } catch (error) {
    logger.error({ ...rowErrorFields(error), accountId }, 'Error finding manual transaction match');
    return null;
  }
}
