/**
 * Calendar dates: a day with no time of day and no zone, held as a
 * `'YYYY-MM-DD'` string end to end. A `date` column reads as one
 * (db/pgSession.ts), and the API answers with one.
 *
 * Never route a calendar date through a `Date` and back: `new Date('2026-12-31')`
 * is UTC midnight, which the local getters read as Dec 30 west of UTC, and
 * `toISOString()` on a local-midnight `Date` gives the day before east of UTC.
 * The arithmetic here runs on UTC days, so neither the process TZ nor a DST
 * change moves a day. Pure, no DB.
 */

const DAY_MS = 86_400_000;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC calendar date of `instant` — the one sanctioned `toISOString()` slice. */
function utcDayOf(instant: Date): string {
  // eslint-disable-next-line no-restricted-syntax -- the one sanctioned UTC-day read
  return instant.toISOString().slice(0, 10);
}

/** Whether `value` is a real `'YYYY-MM-DD'` day (not `2026-02-30`, not a timestamp). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = CALENDAR_DATE.exec(value);
  // Year 0000 parses in JS but isn't a date to Postgres.
  if (!match || Number(match[1]) < 1) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && utcDayOf(new Date(ms)) === value;
}

/** The year and month (1–12) of `day`. */
export function yearMonthOf(day: string): { year: number; month: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) };
}

/** `day` moved by `days` calendar days (negative moves back). */
export function addDays(day: string, days: number): string {
  return utcDayOf(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The first day of `day`'s month. */
export function firstOfMonth(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * UTC midnight of `year`, `monthIndex` (0–11; others roll into the next or last year) and
 * `day` (0 is the last day of the month before). Not `Date.UTC`, which reads a year from 0 to
 * 99 as 1900–1999: the last day of 0050-02 was 1950-02-28.
 */
function utcMidnight(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

/** The last day of `day`'s month. */
export function lastOfMonth(day: string): string {
  const { year, month } = yearMonthOf(day);
  return utcDayOf(utcMidnight(year, month, 0));
}

/** `day` moved by `count` months, clamped to the target month's last day. */
export function addMonths(day: string, count: number): string {
  const { year, month } = yearMonthOf(day);
  const target = utcMidnight(year, month - 1 + count, 1);
  const last = utcMidnight(target.getUTCFullYear(), target.getUTCMonth() + 1, 0).getUTCDate();
  target.setUTCDate(Math.min(Number(day.slice(8, 10)), last));
  return utcDayOf(target);
}

/**
 * The calendar date of `instant` in `timeZone` (an IANA name such as
 * `America/New_York`). Throws a RangeError on an unknown zone.
 */
export function calendarDateIn(timeZone: string, instant: Date = new Date()): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(instant)
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}
