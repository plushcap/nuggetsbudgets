import { describe, it, expect } from 'vitest';
import { nextDueDate } from '../billSchedule';

describe('nextDueDate', () => {
  it('is the anchor while it is today or later', () => {
    expect(nextDueDate('2026-11-15', 1, '2026-10-27')).toBe('2026-11-15');
    expect(nextDueDate('2026-10-27', 1, '2026-10-27')).toBe('2026-10-27');
  });

  // Counting whole months skipped a payment still ahead this month.
  it('is this month while its day is still ahead', () => {
    expect(nextDueDate('2026-01-15', 1, '2026-03-10')).toBe('2026-03-15');
    expect(nextDueDate('2026-01-25', 1, '2026-03-20')).toBe('2026-03-25');
    expect(nextDueDate('2026-01-15', 1, '2026-03-15')).toBe('2026-03-15');
  });

  it('is the next period once this one has passed', () => {
    expect(nextDueDate('2026-01-15', 1, '2026-03-16')).toBe('2026-04-15');
    expect(nextDueDate('2026-07-15', 3, '2026-10-27')).toBe('2027-01-15');
    expect(nextDueDate('2026-07-15', 3, '2026-10-10')).toBe('2026-10-15');
    expect(nextDueDate('2025-02-01', 12, '2026-01-31')).toBe('2026-02-01');
  });

  it("isn't due in a month off the schedule", () => {
    // Every 2 months from January: March, May... On Apr 1 that's May.
    expect(nextDueDate('2026-01-10', 2, '2026-04-01')).toBe('2026-05-10');
  });

  // The backend's rule (services/bills/schedule.ts): the month's last day when it's
  // shorter, then the anchor's day again. JS setMonth rolled Jan 31 into March.
  it('falls on the last day of a shorter month, as the backend schedules it', () => {
    expect(nextDueDate('2026-01-31', 1, '2026-02-10')).toBe('2026-02-28');
    expect(nextDueDate('2026-01-31', 1, '2026-03-01')).toBe('2026-03-31');
    expect(nextDueDate('2028-01-31', 1, '2028-02-01')).toBe('2028-02-29');
    expect(nextDueDate('2026-01-31', 1, '2026-04-30')).toBe('2026-04-30');
  });

  it('crosses a year', () => {
    expect(nextDueDate('2026-11-20', 1, '2026-12-25')).toBe('2027-01-20');
  });

  it('is null without a valid anchor or a whole number of months', () => {
    expect(nextDueDate(undefined, 1, '2026-10-27')).toBeNull();
    expect(nextDueDate('not a date', 1, '2026-10-27')).toBeNull();
    expect(nextDueDate('2026-02-30', 1, '2026-10-27')).toBeNull();
    expect(nextDueDate('2026-01-15', 0, '2026-10-27')).toBeNull();
    expect(nextDueDate('2026-01-15', 1.5, '2026-10-27')).toBeNull();
  });

  it('reads an ISO timestamp by its date part', () => {
    expect(nextDueDate('2026-01-15T00:00:00.000Z', 1, '2026-03-10')).toBe('2026-03-15');
  });
});
