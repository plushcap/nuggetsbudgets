import { DomainError } from '../domainErrors.js';

/**
 * A refusal of the budget-period routes (/api/budgets/periods…, /api/budget-periods…):
 * a period or period item that isn't there (or is another ledger's, which RLS hides), or a
 * ledger without the envelope account a view needs. Thrown by the budget-period services
 * and answered by the route wrapper, which rolls back what the request wrote.
 */
export class BudgetPeriodError extends DomainError {}

/** No such period in this ledger: 404. */
export const budgetPeriodNotFound = (): BudgetPeriodError => new BudgetPeriodError(404, 'NOT_FOUND', 'Budget period not found');

/** No such period item in this ledger: 404. */
export const budgetPeriodItemNotFound = (): BudgetPeriodError =>
  new BudgetPeriodError(404, 'NOT_FOUND', 'Budget period item not found');

/** A transfer's two items aren't both items of the period it names: 404. */
export const transferItemsNotInPeriod = (): BudgetPeriodError =>
  new BudgetPeriodError(404, 'NOT_FOUND', 'Budget period items not found or not in the same period');

/** The ledger has no account marked as its envelope account: 404 NO_ENVELOPE_ACCOUNT, a state the budget page shows. */
export const noEnvelopeAccount = (): BudgetPeriodError =>
  new BudgetPeriodError(404, 'NO_ENVELOPE_ACCOUNT', 'No envelope account configured');

/**
 * A period that has transactions can't be deleted (it would leave them with no period): 409
 * BUDGET_PERIOD_HAS_TRANSACTIONS, with their number. Archiving it hides it instead.
 */
export const budgetPeriodHasTransactions = (name: string, transactionCount: number): BudgetPeriodError =>
  new BudgetPeriodError(
    409,
    'BUDGET_PERIOD_HAS_TRANSACTIONS',
    `${name} has ${transactionCount} ${transactionCount === 1 ? 'transaction' : 'transactions'}, so it can't be deleted. Archive it to hide it instead.`,
    { transaction_count: transactionCount },
  );
