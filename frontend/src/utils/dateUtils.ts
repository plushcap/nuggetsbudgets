/**
 * Calendar dates and instants.
 *
 * A **calendar date** is a day with no time of day: a Postgres DATE column such
 * as a transaction's transaction_date, a goal's target date, a budget period's
 * start_date/end_date, a bill's due date or a snapshot_date. The API sends it as
 * 'YYYY-MM-DD'. Older responses sent some as an ISO timestamp instead
 * ('YYYY-MM-DDT00:00:00.000Z', or 'YYYY-MM-DDT05:00:00.000Z' from a server five
 * hours west of UTC); its date part is the day, and every helper here accepts both.
 *
 * Never pass a calendar date to `new Date(value)`: that reads it as midnight UTC,
 * which is the evening before anywhere west of UTC, so the day shows, sorts into
 * a chart bucket and compares one day early (on the 1st, one month early). And
 * never take "today" from `toISOString()`: that is the UTC day, which is already
 * tomorrow on a US evening and still yesterday on an early morning east of UTC.
 * `npm run lint:guard` rejects both.
 *
 * An **instant** (a timestamptz: `created_at`, `*_at`, sync times, an account's
 * `import_balance_date`, an attachment's `date_uploaded`) is a moment, and
 * `new Date(iso)` is right for it. `formatInstantDate` shows the local day it
 * happened on. Classify a field by what it stores, not by its name.
 */

import { logger } from './logger';

type DateInput = string | null | undefined;

// 'YYYY-MM-DD', alone or followed by a time ('T…', or ' …' as Postgres prints one).
const DATE_PART = /^(\d{4})-(\d{2})-(\d{2})(?=$|[T ])/;

/** Local midnight of y-m-d (1-based month), also for years below 100. */
function localDate(year: number, month: number, day: number): Date {
  const date = new Date(2000, 0, 1);
  date.setFullYear(year, month - 1, day);
  return date;
}

function splitDatePart(part: string): [number, number, number] {
  const [year = NaN, month = NaN, day = NaN] = part.split('-').map(Number);
  return [year, month, day];
}

/**
 * The 'YYYY-MM-DD' day of a calendar date the API sent either as 'YYYY-MM-DD'
 * or as an ISO timestamp 'YYYY-MM-DDT…'. Null when there is no value or it is
 * not a real day.
 */
export function calendarDatePart(value: DateInput): string | null {
  if (!value) return null;
  const match = DATE_PART.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = localDate(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/** The local calendar day of a `Date` (a date picker's choice, a computed day), as 'YYYY-MM-DD'. */
export function toCalendarDateString(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Today in the user's time zone, as 'YYYY-MM-DD': the default for any "today" date field. */
export function todayLocal(): string {
  return toCalendarDateString(new Date());
}

/**
 * A calendar date as a `Date` at local midnight of that day, for date-fns,
 * chart buckets and local getters (`getMonth()`, `getDate()`, ...). An Invalid
 * Date when the value is not a calendar date.
 */
export function parseCalendarDate(value: DateInput): Date {
  const part = calendarDatePart(value);
  return part ? localDate(...splitDatePart(part)) : new Date(NaN);
}

/**
 * Format a calendar date like `toLocaleDateString(locale, options)` does, on its
 * own day. '' when there is no value; the value unchanged when it is not a date.
 */
export function formatCalendarDate(value: DateInput, locale?: string, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return '';
  const date = parseCalendarDate(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale, options);
}

/** The 'YYYY-MM' month a calendar date falls in (a month bucket key), or null. */
export function calendarMonthKey(value: DateInput): string | null {
  return calendarDatePart(value)?.slice(0, 7) ?? null;
}

/**
 * Format a 'YYYY-MM' month key (or the month of a calendar date), by default as
 * "October 2026". The value unchanged when it is not a month.
 */
export function formatCalendarMonth(
  month: string,
  locale: string = 'en-US',
  options: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' },
): string {
  const key = /^\d{4}-\d{2}$/.test(month) ? month : calendarMonthKey(month);
  const firstOfMonth = key && calendarDatePart(`${key}-01`);
  return firstOfMonth ? formatCalendarDate(firstOfMonth, locale, options) : month;
}

/**
 * Whole calendar days from `from` to `to`: 1 from today to tomorrow, negative
 * when `to` is earlier, NaN when either is not a date. Counts days rather than
 * 24-hour spans, so a daylight-saving change between them doesn't skew it.
 */
export function calendarDaysBetween(from: DateInput, to: DateInput): number {
  const a = calendarDatePart(from);
  const b = calendarDatePart(to);
  if (!a || !b) return NaN;
  const utcMidnight = (part: string) => {
    const [year, month, day] = splitDatePart(part);
    const date = new Date(0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getTime();
  };
  return Math.round((utcMidnight(b) - utcMidnight(a)) / 86_400_000);
}

/**
 * Compare two calendar dates for `Array.prototype.sort`: earliest first, with
 * values that are not dates last. Pass `(b, a)` for newest first.
 */
export function compareCalendarDates(a: DateInput, b: DateInput): number {
  const x = calendarDatePart(a);
  const y = calendarDatePart(b);
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return x < y ? -1 : 1;
}

/** Whether calendar date `date` falls within `start`..`end`, both days included. False when any is not a date. */
export function isCalendarDateInRange(date: DateInput, start: DateInput, end: DateInput): boolean {
  const day = calendarDatePart(date);
  const first = calendarDatePart(start);
  const last = calendarDatePart(end);
  return !!day && !!first && !!last && first <= day && day <= last;
}

/**
 * Format the local day an instant (a timestamptz such as `created_at`)
 * happened on, like `toLocaleDateString(locale, options)`. Not for calendar
 * dates. '' when there is no value; the value unchanged when it doesn't parse.
 */
export function formatInstantDate(value: DateInput, locale?: string, options?: Intl.DateTimeFormatOptions): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale, options);
}

/** Display presets for calendar dates, built on the helpers above. */
export class DateUtils {
  /**
   * A calendar date ('YYYY-MM-DD' or 'YYYY-MM-DDT…') as a `Date` at local
   * midnight of that day. Throws when the value is not a calendar date.
   */
  static parseBusinessDate(dateString: string): Date {
    const date = parseCalendarDate(dateString);
    if (Number.isNaN(date.getTime())) {
      throw new Error('Invalid date format. Expected YYYY-MM-DD');
    }
    return date;
  }

  /** A calendar date as "Sep 1, 2025". */
  static formatForDisplay(dateString: string, locale: string = 'en-US'): string {
    return DateUtils.formatPreset(dateString, locale, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  /** A calendar date as "09/01/2025". */
  static formatDateUS(dateString: string): string {
    return DateUtils.formatPreset(dateString, 'en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
  }

  private static formatPreset(dateString: string, locale: string, options: Intl.DateTimeFormatOptions): string {
    if (!calendarDatePart(dateString)) {
      logger.warn({ dateString }, 'Date formatting error');
      return dateString;
    }
    return formatCalendarDate(dateString, locale, options);
  }
}
