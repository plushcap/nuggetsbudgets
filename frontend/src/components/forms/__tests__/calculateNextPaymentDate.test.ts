import { describe, it, expect } from 'vitest';
import { calculateNextPaymentDate } from '../../../utils/billSchedule';
import { pinTimeZone } from '../../../test/timeZone';

const ymd = (d: Date | null) =>
  d && `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// A bill's next payment date is a calendar day; read as a UTC instant it
// lands on the day before anywhere west of UTC.
describe('calculateNextPaymentDate in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles', '2026-10-27T12:00:00-07:00');

  it.each(['2026-11-15', '2026-11-15T00:00:00.000Z'])('keeps a future date (%s) on its day', (next) => {
    expect(ymd(calculateNextPaymentDate(next, 1))).toBe('2026-11-15');
  });

  it('is today when the payment is due today', () => {
    expect(ymd(calculateNextPaymentDate('2026-10-27', 1))).toBe('2026-10-27');
  });

  it('rolls a past date forward by the frequency, on the same day of the month', () => {
    expect(ymd(calculateNextPaymentDate('2026-07-15', 3))).toBe('2027-01-15');
  });

  // Counting whole months skipped a payment still ahead this month: Jul 27 monthly,
  // on Oct 27 is today; Jul 28 monthly is tomorrow, not Nov 28.
  it('keeps a payment still ahead this month', () => {
    expect(ymd(calculateNextPaymentDate('2026-07-28', 1))).toBe('2026-10-28');
  });
});
