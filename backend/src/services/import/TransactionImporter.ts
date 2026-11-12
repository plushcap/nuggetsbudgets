/**
 * Writing one account's transactions from SimpleFin's answer, inside the account's
 * tenant transaction: matched to their rows by bank id, to a pending row they replace,
 * or to a manual entry, else inserted once ((account_id, import_transaction_id) is
 * unique). Each transaction runs in a savepoint of its own.
 */
import { sql, type RawBuilder, type SqlBool } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { appTimezone } from '../../utils/appDate.js';
import { calendarDateIn } from '../../utils/calendarDate.js';
import { createLogger } from '../../utils/logger.js';
import { rowErrorFields } from '../../utils/logSafeErrors.js';
import type { BudgetItemMatch, BudgetItemMatcher } from '../BudgetItemMatcher.js';
import type { BudgetPeriodResolver } from './BudgetPeriodResolver.js';
import type { MerchantMatcher } from './MerchantMatcher.js';
import { findManualTransactionMatch, manualEntriesNear, manualMatchCandidates } from './manualMatch.js';
import { importDays, LEFT_FEED_KEY, planPendingReplacements, type VanishedPending } from './pendingMatcher.js';
import { isLockConflict, isTransactionBusy, lockRowsForReference, lockTransactions } from '../transactions/locks.js';
import { ControlPlaneError } from '../controlPlaneErrors.js';
import { unsavedRows, type UnsavedRows } from './unsavedRows.js';
import {
  DESCRIPTION_MAX_CHARS,
  PAYEE_MAX_CHARS,
  datingSecond,
  importIdOf,
  parseImportAmount,
  truncateChars,
} from './importFields.js';
import type { SimplefinTransaction } from './types.js';
import { annotationSubjectType, assetType, transactionStatus, budgetItemStatus, budgetMatchingMethod, transactionReviewStatus, transactionType as transactionTypes } from '@nuggets/shared';

/** What a sync noticed along the way, for its summary log. */
export interface SyncStats {
  skippedInstitutions: Array<{ domain: string; orgName?: string }>;
  skippedUnlinkedAccounts: Array<{ id: string; name: string }>;
  accountsWithNoTransactions: Array<{ id: string; name: string }>;
  balanceHistoryConflicts: number;
  reconciledTransactionsSkipped: number;
}

/** What importing one account's transactions did. */
export interface ImportedTransactions {
  imported: number;
  updated: number;
  failed: number;
  pendingReplaced: number;
  pendingVanished: number;
  pendingFlagged: number;
  /** What the rebalance leaves out for the `failed` rows (unsavedRows.ts). */
  unsaved: UnsavedRows;
}

/**
 * The account's rows the import wrote that have no budget period, though their month's period
 * was made after anything last wrote them, each with that period's id: their
 * period couldn't be made then (a merge held its lock past the timeout, the month was too far
 * ahead, the ledger had no import user) and was made since, by something that takes in no
 * transactions (another sync, a period made with its month's transactions left out). Only a
 * later sync of the row itself gave it one, while the bank still sent it.
 *
 * A row taken out of a period (budget_period_cleared_from, which a trigger keeps) stays as
 * it is, whenever it was cleared, and whichever period that was (one moved to another
 * month's period and then taken out of it got its own month's back), unless that period is gone
 * (deleted, and its month's made again since): {@link notTakenOut}. Before, keyed on the
 * import's last write alone, the sweep put a cleared period back on every sync; then
 * keyed on updated_at, a transaction's start time, a clear by a request that began before the
 * period was made was undone by the next sync.
 * "Last wrote" is the later of import_imported_at and updated_at, which every UPDATE of a
 * transaction sets (update_transactions_updated_at), this one's included: a row a member edited
 * after its period was made stays as it is, and so does a row the import wrote after its period
 * was made and left without one (the account didn't assign periods then). So are a split (a sync
 * leaves a split's budget to its parts), a reconciled row, an opening balance and what a member
 * entered by hand.
 *
 * A row's period is its day's month's, as the import looks it up (findBudgetPeriodForDate). One
 * join of the account's rows without a period to the periods, worked out once: an EXISTS for
 * each row took 113 ms over 12,000 rows from before the first period, this 13 ms.
 */
/**
 * On a transaction row (`table`, or the row an UPDATE writes, `undefined`): a sync may give it the
 * period whose first day is `start`. Not when it was taken out of a period, unless
 * that period is gone and was this one's month's (deleted, and its month's period made again: the
 * row goes back in it). A row taken out of another month's period (a member moved it there, then
 * took it out) stays out of every one, that period deleted or not. A start unknown (the clear was
 * the period delete's own cascade, which can't read it) counts as its month's, as before.
 */
function notTakenOut(start: RawBuilder<unknown>, table?: string): RawBuilder<SqlBool> {
  const column = (name: string) => (table === undefined ? sql.ref(name) : sql.ref(`${table}.${name}`));
  const cleared = column('budget_period_cleared_from');
  const clearedStart = column('budget_period_cleared_start');
  return sql<SqlBool>`(${cleared} IS NULL
    OR (NOT EXISTS (SELECT 1 FROM budget_period gone WHERE gone.id = ${cleared})
        AND (${clearedStart} IS NULL OR ${clearedStart} = ${start})))`;
}

function periodsMadeSince(accountId: number): RawBuilder<{ id: number; budget_period_id: number }> {
  return sql<{ id: number; budget_period_id: number }>`
    SELECT t.id, bp.id AS budget_period_id
      FROM transactions t
      JOIN budget_period bp
        ON bp.year = EXTRACT(YEAR FROM t.transaction_date)::int
       AND bp.month_number = EXTRACT(MONTH FROM t.transaction_date)::int
       AND bp.created_at > GREATEST(t.import_imported_at, t.updated_at)
       AND ${notTakenOut(sql`bp.start_date`, 't')}
     WHERE t.account_id = ${accountId}
       AND t.parent_transaction_id IS NULL
       AND t.budget_period_id IS NULL
       AND t.import_transaction_id IS NOT NULL
       AND NOT t.is_split_parent
       AND t.type IS DISTINCT FROM ${sql.lit(transactionTypes.enum['starting balance'])}
       AND t.status IS DISTINCT FROM ${sql.lit(transactionStatus.enum.reconciled)}`;
}

/** The code of the 409 a lock of a budget item, merchant or rule answers when it was busy (lockRowsForReference). */
const RECORD_BUSY = 'RECORD_BUSY';

/**
 * How many times lockNamedReferences matches the rows it may add before what they name holds
 * still: the first match is locked, and is the match unless what it named changed while the locks
 * were waited for.
 */
const NAMED_REFERENCE_ROUNDS = 4;

/** What a row the sync may add is matched to, locked (lockNamedReferences). */
interface NamedReferences {
  /** Its merchant, or null for one the loop makes as it adds the row. */
  merchantId: number | null;
  /** Its budget item match, or null when the account doesn't assign items. */
  match: BudgetItemMatch | null;
}

export class TransactionImporter {
  private logger = createLogger({ service: 'ImportService' });

  constructor(
    private readonly periods: BudgetPeriodResolver,
    private readonly merchants: MerchantMatcher,
    private readonly budgetItemMatcher: BudgetItemMatcher,
  ) {}

  /**
   * Import one account's transactions from SimpleFin's answer. Each runs in its own
   * savepoint: one that can't be saved (an amount numeric(12,2) can't hold, say) is
   * logged, counted and skipped, and the rest of the account is saved.
   *
   * A transaction is matched, in this order, to:
   *  1. the account's row with its SimpleFin id: updated. Its amount follows the bank's
   *     (a pending meal that posts with the tip) unless a member changed it;
   *  2. a pending row the bank replaced with this posted transaction under a new id
   *     (planPendingReplacements): updated in place, so its uuid, budget, tags and
   *     splits stay;
   *  3. a manually entered transaction of the same amount within 4 days: linked;
   *  4. nothing: inserted. (account_id, import_transaction_id) is unique for top-level
   *     rows, so the insert can't add a second copy of a row saved meanwhile.
   */
  async importTransactions(
    accountId: number,
    transactions: SimplefinTransaction[],
    syncStats?: SyncStats,
    feedStart: Date | null = null,
  ): Promise<ImportedTransactions> {
    let imported = 0;
    let updated = 0;
    let failed = 0;
    const failedRows: SimplefinTransaction[] = [];
    const replacedPendingIds = new Set<number>();

    // Get account import settings for this account
    const accountSettings = await this.getAccountImportSettings(accountId);
    // An imported transaction's date and its budget period are both its day in
    // the application time zone, as Postgres reads the zone.
    const timeZone = await appTimezone();
    const dayOf = await importDays(transactions, timeZone);
    // The budget periods of the transactions' days, found or made before any transaction is
    // locked (BudgetPeriodResolver.preparePeriods): made after, a period waited
    // for a merge that was waiting for one of the transactions locked here. Each row's lookup
    // below only finds one.
    if (accountSettings.import_auto_assign_budget_period) await this.periods.preparePeriods(dayOf.values());
    // Without a plan, posted transactions are matched by id only, as before.
    let plan: Awaited<ReturnType<typeof planPendingReplacements>> = { replacements: new Map(), gone: [] };
    try {
      plan = await this.periods.savepoint(() => planPendingReplacements(accountId, transactions, dayOf, timeZone));
    } catch (error) {
      this.logger.error({ ...rowErrorFields(error), accountId }, 'Could not match posted transactions to pending ones; importing them by id only');
    }
    const { replacements, gone } = plan;

    // What the rows it adds will name, matched and locked before any transaction
    // (lockNamedReferences): each row is given that merchant and that budget item. Not locked (it
    // failed), each row's are found as it's written, as before.
    let named = new Map<string, NamedReferences>();
    try {
      named = await this.periods.savepoint(() => this.lockNamedReferences(accountId, transactions, dayOf, replacements, accountSettings));
    } catch (error) {
      // Held past the pool's lock_timeout, or a deadlock: the account's sync stops, as when its
      // transactions are busy (below), and the next one imports them.
      if (error instanceof ControlPlaneError && error.code === RECORD_BUSY) throw error;
      this.logger.error({ ...rowErrorFields(error), accountId }, 'Could not lock what the transactions this sync adds name; finding them one by one');
    }

    // The rows this sync can write, locked first, in id order, as every write of several
    // transactions locks them (services/transactions/locks.ts): updated one by one in
    // the bank's order, they deadlocked with Delete Transactions or a bulk edit, which lock
    // in id order. Without the lock (it failed), each row is locked as it's written, as before.
    const assignPeriods = accountSettings.import_auto_assign_budget_period;
    let locked = false;
    try {
      await this.periods.savepoint(() => this.lockRowsToWrite(accountId, transactions, dayOf, replacements, gone, assignPeriods));
      locked = true;
    } catch (error) {
      // Another write held some of them past the pool's lock_timeout (Delete Transactions, a
      // bulk edit), or deadlocked with this lock: writing them one by one would wait
      // that long again for each held row, in the bank's order, which is what deadlocked. The
      // account's sync stops instead, its transaction rolled back: the sync reports it failed,
      // with the reason, and the next one imports its transactions. Carrying on without them
      // would let the rebalance book what they move as a balance adjustment.
      if (isTransactionBusy(error)) throw error;
      this.logger.error({ ...rowErrorFields(error), accountId }, 'Could not lock the transactions this sync writes; writing them one by one');
    }

    // The account's imported rows whose period was made since a sync left them without one
    // (periodsMadeSince), locked above with the rest. Not without that lock: the next sync does it.
    if (locked && assignPeriods) {
      try {
        const assigned = await this.periods.savepoint(() => this.assignPeriodsMadeSince(accountId));
        if (assigned > 0) this.logger.info({ accountId, count: assigned }, 'Gave imported transactions the budget period made since they were imported');
      } catch (error) {
        this.logger.error({ ...rowErrorFields(error), accountId }, 'Could not give imported transactions the budget period made since they were imported');
      }
    }

    for (const tx of transactions) {
      try {
        await this.periods.savepoint(async () => {
          // Refused before anything is written: a transaction without an id would be added
          // again on every sync, and an amount that isn't a number used to import as 0.00.
          const importId = importIdOf(tx.id);
          const parsedAmount = parseImportAmount(tx.amount);
          const amount = parsedAmount.text;
          const amountValue = parsedAmount.cents / 100;
          const importDescription = typeof tx.description === 'string' ? tx.description : null;
          // The column holds 255 characters; import_description keeps the whole text.
          const description = importDescription === null ? null : truncateChars(importDescription, DESCRIPTION_MAX_CHARS);
          const payee = tx.payee?.trim() ? truncateChars(tx.payee.trim(), PAYEE_MAX_CHARS) : null;
          const memo = tx.memo?.trim() || null;
          const postedDate = new Date(tx.posted * 1000);
          const transactedAt = tx.transacted_at ? new Date(tx.transacted_at * 1000) : postedDate;

          // The transaction's calendar date: the day it happened in the application
          // time zone. Its budget period comes from the same day, so the two agree
          // (the UTC day put a 10:30 pm swipe in New York on the next day, but in
          // this month's period).
          const second = datingSecond(tx);
          const transactionDateString = second === null ? undefined : dayOf.get(second);
          if (!transactionDateString) throw new Error(`Transaction ${importId} has no valid date`);

          // Check if transaction already exists
          // CRITICAL: Only match parent transactions (not child splits)
          const existing = await getDb()
            .selectFrom('transactions')
            .select(['id', 'is_split_parent', 'budget_period_id', 'status', 'import_amount'])
            .where('import_transaction_id', '=', importId)
            .where('account_id', '=', accountId)
            .where('parent_transaction_id', 'is', null)
            .executeTakeFirst();

          if (existing) {
            // Skip updating reconciled transactions - they are locked
            if (existing.status === transactionStatus.enum.reconciled) {
              this.logger.debug({
                transactionId: existing.id,
                importTransactionId: tx.id
              }, 'Skipping update for reconciled transaction');

              // Track reconciled transaction skip
              if (syncStats) {
                syncStats.reconciledTransactionsSkipped++;
              }

              return; // on to the next transaction
            }

            let budgetPeriodId = existing.budget_period_id;

            // If no budget period assigned and auto-assignment is enabled, find the one preparePeriods
            // found or made (none is made here, with the account's transactions locked). The UPDATE
            // below gives it only to a row that wasn't taken out of it.
            if (!budgetPeriodId && accountSettings.import_auto_assign_budget_period) {
              try {
                await this.periods.savepoint(async () => {
                  budgetPeriodId = await this.periods.findBudgetPeriodForDate(transactionDateString);

                  if (!budgetPeriodId) {
                    this.logger.warn({
                      importTransactionId: tx.id,
                      transactionDate: transactionDateString
                    }, 'No budget period found for existing transaction');
                  }
                });
              } catch (error) {
                this.logger.error({
                  ...rowErrorFields(error),
                  importTransactionId: tx.id
                }, 'Error finding budget period for existing transaction');
              }
            } else if (!accountSettings.import_auto_assign_budget_period) {
              this.logger.debug({
                importTransactionId: tx.id
              }, 'Skipping budget period assignment - auto-assignment disabled for account');
            }

            // Update existing transaction (preserve user-editable fields, update import fields and budget period if not set)
            // Apply account settings only if not already set to preserve manual user changes
            // CRITICAL: For split parents, preserve the original amount and budget assignments
            const reviewStatus = accountSettings.import_auto_review ? transactionReviewStatus.enum.reviewed : transactionReviewStatus.enum['needs review'];
            const assignedTo = accountSettings.import_default_assigned_to;

            if (existing.is_split_parent) {
              // For split parents: only update import metadata, status, and non-budget fields
              // Do NOT update amount (children have the real amounts)
              const previousCents = existing.import_amount == null ? null : Math.round(Number(existing.import_amount) * 100);
              if (previousCents !== null && previousCents !== parsedAmount.cents) {
                this.logger.warn({
                  transactionId: existing.id,
                  importTransactionId: tx.id
                }, "The bank changed a split transaction's amount; its splits were left as they are");
              }
              // COALESCE/CASE expressions over existing column values — kept as raw sql
              await sql`
                UPDATE transactions SET
                  import_amount = ${amount},
                  import_description = ${importDescription},
                  import_payee = ${payee},
                  notes = COALESCE(NULLIF(notes, ''), ${memo}),
                  import_posted_date = ${postedDate},
                  import_transacted_at = ${transactedAt},
                  import_pending = ${tx.pending || false},
                  import_extra = ${JSON.stringify(tx.extra || {})},
                  import_imported_at = CURRENT_TIMESTAMP,
                  review_status = COALESCE(review_status, ${reviewStatus}),
                  assigned_to = COALESCE(assigned_to, ${assignedTo}),
                  status = CASE
                    WHEN ${tx.pending || false} = true THEN ${sql.lit(transactionStatus.enum.pending)}
                    ELSE ${sql.lit(transactionStatus.enum.cleared)}
                  END
                WHERE id = ${existing.id}
              `.execute(getDb());
            } else {
              // For regular transactions: update normally including budget period.
              // The bank's amount changes as a pending transaction posts (a tip, a fuel or
              // hotel hold): follow it, unless a member changed the amount, which then no
              // longer equals the bank's last amount (the right-hand import_amount is the
              // value before this UPDATE), or it is one side of a transfer, whose two
              // sides stay equal and opposite (import_amount keeps the bank's).
              // COALESCE/CASE expressions over existing column values — kept as raw sql
              await sql`
                UPDATE transactions SET
                  amount = CASE
                    WHEN transfer_transaction_id IS NOT NULL THEN amount
                    WHEN amount IS NOT DISTINCT FROM import_amount THEN ${amount}::numeric
                    ELSE amount
                  END,
                  import_amount = ${amount},
                  import_description = ${importDescription},
                  import_payee = ${payee},
                  notes = COALESCE(NULLIF(notes, ''), ${memo}),
                  import_posted_date = ${postedDate},
                  import_transacted_at = ${transactedAt},
                  import_pending = ${tx.pending || false},
                  import_extra = ${JSON.stringify(tx.extra || {})},
                  import_imported_at = CURRENT_TIMESTAMP,
                  -- Not to a row a member (or a period's delete) took out of a period still
                  -- there: that stays cleared, where COALESCE gave it back on every sync.
                  -- A row that never had one gets it.
                  budget_period_id = CASE
                    WHEN budget_period_id IS NULL AND ${notTakenOut(sql`(SELECT start_date FROM budget_period WHERE id = ${budgetPeriodId}::int)`)}
                      THEN ${budgetPeriodId}::int
                    ELSE budget_period_id
                  END,
                  review_status = COALESCE(review_status, ${reviewStatus}),
                  assigned_to = COALESCE(assigned_to, ${assignedTo}),
                  status = CASE
                    WHEN ${tx.pending || false} = true THEN ${sql.lit(transactionStatus.enum.pending)}
                    ELSE ${sql.lit(transactionStatus.enum.cleared)}
                  END
                WHERE id = ${existing.id}
              `.execute(getDb());
            }

            updated++;
            return;
          }

          // A pending row this posted transaction replaces under a new id: update it in
          // place. Its description, date, budget, tags and splits are the family's and stay;
          // its amount follows the bank's unless a member changed it (and never on a split
          // parent, whose splits carry the amounts, or a side of a transfer).
          const replaced = replacements.get(importId);
          if (replaced) {
            // COALESCE/CASE expressions over existing column values — kept as raw sql
            const result = await sql<{ id: number; is_split_parent: boolean }>`
              UPDATE transactions SET
                import_transaction_id = ${importId},
                amount = CASE
                  WHEN is_split_parent THEN amount
                  WHEN transfer_transaction_id IS NOT NULL THEN amount
                  WHEN amount IS NOT DISTINCT FROM import_amount THEN ${amount}::numeric
                  ELSE amount
                END,
                import_amount = ${amount},
                import_description = ${importDescription},
                import_payee = ${payee},
                notes = COALESCE(NULLIF(notes, ''), ${memo}),
                import_posted_date = ${postedDate},
                import_transacted_at = ${transactedAt},
                import_pending = false,
                import_extra = ${JSON.stringify(tx.extra || {})},
                import_imported_at = CURRENT_TIMESTAMP,
                status = ${sql.lit(transactionStatus.enum.cleared)}
              WHERE id = ${replaced.id}
                AND import_transaction_id = ${replaced.importTransactionId}
                AND import_pending = true
                AND status IS DISTINCT FROM ${sql.lit(transactionStatus.enum.reconciled)}
              RETURNING id, is_split_parent
            `.execute(getDb());
            const [replacedRow] = result.rows;
            if (replacedRow) {
              if (replacedRow.is_split_parent && replaced.cents !== parsedAmount.cents) {
                this.logger.warn({
                  transactionId: replaced.id,
                  importTransactionId: tx.id
                }, "A split transaction posted for another amount; its splits were left as they are");
              }
              this.logger.info({
                transactionId: replaced.id,
                pendingImportTransactionId: replaced.importTransactionId,
                importTransactionId: tx.id,
                amountChanged: parsedAmount.cents !== replaced.cents
              }, 'A pending transaction posted under a new id; updated it in place');
              replacedPendingIds.add(replaced.id);
              updated++;
              return;
            }
          }

          // Check for potential manual transaction match before creating new transaction
          const manualMatch = await findManualTransactionMatch(accountId, amount, transactionDateString, this.periods.savepoint);

          if (manualMatch && manualMatch.status !== transactionStatus.enum.reconciled) {
            // Update the manually entered transaction with import data (only if not reconciled)
            this.logger.info({
              importTransactionId: tx.id,
              manualTransactionId: manualMatch.id
            }, 'Linking imported transaction to existing manual transaction');

            // Apply account settings for review status and assignment to manual transaction links
            const reviewStatus = accountSettings.import_auto_review ? transactionReviewStatus.enum.reviewed : transactionReviewStatus.enum['needs review'];
            const assignedTo = accountSettings.import_default_assigned_to;

            // COALESCE/CASE expressions over existing column values — kept as raw sql
            await sql`
              UPDATE transactions SET
                import_transaction_id = ${importId},
                import_amount = ${amount},
                import_description = ${importDescription},
                import_payee = ${payee},
                notes = COALESCE(NULLIF(notes, ''), ${memo}),
                import_posted_date = ${postedDate},
                import_transacted_at = ${transactedAt},
                import_pending = ${tx.pending || false},
                import_extra = ${JSON.stringify(tx.extra || {})},
                import_imported_at = CURRENT_TIMESTAMP,
                is_import = true,
                import_provider = 'simplefin',
                status = CASE
                  WHEN ${tx.pending || false} = true THEN ${sql.lit(transactionStatus.enum.pending)}
                  ELSE ${sql.lit(transactionStatus.enum.cleared)}
                END,
                review_status = COALESCE(review_status, ${reviewStatus}),
                assigned_to = COALESCE(assigned_to, ${assignedTo})
              WHERE id = ${manualMatch.id}
            `.execute(getDb());

            updated++;
            this.logger.info({
              manualTransactionId: manualMatch.id,
              importTransactionId: tx.id
            }, 'Successfully linked manual transaction with imported transaction');
            return;
          }

          // Create new transaction - no manual match found OR manual match was reconciled
          if (manualMatch && manualMatch.status === transactionStatus.enum.reconciled) {
            this.logger.info({
              manualTransactionId: manualMatch.id,
              importTransactionId: tx.id
            }, 'Skipping link for reconciled manual transaction - creating separate transaction instead');
          }

          // Determine transaction type based on amount and account type
          // For liability accounts (credit cards), positive amounts are payments/credits (expense type)
          // and negative amounts are charges/purchases (also expense type)
          let transactionType: string;
          if (accountSettings.account_type === assetType.enum.Liability) {
            // Liability accounts: Never allow income transactions
            // All transactions on liability accounts are expenses (charges, payments, credits)
            transactionType = transactionTypes.enum.expense;
          } else {
            // Asset accounts: Use standard logic (positive = income, negative = expense)
            transactionType = amountValue >= 0 ? transactionTypes.enum.income : transactionTypes.enum.expense;
          }

          // Try to find/create merchant — payee (pre-cleaned name) preferred,
          // description as the fallback/rules signal.
          const ahead = named.get(importId);
          const merchantId = ahead?.merchantId
            ?? await this.merchants.match(importDescription ?? '', tx.payee, accountSettings.import_auto_match_merchants);

          // The budget period of its day in the application time zone (if enabled), as
          // preparePeriods found or made it: none is made here, with transactions locked
          let budgetPeriodId: number | null = null;
          if (accountSettings.import_auto_assign_budget_period) {
            try {
              await this.periods.savepoint(async () => {
                budgetPeriodId = await this.periods.findBudgetPeriodForDate(transactionDateString);

                if (budgetPeriodId) {
                  this.logger.debug({
                    importTransactionId: tx.id,
                    budgetPeriodId,
                    transactionDate: transactionDateString
                  }, 'Transaction assigned to budget period');
                } else {
                  this.logger.warn({
                    importTransactionId: tx.id,
                    transactionDate: transactionDateString
                  }, 'No budget period found for transaction');
                }
              });
            } catch (error) {
              this.logger.error({
                ...rowErrorFields(error),
                importTransactionId: tx.id
              }, 'Error finding budget period for transaction');
            }
          } else {
            this.logger.debug({
              importTransactionId: tx.id
            }, 'Skipping budget period assignment - auto-assignment disabled for account');
          }

          // Budget Item Matching - Only if auto-assignment is enabled
          let budgetItemId: number | null = null;
          let matchingMethod: string = budgetMatchingMethod.enum.none;
          let matchingConfidence = 0;
          let matchingRuleId: number | null = null;

          if (accountSettings.import_auto_assign_budget_item) {
            try {
              await this.periods.savepoint(async () => {
                // The match lockNamedReferences made, whose item and rule it locked; this row's
                // own only when it made none.
                const matchResult = ahead?.match ?? await this.budgetItemMatcher.findBudgetItemMatch(
                  merchantId,
                  importDescription ?? '',
                  Math.abs(amountValue)
                );

                budgetItemId = matchResult.budgetItemId;
                matchingMethod = matchResult.method;
                matchingConfidence = matchResult.confidence;
                matchingRuleId = matchResult.ruleId || null;

                if (budgetItemId) {
                  this.logger.debug({
                    importTransactionId: tx.id,
                    budgetItemId,
                    matchingMethod,
                    confidence: Math.round(matchingConfidence * 100)
                  }, 'Transaction matched to budget item');
                } else {
                  this.logger.debug({
                    importTransactionId: tx.id
                  }, 'No budget item match found for transaction');
                }
              });
            } catch (error) {
              this.logger.error({
                ...rowErrorFields(error),
                importTransactionId: tx.id
              }, 'Error in budget item matching');
            }
          } else {
            this.logger.debug({
              importTransactionId: tx.id
            }, 'Skipping budget item assignment - auto-assignment disabled for account');
          }

          // Determine review status and assigned user based on account settings
          const reviewStatus = accountSettings.import_auto_review ? transactionReviewStatus.enum.reviewed : transactionReviewStatus.enum['needs review'];
          const assignedTo = accountSettings.import_default_assigned_to;

          const inserted = await getDb()
            .insertInto('transactions')
            .values({
              account_id: accountId,
              amount,
              description, // Initially copy description, user can edit later
              transaction_date: transactionDateString, // Use timezone-aware date string
              type: transactionType,
              status: tx.pending ? transactionStatus.enum.pending : transactionStatus.enum.cleared,
              import_transaction_id: importId,
              import_amount: amount,
              import_description: importDescription,
              import_payee: payee,
              // The provider memo is extra context (e.g. "Dividend Payment -
              // EQFUND" on a brokerage sweep) — surface it as the notes.
              notes: memo,
              import_posted_date: postedDate,
              import_transacted_at: transactedAt,
              import_pending: tx.pending || false,
              import_extra: JSON.stringify(tx.extra || {}),
              import_imported_at: sql<Date>`CURRENT_TIMESTAMP`,
              is_import: true,
              import_provider: 'simplefin',
              merchant_id: merchantId,
              budget_period_id: budgetPeriodId, // Assign to budget period based on application timezone
              budget_item_id: budgetItemId, // Matched budget item
              budget_matching_method: matchingMethod, // How the budget item was matched
              budget_matching_confidence: matchingConfidence, // Confidence level (0.00 to 1.00)
              budget_matching_rule_id: matchingRuleId, // Rule ID if matched by rule
              review_status: reviewStatus, // Auto-reviewed or needs review based on account setting
              assigned_to: assignedTo // User assignment based on account setting
            })
            // uq_transactions_account_import_id: a row saved meanwhile (by anything that
            // doesn't take the sync lock) is left as it is, not copied.
            .onConflict((oc) => oc
              .columns(['account_id', 'import_transaction_id'])
              .where('import_transaction_id', 'is not', null)
              .where('parent_transaction_id', 'is', null)
              .doNothing())
            .returning('id')
            .executeTakeFirst();

          if (inserted) {
            imported++;
          } else {
            this.logger.warn({ accountId, importTransactionId: tx.id }, 'Transaction was saved meanwhile; not adding it again');
          }
        });
      } catch (error) {
        failed++;
        failedRows.push(tx);
        // A database error by its code and constraint: its message and detail can quote the
        // row ("… amount -31.37", "Failing row contains (…)").
        this.logger.error({
          ...rowErrorFields(error),
          accountId,
          importTransactionId: tx.id,
          posted: tx.posted
        }, 'Could not import transaction; skipped it and carried on with the others');
      }
    }

    // Pending rows whose id left SimpleFin's answer and that nothing replaced: the purchase
    // was cancelled, or it posted as a row we couldn't safely match (listed beside it for a
    // sync, re-issued under another id, or one of two alike), so it may now count twice.
    // They stay as they are, but each is flagged for review once, so a member finds it
    // and deletes it or keeps it. Reconciled rows aren't touched (they were never in gone).
    const vanished = gone.filter((p) => !replacedPendingIds.has(p.id));
    let pendingFlagged = 0;
    const toFlag = vanished.filter((p) => !p.flaggedBefore);
    if (toFlag.length > 0) {
      try {
        pendingFlagged = await this.periods.savepoint(async () => {
          // CASE/jsonb expressions over existing column values — kept as raw sql
          const result = await sql`
            UPDATE transactions SET
              review_status = ${sql.lit(transactionReviewStatus.enum['needs review'])},
              import_extra = (CASE
                  WHEN jsonb_typeof(import_extra) = 'object' THEN import_extra
                  WHEN import_extra IS NULL THEN '{}'::jsonb
                  ELSE jsonb_build_object('bank_extra', import_extra)
                END) || jsonb_build_object(${LEFT_FEED_KEY}::text, ${new Date().toISOString()}::text)
            WHERE id = ANY(${toFlag.map((p) => p.id)}::int[])
              AND import_pending = true
              AND status IS DISTINCT FROM ${sql.lit(transactionStatus.enum.reconciled)}
          `.execute(getDb());
          return Number(result.numAffectedRows ?? 0);
        });
      } catch (error) {
        this.logger.error({ ...rowErrorFields(error), accountId }, 'Could not flag pending transactions that left the bank feed');
      }
    }
    if (vanished.length > 0) {
      this.logger.warn({
        accountId,
        count: vanished.length,
        flaggedNow: pendingFlagged,
        transactions: vanished.map((p) => ({
          id: p.id,
          importTransactionId: p.importTransactionId,
          date: p.date,
          flaggedBefore: p.flaggedBefore
        }))
      }, 'Pending transactions are no longer in the bank feed and no posted transaction was matched to them; flagged for review');
    }

    // What the rebalance leaves out for the rows that weren't saved, read after the others
    // were (an entry one of them linked is no longer a manual entry). Unknown if it fails.
    let unsaved: UnsavedRows = { count: failed, bankCents: 0, standInIds: [], undecidable: failed > 0 };
    if (failed > 0) {
      try {
        // The start SimpleFin was asked for, as the day it is in the application time zone.
        const feedStartDay = feedStart ? calendarDateIn(timeZone, feedStart) : null;
        unsaved = await this.periods.savepoint(() => unsavedRows(accountId, failedRows, dayOf, replacements, feedStartDay));
      } catch (error) {
        this.logger.error({ ...rowErrorFields(error), accountId }, "Could not tell what the transactions that weren't saved change; the balance won't be compared with the bank's");
      }
    }

    // Today's net worth is recorded by syncAccount, once, after the rebalance.

    return { imported, updated, failed, pendingReplaced: replacedPendingIds.size, pendingVanished: vanished.length, pendingFlagged, unsaved };
  }

  /**
   * Match, and lock (FOR KEY SHARE), what the rows this sync may add will name, before it locks
   * any transaction: their budget items, merchants and budget item rules, each table in id
   * order. Each insert's foreign keys take those locks anyway, but only once the sync holds the
   * account's transactions (lockRowsToWrite), and an edit holds its budget item FOR UPDATE, a
   * merchant merge or a delete with a replacement its merchant, a rule's delete the rule, and
   * then waits for transactions (a merge for the merchant's, a delete for those naming it): when
   * one was a row the sync held, each waited for the other, a deadlock Postgres broke by failing
   * one (the merge's 409, or the sync's row, saved at the next sync). Locked first, the sync
   * waits for them holding no transaction, or they for it.
   *
   * The rows it may add: those with a SimpleFin id the account hasn't (nor a pending row the plan
   * replaces). Each is matched as the loop would match it, reading only: its merchant
   * ({@link MerchantMatcher.find}: none is made; a row given none gets one as it's added, a new
   * merchant no one else can hold) and its budget item (findBudgetItemMatch, with that merchant).
   * Only what those matches name is locked (every item an active rule names was, and
   * an item edit then waited for a whole first import). When what they name changed while the locks
   * were waited for (a merchant merged away or deleted, an item archived, a rule re-pointed or
   * turned off), the rows are matched again under the locks, and anything the match now names is
   * locked too, until a match names nothing that changed; the loop gives each row that last match,
   * so it writes only what is locked (matched again as it was written, a row could
   * name an item a rule had been re-pointed to, which an edit held while it waited for one of the
   * sync's rows). Nothing changed, the first match is the one (matched twice, a
   * 1,500-row first import took 40-50% longer). The rows are matched in the order the loop writes
   * them, and a row's history match (its merchant's items, the items' use) counts the rows the
   * loop adds before it, as it did when it matched each as it wrote it: a row it
   * links to a manual entry instead adds none.
   *
   * Rules are locked FOR KEY SHARE, not FOR SHARE: a budget item merge moves its rules
   * (FOR NO KEY UPDATE) after it locked the item's transactions, so a sync holding a rule FOR
   * SHARE while it waited for those transactions would deadlock with it. A rule re-pointed while
   * the sync runs leaves the row the item it was matched to, which is locked.
   *
   * Items first, then merchants, then rules: a merchant's delete deletes its rules (ON DELETE
   * CASCADE) after it locked the merchant, and an item edit that names a new merchant checks it
   * after it locked the item. Answers each row's match by its SimpleFin id.
   */
  private async lockNamedReferences(
    accountId: number,
    transactions: SimplefinTransaction[],
    dayOf: Map<number, string>,
    replacements: Map<string, VanishedPending>,
    settings: { import_auto_match_merchants: boolean; import_auto_assign_budget_item: boolean; import_auto_assign_budget_period: boolean },
  ): Promise<Map<string, NamedReferences>> {
    const rows = new Map<string, { description: string; payee: string | null | undefined; amount: number; amountText: string; day: string | undefined }>();
    for (const tx of transactions) {
      // What the loop refuses (no id, an amount that isn't a number) adds nothing.
      try {
        const importId = importIdOf(tx.id);
        const parsed = parseImportAmount(tx.amount);
        const second = datingSecond(tx);
        if (!replacements.has(importId) && !rows.has(importId)) {
          rows.set(importId, {
            description: typeof tx.description === 'string' ? tx.description : '',
            payee: tx.payee,
            amount: Math.abs(parsed.cents / 100),
            amountText: parsed.text,
            day: second === null ? undefined : dayOf.get(second),
          });
        }
      } catch {
        continue;
      }
    }
    if (rows.size === 0) return new Map();
    const present = await getDb()
      .selectFrom('transactions')
      .select('import_transaction_id')
      .where('account_id', '=', accountId)
      .where('parent_transaction_id', 'is', null)
      .where(sql<SqlBool>`import_transaction_id = ANY(${[...rows.keys()]}::text[])`)
      .execute();
    for (const row of present) if (row.import_transaction_id !== null) rows.delete(row.import_transaction_id);
    if (rows.size === 0) return new Map();

    // Which rows the loop adds, and which it links to a manual entry instead (findManualTransactionMatch:
    // the nearest entry of the amount within the window that no earlier row took; a reconciled one
    // is added beside, not taken): only an added row joins the history later rows' matches read.
    const dated = [...rows.entries()].filter((entry): entry is [string, typeof entry[1] & { day: string }] => entry[1].day !== undefined);
    const near = await manualEntriesNear(accountId, dated.map(([, row]) => ({ amount: row.amountText, day: row.day })));
    const entriesOf = new Map<string, Array<{ id: number; status: string | null }>>();
    for (const entry of near) {
      const importId = dated[entry.i]![0];
      entriesOf.set(importId, [...(entriesOf.get(importId) ?? []), entry]);
    }
    // The month's period a row is given, as the loop finds it (each day's once).
    const periodOfDay = new Map<string, number | null>();
    const periodOf = async (day: string) => {
      if (!periodOfDay.has(day)) periodOfDay.set(day, await this.periods.findBudgetPeriodForDate(day));
      return periodOfDay.get(day) ?? null;
    };

    const locked = { items: new Set<number>(), merchants: new Set<number>(), rules: new Set<number>() };
    for (let round = 1; round <= NAMED_REFERENCE_ROUNDS; round++) {
      // In the order the loop writes them, each match reading the history the rows added before
      // it make: matched as it was written, a row saw them in the ledger, so the
      // second row of a merchant took the item the first was given.
      const named = new Map<string, NamedReferences>();
      const taken = new Set<number>();
      const usage = new Map<number, number>();
      const historyOf = new Map<string, Map<number, { count: number; lastDate: string }>>();
      for (const [importId, row] of rows) {
        const merchantId = await this.merchants.find(row.description, row.payee, settings.import_auto_match_merchants);
        // A merchant the loop makes, by the name it makes it with, until it has an id.
        const signal = row.payee?.trim() || row.description.trim();
        const merchantKey = merchantId !== null ? `id:${merchantId}` : signal ? `name:${signal.toLowerCase()}` : null;
        const match = settings.import_auto_assign_budget_item
          ? await this.budgetItemMatcher.findBudgetItemMatch(merchantId, row.description, row.amount, {
              usage,
              ...(merchantKey && historyOf.has(merchantKey) ? { merchant: historyOf.get(merchantKey)! } : {}),
            })
          : null;
        named.set(importId, { merchantId, match });

        if (row.day === undefined) continue; // refused by the loop
        const entry = (entriesOf.get(importId) ?? []).find((e) => !taken.has(e.id));
        if (entry && entry.status !== transactionStatus.enum.reconciled) {
          taken.add(entry.id); // linked, not added
          continue;
        }
        const itemId = match?.budgetItemId ?? null;
        if (itemId === null) continue;
        usage.set(itemId, (usage.get(itemId) ?? 0) + 1);
        // The history counts a row in a period only.
        if (merchantKey === null || !settings.import_auto_assign_budget_period || (await periodOf(row.day)) === null) continue;
        const merchantHistory = historyOf.get(merchantKey) ?? new Map<number, { count: number; lastDate: string }>();
        const was = merchantHistory.get(itemId);
        merchantHistory.set(itemId, { count: (was?.count ?? 0) + 1, lastDate: was && was.lastDate > row.day ? was.lastDate : row.day });
        historyOf.set(merchantKey, merchantHistory);
      }
      const unlocked = (ids: Array<number | null | undefined>, held: Set<number>) =>
        [...new Set(ids.filter((id): id is number => typeof id === 'number' && !held.has(id)))].sort((a, b) => a - b);
      const refs = [...named.values()];
      const items = unlocked(refs.map((r) => r.match?.budgetItemId), locked.items);
      const merchants = unlocked(refs.map((r) => r.merchantId), locked.merchants);
      const rules = unlocked(refs.map((r) => r.match?.ruleId), locked.rules);
      if (items.length === 0 && merchants.length === 0 && rules.length === 0) return named;

      // One gone meanwhile (merged away, deleted) isn't locked: the next round matches its rows again.
      const heldItems = await lockRowsForReference(annotationSubjectType.enum.budget_item, items);
      for (const id of heldItems) locked.items.add(id);
      const heldMerchants = await lockRowsForReference(annotationSubjectType.enum.merchant, merchants);
      for (const id of heldMerchants) locked.merchants.add(id);
      let heldRules: Array<{ id: number; budget_item_id: number; is_active: boolean | null }> = [];
      if (rules.length > 0) {
        try {
          ({ rows: heldRules } = await sql<{ id: number; budget_item_id: number; is_active: boolean | null }>`
            SELECT id, budget_item_id, is_active FROM budget_item_matching_rules WHERE id = ANY(${rules}::int[]) ORDER BY id FOR KEY SHARE
          `.execute(getDb()));
          for (const { id } of heldRules) locked.rules.add(id);
        } catch (err) {
          if (!isLockConflict(err)) throw err;
          throw new ControlPlaneError(409, RECORD_BUSY, 'Another change to these budget item rules was being saved at the same time, so nothing was saved. Try again.');
        }
      }
      // Matched again only when what the match named changed while it waited for the locks: a row
      // gone, an item archived, or a rule that no longer gives the item matched (re-pointed, turned
      // off). Otherwise the match it locked is the match (every sync matched its new
      // rows twice, which made a 1,500-row first import 40-50% slower). A rule, merchant or history
      // written meanwhile, which a match a moment later would have used, isn't looked for: what the
      // loop writes is locked either way.
      const ruleNow = new Map(heldRules.map((r) => [r.id, r]));
      const ruleChanged = refs.some((r) => {
        const ruleId = r.match?.ruleId;
        if (ruleId === undefined || !ruleNow.has(ruleId)) return false;
        const rule = ruleNow.get(ruleId)!;
        return rule.is_active !== true || rule.budget_item_id !== r.match?.budgetItemId;
      });
      const gone = heldItems.length < items.length || heldMerchants.length < merchants.length || heldRules.length < rules.length;
      const archived = heldItems.length > 0 && (await getDb()
        .selectFrom('budget_items')
        .select('id')
        .where('id', 'in', heldItems)
        .where(sql<SqlBool>`COALESCE(status, ${sql.lit(budgetItemStatus.enum.active)}) = ${sql.lit(budgetItemStatus.enum.archived)}`)
        .executeTakeFirst()) !== undefined;
      if (!gone && !ruleChanged && !archived) return named;
    }
    // What the rows name kept changing while this waited for it: the account's sync stops, and
    // the next one imports them.
    throw new ControlPlaneError(409, RECORD_BUSY, 'What these transactions are matched to kept changing, so nothing was saved. Try again.');
  }

  /**
   * Lock, in one statement, in id order, every row of the account a sync of `transactions`
   * can write (none reconciled, which a sync leaves as it is): each one's row by its
   * SimpleFin id (not a split), the pending rows the plan has them replace, the pending rows
   * that left the feed, which are flagged after, and each manual entry one of them can be
   * linked to (manualMatchCandidates: the matcher's own criteria, for every import's amount
   * and day), and, with `assignPeriods`, the rows that get the period made since a sync left
   * them without one (periodsMadeSince).
   */
  private async lockRowsToWrite(
    accountId: number,
    transactions: SimplefinTransaction[],
    dayOf: Map<number, string>,
    replacements: Map<string, VanishedPending>,
    gone: VanishedPending[],
    assignPeriods: boolean,
  ): Promise<void> {
    const importIds: string[] = [];
    const imports: Array<{ amount: string; day: string }> = [];
    for (const tx of transactions) {
      // What the loop refuses (no id, an amount that isn't a number, no date) writes nothing.
      try {
        const importId = importIdOf(tx.id);
        const amount = parseImportAmount(tx.amount).text;
        importIds.push(importId);
        const second = datingSecond(tx);
        const day = second === null ? undefined : dayOf.get(second);
        if (day) imports.push({ amount, day });
      } catch {
        continue;
      }
    }
    const planned = [...[...replacements.values()].map((p) => p.id), ...gone.map((p) => p.id)];
    if (importIds.length === 0 && planned.length === 0 && !assignPeriods) return;
    await lockTransactions((eb) =>
      eb.and([
        eb('account_id', '=', accountId),
        eb('status', '!=', transactionStatus.enum.reconciled),
        eb.or([
          ...(importIds.length > 0
            ? [eb.and([eb('parent_transaction_id', 'is', null), sql<SqlBool>`import_transaction_id = ANY(${importIds}::text[])`])]
            : []),
          ...(planned.length > 0 ? [eb('id', 'in', planned)] : []),
          ...(imports.length > 0 ? [manualMatchCandidates(accountId, imports)] : []),
          ...(assignPeriods ? [sql<SqlBool>`id = ANY(ARRAY(SELECT id FROM (${periodsMadeSince(accountId)}) made))`] : []),
        ]),
      ])
    );
  }

  /** Give the account's rows periodsMadeSince picks the period made since; how many. */
  private async assignPeriodsMadeSince(accountId: number): Promise<number> {
    const { rows } = await sql<{ id: number }>`
      UPDATE transactions
         SET budget_period_id = made.budget_period_id, updated_at = CURRENT_TIMESTAMP
        FROM (${periodsMadeSince(accountId)}) made
       WHERE transactions.id = made.id
      RETURNING transactions.id
    `.execute(getDb());
    return rows.length;
  }

  /**
   * The account's import automation settings and its type, read FOR KEY SHARE: the
   * type decides whether a deposit imports as an income, which a liability account refuses
   * (check_transaction_type_for_account, which reads it locked the same way). Read unlocked,
   * an account made a liability mid-sync had every later income of the sync refused, each
   * counted as failed; now that edit (AccountService, FOR UPDATE) waits for the sync to
   * commit, and then finds its incomes (409 ACCOUNT_HAS_INCOME). An edit that got there
   * first is waited for here, and its type read. The lock comes before the transactions'
   * (lockRowsToWrite), as an account's row comes before its transactions' everywhere:
   * AccountSyncer.upsertAccount holds it already (FOR NO KEY UPDATE, which this lock
   * doesn't wait for), and Delete Transactions takes none. A database error isn't swallowed
   * any more: it aborts the account's transaction, which the sync reports as failed, where
   * defaults read for a liability imported its deposits as incomes, each refused.
   */
  private async getAccountImportSettings(accountId: number): Promise<{
    import_auto_match_merchants: boolean;
    import_auto_assign_budget_period: boolean;
    import_auto_assign_budget_item: boolean;
    import_auto_review: boolean;
    import_default_assigned_to: number | null;
    account_type: string;
  }> {
    const row = await getDb()
      .selectFrom('accounts')
      .select([
        'import_auto_match_merchants',
        'import_auto_assign_budget_period',
        'import_auto_assign_budget_item',
        'import_auto_review',
        'import_default_assigned_to',
        'type as account_type'
      ])
      .where('id', '=', accountId)
      .forKeyShare()
      .executeTakeFirst();

    if (!row) {
      // Return default values if account not found
      return {
        import_auto_match_merchants: true,
        import_auto_assign_budget_period: true,
        import_auto_assign_budget_item: true,
        import_auto_review: false,
        import_default_assigned_to: null,
        account_type: assetType.enum.Asset
      };
    }

    return {
      import_auto_match_merchants: row.import_auto_match_merchants ?? true,
      import_auto_assign_budget_period: row.import_auto_assign_budget_period ?? true,
      import_auto_assign_budget_item: row.import_auto_assign_budget_item ?? true,
      import_auto_review: row.import_auto_review ?? false,
      import_default_assigned_to: row.import_default_assigned_to || null,
      account_type: row.account_type || assetType.enum.Asset
    };
  }
}
