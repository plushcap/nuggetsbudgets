import { sql } from 'kysely';
import type { BudgetItemUsage, LinkedGoal } from '@nuggets/shared';
import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { centsToAmount, numericToCents } from '../../utils/money.js';
import { MERGE_SOURCE, lockBudgetItemRows } from '../BudgetService.js';
import { moveEnvelopeLinks } from '../GoalService.js';
import { isLockConflict, lockTransactions } from '../transactions/locks.js';
import { ControlPlaneError } from '../controlPlaneErrors.js';
import { DomainError, defaultErrorCode } from '../domainErrors.js';
import { oneRow } from '../../utils/present.js';
import { tenantMoneyText } from '../tenantMoneyFormat.js';
import { budgetExpenseType, budgetItemStatus, mergeUnlinksGoalsMessage } from '@nuggets/shared';

const logger = createLogger({ service: 'BudgetItemArchiveService' });

// Every query here also runs under RLS; naming the tenant as well keeps a role
// that bypasses RLS (the CI database role is a superuser) from mixing tenants.
export const currentTenant = sql<number>`current_setting('app.current_tenant_id', true)::int`;

/** A retirement or change of kind the item's money doesn't allow, or an item that isn't there: answered `{ error, code, message }` with its status. */
export class BudgetItemArchiveError extends DomainError {
  constructor(message: string, status: 400 | 404 | 409) {
    super(status, defaultErrorCode(status), message);
  }
}

/** Run `lock`; a wait past the lock timeout, or a deadlock, is a 409 to try again (nothing merged, archived or restored). */
async function lockOrBusy(lock: () => Promise<void>, done: 'merged' | 'archived' | 'restored' = 'merged'): Promise<void> {
  try {
    await lock();
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    const what = { merged: 'merge', archived: 'archive', restored: 'restore' }[done];
    logger.warn({ err }, `A budget item ${what} could not lock its items, budget periods or goals in time; nothing ${done}`);
    throw new ControlPlaneError(
      409,
      'RECORD_BUSY',
      `Another change to these budget items or their budget periods was being saved at the same time, so nothing was ${done}. Try again.`
    );
  }
}

/** pg returns NUMERIC as a string. */
export function money(value: string | number | null | undefined): number {
  return value == null ? 0 : Math.round(Number(value) * 100) / 100;
}

interface Item {
  id: number;
  uuid: string;
  name: string;
  status: string | null;
  rollover: boolean | null;
  expense_type: string | null;
}
/** An envelope's balance: its remaining in the latest period (envelope remaining is cumulative). */
export async function envelopeBalance(itemId: number): Promise<number> {
  const { rows } = await sql<{ remaining: string | null }>`
    SELECT calculate_remaining_for_period_item(bpi.id) AS remaining
      FROM budget_period_items bpi
      JOIN budget_period bp ON bp.id = bpi.budget_period_id
     WHERE bpi.budget_item_id = ${itemId}
       AND bpi.tenant_id = ${currentTenant}
     ORDER BY bp.start_date DESC
     LIMIT 1
  `.execute(getDb());
  return money(rows[0]?.remaining);
}

/** The item's row in the period today falls in (or the latest one, when none has started). */
export async function currentPeriodItem(itemId: number): Promise<number | null> {
  const { rows } = await sql<{ id: number }>`
    SELECT bpi.id
      FROM budget_period_items bpi
      JOIN budget_period bp ON bp.id = bpi.budget_period_id
     WHERE bpi.budget_item_id = ${itemId}
       AND bpi.tenant_id = ${currentTenant}
     ORDER BY (bp.start_date <= app_today()) DESC, bp.start_date DESC
     LIMIT 1
  `.execute(getDb());
  return rows[0]?.id ?? null;
}

/**
 * A merge of an envelope a goal links, or once linked, into an item that doesn't roll over
 * is refused by design: a goal counts only envelopes, so its readings would lose the merged
 * item's money. 409 MERGE_UNLINKS_GOALS, naming the goals (`goals`).
 */
export class MergeUnlinksGoalsError extends DomainError {
  constructor(itemName: string, intoName: string, goals: LinkedGoal[]) {
    super(409, 'MERGE_UNLINKS_GOALS', mergeUnlinksGoalsMessage(itemName, intoName, goals), { goals });
  }
}

/**
 * The goals that link the item, now or before (any range), each once (by id: two goals may share
 * a name), by name. A deleted goal (archived: DELETE /api/goals/:uuid keeps its
 * links) is one of them, marked `deleted`.
 */
export async function linkedGoals(itemId: number): Promise<LinkedGoal[]> {
  const rows = await getDb()
    .selectFrom('budget_items as g')
    .select(['g.uuid', 'g.name', 'g.status'])
    .where((eb) => eb.exists(eb.selectFrom('goal_budget_items as gbi').select('gbi.id').whereRef('gbi.goal_id', '=', 'g.id').where('gbi.budget_item_id', '=', itemId)))
    .orderBy('g.name')
    .orderBy('g.id')
    .execute();
  return rows.map((row) => ({ uuid: row.uuid, name: row.name, deleted: row.status === budgetItemStatus.enum.archived }));
}

/**
 * Whether the item has history: money recorded in a period before the current
 * one, a budget event of more than 0 or a transaction the figures count (an expense or income,
 * not a split's parent, dated on or after the first period's start, as
 * calculate_actual_for_period_item counts them), in a period that starts before the current one. The current period
 * is the latest one that has started (start_date on or before app_today()); with none started,
 * nothing is before it. Whether an item rolls over is read live by the budget functions, so
 * changing it once there is history would change what those periods show.
 */
export async function hasHistoryBeforeCurrentPeriod(itemId: number): Promise<boolean> {
  const { rows } = await sql<{ history: boolean }>`
    WITH current_period AS (
      SELECT MAX(bp.start_date) AS start_date FROM budget_period bp WHERE bp.start_date <= app_today()
    )
    SELECT EXISTS (
             SELECT 1
               FROM budget_period_transactions bpt
               JOIN budget_period_items bpi ON bpi.id = bpt.budget_period_item_id
               JOIN budget_period bp ON bp.id = bpi.budget_period_id
              WHERE bpi.budget_item_id = ${itemId}
                AND bpt.amount <> 0
                AND bp.start_date < (SELECT start_date FROM current_period)
           ) OR EXISTS (
             SELECT 1
               FROM transactions t
               JOIN budget_period bp ON bp.id = t.budget_period_id
              WHERE t.budget_item_id = ${itemId}
                AND t.amount <> 0
                AND t.type IN ('expense', 'income')
                AND NOT COALESCE(t.is_split_parent, false)
                -- As calculate_actual_for_period_item counts: none dated before the first period
                -- starts (one filed in that period locked an item whose figures read 0).
                AND t.transaction_date >= (SELECT MIN(first.start_date) FROM budget_period first)
                AND bp.start_date < (SELECT start_date FROM current_period)
           ) AS history
  `.execute(getDb());
  return rows[0]?.history === true;
}

/** A period item's remaining, as the budget page shows it, in cents. */
export async function remainingCents(periodItemId: number): Promise<number> {
  const { rows } = await sql<{ remaining: string | null }>`
    SELECT calculate_remaining_for_period_item(${periodItemId}::int) AS remaining
  `.execute(getDb());
  return numericToCents(rows[0]?.remaining);
}

/**
 * What a merge's correcting event on the target's current row has to add to the target's
 * balance (remaining), in cents: what the merged item has left this month, less what its rows
 * add to the target's balance this month once they are the target's.
 *
 * Both come from the merged item's own rows, read in one statement before anything moves, and
 * never from the target's balance: a merge that read the target's live
 * remaining before and after the move undid any change to the target's history committed in
 * between (a transfer, a budget change or a transaction in an earlier period, which the merge
 * doesn't lock), and so created or lost that money. A row of the merged item written after
 * this read moves without counting here, so it counts in the target's balance as it would on
 * the target.
 *
 * What the rows add mirrors calculate_remaining_for_period_item's rollover branch (the target
 * rolls over): the budget events (budget_update, starting_balance, transfer) and the spending
 * (expense, income since the first period) of the periods that start no later than the
 * target's current one; for income, actual less budget.
 *
 * What the merged item has left is read from its row in the same periods: its latest one that
 * starts no later than the target's current one, or nothing (0) when it has none. Its own
 * current row was read before, which for an item with no row in a period that
 * has started is its latest, a future one: its money there was booked into the target this
 * month and moved with that row too, counted twice from then on (T 80.00 now and 110.00 next
 * month, where 50.00 and 80.00).
 */
async function mergeShortfallCents(item: Item, into: Item, intoPeriodItem: number): Promise<number> {
  const { rows: readRows } = await sql<{ item_left: string | null; moved_budget: string; moved_actual: string }>`
    WITH cutoff AS (
      SELECT bp.start_date
        FROM budget_period_items bpi
        JOIN budget_period bp ON bp.id = bpi.budget_period_id
       WHERE bpi.id = ${intoPeriodItem}::int
    ), item_row AS (
      SELECT bpi.id
        FROM budget_period_items bpi
        JOIN budget_period bp ON bp.id = bpi.budget_period_id
       WHERE bpi.budget_item_id = ${item.id}
         AND bpi.tenant_id = ${currentTenant}
         AND bp.start_date <= (SELECT start_date FROM cutoff)
       ORDER BY bp.start_date DESC
       LIMIT 1
    )
    SELECT
      COALESCE((SELECT calculate_remaining_for_period_item(id) FROM item_row), 0) AS item_left,
      (SELECT COALESCE(SUM(CASE WHEN bpt.transaction_type IN ('add', 'move_in') THEN bpt.amount
                                WHEN bpt.transaction_type IN ('remove', 'move_out') THEN -bpt.amount
                                ELSE 0 END), 0)
         FROM budget_period_transactions bpt
         JOIN budget_period_items bpi ON bpi.id = bpt.budget_period_item_id
         JOIN budget_period bp ON bp.id = bpi.budget_period_id
        WHERE bpt.budget_item_id = ${item.id}
          AND bpt.type IN ('budget_update', 'starting_balance', 'transfer')
          AND bp.start_date <= (SELECT start_date FROM cutoff)) AS moved_budget,
      (SELECT COALESCE(SUM(t.amount), 0)
         FROM transactions t
         JOIN budget_period bp ON bp.id = t.budget_period_id
        WHERE t.budget_item_id = ${item.id}
          AND t.type IN ('expense', 'income')
          AND t.transaction_date >= (SELECT MIN(start_date) FROM budget_period)
          AND bp.start_date <= (SELECT start_date FROM cutoff)) AS moved_actual
  `.execute(getDb());
  const read = oneRow(readRows, 'the envelope figures');
  const movedBudget = numericToCents(read.moved_budget);
  const movedActual = numericToCents(read.moved_actual);
  const added = into.expense_type === budgetExpenseType.enum.Income ? movedActual - movedBudget : movedBudget + movedActual;
  return numericToCents(read.item_left) - added;
}

/** Drop an item's bill due dates from today on that nothing has paid or decided. */
export async function dropOpenBillDueDates(itemId: number): Promise<void> {
  await sql`
    DELETE FROM bill_occurrences o
     WHERE o.budget_item_id = ${itemId}
       AND o.due_date >= app_today()
       AND o.resolution IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM bill_occurrence_transactions l
              WHERE l.bill_occurrence_id = o.id AND l.matched_by <> 'excluded')
  `.execute(getDb());
}


/**
 * Retiring budget items without losing history.
 *
 * - archive: hidden from the budget page (except past periods it had activity
 *   in), from the budget-item pickers and from automatic matching; its
 *   transactions, budget events and rules stay. An envelope must be empty first.
 * - restore: back to active, with the periods it missed while archived.
 * - delete: only an item nothing references (no transactions, no budget
 *   history); anything else is archived instead.
 * - merge: move its transactions and budget events, and optionally its
 *   matching rules, to another item, then archive it.
 */
export class BudgetItemArchiveService {
  private async item(uuid: string): Promise<Item> {
    const item = await getDb()
      .selectFrom('budget_items')
      .select(['id', 'uuid', 'name', 'status', 'rollover', 'expense_type'])
      .where('uuid', '=', uuid)
      .where('tenant_id', '=', currentTenant)
      .executeTakeFirst();
    if (!item) throw new BudgetItemArchiveError('Budget item not found', 404);
    return item;
  }

  private async balance(item: Item): Promise<number> {
    return item.rollover ? envelopeBalance(item.id) : 0;
  }

  async usage(uuid: string): Promise<BudgetItemUsage> {
    const item = await this.item(uuid);
    const { rows: countRows } = await sql<{
      transactions: string;
      first_date: string | null;
      last_date: string | null;
      rules: string;
      budget_periods: string;
      attachments: string;
    }>`
      SELECT
        (SELECT COUNT(*) FROM transactions WHERE budget_item_id = ${item.id}) AS transactions,
        (SELECT to_char(MIN(transaction_date), 'YYYY-MM-DD') FROM transactions WHERE budget_item_id = ${item.id}) AS first_date,
        (SELECT to_char(MAX(transaction_date), 'YYYY-MM-DD') FROM transactions WHERE budget_item_id = ${item.id}) AS last_date,
        (SELECT COUNT(*) FROM budget_item_matching_rules WHERE budget_item_id = ${item.id}) AS rules,
        (SELECT COUNT(DISTINCT budget_period_item_id) FROM budget_period_transactions WHERE budget_item_id = ${item.id}) AS budget_periods,
        (SELECT COUNT(*) FROM attachments WHERE budget_item_id = ${item.id}) AS attachments
    `.execute(getDb());
    const counts = oneRow(countRows, 'the usage counts');
    const transactions = Number(counts.transactions);
    const budgetPeriods = Number(counts.budget_periods);
    const attachments = Number(counts.attachments);
    return {
      transactions,
      first_transaction_date: counts.first_date,
      last_transaction_date: counts.last_date,
      rules: Number(counts.rules),
      budget_periods: budgetPeriods,
      balance: await this.balance(item),
      attachments,
      archived: item.status === budgetItemStatus.enum.archived,
      // Its attachments keep it too: the database refuses deleting an item with receipts.
      can_delete: transactions === 0 && budgetPeriods === 0 && attachments === 0,
      // Whether it rolls over can't change once it has: the edit pages say so.
      history_before_current_period: await hasHistoryBeforeCurrentPeriod(item.id),
      // The goals that count it, now or before: a merge into an item that doesn't roll over is refused while there are any.
      linked_goals: await linkedGoals(item.id),
    };
  }

  private async refuseBalance(item: Item): Promise<void> {
    const balance = await this.balance(item);
    if (balance !== 0) {
      throw new BudgetItemArchiveError(
        `${item.name} still holds ${await tenantMoneyText(balance)}. Transfer it to another budget item first, then archive it.`,
        409,
      );
    }
  }

  /** Mark archived, and drop the bill due dates ahead of it that nothing has paid or decided. */
  private async markArchived(item: Item): Promise<void> {
    await getDb().updateTable('budget_items').set({ status: 'archived' }).where('id', '=', item.id).execute();
    await dropOpenBillDueDates(item.id);
  }

  /**
   * Archive an item whose envelope is empty. Its row is locked first (FOR NO KEY UPDATE), then
   * each of its period rows, in id order, and the balance is read under those locks, as a merge
   * reads it: a transfer or a budget change locks its period rows before it reads the
   * item's status, so one that started first is read whole here (and the item, still holding
   * money, refused), and one that starts after waits, then finds the item archived. Before, a
   * transfer committed between the balance check and the archiving left the archived item
   * holding its money. An item edit (a starting balance: FOR UPDATE) waits on the item's row, and
   * a period created meanwhile on the ledger's lockBudgetItemRows, taken first, so neither adds
   * money the check didn't see. A wait past the lock timeout is a 409 to try again, nothing
   * archived.
   */
  async archive(uuid: string, userId: number): Promise<void> {
    await lockBudgetItemRows('retire', 'nothing was archived');
    await lockOrBusy(async () => {
      await getDb().selectFrom('budget_items').select('id')
        .where('uuid', '=', uuid).where('tenant_id', '=', currentTenant)
        .forNoKeyUpdate().execute();
    }, 'archived');
    const item = await this.item(uuid);
    if (item.status === budgetItemStatus.enum.archived) return;
    await lockOrBusy(async () => {
      await sql`
        SELECT id FROM budget_period_items
         WHERE budget_item_id = ${item.id}::int AND tenant_id = ${currentTenant}
         ORDER BY id FOR NO KEY UPDATE
      `.execute(getDb());
    }, 'archived');
    await this.refuseBalance(item);
    await this.markArchived(item);
    logger.info({ userId, budgetItem: uuid }, 'Archived a budget item');
  }

  /**
   * Back to active, with a row in each period created while it was archived. The ledger's
   * budget item rows lock first, shared, as an archive and a merge take it:
   * a period being created holds it alone, so the restore waits for that period and then gives
   * the item a row in it, where it read the periods without the new one and left the item none
   * there (a transaction on it that month then counted in no budget figure). A period created
   * after waits for the restore and then gives the active item its row itself.
   */
  async restore(uuid: string, userId: number): Promise<void> {
    await lockBudgetItemRows('retire', 'nothing was restored');
    const item = await this.item(uuid);
    if (item.status !== budgetItemStatus.enum.archived) return;
    await getDb().updateTable('budget_items').set({ status: 'active' }).where('id', '=', item.id).execute();
    // The periods first, FOR KEY SHARE in id order, and a row in each of those: a
    // period deleted meanwhile (locked FOR UPDATE, then deleted) is waited for and left out, where
    // the insert read it, then failed its foreign key check on it once the delete committed, a
    // 500. A period delete that comes after waits for the restore, then deletes its new row too.
    let periodIds: number[] = [];
    await lockOrBusy(async () => {
      const { rows } = await sql<{ id: number }>`
        SELECT id FROM budget_period WHERE tenant_id = ${currentTenant} ORDER BY id FOR KEY SHARE
      `.execute(getDb());
      periodIds = rows.map((row) => row.id);
    }, 'restored');
    if (periodIds.length > 0) {
      await sql`
        INSERT INTO budget_period_items (budget_period_id, budget_item_id, starting)
        SELECT p, ${item.id}::int, 0 FROM UNNEST(${periodIds}::int[]) AS p
        ON CONFLICT ON CONSTRAINT budget_period_items_budget_period_id_budget_item_id_key DO NOTHING
      `.execute(getDb());
    }
    logger.info({ userId, budgetItem: uuid }, 'Restored a budget item');
  }

  /** Delete an item nothing references. Anything with history is refused: archive it instead. */
  async delete(uuid: string, userId: number): Promise<void> {
    const usage = await this.usage(uuid);
    if (!usage.can_delete) {
      const what = [
        usage.transactions > 0 && `${usage.transactions} transaction${usage.transactions === 1 ? '' : 's'}`,
        usage.budget_periods > 0 && `budgets in ${usage.budget_periods} period${usage.budget_periods === 1 ? '' : 's'}`,
        usage.attachments > 0 && `${usage.attachments} attachment${usage.attachments === 1 ? '' : 's'}`,
      ].filter(Boolean).join(' and ');
      throw new BudgetItemArchiveError(`This budget item has ${what}. Archive it instead, or merge it into another item.`, 409);
    }
    await getDb().deleteFrom('budget_items').where('uuid', '=', uuid).where('tenant_id', '=', currentTenant).execute();
    logger.info({ userId, budgetItem: uuid }, 'Deleted an unused budget item');
  }

  /**
   * Move every transaction of `uuid` and its budget events (and, when
   * `moveRules`, its matching rules) to `intoUuid`, then archive it. Each
   * period's budgets go with that period's spending (moving the
   * spending alone took an envelope's history out of the target's balance with
   * none of its funding). An envelope must be empty first, as for archiving.
   *
   * An envelope's balance is a running total, so taking in a monthly item's
   * past months would turn their leftovers into its balance; one event keeps
   * the target's balance this month to what it had plus what the merged item
   * had left this month, as a type change does. The event is worked out from the
   * merged item's rows alone (mergeShortfallCents), so a change to the target made
   * meanwhile stays as it was.
   *
   * A goal that links, or once linked, the merged item links the target on every day it
   * linked the merged item, open and closed ranges alike
   * (GoalService.moveEnvelopeLinks): the merged item's history is the target's now, so the
   * goal's past readings keep that money, now counting the target's own money on those days
   * too. Its open link to the merged item is closed today.
   *
   * The two items' rows are locked first (FOR NO KEY UPDATE, in id order), and read
   * under the lock: two merges of one item at once ran side by side, both answered
   * 200, and a goal that linked it ended up linking both targets. Now
   * the second waits for the first and finds the item archived: a 400, as merging
   * into an archived item is. NO KEY UPDATE, not FOR UPDATE: a transaction written
   * with this budget item (a foreign key, FOR KEY SHARE) doesn't wait for it, so a
   * transaction edit holding its row can't deadlock with the merge's transaction lock
   * below. An item edit, which locks the row FOR UPDATE and then its transactions,
   * takes them in the same order. A wait past the lock timeout is a 409, nothing merged.
   *
   * No row of either item appears while the merge runs: the merge takes the ledger's
   * lockBudgetItemRows first, shared, so a period created meanwhile (which takes it alone) waits
   * for the merge and leaves the archived item out, or the merge waits for it and sees its rows;
   * a restore updates the item's row, which the merge holds, so the merge waits for it, or finds
   * the item archived first.
   */
  async merge(uuid: string, intoUuid: string, moveRules: boolean, userId: number): Promise<{ transactions: number; rules: number }> {
    if (uuid === intoUuid) throw new BudgetItemArchiveError('Choose a different budget item to merge into.', 400);
    await lockBudgetItemRows('retire', 'nothing was merged');
    // With the goals that link the merged item, which moving their links locks
    // (moveEnvelopeLinks), in one id order: locked after the two items, a goal G linking
    // the merged item, being linked meanwhile to the target (associateBudgetItem locks G and the
    // target in id order), held G and waited for the target this held, while this waited for G,
    // a deadlock Postgres broke by failing one (a 409). Now the two wait at the first row they
    // share, holding none after it. The links are read again under the lock as they're moved; a
    // goal linking the merged item can't be added once it's locked (associateBudgetItem locks it).
    await lockOrBusy(async () => {
      await sql`
        SELECT id FROM budget_items
         WHERE tenant_id = ${currentTenant}
           AND (uuid IN (${uuid}::uuid, ${intoUuid}::uuid)
                OR id IN (SELECT gbi.goal_id
                            FROM goal_budget_items gbi
                            JOIN budget_items merged ON merged.id = gbi.budget_item_id
                           WHERE merged.uuid = ${uuid}::uuid))
         ORDER BY id FOR NO KEY UPDATE
      `.execute(getDb());
    });
    const item = await this.item(uuid);
    const into = await this.item(intoUuid);
    if (item.status === budgetItemStatus.enum.archived) {
      throw new BudgetItemArchiveError(`${item.name} is archived: it was merged or archived already. Restore it first to merge it.`, 400);
    }
    if (into.status === budgetItemStatus.enum.archived) throw new BudgetItemArchiveError(`${into.name} is archived. Restore it first, or merge into another item.`, 400);
    if ((item.expense_type === budgetExpenseType.enum.Income) !== (into.expense_type === budgetExpenseType.enum.Income)) {
      throw new BudgetItemArchiveError('Merge income into income, and expenses into expenses.', 400);
    }
    // A goal counts only envelopes, so merging an envelope a goal links (or once linked) into an
    // item that doesn't roll over would take its money out of the goal's history, so it is
    // refused. Read under the lock above, which holds every goal with a
    // link to the item, so none is linked meanwhile.
    if (into.rollover !== true) {
      const goals = await linkedGoals(item.id);
      if (goals.length > 0) throw new MergeUnlinksGoalsError(item.name, into.name, goals);
    }
    // The merged item's transactions are locked first, in id order, before anything is
    // written, as every write of several transactions locks them: a period delete
    // locks them, then its period items. Moving the budget events first took their rows and
    // a share lock on the target's period items before this lock, and deadlocked with such a
    // delete.
    await lockTransactions((eb) => eb('budget_item_id', '=', item.id));

    // Then the periods it writes into and reads, and both items' rows in them, in id order, as a
    // period delete locks the period and then its items (FOR UPDATE): with budget events in a
    // period but no transactions there, the two shared no transaction and still deadlocked (the
    // merge moving the events waited for the target's row the delete held), and a target row the
    // merge added could be committed between the delete's steps, which then failed on it.
    // The periods: each one the merged item has a row, a transaction or a budget event
    // in, and the target's current one.
    //
    // The rows FOR NO KEY UPDATE, as a transfer or a budget change locks them before it reads a
    // figure: the balance check and what the target keeps are read below from both items'
    // rows, and a transfer between the two committed between those reads was counted twice (T
    // ended with money from nowhere), or one committed after the events moved stayed on the
    // archived item. Now a transfer waits for the merge (and then finds the item archived), or the
    // merge for it (and reads it whole). A transaction written with either item references its
    // period item (FOR KEY SHARE), which this doesn't block. A wait past the lock timeout, or a
    // deadlock, is a 409 to try again.
    await lockOrBusy(async () => {
      const { rows } = await sql<{ id: number }>`
        SELECT DISTINCT p.budget_period_id AS id
          FROM (SELECT t.budget_period_id FROM transactions t WHERE t.budget_item_id = ${item.id}
                UNION
                SELECT bpi.budget_period_id FROM budget_period_items bpi WHERE bpi.budget_item_id = ${item.id}
                UNION
                SELECT bpi.budget_period_id
                  FROM budget_period_items bpi
                  JOIN budget_period_transactions bpt ON bpt.budget_period_item_id = bpi.id
                 WHERE bpt.budget_item_id = ${item.id}
                UNION
                (SELECT bpi.budget_period_id
                   FROM budget_period_items bpi
                   JOIN budget_period bp ON bp.id = bpi.budget_period_id
                  WHERE bpi.budget_item_id = ${into.id}
                  ORDER BY (bp.start_date <= app_today()) DESC, bp.start_date DESC
                  LIMIT 1)) p
         WHERE p.budget_period_id IS NOT NULL
      `.execute(getDb());
      const periodIds = rows.map((row) => row.id);
      if (periodIds.length === 0) return;
      await sql`SELECT id FROM budget_period WHERE id = ANY(${periodIds}::int[]) ORDER BY id FOR KEY SHARE`.execute(getDb());
      await sql`
        SELECT id FROM budget_period_items
         WHERE budget_period_id = ANY(${periodIds}::int[]) AND budget_item_id IN (${item.id}::int, ${into.id}::int)
         ORDER BY id FOR NO KEY UPDATE
      `.execute(getDb());
    });

    await this.refuseBalance(item);

    // The target needs a row in each period the moved transactions and budget events belong
    // to, or they'd land in it with no period item to show under, and in each period the
    // merged item has a row in, so it stays on the budget page wherever the merged item was
    // (a target with no row this month wasn't shown this month at all). Its rows in those
    // periods are new, so nothing else can write to them before the merge commits; the periods
    // were locked above.
    await sql`
      INSERT INTO budget_period_items (budget_period_id, budget_item_id, starting)
      SELECT DISTINCT p.budget_period_id, ${into.id}::int, 0
        FROM (SELECT t.budget_period_id FROM transactions t WHERE t.budget_item_id = ${item.id}
              UNION
              SELECT bpi.budget_period_id FROM budget_period_items bpi WHERE bpi.budget_item_id = ${item.id}
              UNION
              SELECT bpi.budget_period_id
                FROM budget_period_transactions bpt
                JOIN budget_period_items bpi ON bpi.id = bpt.budget_period_item_id
               WHERE bpt.budget_item_id = ${item.id}) p
       WHERE p.budget_period_id IS NOT NULL
      ON CONFLICT ON CONSTRAINT budget_period_items_budget_period_id_budget_item_id_key DO NOTHING
    `.execute(getDb());

    // How far the merged item's rows would move the target's balance this month from what it
    // had plus what the merged item had left this month, in cents (mergeShortfallCents). Read
    // once the target has its rows above, nothing moved yet: its current row is then the one its
    // balance is read from after the merge. Read before them, a target with no row this month
    // (a row only in P-2, the merged item's in P-1 and P0) kept its balance on its P-2 row, and
    // the rows it then took in counted the merged item's leftovers since (120.00, not 75.00).
    const intoPeriodItem = into.rollover ? await currentPeriodItem(into.id) : null;
    const shortfall = intoPeriodItem === null ? 0 : await mergeShortfallCents(item, into, intoPeriodItem);

    // Each budget event to the target's row in the same period. Its starting
    // balance isn't the target's own (which a new starting date moves).
    await sql`
      UPDATE budget_period_transactions bpt
         SET budget_item_id = ${into.id}::int, budget_period_item_id = target.id,
             source_system = CASE WHEN bpt.type = 'starting_balance' THEN ${MERGE_SOURCE} ELSE bpt.source_system END
        FROM budget_period_items source
        JOIN budget_period_items target
          ON target.budget_period_id = source.budget_period_id AND target.budget_item_id = ${into.id}::int
       WHERE bpt.budget_item_id = ${item.id}
         AND source.id = bpt.budget_period_item_id
    `.execute(getDb());

    // The consistency trigger moves each one's budget_period_item_id with it (locked above).
    const moved = await getDb()
      .updateTable('transactions')
      .set({ budget_item_id: into.id, updated_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('budget_item_id', '=', item.id)
      .executeTakeFirst();
    const rules = moveRules
      ? await getDb()
        .updateTable('budget_item_matching_rules')
        .set({ budget_item_id: into.id })
        .where('budget_item_id', '=', item.id)
        .executeTakeFirst()
      : undefined;

    // A goal that links the merged item now links the target from today on: its
    // money is the target's now, and the goal goes on counting it.
    // Each goal is locked as a change of its links locks it: one held past the lock timeout is
    // the merge's 409 to try again, nothing merged.
    let goals = 0;
    await lockOrBusy(async () => {
      goals = await moveEnvelopeLinks(item.id, into.id, { linkTarget: into.rollover === true });
    });
    if (goals > 0) logger.info({ budgetItemId: item.id, intoBudgetItemId: into.id, goals }, 'Moved goal links to the merge target');

    if (intoPeriodItem !== null) {
      // For income, budget counts against remaining (remaining = actual - budget).
      const budgetChange = into.expense_type === budgetExpenseType.enum.Income ? -shortfall : shortfall;
      if (budgetChange !== 0) {
        await getDb().insertInto('budget_period_transactions').values({
          budget_period_item_id: intoPeriodItem,
          budget_item_id: into.id,
          type: 'starting_balance',
          transaction_type: budgetChange > 0 ? 'add' : 'remove',
          amount: centsToAmount(Math.abs(budgetChange)),
          description: `Kept ${into.name}'s balance when ${item.name} was merged into it`,
          source_system: MERGE_SOURCE,
          user_id: userId,
        }).execute();
      }
    }

    await this.markArchived(item);
    const result = { transactions: Number(moved.numUpdatedRows), rules: Number(rules?.numUpdatedRows ?? 0) };
    logger.info({ userId, budgetItem: uuid, into: intoUuid, ...result }, 'Merged a budget item into another and archived it');
    return result;
  }
}
