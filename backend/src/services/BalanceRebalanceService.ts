import { sql } from 'kysely';
import { getDb } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { rowErrorFields } from '../utils/logSafeErrors.js';
import { appToday } from '../utils/appDate.js';
import { tenantMoneyText } from './tenantMoneyFormat.js';
import type { UnsavedRows } from './import/unsavedRows.js';
import { transactionReviewStatus, transactionStatus, transactionType } from '@nuggets/shared';

const logger = createLogger({ service: 'BalanceRebalanceService' });

/**
 * Overrides for a balance-adjustment transaction. The SimpleFin auto-rebalance
 * uses the defaults ("...to match imported balance"); the manual "Adjust Balance"
 * action passes its own description/notes and the acting user as `assignedTo`.
 */
export interface BalanceAdjustmentOptions {
  description?: string;
  notes?: string;
  assignedTo?: number | null;
}

/**
 * Creates "balance adjustment" transactions so an account's event-sourced balance
 * matches an externally-known balance (a SimpleFin import balance, or a value the
 * user types in the Adjust Balance modal).
 *
 * Every method runs through {@link getDb} — i.e. inside the caller's `withTenant`
 * transaction (the SimpleFin sync wraps each tenant via `forEachTenant`; the HTTP
 * routes use `tenantHandler`). That keeps the INSERT under the tenant's RLS GUC so
 * `tenant_id` self-stamps correctly; constructing a raw pool Kysely here would run
 * on a connection with no `app.current_tenant_id` and fail the RLS WITH CHECK.
 */
export class BalanceRebalanceService {
  /**
   * The SimpleFin auto-rebalance: when the account rebalances, an adjustment makes the
   * ledger's balance without its pending rows equal the bank's (posted) `importBalance`,
   * so the ledger's own balance is the bank's plus what is still pending.
   *
   * Call it before recording today's net worth in the same transaction, never after: it
   * locks the account's row, and the lock order is an account's row, then today's
   * snapshot row (create_net_worth_snapshot), as Adjust Balance takes them. A transaction
   * holding the snapshot row while it waits here deadlocks with an Adjust Balance of the
   * account.
   *
   * `unsaved` is what the sync couldn't save (unsavedRows.ts): its rows stay out of
   * both balances, so the adjustment is only the drift the feed doesn't explain, and a row
   * saved by a later sync isn't counted twice.
   */
  async checkAndRebalanceAccount(
    accountId: number,
    importBalance: number,
    budgetPeriodId?: number | null,
    unsaved?: Pick<UnsavedRows, 'count' | 'bankCents' | 'standInIds'> | undefined
  ): Promise<boolean> {
    try {
      // 1. Check if account has import_account_rebalance = true. Locked until the
      // caller's transaction ends, as Adjust Balance locks it: the adjustment is the
      // difference from the balance read below, so another one computed meanwhile
      // waits and reads the balance this one leaves.
      const account = await getDb()
        .selectFrom('accounts')
        .select('import_account_rebalance')
        .where('id', '=', accountId)
        .forNoKeyUpdate()
        .executeTakeFirst();

      if (!account) {
        logger.warn({ accountId }, 'Account not found for rebalancing');
        return false;
      }

      if (!account.import_account_rebalance) {
        logger.debug({ accountId }, 'Rebalancing disabled for account');
        return false;
      }

      // 2. The ledger's balance as the bank counts it: without what is still pending, nor
      // what stands for a row the sync couldn't save.
      const { posted } = await this.calculateBankComparableBalance(accountId, unsaved?.standInIds ?? []);

      // 3. Compare with import balance, in cents (both are 2-decimal amounts), less the
      // unsaved rows the bank's balance counts.
      const difference = (Math.round(importBalance * 100) - (unsaved?.bankCents ?? 0) - Math.round(posted * 100)) / 100;

      // 4. If difference exists, create adjustment transaction (ignore penny differences)
      if (Math.abs(difference) > 0.01) {
        const leftOut = unsaved?.count ?? 0;
        const notes = leftOut > 0
          ? `Adjusted to match imported balance of ${await tenantMoneyText(importBalance)}, leaving out ${leftOut} transaction${leftOut === 1 ? '' : 's'} that could not be imported`
          : undefined;
        await this.createBalanceAdjustmentTransaction(accountId, difference, importBalance, budgetPeriodId, notes === undefined ? undefined : { notes });
        // Ids and counts, not the balances or the adjustment's amount: the adjustment
        // is a transaction in the ledger, which shows them.
        logger.info({ accountId, budgetPeriodId, unsavedRows: leftOut }, 'Created balance adjustment');
        return true;
      }

      logger.debug({ accountId }, 'No balance adjustment needed');
      return false;

    } catch (error) {
      logger.error({ ...rowErrorFields(error), accountId }, 'Error rebalancing account');
      throw error;
    }
  }

  /**
   * The account's balance as SimpleFin's `balance` counts it: the ledger's
   * balance (calculate_account_balance) less its imported transactions the bank
   * still lists as pending (`import_pending`). The bank's `balance` is its posted
   * balance: a pending purchase isn't in it until it posts (the import tests' feeds are
   * shaped that way), but the ledger counts it from the day it's imported, so comparing
   * the two whole balances made every pending purchase look like a discrepancy: the
   * rebalance added an adjustment cancelling it, and another undoing that once it posted.
   *
   * `available-balance` isn't the comparison instead: SimpleFin sends it only for some
   * accounts (the import stores null otherwise), and on a card it is the credit left,
   * not what is owed, so it doesn't measure what the ledger's balance does.
   *
   * A pending row that left the bank's feed with no posted row matched to it keeps
   * `import_pending` (the import flags it for review) and stays out of the comparison.
   * Most often the bank lists the posted transaction a sync or two later and the import
   * replaces the row with it; counting the row meanwhile would add an adjustment and
   * then its reversal. If the bank really dropped it (a released hold), or it posted as
   * a row the import couldn't match, the ledger's balance is off the bank's by it until
   * a member deletes it, as the review flag asks: the rebalance doesn't hide it.
   */
  async calculateBankComparableBalance(
    accountId: number,
    leaveOut: number[] = []
  ): Promise<{ balance: number; pending: number; posted: number }> {
    const result = await sql<{ balance: string; pending: string; posted: string }>`
      SELECT b.balance, b.pending, b.balance - b.pending - b.left_out AS posted
        FROM (SELECT calculate_account_balance(${accountId}) AS balance,
                     -- The pending rows the balance counts: it stops at today.
                     (SELECT COALESCE(SUM(t.amount), 0)
                        FROM transactions t
                       WHERE t.account_id = ${accountId}
                         AND t.parent_transaction_id IS NULL
                         AND t.transaction_date <= app_today()
                         AND t.import_pending IS TRUE) AS pending,
                     -- What it counts of the rows (leaveOut) standing for ones the sync
                     -- couldn't save; the pending ones are out already.
                     (SELECT COALESCE(SUM(t.amount), 0)
                        FROM transactions t
                       WHERE t.id = ANY(${leaveOut}::int[])
                         AND t.account_id = ${accountId}
                         AND t.parent_transaction_id IS NULL
                         AND t.transaction_date <= app_today()
                         AND t.import_pending IS NOT TRUE) AS left_out) b
    `.execute(getDb());

    // pg returns NUMERIC as strings.
    const row = result.rows[0];
    return { balance: Number(row?.balance ?? 0), pending: Number(row?.pending ?? 0), posted: Number(row?.posted ?? 0) };
  }

  /**
   * The ledger's configured balance-adjustment merchant (or null). Read from the
   * control-plane `tenants` row for the ACTIVE tenant via the RLS GUC, so it works
   * identically for scheduled syncs (forEachTenant) and HTTP requests.
   */
  private async resolveBalanceAdjustmentMerchantId(): Promise<number | null> {
    const row = await getDb()
      .selectFrom('tenants')
      .select('balance_adjustment_merchant_id')
      .where('id', '=', sql<number>`current_setting('app.current_tenant_id', true)::int`)
      .executeTakeFirst();
    return row?.balance_adjustment_merchant_id ?? null;
  }

  async createBalanceAdjustmentTransaction(
    accountId: number,
    adjustmentAmount: number,
    targetBalance: number,
    budgetPeriodId?: number | null,
    options?: BalanceAdjustmentOptions
  ): Promise<{ uuid: string }> {
    try {
      const db = getDb();
      const transactionDate = await appToday(); // Today in the application time zone

      // Use provided budget period ID if available, otherwise look it up
      let finalBudgetPeriodId: number | null = budgetPeriodId ?? null;

      if (finalBudgetPeriodId === undefined || finalBudgetPeriodId === null) {
        // Fallback: Get budget period for the transaction date if not provided
        try {
          const period = await db
            .selectFrom('budget_period')
            .select('id')
            // Explicit ::date casts preserved from the original SQL.
            .where(sql<boolean>`${transactionDate}::date >= start_date AND ${transactionDate}::date <= end_date`)
            .orderBy('start_date', 'desc')
            .limit(1)
            .executeTakeFirst();

          if (period) {
            finalBudgetPeriodId = period.id;
            logger.debug({ transactionDate, budgetPeriodId: finalBudgetPeriodId }, 'Looked up budget period for balance adjustment');
          } else {
            logger.warn({ transactionDate }, 'No budget period found for balance adjustment transaction date');
          }
        } catch (periodError) {
          logger.error({ ...rowErrorFields(periodError), transactionDate }, 'Error finding budget period for balance adjustment');
          // Continue without budget period assignment
        }
      } else {
        logger.debug({ budgetPeriodId: finalBudgetPeriodId }, 'Using provided budget period for balance adjustment');
      }

      // The ledger-configured merchant for balance adjustments (null when unset).
      const merchantId = await this.resolveBalanceAdjustmentMerchantId();

      // Create transaction record for balance adjustment
      const inserted = await db
        .insertInto('transactions')
        .values({
          account_id: accountId,
          amount: adjustmentAmount,
          description: options?.description ?? 'Balance adjustment to match imported balance',
          transaction_date: transactionDate,
          merchant_id: merchantId, // Ledger's balance-adjustment merchant, or null
          budget_item_id: null, // No budget item for system transactions
          budget_period_id: finalBudgetPeriodId, // Assign to budget period (provided or looked up)
          type: transactionType.enum['balance adjustment'],
          status: transactionStatus.enum.cleared, // System adjustments are automatically cleared
          is_import: false, // This is NOT an imported transaction, it's system-generated
          notes: options?.notes ?? `Adjusted to match imported balance of ${await tenantMoneyText(targetBalance)}`,
          review_status: transactionReviewStatus.enum.reviewed, // System transactions don't need review
          ...(options?.assignedTo != null ? { assigned_to: options.assignedTo } : {}),
        })
        .returning('uuid')
        .executeTakeFirstOrThrow();

      logger.info({
        accountId,
        transactionUuid: inserted.uuid,
        budgetPeriodId: finalBudgetPeriodId,
        merchantId,
      }, 'Created balance adjustment transaction');

      return { uuid: inserted.uuid };

    } catch (error) {
      // A check's message names the amount: the database error by its code.
      logger.error({ ...rowErrorFields(error), accountId }, 'Error creating balance adjustment transaction');
      throw error;
    }
  }
}
