/**
 * When a bill is due: its anchor date (recurring_next_payment_date) plus whole
 * multiples of its frequency in months, on the anchor's day of the month — or
 * the month's last day when the month is shorter (an anchor of Jan 31 is due
 * Feb 28, then Mar 31). Days are 'YYYY-MM-DD', months 'YYYY-MM'. Pure. The month
 * arithmetic is the calendar-day helpers' (utils/calendarDate.ts), which keep a year
 * under 100 as itself, written with four digits.
 */

import { addMonths as addCalendarMonths, lastOfMonth } from '../../utils/calendarDate.js';

function parts(day: string): { year: number; month: number; date: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)), date: Number(day.slice(8, 10)) };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The number of days in `month` ('YYYY-MM'). */
function daysInMonth(month: string): number {
  return Number(lastOfMonth(`${month}-01`).slice(8, 10));
}

/** Months from `from` to `to` ('YYYY-MM'); negative when `to` is earlier. */
export function monthsBetween(from: string, to: string): number {
  return (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
}

/** `month` moved by `count` months. */
export function addMonths(month: string, count: number): string {
  return addCalendarMonths(`${month}-01`, count).slice(0, 7);
}

/** The anchor's due day in `month`: its day of the month, or the month's last day. */
function dueDayIn(month: string, anchorDate: number): string {
  return `${month}-${pad(Math.min(anchorDate, daysInMonth(month)))}`;
}

/**
 * The day the bill is due in `month`, or null when it isn't due that month.
 * Only months on or after the anchor's count (the schedule starts there).
 */
export function dueDateIn(anchor: string, frequencyMonths: number, month: string): string | null {
  if (!(frequencyMonths >= 1)) return null;
  const offset = monthsBetween(anchor.slice(0, 7), month);
  if (offset < 0 || offset % frequencyMonths !== 0) return null;
  return dueDayIn(month, parts(anchor).date);
}

export { addDays, daysBetween } from '../../utils/calendarDate.js';
