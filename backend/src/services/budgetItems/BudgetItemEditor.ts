import { sql, type Insertable, type Selectable } from 'kysely';
import { BUDGET_ITEM_WRITABLE_FIELDS, budgetExpenseType, budgetPriority } from '@nuggets/shared';
import type { DB } from '../../db/schema.generated.js';
import { getDb } from '../../db/withTenant.js';
import { DomainError } from '../domainErrors.js';
import { createLogger } from '../../utils/logger.js';
import { toCents } from '../../utils/money.js';
import { BudgetChangeError, BudgetService } from '../BudgetService.js';
import { BudgetItemTypeChange } from './BudgetItemTypeChange.js';
import { applyBudgetItemAutoTags } from '../tags/TaggingService.js';
import { asId, firstMissingReference, missingReferenceError, type TenantReferenceField } from '../tenantReferences.js';
import { isLockConflict } from '../transactions/locks.js';

const logger = createLogger({ service: 'BudgetItemEditor' });

/**
 * Listing, creating and editing budget items: the item's own fields, and what a change to
 * them means for its envelope. The envelope's money is event-sourced, so a starting
 * balance or its date is never written to a period item: BudgetService appends the event
 * of the difference, or moves the starting balance to its period. A change of kind
 * (envelope ↔ monthly, bill ↔ not) goes through BudgetItemTypeChange.
 *
 * Runs on the request's tenant transaction (getDb()). A refusal is one of the errors
 * below, thrown before or during the writes, so the caller's transaction rolls them back.
 */

/** The item isn't there, or is another ledger's: a 404. */
export class BudgetItemNotFoundError extends DomainError {
  constructor() {
    super(404, 'NOT_FOUND', 'Budget item not found');
  }
}

/** A value the item can't hold (an expense type or priority outside the vocabulary, a starting balance that isn't an amount): a 400 with the reason. */
export class BudgetItemValidationError extends DomainError {
  constructor(message: string) {
    super(400, 'BAD_REQUEST', message);
  }
}

/** A category, merchant or auto-tag id that names no row of this ledger: 400 INVALID_REFERENCE, naming the field. */
export class BudgetItemReferenceError extends DomainError {
  constructor(name: TenantReferenceField = 'category_id') {
    const { error, code, field } = missingReferenceError(name);
    super(400, code, error, { field });
  }
}

/**
 * Check the item's category, merchant and auto-tag are the ledger's, and hold them (FOR KEY
 * SHARE) until the write: a delete of one running at once then waits for this request and
 * finds it in use (a category's or a merchant's), or clears the new link with the rest (a
 * tag's, ON DELETE SET NULL); or this request waits for the delete and answers 400, not the
 * write's 23503, a 500.
 *
 * None is null: the budget item forms send null for no category, merchant or auto-tag. Empty
 * text is refused, 400 INVALID_REFERENCE, as any other id that names nothing:
 * firstMissingReference passes '' as unset (a multipart form's empty field), and the write
 * then failed on it, 22P02 "invalid input syntax for type integer", a 500.
 */
async function refuseMissingReferences(refs: Partial<Record<'category_id' | 'merchant_id' | 'transaction_auto_tag_id', unknown>>): Promise<void> {
  const empty = (Object.keys(refs) as Array<keyof typeof refs>).find((field) => refs[field] === '');
  if (empty) throw new BudgetItemReferenceError(empty);
  const missing = await firstMissingReference(refs, { lock: true });
  if (missing) throw new BudgetItemReferenceError(missing);
}

/** An update that names none of the fields an item has: a 400. */
export class BudgetItemNoValidFieldsError extends DomainError {
  constructor() {
    super(400, 'BAD_REQUEST', 'No valid fields to update');
  }
}

export const STARTING_BALANCE_INVALID = 'rollover_starting_balance must be an amount with at most 2 decimal places';

// A budget item's optional calendar dates: a form left empty sends '' for them, and '' isn't a date.
const OPTIONAL_DATE_FIELDS = ['rollover_target_date', 'rollover_starting_balance_date', 'recurring_next_payment_date'];

/**
 * The fields an update may change; anything else in the body is ignored. The list is
 * `@nuggets/shared`'s, which types what the frontend sends (BudgetItemRequest).
 */
const UPDATABLE_FIELDS: readonly string[] = BUDGET_ITEM_WRITABLE_FIELDS;

/** A starting balance in cents: none is 0, and null is what isn't an amount. */
function startingBalanceCents(value: unknown): number | null {
  return value == null ? 0 : toCents(value);
}

/** The starting balance in cents, or a BudgetItemValidationError for one that isn't an amount. */
function requiredStartingCents(value: unknown): number {
  const cents = startingBalanceCents(value);
  if (cents === null) throw new BudgetItemValidationError(STARTING_BALANCE_INVALID);
  return cents;
}

/** An update's fields as the client sends them: updateBudgetItem checks their vocabulary and keeps the UPDATABLE_FIELDS. */
export type BudgetItemFields = Record<string, unknown>;

/**
 * A new budget item's columns. budgetItemCreateSchema (shared) checked its name and
 * vocabulary; the rest go to the INSERT as the client sent them, for the database to check.
 */
export type BudgetItemCreateFields = Insertable<DB['budget_items']>;

/** Every budget item of the ledger with its category's name, by type (descending), then name. */
export async function listBudgetItems(): Promise<Record<string, unknown>[]> {
  // Raw sql: bi.* alongside a joined column.
  const { rows } = await sql<Record<string, unknown>>`
    SELECT bi.*, c.name as category_name
    FROM budget_items bi
    LEFT JOIN categories c ON bi.category_id = c.id
    ORDER BY bi.type DESC, bi.name
  `.execute(getDb());
  return rows;
}

/**
 * Create a budget item, with a period item in every existing period, and its envelope's
 * starting balance as an event when it rolls over.
 */
export async function createBudgetItem(fields: BudgetItemCreateFields, userId: number): Promise<Selectable<DB['budget_items']>> {
  const {
    name,
    description,
    expense_type,
    priority,
    type,
    subtype,
    rollover,
    isbill,
    recurring_payment,
    recurring_payment_frequency,
    recurring_payment_amount,
    recurring_next_payment_date,
    default_budget_amount,
    rollover_target_amount,
    rollover_target_date,
    recurring_amount_varies,
    rollover_starting_balance,
    rollover_starting_balance_date,
    category_id,
    merchant_id,
    transaction_auto_tag_id,
    color,
    icon,
    instructions,
    notes
  } = fields;

  const startingCents = requiredStartingCents(rollover_starting_balance);
  await refuseMissingReferences({ category_id, merchant_id, transaction_auto_tag_id });

  const budgetItem = await getDb()
    .insertInto('budget_items')
    .values({
      name,
      description,
      expense_type,
      priority,
      type,
      subtype,
      rollover,
      isbill,
      recurring_payment,
      recurring_payment_frequency,
      recurring_payment_amount,
      recurring_next_payment_date: recurring_next_payment_date || null,
      default_budget_amount,
      rollover_target_amount,
      rollover_target_date: rollover_target_date || null,
      recurring_amount_varies: recurring_amount_varies === true,
      rollover_starting_balance,
      rollover_starting_balance_date: rollover_starting_balance_date || null,
      category_id,
      merchant_id,
      // The Add page sends the auto-tag it chose; it was left out, so the new item had none.
      // A new item has no transactions yet to apply it to.
      transaction_auto_tag_id,
      color,
      icon,
      instructions: instructions || null,
      // The forms have a Notes field; it was left out here and on update, so what was typed went nowhere.
      notes: notes || null
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  // A period item for every existing period, in one batched insert. UNNEST
  // expands the period-id array into one row per period.
  const periods = await getDb()
    .selectFrom('budget_period')
    .select('id')
    .orderBy('year')
    .orderBy('month_number')
    .execute();
  if (periods.length > 0) {
    const periodIds = periods.map((p) => p.id);
    await sql`
      INSERT INTO budget_period_items (budget_period_id, budget_item_id, starting)
      SELECT p, ${budgetItem.id}, 0 FROM UNNEST(${periodIds}::int[]) AS p
    `.execute(getDb());
  }

  // An envelope's starting balance is an event in the log, which is what its
  // balance is computed from; budget_period_items.starting isn't read.
  if (budgetItem.rollover) {
    await new BudgetService().changeStartingBalance(budgetItem, 0, startingCents, userId);
  }
  return budgetItem;
}

/**
 * Update a budget item with the fields sent (under the item's row lock, in the
 * caller's transaction, so concurrent edits serialize and a failure part way leaves
 * nothing half done):
 *
 * - an expense type or priority outside the vocabulary is refused, unless it is the
 *   value the item already holds (an older item may hold a legacy one);
 * - a changed starting balance appends the difference to the log;
 * - a new starting-balance date moves the starting balance to its period;
 * - a new auto-tag rule is applied to the item's transactions already there.
 *
 * The lock is FOR UPDATE: a write that references the item (a transaction written with it, a
 * budget change or a transfer of its money: their foreign key checks take FOR KEY SHARE) waits
 * for the edit, and the edit for one under way, so a change of kind reads the item's money whole
 * (BudgetItemTypeChange: a carry-over read twice, a balance that must be empty). So a bank sync,
 * which holds the account's transactions while it inserts a row of the item, waits for an edit
 * too, and an edit that then waited for one of the sync's rows would deadlock with it;
 * Postgres fails one side: the sync's row, which the next sync imports, or the edit,
 * answered 409 RECORD_BUSY, as a lock it couldn't get in time is. None of the edit's own writes
 * waits for a sync's row today (it locks the item's transactions FOR KEY SHARE, for auto-tags,
 * which a sync's FOR NO KEY UPDATE doesn't block).
 */
export async function updateBudgetItem(uuid: string, updates: BudgetItemFields, userId: number): Promise<Selectable<DB['budget_items']>> {
  try {
    return await updateLockedBudgetItem(uuid, updates, userId);
  } catch (err) {
    if (!isLockConflict(err)) throw err;
    logger.warn({ err, uuid }, 'A budget item edit could not lock what it changes in time; nothing saved');
    throw new BudgetChangeError(409, 'RECORD_BUSY', 'Another change to this budget item was being saved at the same time, so nothing was saved. Try again.');
  }
}

/** {@link updateBudgetItem}'s work, under the item's lock. */
async function updateLockedBudgetItem(uuid: string, updates: BudgetItemFields, userId: number): Promise<Selectable<DB['budget_items']>> {
  const startingCents = requiredStartingCents(updates.rollover_starting_balance);
  const budgetService = new BudgetService();
  const trx = getDb();

  const currentItem = await trx
    .selectFrom('budget_items')
    .selectAll()
    .where('uuid', '=', uuid)
    .forUpdate()
    .executeTakeFirst();
  if (!currentItem) {
    logger.warn({ uuid }, 'Budget item update failed: not found');
    throw new BudgetItemNotFoundError();
  }

  // A value the database refuses is a 400 here, not a failed statement. One sent back
  // unchanged is allowed, as the database allows it: older items may hold a legacy one.
  for (const [field, allowed] of [['expense_type', budgetExpenseType], ['priority', budgetPriority]] as const) {
    const value = updates[field];
    if (field in updates && value !== currentItem[field] && !(field === 'priority' && value === null) && !allowed.safeParse(value).success) {
      throw new BudgetItemValidationError(`${field} must be one of: ${allowed.options.join(', ')}`);
    }
  }

  const updateValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (UPDATABLE_FIELDS.includes(key)) {
      // A cleared date input sends '', which isn't a date.
      updateValues[key] = OPTIONAL_DATE_FIELDS.includes(key) && value === '' ? null : value;
    }
  }
  if (Object.keys(updateValues).length === 0) {
    logger.warn({ uuid, providedFields: Object.keys(updates) }, 'Budget item update failed: no valid fields');
    throw new BudgetItemNoValidFieldsError();
  }
  // After the item's own lock, as a category delete takes only the category's. A merchant or an
  // auto-tag is checked only when it changes: the foreign key doesn't check one sent back
  // unchanged either, and a merchant delete with a replacement locks the merchant and then moves
  // the items naming it, so locking an unchanged one here, under the item's lock, could deadlock
  // with it.
  const changed = (field: 'merchant_id' | 'transaction_auto_tag_id') => {
    const value = updateValues[field];
    const id = asId(value);
    // What isn't an id is checked (and refused) whatever the item holds.
    return id === null || id !== currentItem[field] ? value : undefined;
  };
  await refuseMissingReferences({
    category_id: updateValues.category_id,
    merchant_id: changed('merchant_id'),
    transaction_auto_tag_id: changed('transaction_auto_tag_id'),
  });

  const typeChange = await BudgetItemTypeChange.before(currentItem, updateValues);

  logger.debug({ uuid, fieldsToUpdate: Object.keys(updateValues).length }, 'Executing budget item UPDATE query');
  const updatedItem = await trx
    .updateTable('budget_items')
    .set(updateValues)
    .where('uuid', '=', uuid)
    .returningAll()
    .executeTakeFirst();
  if (!updatedItem) {
    logger.error({ uuid }, 'Budget item update failed: no rows returned after UPDATE');
    throw new BudgetItemNotFoundError();
  }

  await typeChange.after(userId);

  // A changed starting balance adds the difference to the log; the events already
  // there stay as they are. The stored value is a NUMERIC string and the request's a
  // number, so they're compared in cents. As on create, it counts for an item that rolls over.
  if (updates.rollover_starting_balance !== undefined && updatedItem.rollover) {
    const before = startingBalanceCents(currentItem.rollover_starting_balance) ?? 0;
    if (before !== startingCents) {
      logger.info({ budgetItemId: updatedItem.id, userId }, 'Budget starting balance changed');
      await budgetService.changeStartingBalance(updatedItem, before, startingCents, userId);
    }
  }

  // A new starting-balance date moves the starting balance to its period. Only a new
  // date moves the events; a cleared one leaves them where they are.
  const newStartingDate = updateValues.rollover_starting_balance_date;
  if (typeof newStartingDate === 'string' && currentItem.rollover_starting_balance_date !== newStartingDate) {
    logger.info({
      budgetItemId: updatedItem.id,
      oldDate: currentItem.rollover_starting_balance_date,
      newDate: newStartingDate,
      userId
    }, 'Budget starting balance date changed');
    await budgetService.moveStartingBalance(updatedItem, newStartingDate, userId);
  }

  // A new auto-tag rule applies to the item's transactions already there, in one
  // set-based call.
  if (updates.transaction_auto_tag_id !== undefined &&
      currentItem.transaction_auto_tag_id !== updates.transaction_auto_tag_id) {
    logger.info({
      budgetItemId: updatedItem.id,
      oldTagId: currentItem.transaction_auto_tag_id,
      newTagId: updates.transaction_auto_tag_id,
      userId
    }, 'Budget item auto-tag rule changed, applying retroactive auto-tagging');

    // Its transactions locked first: a 409 TRANSACTION_BUSY behind Delete Transactions.
    const autoTagged = await applyBudgetItemAutoTags(updatedItem.id);
    logger.info({ budgetItemId: updatedItem.id, transactionsUpdated: autoTagged }, 'Applied retroactive auto-tags to transactions');
  }

  return updatedItem;
}
