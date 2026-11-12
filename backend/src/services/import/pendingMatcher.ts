/**
 * Matching a posted transaction to the pending row it replaces when the bank gave it a
 * new id, and finding the pending rows that left the feed with nothing to replace
 * them, so they can be flagged for review.
 */
import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { appDatesOf } from '../../utils/appDate.js';
import { createLogger } from '../../utils/logger.js';
import { datingSecond, importIdOf, parseImportAmount } from './importFields.js';
import type { SimplefinTransaction } from './types.js';
import { present } from '../../utils/present.js';

const logger = createLogger({ service: 'ImportService' });

/**
 * Matching a posted transaction to the pending row it replaces when the bank gave it a
 * new id: the pending row's date may be up to this many days before the posted date
 * (a restaurant tip or a hotel hold settles within days), or one day after it.
 */
export const PENDING_TO_POSTED_MAX_DAYS = 5;
/**
 * …the merchant text must be the same, and its amount may differ by up to this share of
 * the pending amount (a tip on a meal: 50.00 → 61.25 is 22.5%).
 */
export const PENDING_TO_POSTED_TOLERANCE = 0.25;

/**
 * import_extra key set on a pending row when its id left SimpleFin's answer with no
 * posted transaction matched to it, and the row was flagged for review: it is flagged
 * once, not again on every sync. Cleared with the rest of import_extra if the bank lists
 * the row again or a posted transaction replaces it.
 */
export const LEFT_FEED_KEY = 'nuggets_left_bank_feed_at';

/** An imported pending row of the account whose id is no longer in SimpleFin's answer. */
export interface VanishedPending {
  id: number;
  importTransactionId: string;
  cents: number;
  date: string;
  payee: string | null;
  description: string | null;
  /** An earlier sync already flagged it for review (LEFT_FEED_KEY). */
  flaggedBefore: boolean;
}

/** Merchant text for comparing a pending row with a posted transaction: lower case, letters and digits only. */
function merchantText(payee: string | null | undefined, description: string | null | undefined, preferPayee: boolean): string {
  const text = (preferPayee ? payee : description) ?? '';
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Days from calendar date `a` to `b` (YYYY-MM-DD). */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Could posted transaction `tx` (`cents`, dated `date`) be `pending` posting under a new
 * id? The rules are planPendingReplacements'; this checks one pair.
 */
export function pendingFitsPosted(pending: VanishedPending, tx: SimplefinTransaction, cents: number, date: string): boolean {
  const days = daysBetween(pending.date, date);
  if (!Number.isFinite(days) || days < -1 || days > PENDING_TO_POSTED_MAX_DAYS) return false;
  // Always the same merchant, even for the same amount to the cent: a vanished Sample Eats
  // authorization and an Example Fuel charge of the same amount are two purchases, and a wrong
  // merge (the fuel charge saved as the Sample Eats row, in its budget) is worse than a
  // duplicate. Compare payees when both sides have one (a cleaner signal), else descriptions.
  const byPayee = Boolean(pending.payee?.trim() && tx.payee?.trim());
  const pendingText = merchantText(pending.payee, pending.description, byPayee);
  if (pendingText === '' || pendingText !== merchantText(tx.payee, tx.description, byPayee)) return false;
  if (cents === pending.cents) return true;
  if (cents === 0 || pending.cents === 0 || Math.sign(cents) !== Math.sign(pending.cents)) return false;
  return Math.abs(cents - pending.cents) <= Math.abs(pending.cents) * PENDING_TO_POSTED_TOLERANCE;
}

/**
 * Each transaction's day in the application time zone, keyed by its datingSecond, in
 * one query. A transaction without one has no day, and is skipped on its own.
 */
export async function importDays(transactions: SimplefinTransaction[], timeZone: string): Promise<Map<number, string>> {
  const timestamps = [...new Set(transactions.map(datingSecond))].filter((second): second is number => second !== null);
  const days = await appDatesOf(timestamps.map((timestamp) => new Date(timestamp * 1000)), timeZone);
  return new Map(timestamps.map((timestamp, i) => [timestamp, present(days[i], 'a day for each instant')]));
}

/**
 * The account's pending rows that the bank replaced with a posted transaction under a
 * new id (many banks do), keyed by that transaction's id. Otherwise the posted
 * transaction is inserted beside its pending row and the purchase counts twice.
 *
 * A posted transaction with no row of its own replaces a pending row when:
 *  - the pending row's SimpleFin id is no longer in the answer (one still there is
 *    still pending, so it's another purchase), and the row isn't reconciled;
 *  - the pending date is at most PENDING_TO_POSTED_MAX_DAYS before the posted date
 *    (or one day after);
 *  - the merchant text is the same (payees when both have one, else descriptions),
 *    whatever the amounts;
 *  - the bank's pending amount (import_amount, not one a member typed) has the same
 *    sign and is equal to the cent or within PENDING_TO_POSTED_TOLERANCE (a tip);
 *  - and the pair is unambiguous: the posted transaction fits exactly one pending row,
 *    and that row fits no other posted transaction.
 * Anything less certain is left alone: a duplicate a member can delete is better than
 * one purchase silently written over another. The pending rows nothing replaces are
 * flagged for review, so the duplicate doesn't go unseen.
 *
 * Also returns every pending row that left the answer, dated no more than
 * PENDING_TO_POSTED_MAX_DAYS before its oldest transaction (the answer covers a window
 * of days, so older ones aren't expected in it), so that the ones nothing replaced
 * can be flagged.
 */
export async function planPendingReplacements(
  accountId: number,
  transactions: SimplefinTransaction[],
  dayOf: Map<number, string>,
  timeZone: string,
): Promise<{
  replacements: Map<string, VanishedPending>;
  gone: VanishedPending[];
}> {
  const replacements = new Map<string, VanishedPending>();
  // Transactions without an id are refused when they're imported; they match nothing.
  const withIds = transactions.flatMap((tx) => {
    try {
      return [{ tx, id: importIdOf(tx.id) }];
    } catch {
      return [];
    }
  });
  const dated = withIds.flatMap(({ tx, id }) => {
    const second = datingSecond(tx);
    const date = second === null ? undefined : dayOf.get(second);
    return date ? [{ tx, id, date }] : [];
  });
  const [firstDated] = dated;
  if (!firstDated) return { replacements, gone: [] };
  const oldest = dated.reduce((min, d) => (d.date < min ? d.date : min), firstDated.date);
  const answerIds = withIds.map(({ id }) => id);

  // The bank's dates and amounts, not ones a member may have changed. The date is the
  // day in the application time zone, as the posted side's is.
  const pendingRows = await sql<{
    id: number;
    import_transaction_id: string;
    bank_amount: string | null;
    bank_date: string;
    import_payee: string | null;
    import_description: string | null;
    flagged_before: boolean;
  }>`
    SELECT id, import_transaction_id,
           COALESCE(import_amount, amount)::text AS bank_amount,
           COALESCE((import_transacted_at AT TIME ZONE ${timeZone})::date, transaction_date)::text AS bank_date,
           import_payee, import_description,
           COALESCE(jsonb_typeof(import_extra) = 'object' AND import_extra ? ${LEFT_FEED_KEY}, false) AS flagged_before
      FROM transactions
     WHERE account_id = ${accountId}
       AND parent_transaction_id IS NULL
       AND import_transaction_id IS NOT NULL
       AND import_pending = true
       AND status IS DISTINCT FROM 'reconciled'
       AND import_transaction_id <> ALL(${answerIds}::text[])
       AND transaction_date >= ${oldest}::date - ${PENDING_TO_POSTED_MAX_DAYS}::int
     ORDER BY id
  `.execute(getDb());
  const gone: VanishedPending[] = pendingRows.rows.flatMap((row) =>
    row.bank_amount == null
      ? []
      : [{
          id: row.id,
          importTransactionId: row.import_transaction_id,
          cents: Math.round(Number(row.bank_amount) * 100),
          date: row.bank_date,
          payee: row.import_payee,
          description: row.import_description,
          flaggedBefore: row.flagged_before
        }]
  );
  const posted = dated.filter(({ tx }) => !tx.pending);
  if (gone.length === 0 || posted.length === 0) return { replacements, gone };

  // Posted transactions already saved under their own id replace nothing.
  const saved = new Set(
    (
      await getDb()
        .selectFrom('transactions')
        .select('import_transaction_id')
        .where('account_id', '=', accountId)
        .where('parent_transaction_id', 'is', null)
        .where('import_transaction_id', 'in', posted.map(({ id }) => id))
        .execute()
    ).map((row) => row.import_transaction_id)
  );

  const fits = new Map<string, VanishedPending[]>();
  const claimants = new Map<number, number>();
  for (const { tx, id, date } of posted) {
    if (saved.has(id) || fits.has(id)) continue;
    let cents: number;
    try {
      cents = parseImportAmount(tx.amount).cents;
    } catch {
      continue; // refused (and counted) when it's imported
    }
    const candidates = gone.filter((pending) => pendingFitsPosted(pending, tx, cents, date));
    fits.set(id, candidates);
    for (const pending of candidates) claimants.set(pending.id, (claimants.get(pending.id) ?? 0) + 1);
  }

  for (const [id, candidates] of fits) {
    const [only] = candidates;
    if (only && candidates.length === 1 && claimants.get(only.id) === 1) {
      replacements.set(id, only);
    } else if (candidates.length > 0) {
      logger.info({
        accountId,
        importTransactionId: id,
        pendingTransactionIds: candidates.map((c) => c.id)
      }, 'A posted transaction could replace more than one pending transaction, or another could replace the same one; importing it as new');
    }
  }
  return { replacements, gone };
}
