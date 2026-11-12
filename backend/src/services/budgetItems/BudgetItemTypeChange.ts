import { getDb } from '../../db/withTenant.js';
import { createLogger } from '../../utils/logger.js';
import { centsToAmount, centsToNumber } from '../../utils/money.js';
import { TYPE_CHANGE_SOURCE } from '../BudgetService.js';
import { DomainError } from '../domainErrors.js';
import {
  BudgetItemArchiveError, currentPeriodItem, dropOpenBillDueDates, envelopeBalance, hasHistoryBeforeCurrentPeriod, remainingCents,
} from './BudgetItemArchiveService.js';
import { tenantMoneyText } from '../tenantMoneyFormat.js';

const logger = createLogger({ service: 'BudgetItemTypeChange' });

/**
 * A change of whether an item rolls over, refused because the item has history:
 * money recorded in a period before the current one. 409 ROLLOVER_LOCKED.
 */
export class RolloverLockedError extends DomainError {
  constructor(name: string) {
    super(
      409,
      'ROLLOVER_LOCKED',
      `${name} has money recorded in an earlier period (a budget change or a transaction in a period before this one), ` +
        'so whether it rolls over can’t change: that would change what those periods show. ' +
        'Keep it as it is, or make a new budget item for the new way.',
    );
  }
}

interface Before {
  id: number;
  name: string;
  rollover: boolean | null;
  isbill: boolean | null;
}

interface Changes {
  rollover?: unknown;
  isbill?: unknown;
}

/**
 * Changing what kind of budget item something is (monthly ↔ envelope, expense
 * ↔ bill) without breaking its history. Whether an item rolls over is read
 * live by the budget functions, so flipping it re-reads every past period:
 *
 * - envelope → monthly would make its balance vanish, so it's refused while
 *   the envelope holds money (transfer it first, as for archiving);
 * - monthly → envelope would turn every past month's leftover or overspend
 *   into the new envelope's balance, so a carry-over event resets it to what
 *   this month had left. That fixes this month and the ones after it; a
 *   period before it, viewed afterwards, shows the running balance as if the
 *   item had always been an envelope (accepted, not stored);
 * - bill → not a bill drops its open due dates ahead; past ones stay, and come
 *   back if it becomes a bill again.
 *
 * Call {@link before} ahead of the UPDATE and {@link after} once it's done,
 * inside the same transaction.
 */
export class BudgetItemTypeChange {
  /** The month's leftover as a monthly item, in cents, and the row it is kept on. */
  private carry: { periodItemId: number; cents: number } | null = null;

  private constructor(private readonly item: Before, private readonly changes: Changes) {}

  static async before(item: Before, changes: Changes): Promise<BudgetItemTypeChange> {
    const change = new BudgetItemTypeChange(item, changes);
    // Once the item has history, whether it rolls over doesn't change at all, by
    // design: flipping it re-reads every past period.
    if ((change.turnsMonthly || change.turnsEnvelope) && await hasHistoryBeforeCurrentPeriod(item.id)) {
      throw new RolloverLockedError(item.name);
    }
    if (change.turnsMonthly) {
      const balance = await envelopeBalance(item.id);
      if (balance !== 0) {
        throw new BudgetItemArchiveError(
          `${item.name} holds ${await tenantMoneyText(balance)}. Transfer it to another budget item first; only an empty envelope can become a monthly item.`,
          409,
        );
      }
    }
    if (change.turnsEnvelope) {
      const periodItemId = await currentPeriodItem(item.id);
      if (periodItemId != null) change.carry = { periodItemId, cents: await remainingCents(periodItemId) };
    }
    return change;
  }

  private get turnsMonthly(): boolean {
    return this.item.rollover === true && this.changes.rollover === false;
  }

  private get turnsEnvelope(): boolean {
    return this.item.rollover !== true && this.changes.rollover === true;
  }

  private get stopsBeingBill(): boolean {
    return this.item.isbill === true && this.changes.isbill === false;
  }

  async after(userId: number): Promise<void> {
    if (this.carry) {
      // As an envelope its remaining now sums every period so far; one event
      // brings it back to what this month had left as a monthly item. In cents
      // (utils/money.ts); the log line names the item and whether an event was
      // booked, not the amounts.
      const { periodItemId, cents } = this.carry;
      const adjustment = cents - await remainingCents(periodItemId);
      if (adjustment !== 0) {
        await getDb().insertInto('budget_period_transactions').values({
          budget_period_item_id: periodItemId,
          budget_item_id: this.item.id,
          type: 'starting_balance',
          transaction_type: adjustment > 0 ? 'add' : 'remove',
          amount: centsToAmount(Math.abs(adjustment)),
          description: `Carried over ${await tenantMoneyText(centsToNumber(cents))} when ${this.item.name} became an envelope`,
          source_system: TYPE_CHANGE_SOURCE,
          user_id: userId,
        }).execute();
      }
      logger.info({ userId, budgetItemId: this.item.id, periodItemId, carriedOver: adjustment !== 0 }, 'Monthly budget item became an envelope');
    }
    if (this.stopsBeingBill) {
      await dropOpenBillDueDates(this.item.id);
      logger.info({ userId, budgetItemId: this.item.id }, 'Budget item is no longer a bill');
    }
  }
}
