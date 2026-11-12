import { TRANSACTION_TYPES as TENANT_TRANSACTION_TYPES, transactionStatus, transactionReviewStatus, assetType, transactionType } from '@nuggets/shared';

/**
 * The ledger's rules for a transaction's type, sign, amount and vocabulary, which
 * create, bulk create and edit all apply.
 */

/** The types a transaction may have: the shared list the database enforces. */
export const TRANSACTION_TYPES: readonly string[] = TENANT_TRANSACTION_TYPES;
export const INVALID_TYPE_ERROR =
  'Invalid transaction type. Must be: income, expense, payment, transfer, starting balance, or balance adjustment';
/** The types the two sides of a transfer (POST /api/transfer) can have. */
export const TRANSFER_TYPES = ['payment', 'transfer'];

/**
 * Amounts are pre-signed: an income is positive and an expense negative whatever
 * sign was sent, so a magnitude works for either. Other types keep the sign given.
 */
export function signForType(type: string, cents: number): number {
  if (type === transactionType.enum.income) return Math.abs(cents);
  if (type === transactionType.enum.expense) return -Math.abs(cents);
  return cents;
}

/**
 * A liability account (a card, a loan) takes no income: the database refuses one
 * (trigger_check_transaction_type_for_account, on every install since v2.0.0). Money paid
 * toward it is a payment, and a charge on it an expense, as the importer records them.
 * Create, bulk create and edit refuse one first, so the answer is a 400 with this code.
 */
export const INCOME_ON_LIABILITY_CODE = 'INCOME_ON_LIABILITY';
export const INCOME_ON_LIABILITY_ERROR =
  "Income can't be recorded on a liability account. Record money paid toward it as a payment, or a charge on it as an expense.";
/** The same, as a bulk create's per-row reason. */
export const INCOME_ON_LIABILITY_REASON = 'income is not allowed on a liability account (record a payment or an expense)';
/** The same, for splitting such an income from before the rule: its splits would be incomes on it too. */
export const INCOME_ON_LIABILITY_SPLIT_ERROR =
  "Income can't be recorded on a liability account, so this income can't be split as it is. Change it to a payment or an expense first, then split it.";

/** Whether a transaction of `type` on an account of `accountType` (accounts.type) is an income on a liability. */
export function isIncomeOnLiability(type: unknown, accountType: string | null | undefined): boolean {
  return type === transactionType.enum.income && accountType === assetType.enum.Liability;
}

const TRANSACTION_STATUSES: readonly string[] = transactionStatus.options;
const REVIEW_STATUSES: readonly string[] = transactionReviewStatus.options;

/**
 * The status and review_status an edit may write: one of today's values, or the
 * one the row already has (a whole-form save of a row from before them), as the database
 * allows. Says which values are allowed instead of failing the write.
 */
export function transactionVocabularyError(
  update: Record<string, unknown>,
  stored: { status?: string | null; review_status?: string | null } = {}
): string | null {
  if ('status' in update && update.status !== stored.status && !TRANSACTION_STATUSES.includes(update.status as string)) {
    return `Invalid status. Must be one of: ${TRANSACTION_STATUSES.join(', ')}`;
  }
  if (
    'review_status' in update &&
    update.review_status !== stored.review_status &&
    !REVIEW_STATUSES.includes(update.review_status as string)
  ) {
    return `Invalid review_status. Must be one of: ${REVIEW_STATUSES.join(', ')}`;
  }
  return null;
}

/**
 * An id sent in a body, as the routes have always read one: a falsy value is none, and
 * anything else is parsed as an integer (`'12'`, `12`; `'abc'` is NaN, which no row has).
 */
export function sentId(value: unknown): number | null {
  return value ? parseInt(String(value), 10) : null;
}
