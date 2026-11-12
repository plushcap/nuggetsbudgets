import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { findOrCreateMerchant } from '../merchantNames.js';
import { createLogger } from '../../utils/logger.js';
import { toCents, centsToAmount, invalidAmountAnswer, readCents } from '../../utils/money.js';
import { firstMissingReference } from '../tenantReferences.js';
import { badRequest, invalidReference, notFound, TransactionRefusal, transferAmountZero } from './refusal.js';
import { transactionType } from '@nuggets/shared';

/**
 * Transfers: money moved between two accounts (POST /api/transfer), and a period's
 * balance moved to the next period on the same account (POST /api/transfer/period).
 *
 * Each writes two transactions that point at each other with opposite amounts. The
 * database checks that at COMMIT, so both sides are written in the request's
 * one transaction, and a refusal comes before anything is written.
 */

const logger = createLogger({ service: 'Transfers' });

/** POST /api/transfer's body: accounts and period by id or uuid. */
export interface TransferInput {
  source_account_id?: number;
  source_account_uuid?: string;
  destination_account_id?: number;
  destination_account_uuid?: string;
  /** A number or decimal text, as sent (moneyInput): read in whole cents below. */
  amount: number | string;
  transaction_date: string;
  type: 'payment' | 'transfer';
  description?: string;
  budget_period_id?: number | null;
  budget_period_uuid?: string;
}

export interface TransferResult {
  source_transaction_uuid: string;
  destination_transaction_uuid: string;
}

/** The two sides of a transfer, written and linked to each other. */
type Side = {
  account_id: number;
  amount: string;
  description: string | null;
  transaction_date: string;
  merchant_id: number | null;
  type: string;
  budget_period_id: number | null;
};
async function writeLinkedPair(source: Side, destination: Side & { transfer_source_account_id: number }) {
  const common = { status: 'pending', review_status: 'reviewed', created_at: sql<Date>`NOW()`, updated_at: sql<Date>`NOW()` };
  const sourceTx = await getDb()
    .insertInto('transactions')
    .values({ ...source, ...common })
    .returning(['id', 'uuid'])
    .executeTakeFirstOrThrow();
  const destTx = await getDb()
    .insertInto('transactions')
    .values({ ...destination, ...common })
    .returning(['id', 'uuid'])
    .executeTakeFirstOrThrow();
  await getDb().updateTable('transactions').set({ transfer_transaction_id: destTx.id }).where('id', '=', sourceTx.id).execute();
  await getDb().updateTable('transactions').set({ transfer_transaction_id: sourceTx.id }).where('id', '=', destTx.id).execute();
  return { sourceTx, destTx };
}

/** The id of the row of `table` with this uuid, or the 404 `error` when none has it. */
async function idForUuid(table: 'accounts' | 'budget_period', uuid: string, error: string): Promise<number> {
  const row = await getDb().selectFrom(table).select('id').where('uuid', '=', uuid).executeTakeFirst();
  if (!row?.id) throw notFound(error);
  return row.id;
}

/**
 * Move `amount` from one account to another: a negative side on the source and a
 * positive one on the destination, both under a "Payment: …" or "Transfer: …" merchant
 * named for the destination. `amount` (> 0), the date and the type were checked by
 * transferCreateSchema (shared).
 */
export async function createTransfer(input: TransferInput): Promise<TransferResult> {
  const { amount, transaction_date, type, description } = input;

  let sourceAccountId: number | null = input.source_account_id ? Number(input.source_account_id) : null;
  if (!sourceAccountId && input.source_account_uuid) {
    sourceAccountId = await idForUuid('accounts', input.source_account_uuid, 'Source account not found for source_account_uuid');
  }
  let destinationAccountId: number | null = input.destination_account_id ? Number(input.destination_account_id) : null;
  if (!destinationAccountId && input.destination_account_uuid) {
    destinationAccountId = await idForUuid(
      'accounts', input.destination_account_uuid, 'Destination account not found for destination_account_uuid',
    );
  }
  let budgetPeriodId: number | null = input.budget_period_id ? Number(input.budget_period_id) : null;
  if (!budgetPeriodId && input.budget_period_uuid) {
    budgetPeriodId = await idForUuid('budget_period', input.budget_period_uuid, 'Budget period not found for budget_period_uuid');
  }

  if (!sourceAccountId || !destinationAccountId) throw badRequest('Source and destination accounts are required');
  if (sourceAccountId === destinationAccountId) throw badRequest('Cannot transfer to the same account');

  // Numeric ids from the body name rows of this ledger, checked before anything is
  // written, as a transaction's are: the foreign key would refuse them with a 500.
  const missing = await firstMissingReference({
    source_account_id: sourceAccountId,
    destination_account_id: destinationAccountId,
    budget_period_id: budgetPeriodId,
  });
  if (missing) throw invalidReference(missing);

  // Whole cents: both sides are written from the same exact amount.
  const amountCents = toCents(amount);
  if (amountCents === null) throw badRequest('Amount must have at most 2 decimal places');

  const destination = await getDb().selectFrom('accounts').select('name').where('id', '=', destinationAccountId).executeTakeFirst();
  if (!destination) throw notFound('Destination account not found');

  // "Payment: Card" or "Transfer: Savings". Names are unique per ledger ignoring case.
  const merchantName = `${type === transactionType.enum.payment ? 'Payment' : 'Transfer'}: ${destination.name}`;
  const merchant = await findOrCreateMerchant(merchantName);
  logger.info({ merchantId: merchant.id, created: merchant.created }, `Merchant for ${type}`);

  const side = {
    description: description?.trim() || null,
    transaction_date,
    merchant_id: merchant.id,
    type,
    budget_period_id: budgetPeriodId,
  };
  const { sourceTx, destTx } = await writeLinkedPair(
    { ...side, account_id: sourceAccountId, amount: centsToAmount(-Math.abs(amountCents)) },
    { ...side, account_id: destinationAccountId, amount: centsToAmount(Math.abs(amountCents)), transfer_source_account_id: sourceAccountId },
  );

  logger.info(
    { sourceTransactionId: sourceTx.id, destTransactionId: destTx.id, type, merchantId: merchant.id },
    'Transfer created successfully',
  );
  return { source_transaction_uuid: sourceTx.uuid, destination_transaction_uuid: destTx.uuid };
}

export interface PeriodMoveInput {
  account_uuid: string;
  source_period_uuid: string;
  /** Signed balance to move forward (the UI defaults it to the period's balance): a number or decimal text, as sent. */
  amount: number | string;
  description?: string | undefined;
}

/**
 * Move an account's period balance to the NEXT period (same account, two periods):
 * -amount on the source period's last day and +amount on the next period's first, so
 * each month's balance shifts and both reconcile. Excluded from spending
 * (type='transfer') but counted in each period's account balance.
 */
export async function movePeriodBalance(
  input: PeriodMoveInput,
): Promise<TransferResult & { next_period_name: string }> {
  // Whole cents, before anything is looked up or written: 12.345 is refused, not
  // rounded, and so is an amount that would round to a 0.00 pair (a transfer moves money).
  const read = readCents(input.amount);
  if (!('cents' in read)) throw new TransactionRefusal(400, invalidAmountAnswer('amount', read.problem));
  const cents = read.cents;
  if (cents === 0) throw transferAmountZero("There's no amount to move: it can't be 0.");

  const account = await getDb().selectFrom('accounts').select(['id', 'name']).where('uuid', '=', input.account_uuid).executeTakeFirst();
  if (!account) throw notFound('Account not found');

  const source = await getDb()
    .selectFrom('budget_period').select(['id', 'name', 'start_date', 'end_date'])
    .where('uuid', '=', input.source_period_uuid).executeTakeFirst();
  if (!source) throw notFound('Source budget period not found');

  // Periods are ordered by start date: the next is the first to start after this one.
  const next = await getDb()
    .selectFrom('budget_period').select(['id', 'name', 'start_date', 'end_date'])
    .where('start_date', '>', source.start_date)
    .orderBy('start_date', 'asc').limit(1).executeTakeFirst();
  if (!next) throw badRequest("The next budget period doesn't exist yet. Create it first, then move the balance.");

  // Under its own merchant, so these read as a "Budget Period Transfer" in the ledger. The
  // source period loses `cents`, the next gains it.
  const merchantId = (await findOrCreateMerchant('Budget Period Transfer')).id;
  const note = input.description?.trim() || `Moved ${source.name} balance to ${next.name}`;
  const side = { account_id: account.id, description: note, merchant_id: merchantId, type: 'transfer' };
  const { sourceTx, destTx } = await writeLinkedPair(
    { ...side, amount: centsToAmount(-cents), transaction_date: source.end_date, budget_period_id: source.id },
    {
      ...side, amount: centsToAmount(cents), transaction_date: next.start_date, budget_period_id: next.id,
      transfer_source_account_id: account.id,
    },
  );

  logger.info({ accountId: account.id, fromPeriod: source.id, toPeriod: next.id }, 'Budget period transfer created');
  return {
    source_transaction_uuid: sourceTx.uuid,
    destination_transaction_uuid: destTx.uuid,
    next_period_name: next.name,
  };
}
