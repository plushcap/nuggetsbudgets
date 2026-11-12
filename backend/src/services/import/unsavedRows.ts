/**
 * The rows of the bank's feed a sync couldn't save, as the rebalance leaves them out of its
 * comparison.
 *
 * The rebalance makes the ledger's balance without its pending rows equal the bank's
 * (posted) balance. A row the import couldn't save (a posted time in milliseconds, an amount
 * numeric(12,2) can't hold) is in the bank's balance when it has posted, and not in the
 * ledger's: compared as they were, the adjustment booked its amount, and the sync that later
 * saved the row counted it a second time. Not comparing at all while a row failed (the first
 * fix) left an account whose row fails on every sync never rebalanced, its other drift never
 * corrected.
 *
 * So each unsaved row is left out on both sides: its amount out of the bank's balance when
 * the bank counts it (a posted row; SimpleFin's balance leaves out what is still pending, as
 * the comparison leaves out the ledger's pending rows), and out of the ledger's whatever of
 * the ledger stands for it: its own row from an earlier sync (matched by its SimpleFin id),
 * or the manual entry the import would link it to. The adjustment is then only the drift the
 * feed doesn't explain, and once the row is saved both balances count it.
 */
import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { datingSecond, importIdOf, parseImportAmount } from './importFields.js';
import { hasManualEntryOfAmount, manualEntriesNear } from './manualMatch.js';
import { PENDING_TO_POSTED_MAX_DAYS, type VanishedPending } from './pendingMatcher.js';
import { addDays } from '../../utils/calendarDate.js';
import type { SimplefinTransaction } from './types.js';
import { transactionStatus } from '@nuggets/shared';

/** What the rebalance leaves out for the rows a sync couldn't save. */
export interface UnsavedRows {
  /** How many rows couldn't be saved. */
  count: number;
  /** The cents of those the bank's balance counts (the posted ones). */
  bankCents: number;
  /** The ledger's rows that stand for them; the comparison leaves out what it counts of each. */
  standInIds: number[];
  /**
   * What they change can't be told, so the balances aren't compared: a row's amount can't be
   * read; a row with no date has the amount of an unlinked manual entry dated near the feed's
   * days (it may be that entry, or another transaction); or the entry a row would be linked to
   * is dated after today (the balance counts it from then).
   */
  undecidable: boolean;
}

export const NO_UNSAVED_ROWS: UnsavedRows = { count: 0, bankCents: 0, standInIds: [], undecidable: false };

/** An unsaved row, as far as it can be read. */
interface Unsaved {
  importId: string | null;
  amount: { text: string; cents: number } | null;
  pending: boolean;
  day: string | null;
}

function read(tx: SimplefinTransaction, dayOf: Map<number, string>): Unsaved {
  let importId: string | null = null;
  try {
    importId = importIdOf(tx.id);
  } catch {
    // No id: nothing in the ledger has it.
  }
  let amount: Unsaved['amount'] = null;
  try {
    const parsed = parseImportAmount(tx.amount);
    if (Number.isSafeInteger(parsed.cents)) amount = parsed;
  } catch {
    // Not a number: what the bank counts of it can't be told.
  }
  const second = datingSecond(tx);
  // As the import reads it (`tx.pending || false`).
  return { importId, amount, pending: Boolean(tx.pending), day: (second === null ? undefined : dayOf.get(second)) ?? null };
}

/**
 * What the rebalance leaves out for `failed`, the account's rows the import couldn't save,
 * after it saved the others: the import's own matching, in its order (a row's own row by
 * SimpleFin id, else the pending row it replaces, which the comparison leaves out already,
 * else the nearest manual entry of its amount within the import's window, unless that one is
 * reconciled or an earlier unsaved row took it).
 */
export async function unsavedRows(
  accountId: number,
  failed: SimplefinTransaction[],
  dayOf: Map<number, string>,
  replacements: Map<string, VanishedPending>,
  feedStart: string | null = null,
): Promise<UnsavedRows> {
  if (failed.length === 0) return NO_UNSAVED_ROWS;
  const undecidable: UnsavedRows = { count: failed.length, bankCents: 0, standInIds: [], undecidable: true };
  const rows = failed.map((tx) => read(tx, dayOf));
  const readable: Array<Unsaved & { amount: { text: string; cents: number } }> = [];
  for (const row of rows) {
    if (row.amount === null) return undecidable;
    readable.push({ ...row, amount: row.amount });
  }

  const bankCents = readable.reduce((sum, row) => (row.pending ? sum : sum + row.amount.cents), 0);
  if (!Number.isSafeInteger(bankCents)) return undecidable;
  const standInIds = new Set<number>();

  // Its own row, from an earlier sync (the import would update it).
  const importIds = [...new Set(readable.flatMap((row) => (row.importId === null ? [] : [row.importId])))];
  const own = importIds.length === 0
    ? []
    : await getDb()
        .selectFrom('transactions')
        .select(['id', 'import_transaction_id'])
        .where('account_id', '=', accountId)
        .where('parent_transaction_id', 'is', null)
        .where(sql<boolean>`import_transaction_id = ANY(${importIds}::text[])`)
        .execute();
  for (const row of own) standInIds.add(row.id);
  const saved = new Set(own.map((row) => row.import_transaction_id));
  const unmatched = readable.filter(
    (row) => row.importId === null || (!saved.has(row.importId) && !replacements.has(row.importId))
  );

  // A manual entry it would be linked to. Without a date that can't be told when an entry of its
  // amount is near any day it could have; one far from them (entered by hand long before) isn't.
  // The days it could have run from the feed's first day to today:
  //  - asked from a start-date (import_days_back), SimpleFin answers with what posted from then
  //    on, and a row is dated when it was transacted, at most PENDING_TO_POSTED_MAX_DAYS earlier:
  //    the first day is that much before the start. The feed's earliest dated row could be days
  //    after it, and a row dated before that row, linked later to an entry from before it, booked
  //    the entry's amount and then its reversal;
  //  - asked for all history, the first day is the feed's earliest dated row's: the bank's
  //    oldest row it has a date for. Any day instead would stall the rebalance for good as soon
  //    as the member entered an old row by hand, which is worse than the rare row older than
  //    every dated one;
  //  - with neither, any day.
  const days = [...dayOf.values()].sort();
  const floor = feedStart === null ? null : addDays(feedStart, -PENDING_TO_POSTED_MAX_DAYS);
  const earliest = days[0];
  const first = floor !== null && (earliest === undefined || floor < earliest) ? floor : earliest;
  const span = first === undefined ? null : { first, last: days[days.length - 1] ?? first };
  if (await hasManualEntryOfAmount(accountId, unmatched.filter((row) => row.day === null).map((row) => row.amount.text), span)) {
    return undecidable;
  }
  const dated = unmatched.flatMap((row) => (row.day === null ? [] : [{ amount: row.amount.text, day: row.day }]));
  const near = new Map<number, Array<{ id: number; status: string | null; future: boolean }>>();
  for (const entry of await manualEntriesNear(accountId, dated)) {
    const entries = near.get(entry.i) ?? [];
    entries.push(entry);
    near.set(entry.i, entries);
  }
  const taken = new Set<number>();
  for (let i = 0; i < dated.length; i++) {
    // The import links the nearest entry, unless it's reconciled; an entry links once.
    const nearest = near.get(i)?.find((entry) => !taken.has(entry.id));
    if (nearest && nearest.status !== transactionStatus.enum.reconciled) {
      // Dated after today, the balance counts it only from its day, while the bank's counts
      // the row: left out today and counted, linked, tomorrow, it booked an adjustment and
      // then its reversal. Linked or not, it is the import's pick, so it can't be passed over.
      if (nearest.future) return undecidable;
      taken.add(nearest.id);
      standInIds.add(nearest.id);
    }
  }

  return { count: failed.length, bankCents, standInIds: [...standInIds], undecidable: false };
}
