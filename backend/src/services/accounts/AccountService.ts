import { sql } from 'kysely';
import type { UpdateObject } from 'kysely';
import type { DB } from '../../db/schema.generated.js';
import { getDb, withSavepoint } from '../../db/withTenant.js';
import { accountCreateSchema, accountUpdateSchemaFor, accountGroup as accountGroups, accountType as accountTypes, assetType, transactionReviewStatus, transactionStatus, transactionType } from '@nuggets/shared';
import type { z } from 'zod';
import { errorCode } from '../../utils/errors.js';
import { createLogger } from '../../utils/logger.js';
import { readCents, centsToAmount, centsToNumber, numericToCents, fitsAmount, invalidAmountAnswer, MAX_AMOUNT_TEXT } from '../../utils/money.js';
import { storeImage, imageUrl, deleteImageByUrl } from '../ImageService.js';
import { accountBalanceService } from '../AccountBalanceService.js';
import { BalanceRebalanceService } from '../BalanceRebalanceService.js';
import { AccountError, accountNotFound } from './AccountError.js';
import { accountIdByUuid } from './AccountQueries.js';
import { firstMissingReference, missingReferenceError } from '../tenantReferences.js';
import { holdDayRangesShared } from '../goalDayRanges.js';
import { tenantMoneyText } from '../tenantMoneyFormat.js';

const logger = createLogger({ service: 'AccountService' });

/** An uploaded account image: its bytes and the type the client claimed (storeImage checks both). */
export interface AccountImageUpload {
  mimeType: string;
  data: Buffer;
}

/** A body accountCreateSchema (shared) has validated and coerced. */
export type AccountCreateInput = z.infer<typeof accountCreateSchema>;

/**
 * Creating and changing a ledger's accounts: their fields, image, hiding and
 * closing, the opening balance, deleting one, and Adjust Balance.
 *
 * Everything runs on the request's tenant transaction (getDb()), so a refusal or a
 * failure part way rolls the whole change back. Balances are read through
 * AccountBalanceService; money is handled in whole cents. A refusal
 * the caller can act on is an {@link AccountError}, which the route wrapper answers.
 */

/** Only one account is the envelope account: clear the flag on the others. */
async function clearOtherEnvelopeAccounts(exceptUuid?: string): Promise<void> {
  let query = getDb()
    .updateTable('accounts')
    .set({ is_envelope_account: false })
    .where('is_envelope_account', '=', true);
  if (exceptUuid !== undefined) query = query.where('uuid', '!=', exceptUuid);
  await query.execute();
}

/** An asset account with `incomeCount` incomes can't become a liability: retype them first. */
function accountHasIncome(incomeCount: number): AccountError {
  const incomes = incomeCount === 1 ? '1 income' : `${incomeCount} incomes`;
  const them = incomeCount === 1 ? 'it' : 'them';
  return new AccountError(409, {
    error: `This account has ${incomes}, and a liability account takes no income. Change ${them} to a payment or an expense first (money paid toward a card or loan is a payment, a charge on it an expense), then make the account a liability.`,
    code: 'ACCOUNT_HAS_INCOME',
    incomeCount,
  });
}

/** Store an uploaded image (its type is taken from its bytes) and return the URL it's served at. */
async function storeAccountImage(image: AccountImageUpload, userId: number | null): Promise<string> {
  const uuid = await storeImage(getDb(), { mimeType: image.mimeType, data: image.data, createdByUserId: userId });
  return imageUrl(uuid);
}

/**
 * Check the account's institution is the ledger's, and hold it (FOR KEY SHARE) until the
 * write: an institution delete running at once then waits for this request and finds the
 * institution in use, or this request waits for the delete and answers 400
 * INVALID_REFERENCE, not the write's 23503, a 500.
 */
async function refuseMissingInstitution(institutionId: unknown): Promise<void> {
  if (await firstMissingReference({ institution_id: institutionId }, { lock: true })) {
    throw new AccountError(400, missingReferenceError('institution_id'));
  }
}

/**
 * Create an account. Its opening balance is an ordinary 'starting balance' transaction
 * in the same transaction: if that fails, the account isn't created. To change it
 * later, edit that transaction or use Adjust Balance.
 */
export async function createAccount(input: AccountCreateInput, image: AccountImageUpload | undefined, userId: number) {
  const {
    name,
    type,
    account_type,
    account_group,
    initial_balance,
    institution_id,
    account_number,
    routing_number,
    notes,
    instructions,
    icon,
    is_active,
    hide_transactions,
    hide_account,
    exclude_account_balance,
    is_envelope_account,
  } = input;

  // The opening balance in whole cents: one with more decimals, or too large for
  // an amount, is refused, not rounded, before anything is written.
  const opening = readCents(initial_balance ?? 0);
  if (!('cents' in opening)) throw new AccountError(400, invalidAmountAnswer('initial_balance', opening.problem));
  const openingCents = opening.cents;
  // The ledger's day-ranges lock, shared, as its first lock: the insert takes it
  // anyway (its trigger), but after the old envelope account's flag is cleared, a row a zone
  // change, holding the lock alone, waits for: each waited for the other.
  await holdDayRangesShared();
  await refuseMissingInstitution(institution_id);

  if (is_envelope_account) await clearOtherEnvelopeAccounts();

  const accountImagePath = image ? await storeAccountImage(image, userId) : null;

  const newAccount = await getDb()
    .insertInto('accounts')
    .values({
      name,
      account_type,
      account_group,
      type,
      institution_id,
      account_number,
      routing_number,
      notes,
      instructions: instructions || null,
      icon,
      close_account: !is_active,
      hide_transactions,
      hide_account,
      exclude_account_balance,
      account_image: accountImagePath,
      is_envelope_account,
      created_at: sql<Date>`NOW()`,
      updated_at: sql<Date>`NOW()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  if (openingCents !== 0) {
    await getDb()
      .insertInto('transactions')
      .values({
        account_id: newAccount.id,
        amount: centsToAmount(openingCents),
        description: 'Starting Balance',
        type: transactionType.enum['starting balance'],
        status: transactionStatus.enum.cleared,
        review_status: transactionReviewStatus.enum.reviewed,
        transaction_date: sql<string>`app_today()`,
        is_import: false,
      })
      .execute();
    logger.info({ accountId: newAccount.id, openingBalance: centsToNumber(openingCents), userId }, 'Recorded opening balance for new account');
  }
  await accountBalanceService.triggerNetWorthSnapshot();
  return newAccount;
}

/**
 * The group an account saved with the legacy group 'other' goes in, from its type. Any
 * other group is kept as it is.
 */
function mappedAccountGroup(accountGroup: string, accountType: string): string {
  if (accountGroup !== accountGroups.enum.other) return accountGroup;
  if (accountType === accountTypes.enum.credit_card || accountType === accountTypes.enum.other) return accountGroups.enum.credit_cards;
  if ([accountTypes.enum.checking, accountTypes.enum.savings, accountTypes.enum.cash].some((type) => type === accountType)) {
    return accountGroups.enum.cash;
  }
  if (accountType === accountTypes.enum.investment) return accountGroups.enum.investments;
  return accountGroups.enum.cash;
}

/** Why an account update's body was refused: the route answers it as an invalid body. */
export class AccountUpdateInvalidError extends Error {
  constructor(readonly zodError: z.ZodError) {
    super('Invalid account update');
    this.name = 'AccountUpdateInvalidError';
  }
}

/**
 * Update an account from the edit form: its fields, its classification, hiding it
 * (`hide_account`) or closing it (`is_active: false`), and a new image, which replaces and
 * deletes the old one. The opening balance isn't a field: it is a transaction,
 * so editing an account never changes its balance.
 */
export async function updateAccount(uuid: string, body: unknown, image: AccountImageUpload | undefined, userId: number) {
  // The ledger's day-ranges lock, shared, as its first lock: making this account
  // the envelope account clears the old one's flag, a row lock taken before this account's, and
  // a zone change, holding the lock alone, locks every account in id order: with this account's
  // id the lower, each waited for the other. Hiding or showing it writes a day range too.
  await holdDayRangesShared();
  // The row comes first: the body is validated against its classification, so an account
  // that holds a value outside today's enums (a legacy account_group, say) saves with that
  // value unchanged, while any other new value is refused.
  const stored = await getDb()
    .selectFrom('accounts')
    .select(['id', 'type', 'account_type', 'account_group', 'account_image'])
    .where('uuid', '=', uuid)
    .executeTakeFirst();
  if (!stored) {
    logger.warn({ uuid }, 'Account update failed: not found');
    throw accountNotFound();
  }
  const accountId = stored.id;

  const parsed = accountUpdateSchemaFor(stored).safeParse(body);
  if (!parsed.success) throw new AccountUpdateInvalidError(parsed.error);
  const {
    name,
    type,
    account_type,
    account_group,
    institution_id,
    account_number,
    routing_number,
    notes,
    instructions,
    icon,
    subtype,
    custom_sort,
    is_active,
    hide_transactions,
    hide_account,
    exclude_account_balance,
    is_envelope_account,
    require_zero_balance,
    default_pay_from_account_id,
  } = parsed.data;
  await refuseMissingInstitution(institution_id);

  // A liability account takes no income: the database refuses one on every write of a
  // transaction, but the check is on transactions only, so an asset account with
  // incomes made a liability kept them, each refused at its next edit. One already a
  // liability, with incomes from before that rule, saves as it is.
  //
  // The row is locked FOR UPDATE first: an income being added reads the account's
  // type FOR KEY SHARE (check_transaction_type_for_account), so this waits for it and then
  // counts it, and one added from now on waits for this edit and then reads 'Liability'.
  // Without it, each read the other's state from before it committed, and both went through.
  const becomesLiability =
    type === assetType.enum.Liability &&
    stored.type !== assetType.enum.Liability &&
    (await getDb().selectFrom('accounts').select('type').where('id', '=', accountId).forUpdate().executeTakeFirst())?.type !== assetType.enum.Liability;
  if (becomesLiability) {
    const { count } = await getDb()
      .selectFrom('transactions')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('account_id', '=', accountId)
      .where('type', '=', transactionType.enum.income)
      .where('parent_transaction_id', 'is', null)
      .executeTakeFirstOrThrow();
    const incomeCount = Number(count);
    if (incomeCount > 0) throw accountHasIncome(incomeCount);
  }

  if (is_envelope_account) {
    logger.debug({ uuid }, 'Setting as envelope account, clearing others');
    await clearOtherEnvelopeAccounts(uuid);
  }

  let accountImagePath: string | null = null;
  if (image) {
    accountImagePath = await storeAccountImage(image, userId);
    logger.debug({ uuid, imagePath: accountImagePath }, 'Account image uploaded');
  }

  const updateValues: UpdateObject<DB, 'accounts'> = {
    name,
    account_type,
    account_group: mappedAccountGroup(account_group, account_type),
    type,
    institution_id,
    account_number,
    routing_number,
    notes,
    icon,
    close_account: !is_active,
    hide_transactions,
    hide_account,
    exclude_account_balance,
    is_envelope_account,
    require_zero_balance,
    default_pay_from_account_id,
    subtype,
    custom_sort,
    updated_at: sql<Date>`NOW()`,
  };
  if (accountImagePath) updateValues.account_image = accountImagePath;
  // Only overwrite instructions when the caller sent them.
  if (instructions !== undefined) updateValues.instructions = instructions;

  logger.debug({ uuid, accountId }, 'Executing account UPDATE query');
  const updated = await getDb()
    .updateTable('accounts')
    .set(updateValues)
    .where('id', '=', accountId)
    .returningAll()
    .executeTakeFirst();
  if (accountImagePath) {
    // The image it replaced goes, in the same transaction, so it doesn't stay behind in
    // the database and every backup: unless a merchant or a goal of the ledger
    // shows it too. After the update, so the check no longer sees this account naming it.
    // No-op for none or a legacy /uploads path.
    await deleteImageByUrl(getDb(), stored.account_image);
  }
  return updated;
}

/**
 * Set only an account's `instructions` (the MCP server records per-account context with
 * it, without re-sending the other fields). null clears them.
 */
export async function setAccountInstructions(uuid: string, instructions: string | null) {
  const accountId = await accountIdByUuid(uuid);
  return getDb()
    .updateTable('accounts')
    .set({ instructions })
    .where('id', '=', accountId)
    .returning(['id', 'uuid', 'name', 'instructions', 'updated_at'])
    .executeTakeFirst();
}

/**
 * Delete an account that has nothing but its opening balance. One with other transactions
 * is refused (400): hiding it keeps its history.
 */
export async function deleteAccount(uuid: string): Promise<{ name: string }> {
  const accountId = await accountIdByUuid(uuid);

  const account = await getDb()
    .selectFrom('accounts')
    .select('name')
    .where('id', '=', accountId)
    .executeTakeFirstOrThrow();

  // The opening balance is a 'starting balance' transaction; an account
  // with nothing else can still be deleted.
  const dependentCheck = await getDb()
    .selectFrom('transactions')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('account_id', '=', accountId)
    .where('type', '!=', transactionType.enum['starting balance'])
    .executeTakeFirstOrThrow();
  const transactionCount = parseInt(dependentCheck.count);

  if (transactionCount > 0) {
    const plural = transactionCount > 1 ? 's' : '';
    throw new AccountError(400, {
      error: 'Cannot delete account with dependent records',
      message: `Account "${account.name}" cannot be deleted because it has ${transactionCount} transaction${plural}.\n\nDeleting this account would permanently remove:\n• All ${transactionCount} transaction${plural}\n• All balance history\n• All related financial data\n\nInstead, consider using "Hide Account" to remove it from view while preserving your financial history.`,
      details: {
        accountName: account.name,
        transactionCount,
        recommendation: 'Use the "Hide Account" option to remove from view without losing data',
      },
    });
  }

  // transactions.account_id is ON DELETE RESTRICT: an account's history is never
  // deleted with it. Its opening balance is the one transaction that goes, so delete it
  // here. A transaction added since the check above (an import) makes the delete fail,
  // and the account stays.
  let deleted: bigint;
  try {
    deleted = await withSavepoint(async () => {
      await getDb()
        .deleteFrom('transactions')
        .where('account_id', '=', accountId)
        .where('type', '=', transactionType.enum['starting balance'])
        .execute();
      return (await getDb().deleteFrom('accounts').where('id', '=', accountId).executeTakeFirst()).numDeletedRows;
    });
  } catch (err) {
    // The delete takes the opening balance, then the account. A write on the two in the
    // other order (a note on both, which locks the account first) can deadlock with it, and
    // Postgres fails one side: here, 409 and try again, not a 500. Locking the
    // account first instead deadlocked with splitting the opening balance, which locks the
    // transaction and then, inserting its splits, the account.
    if (['40P01', '55P03'].includes(errorCode(err) ?? '')) {
      throw new AccountError(409, {
        error: 'The account is busy',
        code: 'RECORD_BUSY',
        message: `Account "${account.name}" is being changed by another request. Try again in a moment.`,
      });
    }
    if (!['23001', '23503'].includes(errorCode(err) ?? '')) throw err;
    throw new AccountError(409, {
      error: 'Cannot delete account with dependent records',
      message: `Account "${account.name}" has transactions or other records, so it can't be deleted. Hide it instead.`,
    });
  }
  // Another delete of it, which this one waited for, deleted it first: nothing was
  // deleted here, which answered 200 "Account deleted successfully".
  if (deleted === 0n) throw accountNotFound();
  return { name: account.name };
}

/** What Adjust Balance did: nothing when the balance already matched, else the adjustment. */
export type BalanceAdjustmentResult =
  | { adjusted: false; account_id: number; balance: number; message: string }
  | { adjusted: true; account_id: number; transaction_uuid: string; adjustment: number; balance: number };

/**
 * Adjust Balance: one "balance adjustment" transaction for the difference, so the
 * account's balance becomes the target the member entered. It mirrors the SimpleFin
 * auto-rebalance (BalanceRebalanceService: the ledger's adjustment merchant, cleared and
 * reviewed, today's period), with a manual description and the member as assignee.
 * The target and the difference are whole cents, each within DECIMAL(12,2).
 */
export async function adjustAccountBalance(uuid: string, target: unknown, userId: number): Promise<BalanceAdjustmentResult> {
  // One with more decimals, or too large for an amount, is refused, not rounded.
  const read = readCents(target);
  if (!('cents' in read)) throw new AccountError(400, invalidAmountAnswer('targetBalance', read.problem));
  const targetCents = read.cents;
  const targetBalance = centsToNumber(targetCents);

  const accountId = await accountIdByUuid(uuid);

  // The adjustment is the difference from the balance read here, so the account is
  // locked first, until this request's transaction ends: another adjustment of it sent
  // meanwhile waits, then reads the balance this one leaves (and adjusts nothing when
  // that is its target), instead of both adding the whole difference. The SimpleFin
  // rebalance takes the same lock, and both take it before today's net-worth snapshot row.
  await getDb().selectFrom('accounts').select('id').where('id', '=', accountId).forNoKeyUpdate().execute();

  const currentBalance = await accountBalanceService.getBalance(accountId);
  const adjustmentCents = targetCents - numericToCents(currentBalance);
  if (adjustmentCents === 0) {
    return {
      adjusted: false,
      account_id: accountId,
      balance: currentBalance,
      message: 'Balance already matches the entered amount; no adjustment created.',
    };
  }
  // The target and the balance are each an amount, but their difference may not be one
  // (from -9,999,999,999.99 to 9,999,999,999.99): refused before anything is written.
  if (!fitsAmount(adjustmentCents)) {
    throw new AccountError(400, {
      error: `That balance is too far from the current one: the adjustment would be more than one transaction holds (${MAX_AMOUNT_TEXT} either way)`,
      code: 'INVALID_AMOUNT',
    });
  }
  const adjustment = centsToNumber(adjustmentCents);

  const formatted = await tenantMoneyText(targetBalance);
  const { uuid: transactionUuid } = await new BalanceRebalanceService().createBalanceAdjustmentTransaction(
    accountId,
    adjustment,
    targetBalance,
    null, // the service assigns today's budget period
    {
      description: `Balance adjustment to ${formatted}`,
      notes: `Manual balance adjustment to ${formatted}`,
      assignedTo: userId,
    }
  );

  // Record today's net-worth snapshot, as the sync does: last, after the account's lock.
  await accountBalanceService.triggerNetWorthSnapshot();

  return { adjusted: true, account_id: accountId, transaction_uuid: transactionUuid, adjustment, balance: targetBalance };
}
