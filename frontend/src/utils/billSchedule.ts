import { calendarDatePart, parseCalendarDate, todayLocal } from './dateUtils';

/**
 * When a bill is due, by the backend's rule (backend/src/services/bills/schedule.ts):
 * its anchor date (recurring_next_payment_date) plus whole multiples of its frequency
 * in months, on the anchor's day of the month, or the month's last day when the month
 * is shorter (an anchor of Jan 31 is due Feb 28, then Mar 31). Days are 'YYYY-MM-DD'.
 */

const pad = (value: number) => String(value).padStart(2, '0');

/** The bill's due day `months` months after its anchor's month. */
function dueDayAfter(anchor: string, months: number): string {
  const index = Number(anchor.slice(0, 4)) * 12 + Number(anchor.slice(5, 7)) - 1 + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const lastDay = new Date(year, month, 0).getDate();
  return `${year}-${pad(month)}-${pad(Math.min(Number(anchor.slice(8, 10)), lastDay))}`;
}

/**
 * The first day on or after `today` that the bill is due ('YYYY-MM-DD'), or null
 * without a valid anchor and a whole number of months. A payment due later this
 * month is this month's: counting whole months alone skipped it (Jan 15 monthly,
 * on Mar 10, gave Apr 15).
 */
export function nextDueDate(anchor: string | undefined | null, frequencyMonths: number | undefined | null, today: string = todayLocal()): string | null {
  const start = calendarDatePart(anchor ?? undefined);
  if (!start || !frequencyMonths || !Number.isInteger(frequencyMonths) || frequencyMonths < 1) return null;
  if (start >= today) return start;

  const monthsToToday =
    (Number(today.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(start.slice(5, 7));
  // The last due month on or before today's month; its day may still be ahead.
  let periods = Math.floor(monthsToToday / frequencyMonths);
  let due = dueDayAfter(start, periods * frequencyMonths);
  while (due < today) {
    periods += 1;
    due = dueDayAfter(start, periods * frequencyMonths);
  }
  return due;
}

/** {@link nextDueDate} as a `Date` at local midnight, for date math and display. */
export function calculateNextPaymentDate(anchor: string | undefined | null, frequencyMonths: number | undefined | null): Date | null {
  const due = nextDueDate(anchor, frequencyMonths);
  return due ? parseCalendarDate(due) : null;
}
