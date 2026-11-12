/**
 * Transaction filters to and from query parameters: the API's (server-side
 * filtering) and the page URL's.
 */
import { REVIEW_STATUSES, TRANSACTION_TYPES } from '@nuggets/shared';
import { TransactionFilters } from '../components/SharedTransactionFilter';
import { oneOf } from './vocabularyOptions';

/**
 * Build query parameters for API filtering
 * Use this when you want to filter transactions on the backend
 */
export const buildTransactionFilterParams = (filters: TransactionFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  
  if (filters.search) {
    params.search = filters.search;
  }
  
  if (filters.reviewStatus && filters.reviewStatus !== 'all') {
    params.review_status = filters.reviewStatus;
  }
  
  if (filters.dateFrom) {
    params.date_from = filters.dateFrom;
  }
  
  if (filters.dateTo) {
    params.date_to = filters.dateTo;
  }
  
  if (filters.transactionType && filters.transactionType !== 'all') {
    params.type = filters.transactionType;
  }
  
  if (filters.budgetPeriodId) {
    params.budget_period_id = filters.budgetPeriodId.toString();
  }
  
  if (filters.budgetItemId) {
    params.budget_item_id = filters.budgetItemId.toString();
  }
  
  if (filters.amountMin !== undefined) {
    params.amount_min = filters.amountMin.toString();
  }
  
  if (filters.amountMax !== undefined) {
    params.amount_max = filters.amountMax.toString();
  }
  
  return params;
};

/**
 * Parse URL parameters into TransactionFilters
 */
export const parseUrlFilters = (searchParams: URLSearchParams): Partial<TransactionFilters> => {
  const filters: Partial<TransactionFilters> = {};
  
  const search = searchParams.get('search');
  if (search) filters.search = search;
  
  // A list's value, as the database has it, or 'all'; any other spelling ("Needs Review",
  // needs_review) is dropped, which the API would compare exactly and match nothing.
  const reviewStatus = oneOf(['all', ...REVIEW_STATUSES], searchParams.get('reviewStatus'));
  if (reviewStatus) filters.reviewStatus = reviewStatus;
  
  const dateFrom = searchParams.get('dateFrom');
  if (dateFrom) filters.dateFrom = dateFrom;
  
  const dateTo = searchParams.get('dateTo');
  if (dateTo) filters.dateTo = dateTo;
  
  const transactionType = oneOf(['all', ...TRANSACTION_TYPES], searchParams.get('transactionType'));
  if (transactionType) filters.transactionType = transactionType;
  
  const budgetPeriodId = searchParams.get('budgetPeriodId');
  if (budgetPeriodId) filters.budgetPeriodId = parseInt(budgetPeriodId);
  
  const budgetItemId = searchParams.get('budgetItemId');
  if (budgetItemId) filters.budgetItemId = parseInt(budgetItemId);
  
  // An amount bound from the URL is read to the cent, as its box shows it: a hand-edited
  // `amountMin=10.005` would otherwise be put back by the box as it opens.
  const amountMin = toBoundCents(searchParams.get('amountMin'));
  if (amountMin !== undefined) filters.amountMin = amountMin;
  
  const amountMax = toBoundCents(searchParams.get('amountMax'));
  if (amountMax !== undefined) filters.amountMax = amountMax;
  
  return filters;
};

/**
 * Build query parameters for account transaction filtering
 * Similar to buildTransactionFilterParams but for account-specific API
 */
export const buildAccountTransactionFilterParams = (filters: TransactionFilters): Record<string, string> => {
  const params: Record<string, string> = {};
  
  if (filters.search) {
    params.search = filters.search;
  }
  
  if (filters.reviewStatus && filters.reviewStatus !== 'all') {
    params.review_status = filters.reviewStatus;
  }
  
  if (filters.dateFrom) {
    params.date_from = filters.dateFrom;
  }
  
  if (filters.dateTo) {
    params.date_to = filters.dateTo;
  }
  
  if (filters.transactionType && filters.transactionType !== 'all') {
    params.type = filters.transactionType;
  }
  
  if (filters.budgetPeriodId) {
    params.budget_period_id = filters.budgetPeriodId.toString();
  }
  
  if (filters.budgetItemId) {
    params.budget_item_id = filters.budgetItemId.toString();
  }
  
  if (filters.amountMin !== undefined) {
    params.amount_min = filters.amountMin.toString();
  }
  
  if (filters.amountMax !== undefined) {
    params.amount_max = filters.amountMax.toString();
  }
  
  return params;
};

/**
 * A URL amount bound as its box will show it (2 decimals, rounded as CurrencyInput's
 * toLocaleString rounds), or undefined when it is missing or not a number.
 */
function toBoundCents(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = parseFloat(raw);
  if (!Number.isFinite(value)) return undefined;
  return Number(value.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 2 })) || 0;
}
