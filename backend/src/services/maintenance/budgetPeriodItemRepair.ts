/**
 * POST /api/import/fix-budget-period-items: give each transaction with a budget item and
 * a budget period, but no period item, that item's row for that period.
 *
 * Still needed with the consistency trigger (trigger_maintain_budget_period_consistency):
 * the trigger runs when a transaction's budget fields are written, so a transaction saved
 * before its item had a row for the period keeps a NULL period item when the row is
 * added later. Nothing else fills it in. Runs in the request's tenant transaction.
 */
import { sql, type SqlBool } from 'kysely';
import { getDb, withSavepoint } from '../../db/withTenant.js';
import { isTransactionBusy, lockTransactions } from '../transactions/locks.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger({ service: 'ImportService' });

export async function fixMissingBudgetPeriodItemIds(): Promise<{ updated: number; errors: number }> {
  let updated = 0;
  let errors = 0;

  // One UPDATE for them all: each transaction with a budget item and a
  // period but no period item gets that item's row for that period, where there is
  // one. It took two queries per transaction; one at a time is now only the fallback.
  try {
    const fixed = await withSavepoint(async () => {
      // Locked in id order first, as every write of several transactions locks them.
      await lockTransactions(() => sql<SqlBool>`
        budget_item_id IS NOT NULL
        AND budget_period_id IS NOT NULL
        AND budget_period_item_id IS NULL
        AND EXISTS (SELECT 1 FROM budget_period_items bpi
                     WHERE bpi.budget_period_id = transactions.budget_period_id
                       AND bpi.budget_item_id = transactions.budget_item_id)
      `);
      const rows = await sql<{ id: number }>`
        UPDATE transactions t
           SET budget_period_item_id = bpi.id,
               updated_at = CURRENT_TIMESTAMP
          FROM budget_period_items bpi
         WHERE t.budget_item_id IS NOT NULL
           AND t.budget_period_id IS NOT NULL
           AND t.budget_period_item_id IS NULL
           AND bpi.budget_period_id = t.budget_period_id
           AND bpi.budget_item_id = t.budget_item_id
        RETURNING t.id
      `.execute(getDb());
      const unmatched = await getDb()
        .selectFrom('transactions as t')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('t.budget_item_id', 'is not', null)
        .where('t.budget_period_id', 'is not', null)
        .where('t.budget_period_item_id', 'is', null)
        .executeTakeFirstOrThrow();
      return { updated: rows.rows.length, errors: Number(unmatched.count) };
    });
    logger.info(fixed, 'Fixed transactions with missing budget_period_item_id');
    if (fixed.errors > 0) {
      logger.warn({ count: fixed.errors }, 'No budget_period_item found for some transactions');
    }
    return fixed;
  } catch (error) {
    // Rows another write holds (Delete Transactions): the 409 to try again. One at a time would
    // wait the lock timeout again for each of them, and fix none.
    if (isTransactionBusy(error)) throw error;
    logger.warn({ err: error }, 'Fixing budget_period_item_id in one statement failed; fixing one transaction at a time');
  }

  try {
    // Find transactions with budget_item_id and budget_period_id but no budget_period_item_id
    const transactionsToFix = await getDb()
      .selectFrom('transactions as t')
      .select(['t.id', 't.budget_item_id', 't.budget_period_id'])
      .where('t.budget_item_id', 'is not', null)
      .where('t.budget_period_id', 'is not', null)
      .where('t.budget_period_item_id', 'is', null)
      .execute();

    logger.info({
      count: transactionsToFix.length
    }, 'Found transactions with missing budget_period_item_id');

    for (const transaction of transactionsToFix) {
      try {
        await withSavepoint(async () => {
          // Find the corresponding budget_period_item
          const budgetPeriodItem = await getDb()
            .selectFrom('budget_period_items')
            .select('id')
            .where('budget_period_id', '=', transaction.budget_period_id)
            .where('budget_item_id', '=', transaction.budget_item_id)
            .executeTakeFirst();

          if (budgetPeriodItem) {
            const budgetPeriodItemId = budgetPeriodItem.id;

            // Update the transaction
            await getDb()
              .updateTable('transactions')
              .set({
                budget_period_item_id: budgetPeriodItemId,
                updated_at: sql<Date>`CURRENT_TIMESTAMP`
              })
              .where('id', '=', transaction.id)
              .execute();

            updated++;
            logger.debug({
              transactionId: transaction.id,
              budgetPeriodItemId
            }, 'Fixed transaction - assigned budget_period_item_id');
          } else {
            logger.warn({
              transactionId: transaction.id,
              budgetPeriodId: transaction.budget_period_id,
              budgetItemId: transaction.budget_item_id
            }, 'No budget_period_item found for transaction');
            errors++;
          }
        });
      } catch (error) {
        logger.error({
          err: error,
          transactionId: transaction.id
        }, 'Error fixing transaction');
        errors++;
      }
    }

    return { updated, errors };
  } catch (error) {
    logger.error({ err: error }, 'Error in fixMissingBudgetPeriodItemIds');
    return { updated: 0, errors: 1 };
  }
}
