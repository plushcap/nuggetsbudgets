import { describe, it, expect } from 'vitest';
import { buildAccountTransactionFilterParams, buildTransactionFilterParams, parseUrlFilters } from '../transactionFilterParams';
import { oneOf, TRANSACTION_TYPE_OPTIONS } from '../vocabularyOptions';
import { TRANSACTION_TYPES } from '@nuggets/shared';

// The API compares review_status and type exactly, so a filter sends the list's value.
describe('transaction filters as query parameters', () => {
  it("reads a page URL's review status and type when they are the lists' values", () => {
    const filters = parseUrlFilters(new URLSearchParams('reviewStatus=needs%20review&transactionType=starting%20balance'));
    expect(filters).toEqual({ reviewStatus: 'needs review', transactionType: 'starting balance' });
    expect(parseUrlFilters(new URLSearchParams('reviewStatus=all&transactionType=all'))).toEqual({
      reviewStatus: 'all',
      transactionType: 'all',
    });
  });

  it('drops a review status or type in another spelling, which would match nothing', () => {
    for (const query of [
      'reviewStatus=needs_review',
      'reviewStatus=Needs%20Review',
      'reviewStatus=Reviewed',
      'transactionType=Expense',
      'transactionType=starting_balance',
    ]) {
      expect(parseUrlFilters(new URLSearchParams(query))).toEqual({});
    }
  });

  it("reads an amount bound to the cent its box shows, so the box doesn't put it back", () => {
    expect(parseUrlFilters(new URLSearchParams('amountMin=10.005&amountMax=20.005'))).toMatchObject({ amountMin: 10.01, amountMax: 20.01 });
    expect(parseUrlFilters(new URLSearchParams('amountMin=12.5&amountMax=abc'))).toEqual({ amountMin: 12.5 });
  });

  it('sends the values as they are, and no filter for all', () => {
    expect(buildTransactionFilterParams({ reviewStatus: 'needs review', transactionType: 'balance adjustment' })).toEqual({
      review_status: 'needs review',
      type: 'balance adjustment',
    });
    expect(buildAccountTransactionFilterParams({ reviewStatus: 'flagged', transactionType: 'transfer' })).toEqual({
      review_status: 'flagged',
      type: 'transfer',
    });
    expect(buildTransactionFilterParams({ reviewStatus: 'all', transactionType: 'all' })).toEqual({});
  });
});

describe('vocabularyOptions', () => {
  it('offers every transaction type once, expense first', () => {
    expect(TRANSACTION_TYPE_OPTIONS[0]).toBe('expense');
    expect([...TRANSACTION_TYPE_OPTIONS].sort()).toEqual([...TRANSACTION_TYPES].sort());
  });

  it('oneOf takes only a value of the list', () => {
    expect(oneOf(['a b', 'c'], 'a b')).toBe('a b');
    expect(oneOf(['a b', 'c'], 'a_b')).toBeUndefined();
    expect(oneOf(['a b', 'c'], null)).toBeUndefined();
    expect(oneOf(['a b', 'c'], undefined)).toBeUndefined();
  });
});
