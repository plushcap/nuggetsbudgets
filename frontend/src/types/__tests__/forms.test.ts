import { describe, it, expect } from 'vitest';
import { transactionStatus, transactionReviewStatus, transactionType } from '@nuggets/shared';
import { createDefaultTransactionForm } from '../forms';
import { pinTimeZone } from '../../test/timeZone';

// "today" is the user's local day, not the UTC one.
describe('createDefaultTransactionForm transaction_date', () => {
  describe('9:30 pm on Oct 31 in Los Angeles (already Nov 1 in UTC)', () => {
    pinTimeZone('America/Los_Angeles', '2026-10-31T21:30:00-07:00');
    it('defaults to Oct 31', () => {
      expect(createDefaultTransactionForm().transaction_date).toBe('2026-10-31');
    });
  });

  describe('8:00 am on Nov 1 in Kiritimati, UTC+14 (still Oct 31 in UTC)', () => {
    pinTimeZone('Pacific/Kiritimati', '2026-11-01T08:00:00+14:00');
    it('defaults to Nov 1', () => {
      expect(createDefaultTransactionForm().transaction_date).toBe('2026-11-01');
    });
  });
});

describe('createDefaultTransactionForm statuses', () => {
  it('defaults to values the database takes (it refused "Pending" with a 500)', () => {
    const form = createDefaultTransactionForm();
    expect(transactionStatus.safeParse(form.status).success).toBe(true);
    expect(transactionReviewStatus.safeParse(form.review_status).success).toBe(true);
    expect(transactionType.safeParse(form.type).success).toBe(true);
  });
});
