import { describe, it, expect } from 'vitest';
import type { Account, BudgetPeriod, Transaction, User } from '../../../services/api';
import {
  amountColor,
  latestBudgetPeriods,
  reviewStatusWords,
  rowLabel,
  selectLabel,
  statusBadgeColor,
  transactionRowLookups,
} from '../transactionRows';

const transaction = {
  id: 1,
  uuid: 't-1',
  description: 'POS 1234 CORNER',
  merchant_name: null,
  transaction_date: '2026-10-20',
  review_status: 'needs review',
  status: 'pending',
  assigned_to: 7,
  budget_period_id: 3,
  account_id: 9,
  account_name: null,
  running_account_balance: 120.5,
} as unknown as Transaction;
const users = [{ id: 7, first_name: 'Alice', last_name: 'Smith' }] as unknown as User[];
const periods = [
  { id: 1, name: 'August 2026' },
  { id: 2, name: 'September 2026' },
  { id: 3, name: 'October 2026' },
  { id: 4, name: 'November 2026' },
] as unknown as BudgetPeriod[];
const accounts = [{ id: 9, name: 'Checking' }] as unknown as Account[];

describe('the transaction table row labels', () => {
  it('names a row by its merchant, else its description, and its date', () => {
    expect(rowLabel(transaction)).toBe('POS 1234 CORNER, 10/20/2026');
    expect(rowLabel({ ...transaction, merchant_name: 'Corner store' })).toBe('Corner store, 10/20/2026');
    expect(selectLabel(transaction)).toBe('Select POS 1234 CORNER, 10/20/2026');
  });

  it('words the review status, a value it does not know as needing review', () => {
    expect(reviewStatusWords({ ...transaction, review_status: 'reviewed' })).toBe('Reviewed');
    expect(reviewStatusWords({ ...transaction, review_status: 'flagged' })).toBe('Flagged');
    expect(reviewStatusWords(transaction)).toBe('Needs review');
  });

  it('colours a status green once the bank has it, else gray', () => {
    expect(['cleared', 'reconciled', 'pending', 'posted'].map((s) => statusBadgeColor(s as Transaction['status']))).toStrictEqual([
      'green',
      'green',
      'gray',
      'gray',
    ]);
  });

  it('colours money out red and money in green', () => {
    expect([amountColor(-0.01), amountColor(0), amountColor(5)]).toStrictEqual(['red', 'green', 'green']);
  });

  it('offers the three latest periods, newest first', () => {
    expect(latestBudgetPeriods(periods).map((p) => p.id)).toStrictEqual([4, 3, 2]);
    expect(latestBudgetPeriods(periods.slice(0, 1)).map((p) => p.id)).toStrictEqual([1]);
  });
});

describe('transactionRowLookups', () => {
  const lookups = transactionRowLookups({ users, budgetPeriods: periods, accounts, showBalance: true });

  it("finds the row's person, period and account in the lists", () => {
    expect(lookups.assignedUser(transaction)?.first_name).toBe('Alice');
    expect(lookups.budgetPeriodName(transaction)).toBe('October 2026');
    expect(lookups.accountName(transaction)).toBe('Checking');
  });

  it("prefers the account name the list sent, and is null for what isn't there", () => {
    expect(lookups.accountName({ ...transaction, account_name: 'Savings' })).toBe('Savings');
    const bare = { ...transaction, assigned_to: 99, budget_period_id: null, account_id: 0 } as unknown as Transaction;
    expect(lookups.assignedUser(bare)).toBeNull();
    expect(lookups.budgetPeriodName(bare)).toBeNull();
    expect(lookups.accountName(bare)).toBeNull();
  });

  it("shows the server's running balance only where the page shows balances", () => {
    expect(lookups.runningBalance(transaction)).toBe(120.5);
    expect(lookups.runningBalance({ ...transaction, running_account_balance: null } as unknown as Transaction)).toBe(0);
    const noBalance = transactionRowLookups({ users, budgetPeriods: periods, accounts, showBalance: false });
    expect(noBalance.runningBalance(transaction)).toBe(0);
  });
});
