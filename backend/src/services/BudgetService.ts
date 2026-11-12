// BudgetService.ts - Application-level budget management service
import { sql, type ExpressionBuilder, type Selectable, type SqlBool } from 'kysely';
import { getDb } from '../db/withTenant.js';
import type { DB } from '../db/schema.generated.js';
import { createLogger } from '../utils/logger.js';
import { oneRow } from '../utils/present.js';
import { centsToAmount, centsToNumber, numericToCents, toCents } from '../utils/money.js';
import { ControlPlaneError } from './controlPlaneErrors.js';
import { DomainError, type RefusalStatus } from './domainErrors.js';
import { isLockConflict, lockRowsForDelete, lockTransactions } from './transactions/locks.js';
import { transferItemsNotInPeriod } from './budgetPeriods/BudgetPeriodError.js';
import { budgetPeriodItemIdOf, budgetPeriodOf } from './budgetPeriods/periodLookups.js';
import { budgetEventType, budgetItemStatus } from '@nuggets/shared';

const logger = createLogger({ service: 'BudgetService' });

/** The month already has its budget period: a ledger has one per month. A 409. */
export class BudgetPeriodExistsError extends ControlPlaneError {
    constructor(year: number, month: number, name?: string) {
        super(409, 'BUDGET_PERIOD_EXISTS', `Budget period for ${month}/${year} already exists${name ? `: ${name}` : ''}`);
        this.name = 'BudgetPeriodExistsError';
    }
}

/** A budget change that can't be made as asked (a bad amount, missing funds, no such item): a 4xx. */
export class BudgetChangeError extends ControlPlaneError {
    constructor(status: RefusalStatus, code: string, message: string) {
        super(status, code, message);
        this.name = 'BudgetChangeError';
    }
}

/**
 * Refuse a budget change, a transfer or a starting balance on an archived item, read
 * under the period item's lock (a starting balance: under the item's own). A merge locks those
 * rows before it archives the item, so a change it held up finds the item archived here,
 * rather than leave money on an item that is gone from the budget page. 400 BUDGET_ITEM_ARCHIVED. A transaction may still name an archived item: its spending
 * is history, and the item's balance shows it.
 */
async function refuseArchivedItems(trx: ReturnType<typeof getDb>, budgetItemIds: number[], toDo: string): Promise<void> {
    const archived = await trx
        .selectFrom('budget_items')
        .select('name')
        .where('id', 'in', budgetItemIds)
        .where('status', '=', budgetItemStatus.enum.archived)
        .executeTakeFirst();
    if (archived) {
        throw new BudgetChangeError(400, 'BUDGET_ITEM_ARCHIVED', `${archived.name} is archived. Restore it first to ${toDo}.`);
    }
}

/** pg_advisory_xact_lock's class for a ledger's budget items' period rows ('BPRW'). */
const BUDGET_ITEM_ROWS_LOCK_CLASS = 0x42505257;

/**
 * The ledger's lock on which period rows its budget items have, held to the end of the
 * transaction: a period created takes it alone ('add': the period gives every active item a
 * row, and its default budget), an archive or a merge shared ('retire': it reads and moves an
 * item's rows, then archives it). So a period waits for the archives and merges under way and
 * then leaves their items out (they're archived by then), or they wait for it and see the rows
 * it added. Before, a period created during a merge gave the merged item a row, with its default
 * budget, that the merge hadn't locked or moved, left on the item once archived: the row's
 * foreign key check (FOR KEY SHARE) doesn't wait for a merge's lock on the item. A lock rather
 * than the items' rows: a period locking every active item would wait on, and could deadlock
 * with, any write of several items (a tag or category delete clearing them). Taken before
 * anything else either does. A wait past the lock timeout, or a deadlock, is a 409.
 *
 * It comes before any transaction's row lock: a merge holds it while it waits for its item's
 * transactions (lockTransactions). So code that has locked transactions doesn't take it (a
 * bank sync locked its transactions, then waited here to make a period, while a merge
 * of one of their items waited for them, a deadlock): the sync makes its periods before it locks
 * its transactions (BudgetPeriodResolver.preparePeriods), and a row's lookup makes none.
 */
export async function lockBudgetItemRows(mode: 'add' | 'retire', nothingDone: string): Promise<void> {
    try {
        await (mode === 'add'
            ? sql`SELECT pg_advisory_xact_lock(${BUDGET_ITEM_ROWS_LOCK_CLASS}::int, current_tenant_id())`
            : sql`SELECT pg_advisory_xact_lock_shared(${BUDGET_ITEM_ROWS_LOCK_CLASS}::int, current_tenant_id())`
        ).execute(getDb());
    } catch (err) {
        if (!isLockConflict(err)) throw err;
        logger.warn({ err, mode }, 'Could not take the budget item rows lock in time');
        throw new BudgetChangeError(409, 'RECORD_BUSY', `Another change to the budget was being saved at the same time, so ${nothingDone}. Try again.`);
    }
}

/** Marks the event that carries a monthly item's money into its new envelope. */
export const TYPE_CHANGE_SOURCE = 'type_change';
/** Marks the event that keeps an envelope's balance when another item is merged into it. */
export const MERGE_SOURCE = 'merge';

/**
 * A budget item's own starting-balance events: not the ones a type change or a
 * merge records to keep a balance where it was.
 */
export const ownStartingBalance = (eb: ExpressionBuilder<DB, 'budget_period_transactions'>) => eb.and([
    eb('type', '=', budgetEventType.enum.starting_balance),
    eb.or([eb('source_system', 'is', null), eb('source_system', 'not in', [TYPE_CHANGE_SOURCE, MERGE_SOURCE])]),
]);

/** The item a starting balance belongs to, as budget_items has it. */
interface StartingBalanceItem {
    id: number;
    name: string;
    rollover_starting_balance_date: string | null;
}

export interface BudgetPeriodItemSummary {
    budgetItemId: number;
    budgetItemName: string;
    startingAmount: number;
    budgetAmount: number;
    actualAmount: number;
    transfersAmount: number;
    remainingAmount: number;
    rolloverEnabled: boolean;
}

// This service is predominantly PL/pgSQL event-sourcing calls
// (record_budget_change_event, record_transfer_event, create_budget_period_with_items,
// calculate_*_for_period_item), so queries are kept as
// typed raw sql templates (byte-identical text); transactions use db.transaction().
//
// Every query runs on the caller's tenant transaction via getDb() (RLS-scoped to the
// active tenant), so the service holds no state and takes no pool.
export class BudgetService {

    // ====================================================================
    // BUDGET MANAGEMENT
    // ====================================================================

    /**
     * Update budget amount for a budget item in a specific period
     * This replaces the trigger logic with application-controlled events
     */
    async updateBudgetAmount(
        budgetPeriodItemId: number,
        newAmount: number | string,
        userId?: number,
        description?: string | null
    ): Promise<{ success: boolean; eventUuid: string }> {
        const newCents = toCents(newAmount);
        if (newCents === null) {
            throw new BudgetChangeError(400, 'INVALID_AMOUNT', 'Amount must be a number with at most 2 decimal places');
        }
        try {
            // Already runs inside the caller's withTenant transaction; use getDb()
            // directly instead of opening a nested transaction.
            return await (async () => {
                const trx = getDb();
                // The change is recorded as the difference from the budget read below,
                // so lock the period item first: two edits at once would both
                // read the same budget, and the one recorded last would leave the
                // wrong total. NO KEY UPDATE queues the budget's writers without
                // holding up rows that only reference the period item.
                const periodItem = await trx
                    .selectFrom('budget_period_items')
                    .select('budget_item_id')
                    .where('id', '=', budgetPeriodItemId)
                    .forNoKeyUpdate()
                    .executeTakeFirst();
                if (!periodItem) {
                    throw new BudgetChangeError(404, 'BUDGET_PERIOD_ITEM_NOT_FOUND', 'Budget period item not found');
                }
                await refuseArchivedItems(trx, [periodItem.budget_item_id], 'change its budget');

                // Get current budget amount
                const currentResult = await sql<{ current_budget: string }>`SELECT calculate_budget_for_period_item(${budgetPeriodItemId}) as current_budget`.execute(trx);
                const currentCents = numericToCents(currentResult.rows[0]?.current_budget);

                // Record the budget change event
                const eventResult = await sql<{ event_uuid: string }>`SELECT record_budget_change_event(${budgetPeriodItemId}, ${periodItem.budget_item_id}, ${centsToAmount(newCents)}, ${centsToAmount(currentCents)}, ${description || `Budget updated to ${newAmount}`}, ${userId}, NULL) as event_uuid`.execute(trx);

                return {
                    success: true,
                    eventUuid: oneRow(eventResult.rows, 'the recorded event').event_uuid
                };
            })();
        } catch (error) {
            // A refusal is answered as itself; anything else is logged here with the ids
            // (never the amount) and answered 500 by the route wrapper.
            if (!(error instanceof DomainError)) logger.error({ err: error, budgetPeriodItemId }, 'Error updating budget amount');
            throw error;
        }
    }

    /**
     * Set the budget of the period item `periodItemUuid` names (PUT
     * /api/budgets/period-items/:uuid/budget): {@link updateBudgetAmount}, after a 404 for a
     * period item that isn't the ledger's.
     */
    async setPeriodItemBudget(
        periodItemUuid: string,
        amount: number | string,
        userId: number,
        description?: string | null
    ): Promise<{ success: boolean; eventUuid: string }> {
        return this.updateBudgetAmount(await budgetPeriodItemIdOf(periodItemUuid), amount, userId, description);
    }

    /**
     * Move `amount` between two items of the period `periodUuid` names (POST
     * /api/budget-periods/:periodUuid/transfer): both must be items of that period, else a
     * 404; then {@link transferBetweenBudgetItems}, which checks the amount and the funds.
     * The event's description is the one given, else "Transfer from <one> to <other>".
     */
    async transferInPeriod(
        periodUuid: string,
        transfer: { fromBudgetPeriodItemId: number; toBudgetPeriodItemId: number; amount: number | string; description?: string | null | undefined },
        userId: number
    ): Promise<{ eventUuid: string; fromName: string; toName: string; amount: number }> {
        const period = await budgetPeriodOf(periodUuid);
        const { fromBudgetPeriodItemId: fromId, toBudgetPeriodItemId: toId } = transfer;
        const items = await getDb()
            .selectFrom('budget_period_items as bpi')
            .innerJoin('budget_items as bi', 'bi.id', 'bpi.budget_item_id')
            .select(['bpi.id', 'bi.name'])
            .where('bpi.id', 'in', [fromId, toId])
            .where('bpi.budget_period_id', '=', period.id)
            .execute();
        const from = items.find((item) => item.id === fromId);
        const to = items.find((item) => item.id === toId);
        if (!from || !to) throw transferItemsNotInPeriod();

        const result = await this.transferBetweenBudgetItems(
            fromId,
            toId,
            transfer.amount,
            userId,
            transfer.description || `Transfer from ${from.name} to ${to.name}`
        );
        logger.info({ periodId: period.id, fromBudgetPeriodItemId: fromId, toBudgetPeriodItemId: toId }, 'Budget transfer completed');
        return { eventUuid: result.eventUuid, fromName: from.name, toName: to.name, amount: result.amount };
    }

    /**
     * Transfer money between two items of one budget period. The amount is more
     * than zero (a negative one passed the funds check and took the money
     * from the other item), and the item it leaves must have it.
     */
    async transferBetweenBudgetItems(
        fromBudgetPeriodItemId: number,
        toBudgetPeriodItemId: number,
        amount: number | string,
        userId?: number,
        description?: string
    ): Promise<{ success: boolean; eventUuid: string; amount: number }> {
        const cents = toCents(amount);
        if (cents === null || cents <= 0) {
            throw new BudgetChangeError(400, 'INVALID_AMOUNT', 'Amount must be greater than zero, with at most 2 decimal places');
        }
        const fromId = Number(fromBudgetPeriodItemId);
        const toId = Number(toBudgetPeriodItemId);
        if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
            throw new BudgetChangeError(400, 'INVALID_TRANSFER', 'From and To budget period item IDs are required');
        }
        if (fromId === toId) {
            throw new BudgetChangeError(400, 'INVALID_TRANSFER', 'Cannot transfer to the same budget item');
        }
        try {
            // Already runs inside the caller's withTenant transaction; use getDb()
            // directly instead of opening a nested transaction.
            return await (async () => {
                const trx = getDb();
                // Lock both items before the funds check, in id order so two
                // transfers between the same two can't deadlock: otherwise two
                // transfers at once both pass the check, and the item is overdrawn.
                const periodItems = await trx
                    .selectFrom('budget_period_items')
                    .select(['id', 'budget_period_id', 'budget_item_id'])
                    .where('id', 'in', [fromId, toId])
                    .orderBy('id')
                    .forNoKeyUpdate()
                    .execute();
                const [first, second] = periodItems;
                if (!first || !second || periodItems.length !== 2) {
                    throw new BudgetChangeError(404, 'BUDGET_PERIOD_ITEM_NOT_FOUND', 'Budget period item not found');
                }
                if (first.budget_period_id !== second.budget_period_id) {
                    throw new BudgetChangeError(400, 'INVALID_TRANSFER', 'Transfers move money between items of one budget period');
                }
                await refuseArchivedItems(trx, periodItems.map((row) => row.budget_item_id), 'move money to or from it');

                // Validate sufficient funds
                const fromBalanceResult = await sql<{ remaining: string }>`SELECT calculate_remaining_for_period_item(${fromId}) as remaining`.execute(trx);
                const remainingCents = numericToCents(fromBalanceResult.rows[0]?.remaining);

                if (remainingCents < cents) {
                    throw new BudgetChangeError(400, 'INSUFFICIENT_FUNDS', `Insufficient funds. Available: ${centsToNumber(remainingCents)}, Requested: ${centsToNumber(cents)}`);
                }

                // Record the transfer event
                const eventResult = await sql<{ event_uuid: string }>`SELECT record_transfer_event(${fromId}, ${toId}, ${centsToAmount(cents)}, ${description || `Transfer: ${amount}`}, ${userId}) as event_uuid`.execute(trx);

                return {
                    success: true,
                    eventUuid: oneRow(eventResult.rows, 'the recorded event').event_uuid,
                    // The amount recorded, read in cents: what the answer states, never the text as sent.
                    amount: centsToNumber(cents),
                };
            })();
        } catch (error) {
            // A refusal (missing funds, a bad amount) is answered as itself; anything else is
            // logged with the ids, never the amount, and answered 500.
            if (!(error instanceof DomainError)) {
                logger.error({ err: error, fromBudgetPeriodItemId, toBudgetPeriodItemId }, 'Error transferring between budget items');
            }
            throw error;
        }
    }

    // ====================================================================
    // ENVELOPE STARTING BALANCES
    // ====================================================================

    /**
     * Record a change of an envelope's starting balance, the balance it starts
     * with: one event of the difference, added to the log. Creating an
     * envelope records its whole starting balance this way (from 0). The event
     * goes where the item's starting balance already is, else in the period its
     * date falls in (starting_balance_period_item). With no budget period to
     * record it in, it's refused (409) rather than left out of the balance. The
     * event's uuid; null when nothing changed.
     */
    async changeStartingBalance(
        item: StartingBalanceItem,
        previousCents: number,
        nextCents: number,
        userId?: number
    ): Promise<string | null> {
        if (previousCents === nextCents) return null;
        const trx = getDb();
        // The caller holds the item's row lock, which a merge's archiving waits on or ends.
        await refuseArchivedItems(trx, [item.id], 'change its starting balance');
        const existing = await trx
            .selectFrom('budget_period_transactions')
            .select('budget_period_item_id')
            .where('budget_item_id', '=', item.id)
            .where(ownStartingBalance)
            .where('budget_period_item_id', 'is not', null)
            .orderBy('id', 'desc')
            .limit(1)
            .executeTakeFirst();
        const periodItemId = existing?.budget_period_item_id
            ?? (await sql<{ id: number | null }>`SELECT starting_balance_period_item(${item.id}::int, ${item.rollover_starting_balance_date}::date) AS id`.execute(trx)).rows[0]?.id
            ?? null;
        if (periodItemId === null) {
            throw new BudgetChangeError(409, 'NO_BUDGET_PERIOD', "Create a budget period first: an envelope's starting balance is recorded in one.");
        }

        const description = previousCents === 0
            ? `Starting balance for ${item.name}: ${centsToAmount(nextCents)}`
            : `Starting balance for ${item.name} changed from ${centsToAmount(previousCents)} to ${centsToAmount(nextCents)}`;
        const { rows } = await sql<{ event_uuid: string }>`SELECT record_budget_change_event(${periodItemId}::int, ${item.id}::int, ${centsToAmount(nextCents)}::numeric, ${centsToAmount(previousCents)}::numeric, ${description}, ${userId ?? null}::int, NULL::uuid, 'starting_balance') AS event_uuid`.execute(trx);
        logger.info({ budgetItemId: item.id, periodItemId }, 'Recorded a starting balance change');
        return oneRow(rows, 'record_budget_change_event').event_uuid;
    }

    /**
     * Move an item's starting balance to the period of its new starting date.
     * Only a new date moves it; a cleared one leaves it where it is.
     */
    async moveStartingBalance(item: StartingBalanceItem, newDate: string, userId?: number): Promise<void> {
        const trx = getDb();
        const { rows } = await sql<{ id: number | null }>`SELECT starting_balance_period_item(${item.id}::int, ${newDate}::date) AS id`.execute(trx);
        const periodItemId = rows[0]?.id ?? null;
        if (periodItemId === null) {
            logger.warn({ budgetItemId: item.id, newDate }, 'No budget period for the starting balance date, skipping period reassignment');
            return;
        }

        // Update both the created_at timestamp and budget_period_item_id for starting_balance events
        const moved = await trx
            .updateTable('budget_period_transactions')
            .set({
                created_at: sql<Date>`${newDate}::timestamp`,
                budget_period_item_id: periodItemId,
            })
            .where('budget_item_id', '=', item.id)
            .where(ownStartingBalance)
            .executeTakeFirst();
        logger.info({
            budgetItemId: item.id,
            newDate,
            periodItemId,
            eventsUpdated: Number(moved.numUpdatedRows),
            userId,
        }, 'Moved the starting balance to the period of its new date');
    }

    // ====================================================================
    // PERIOD MANAGEMENT
    // ====================================================================

    /**
     * Create a month's budget period, with an item for each budget item. A ledger has
     * one period per month (budget_period_tenant_month_key): when it already has
     * this one, made before or by a concurrent request that committed first, nothing is
     * created and the existing period comes back with `created: false`. The caller
     * decides whether that is an error (the create routes answer 409). Not for a caller that
     * holds transactions' row locks (lockBudgetItemRows).
     */
    async createBudgetPeriod(
        year: number,
        month: number,
        userId?: number,
        autoRollover: boolean = true
    ): Promise<{ periodId: number; budgetItemsCreated: number; created: boolean }> {
        try {
            // Already runs inside the caller's withTenant transaction; use getDb()
            // directly instead of opening a nested transaction.
            return await (async () => {
                const trx = getDb();
                const existingPeriod = async () =>
                    (await sql<{ id: number }>`SELECT id FROM budget_period WHERE year = ${year} AND month_number = ${month}`.execute(trx)).rows[0]?.id;

                const existing = await existingPeriod();
                if (existing !== undefined) {
                    return { periodId: existing, budgetItemsCreated: 0, created: false };
                }

                // Not while an archive or a merge runs: see lockBudgetItemRows.
                await lockBudgetItemRows('add', 'no budget period was created');

                // Create the period. NULL: the month's period was created meanwhile, by a
                // call that committed after the check above (the insert waited for it).
                const periodResult = await sql<{ period_id: number | null }>`SELECT create_budget_period_with_items(${year}, ${month}, ${userId}, ${autoRollover}) as period_id`.execute(trx);

                const periodId = periodResult.rows[0]?.period_id ?? null;
                if (periodId === null) {
                    const meanwhile = await existingPeriod();
                    if (meanwhile === undefined) {
                        throw new Error(`Budget period for ${month}/${year} was neither created nor found`);
                    }
                    logger.info({ year, month, periodId: meanwhile }, 'Budget period was created meanwhile; using it');
                    return { periodId: meanwhile, budgetItemsCreated: 0, created: false };
                }

                // Count budget items created
                const countResult = await sql<{ count: string }>`SELECT COUNT(*) as count FROM budget_period_items WHERE budget_period_id = ${periodId}`.execute(trx);

                return {
                    periodId,
                    budgetItemsCreated: parseInt(oneRow(countResult.rows, 'count(*)').count),
                    created: true
                };
            })();
        } catch (error) {
            logger.error({ err: error, year, month, autoRollover }, 'Error creating budget period');
            throw error;
        }
    }

    /**
     * Create a month's period for the two create routes (POST /api/budgets/periods, the
     * Budget page's, and POST /api/budget-periods, the settings page's: one method, each
     * answering in its own shape): the period with an item for each budget item
     * ({@link createBudgetPeriod}) and the month's transactions that have no period yet,
     * unless `associateTransactions` is false. A month that has its period (made before, or
     * by a concurrent request) is refused: 409 BudgetPeriodExistsError.
     */
    async createMonthPeriod(
        year: number,
        month: number,
        userId: number,
        options: { autoRollover?: boolean; associateTransactions?: boolean } = {}
    ): Promise<{ period: Selectable<DB['budget_period']>; budgetItemsCreated: number; transactionsAssociated: number }> {
        const associateTransactions = options.associateTransactions ?? true;
        const created = await this.createBudgetPeriod(year, month, userId, options.autoRollover ?? true);
        const period = await getDb().selectFrom('budget_period').selectAll().where('id', '=', created.periodId).executeTakeFirstOrThrow();
        if (!created.created) throw new BudgetPeriodExistsError(year, month, period.name);
        const transactionsAssociated = associateTransactions ? await this.takeInPeriodTransactions(period.id) : 0;
        if (associateTransactions) {
            logger.info({ periodId: period.id, transactionsAssociated }, 'Associated existing transactions to budget period');
        }
        return { period, budgetItemsCreated: created.budgetItemsCreated, transactionsAssociated };
    }

    /**
     * Put the transactions dated within the period's own first and last days that have no
     * period into it, but an opening balance (not the month's activity). Locked in id
     * order first, as every write of several transactions locks them: a busy one is a
     * 409 TRANSACTION_BUSY. The number taken in.
     */
    private async takeInPeriodTransactions(periodId: number): Promise<number> {
        await lockTransactions(() => sql<SqlBool>`
            budget_period_id IS NULL
            AND type IS DISTINCT FROM 'starting balance'
            AND transaction_date BETWEEN (SELECT start_date FROM budget_period WHERE id = ${periodId})
                                     AND (SELECT end_date FROM budget_period WHERE id = ${periodId})
        `);
        const { rows } = await sql<{ id: number }>`
            UPDATE transactions t
            SET budget_period_id = bp.id, updated_at = CURRENT_TIMESTAMP
            FROM budget_period bp
            WHERE bp.id = ${periodId}
              AND t.budget_period_id IS NULL
              AND t.type IS DISTINCT FROM 'starting balance'
              AND t.transaction_date BETWEEN bp.start_date AND bp.end_date
            RETURNING t.id
        `.execute(getDb());
        return rows.length;
    }

    /**
     * Delete the period `uuid` names (DELETE /api/budget-periods/:uuid): its transactions
     * leave it (they keep their budget item), and its budget events, its items and the
     * period itself are deleted. A period that isn't the ledger's is a 404.
     *
     * The lock order: the transactions first, in id order, as every write of
     * several transactions locks them; then the period's own row FOR UPDATE, as a
     * budget item merge share-locks the periods it writes into before their items (one waits
     * for the other, and a merge can't add an item between this delete's steps); then the
     * period's items, in id order, before anything of theirs is deleted: the deletes took them
     * in the order they scanned them, and a note written on two of them (a manual resolve,
     * which locks them in id order, FOR KEY SHARE) could hold one this waited for while it
     * waited for one this had deleted, a deadlock. A wait past the pool's lock_timeout is a
     * 409 to try again, nothing deleted.
     */
    async deletePeriod(uuid: string): Promise<{
        name: string;
        transactionsUnassociated: number;
        budgetItemsDeleted: number;
        budgetTransactionsDeleted: number;
    }> {
        const trx = getDb();
        const period = await budgetPeriodOf(uuid);
        const periodId = period.id;
        logger.info({ periodId }, 'Deleting budget period');

        await lockTransactions((eb) => eb('budget_period_id', '=', periodId));
        const unassociated = await trx
            .updateTable('transactions')
            .set({ budget_period_id: null, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
            .where('budget_period_id', '=', periodId)
            .executeTakeFirst();
        const transactionsUnassociated = Number(unassociated.numUpdatedRows ?? 0);

        await lockRowsForDelete('this budget period', async () => {
            await trx.selectFrom('budget_period').select('id').where('id', '=', periodId).forUpdate().execute();
            await trx.selectFrom('budget_period_items').select('id').where('budget_period_id', '=', periodId).orderBy('id').forUpdate().execute();
        });

        const events = await trx
            .deleteFrom('budget_period_transactions')
            .where('budget_period_item_id', 'in',
                trx.selectFrom('budget_period_items').select('id').where('budget_period_id', '=', periodId))
            .executeTakeFirst();
        const budgetTransactionsDeleted = Number(events.numDeletedRows ?? 0);

        const items = await trx.deleteFrom('budget_period_items').where('budget_period_id', '=', periodId).executeTakeFirst();
        const budgetItemsDeleted = Number(items.numDeletedRows ?? 0);

        await trx.deleteFrom('budget_period').where('id', '=', periodId).executeTakeFirst();
        logger.info({ periodId, transactionsUnassociated, budgetItemsDeleted, budgetTransactionsDeleted }, 'Budget period deleted');

        return { name: period.name, transactionsUnassociated, budgetItemsDeleted, budgetTransactionsDeleted };
    }

    /**
     * Auto-create next month's budget period when current becomes active
     */
    async autoCreateNextPeriod(currentPeriodId: number, userId?: number): Promise<boolean> {
        try {
            // Get current period info
            const periodResult = await sql<{ year: number; month_number: number }>`SELECT year, month_number FROM budget_period WHERE id = ${currentPeriodId}`.execute(getDb());

            const period = periodResult.rows[0];
            if (!period) {
                throw new Error('Current period not found');
            }

            const { year, month_number } = period;

            // Calculate next month
            let nextMonth = month_number + 1;
            let nextYear = year;

            if (nextMonth > 12) {
                nextMonth = 1;
                nextYear += 1;
            }

            // Create next period; false when it already exists
            const { created } = await this.createBudgetPeriod(nextYear, nextMonth, userId, true);

            return created;

        } catch (error) {
            logger.error({ err: error, currentPeriodId }, 'Error auto-creating next period');
            return false;
        }
    }

    // ====================================================================
    // QUERY METHODS
    // ====================================================================

    /**
     * Get budget summary for a period with calculated amounts
     */
    async getBudgetPeriodSummary(periodId: number): Promise<BudgetPeriodItemSummary[]> {
        const result = await sql<{
            budget_item_id: number;
            budget_item_name: string;
            starting_amount: string;
            budget_amount: string;
            actual_amount: string;
            transfers_amount: string;
            remaining_amount: string;
            rollover_enabled: boolean;
        }>`SELECT * FROM get_budget_period_summary(${periodId})`.execute(getDb());

        return result.rows.map(row => ({
            budgetItemId: row.budget_item_id,
            budgetItemName: row.budget_item_name,
            startingAmount: parseFloat(row.starting_amount) || 0,
            budgetAmount: parseFloat(row.budget_amount) || 0,
            actualAmount: parseFloat(row.actual_amount) || 0,
            transfersAmount: parseFloat(row.transfers_amount) || 0,
            remainingAmount: parseFloat(row.remaining_amount) || 0,
            rolloverEnabled: row.rollover_enabled
        }));
    }

    /**
     * Get event history for audit trail (simplified version)
     */
    async getBudgetEventHistory(
        budgetItemId?: number,
        periodId?: number,
        limit: number = 100
    ) {
        // Multi-join with COALESCE/CASE ordering and ::integer casts — kept as raw sql
        const result = await sql<{
            event_id: number;
            timestamp: string;
            budget_item_name: string;
            period_name: string | null;
            event_type: string;
            transaction_type: string;
            amount: string;
            description: string;
            user_name: string;
        }>`
            SELECT
                bpt.id as event_id,
                bpt.created_at as timestamp,
                bi.name as budget_item_name,
                bp.name as period_name,
                bpt.type as event_type,
                bpt.transaction_type,
                bpt.amount,
                bpt.description,
                COALESCE(u.first_name || ' ' || u.last_name, u.email, 'System') as user_name
            FROM budget_period_transactions bpt
            JOIN budget_items bi ON bpt.budget_item_id = bi.id
            LEFT JOIN budget_period_items bpi ON bpt.budget_period_item_id = bpi.id
            LEFT JOIN budget_period bp ON bpi.budget_period_id = bp.id
            LEFT JOIN users u ON bpt.user_id = u.id
            WHERE (${budgetItemId}::integer IS NULL OR bpt.budget_item_id = ${budgetItemId})
              AND (${periodId}::integer IS NULL OR bpi.budget_period_id = ${periodId})
            ORDER BY
                COALESCE(bp.year, 9999) DESC,
                COALESCE(bp.month_number, 12) DESC,
                CASE bpt.type
                    WHEN 'starting_balance' THEN 1
                    WHEN 'budget_update' THEN 2
                    WHEN 'transfer' THEN 3
                    ELSE 4
                END,
                bpt.created_at ASC,
                -- Events recorded in one statement share created_at: id keeps them in the
                -- order they were recorded, the same on every read.
                bpt.id ASC
            LIMIT ${limit}
        `.execute(getDb());

        return result.rows.map(row => ({
            eventId: row.event_id,
            timestamp: row.timestamp,
            budgetItemName: row.budget_item_name,
            periodName: row.period_name || 'Unknown',
            eventType: row.event_type,
            transactionType: row.transaction_type,
            amount: parseFloat(row.amount) || 0,
            description: row.description,
            userName: row.user_name
        }));
    }

}

export default BudgetService;
