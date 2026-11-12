import { describe, it, expect } from 'vitest';
import {
  billMessage,
  budgetItemMessage,
  digestMessage,
  reviewReminderMessage,
  transactionMessage,
} from '../../../services/notifications/messages.js';

const item = (facts: Record<string, string | number | boolean | null>) => ({
  periodItemUuid: 'bpi-1',
  itemUuid: 'item-1',
  name: 'Groceries',
  periodName: 'October 2026',
  facts,
});

describe('notification messages', () => {
  it('says how far over budget an expense item is', () => {
    const message = budgetItemMessage(
      'Over budget',
      item({ kind: 'expense', budgeted: 500, spent: 650, remaining: -150, percent_used: 130, days_left: 10 }),
      'Pat'
    );
    expect(message).toEqual({
      subject: 'Over budget: Groceries',
      heading: 'Groceries',
      paragraphs: ['Hi Pat,', "Groceries has spent $650.00 of its $500.00 budget (130%) in October 2026. That's $150.00 over budget."],
      buttonText: 'Open the budget item',
      path: '/budget-items/item-1/view',
      push: { title: 'Over budget: Groceries', body: "$650.00 of $500.00. That's $150.00 over budget." },
    });
  });

  it('says what is left of an item still under budget', () => {
    const message = budgetItemMessage(
      'Most of the budget used',
      item({ kind: 'expense', budgeted: 500, spent: 450, remaining: 50, percent_used: 90, days_left: 1 }),
      null
    );
    expect(message.paragraphs).toEqual([
      'Hi there,',
      'Groceries has spent $450.00 of its $500.00 budget (90%) in October 2026. $50.00 is left with 1 day to go.',
    ]);
  });

  it('describes a purchase', () => {
    const message = transactionMessage(
      'A large purchase',
      {
        uuid: 'tx-1',
        assignedTo: null,
        transactionDate: '2026-10-16',
        facts: { size: 812.4, direction: 'out', merchant: 'Sample Wholesale', account: 'Joint Checking' },
      },
      'Pat'
    );
    expect(message.subject).toBe('A large purchase: $812.40 at Sample Wholesale');
    expect(message.paragraphs[1]).toBe('A payment of $812.40 at Sample Wholesale in Joint Checking, dated Friday, October 16.');
    expect(message.path).toBe('/transactions/tx-1');
    expect(message.push).toEqual({ title: 'A large purchase', body: '$812.40 at Sample Wholesale in Joint Checking.' });
  });

  it('counts the review backlog', () => {
    const message = reviewReminderMessage(
      'Transactions waiting for review',
      { unreviewed_count: 1, unreviewed_total: 42, oldest_unreviewed_days: 3 },
      'Pat'
    );
    expect(message.subject).toBe('Transactions waiting for review: 1 transaction to review');
    expect(message.paragraphs[1]).toBe('1 transaction is waiting for your review, totalling $42.00. The oldest is 3 days old.');
    expect(message.path).toBe('/tasks?showMyTasks=true&includeUnassigned=false');
  });

  it('sums up the week', () => {
    const message = digestMessage(
      'The week in review',
      { moneyIn: 3000, moneyOut: 1234.5, overBudget: ['Dining', 'Fuel'], toReview: 0 },
      '2026-10-25',
      'The Smiths',
      'Pat'
    );
    expect(message.subject).toBe('The week in review: The Smiths');
    expect(message.paragraphs.slice(1)).toEqual([
      'In the seven days to Sunday, October 25, $3,000.00 came in and $1,234.50 went out.',
      'Over budget: Dining, Fuel.',
      'Nothing is waiting for review.',
    ]);
  });
});

// A ledger's currency and locale (General Settings): the engine passes them to each message.
describe("notification messages in the ledger's money format", () => {
  const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');
  const euros = { currency: 'EUR', locale: 'de-DE' };

  it('name every amount in it', () => {
    const over = budgetItemMessage(
      'Over budget',
      item({ kind: 'expense', budgeted: 500, spent: 650, remaining: -150, percent_used: 130, days_left: 10 }),
      'Pat',
      euros
    );
    expect(plain(over.paragraphs[1]!)).toBe("Groceries has spent 650,00 € of its 500,00 € budget (130%) in October 2026. That's 150,00 € over budget.");
    expect(plain(over.push.body)).toBe("650,00 € of 500,00 €. That's 150,00 € over budget.");

    const purchase = transactionMessage(
      'Large purchase',
      { uuid: 't-1', transactionDate: '2026-10-02', assignedTo: null, facts: { size: 1234.5, direction: 'out', merchant: 'Shop', account: null } },
      null,
      { currency: 'GBP', locale: 'en-GB' }
    );
    expect(purchase.heading).toBe('£1,234.50 at Shop');

    const review = reviewReminderMessage('Review', { unreviewed_count: 2, unreviewed_total: 12.5, oldest_unreviewed_days: 1 }, null, euros);
    expect(plain(review.push.body)).toMatch(/^Totalling 12,50 €\./);

    const week = digestMessage(
      'Weekly',
      { moneyIn: 100, moneyOut: 40.25, overBudget: [], toReview: 0 },
      '2026-10-04',
      'Home',
      null,
      { currency: 'JPY', locale: 'ja-JP' }
    );
    expect(week.paragraphs[1]).toContain('￥100 came in and ￥40 went out');

    const bill = billMessage(
      'Bill due',
      { bill: { name: 'Rent' }, due_date: '2026-10-05', expected: 900, paid: 0, status: 'due' } as unknown as Parameters<typeof billMessage>[1],
      '2026-10-03',
      null,
      euros
    );
    expect(plain(bill.paragraphs[1]!)).toContain('Rent (900,00 €) is due');
  });

  it('are USD in en-US when the engine names none', () => {
    const over = budgetItemMessage('Over', item({ kind: 'expense', budgeted: 1, spent: 2, remaining: -1 }), null);
    expect(over.push.body).toBe("$2.00 of $1.00. That's $1.00 over budget.");
  });
});
