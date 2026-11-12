import { DomainError, refusalFromBody, type RefusalBody } from '../domainErrors.js';
import { missingReferenceError, type TenantReferenceField } from '../tenantReferences.js';
import { INCOME_ON_LIABILITY_CODE, INCOME_ON_LIABILITY_ERROR } from './rules.js';

/**
 * A request the transaction services refuse: a {@link DomainError}, written
 * as the answer body it has always had.
 *
 * The services check what a request names and whether the ledger's rules allow it, in
 * the order the routes always did, and throw one of these for the first thing wrong. The
 * route wrapper answers it with `status` and the body, `{ error }` plus any detail the
 * answer has always carried (`code`, `field`, `expected`/`actual`) and `message`; the
 * code is the status's (BAD_REQUEST, NOT_FOUND) when the body names none. The request's
 * transaction rolls back, as for any answer of 400 or more.
 */
export class TransactionRefusal extends DomainError {
  constructor(status: 400 | 404 | 409, body: RefusalBody) {
    super(...refusalFromBody(status, body));
  }
}

export const notFound = (error: string) => new TransactionRefusal(404, { error });
export const badRequest = (error: string, detail: Record<string, unknown> = {}) =>
  new TransactionRefusal(400, { error, ...detail });

/** A numeric id in the body that names no row of this ledger. */
export const invalidReference = (field: TenantReferenceField) => new TransactionRefusal(400, missingReferenceError(field));
/** A tag id or uuid (a transaction's or a split's) that names no tag of this ledger: 400 INVALID_REFERENCE, naming the list. */
export const invalidTagReference = (field: 'tag_ids' | 'tag_uuids') =>
  new TransactionRefusal(400, { error: `${field} names a tag that isn't in this tenant`, code: 'INVALID_REFERENCE', field });
/** A split's budget item or period uuid that names no row of this ledger: 400 INVALID_REFERENCE, naming the field. */
export const invalidUuidReference = (field: 'budget_item_uuid' | 'budget_period_uuid') =>
  new TransactionRefusal(400, {
    error: `${field} names ${field === 'budget_item_uuid' ? 'a budget item' : 'a budget period'} that isn't in this tenant`,
    code: 'INVALID_REFERENCE',
    field,
  });
/** An assignee who can't see this ledger. */
export const invalidAssignee = () =>
  badRequest('assigned_to must be a user with access to this tenant', { code: 'INVALID_ASSIGNEE' });
/** An income on a liability account, which the database refuses (rules.ts). */
export const incomeOnLiability = (error: string = INCOME_ON_LIABILITY_ERROR) => badRequest(error, { code: INCOME_ON_LIABILITY_CODE });
/** A transfer whose two sides would be 0: an edit to 0, or a period move of 0. */
export const transferAmountZero = (error = "A transfer's amount can't be 0. Enter the amount that moved, or delete the transfer.") =>
  badRequest(error, { code: 'TRANSFER_AMOUNT_ZERO' });

/**
 * A split asked of a side of a transfer, refused by design: a
 * transfer's sides move money between two accounts, not across budget items, and a split one
 * read as several moves on one side and one on the other. A side split before the rule keeps
 * its splits, and can be unsplit.
 */
export const transferSplitRefused = () =>
  new TransactionRefusal(409, {
    error: "A transfer can't be split",
    code: 'TRANSFER_SPLIT_REFUSED',
    message:
      'This transaction is one side of a transfer, which moves money between two accounts and isn\'t split across budget items. Record the parts as separate transactions instead.',
  });

/**
 * A split asked of one split of a transaction: splits are one level deep. A
 * split's split wrote rows two levels under the transaction, which the balances, the budget
 * and the money rules read as one level (a transfer side's split's split, too). The
 * transaction's own splits are edited instead, or it is unsplit.
 */
export const splitOfSplitRefused = () =>
  new TransactionRefusal(409, {
    error: "A split can't be split again",
    code: 'SPLIT_OF_SPLIT_REFUSED',
    message:
      "This transaction is one split of another, and splits are one level deep. Edit the splits on that transaction instead, or unsplit it first.",
  });
