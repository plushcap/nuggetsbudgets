/**
 * Calendar arithmetic for notification rules, in the application time zone.
 * Days are 'YYYY-MM-DD' strings and are added as UTC dates, so no day ever
 * gains or loses an hour across a daylight-saving change. Pure.
 */

import { addDays, daysBetween } from '../../utils/calendarDate.js';

/** The local day and minutes since local midnight at `now` in `timeZone`. */
export function localTime(now: Date, timeZone: string): { day: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value])
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

export { addDays, daysBetween };

/** ISO weekday of `day`: 1 Monday … 7 Sunday. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay() || 7;
}

/** The Monday of `day`'s week. */
export function mondayOf(day: string): string {
  return addDays(day, 1 - weekdayOf(day));
}

// A digest goes from its hour until a day later; a run that first notices it
// later than that (the scheduler was off, say) leaves it for next week rather
// than sending it just before the next one.
const digestWindowMinutes = 24 * 60;

/**
 * The local day a weekly digest scheduled for `weekday` at `hour` was due on,
 * when it is due at local `day` and `minutes`; null when it isn't due. Due
 * means from its hour until 24 hours later, also across the end of the week.
 */
export function digestDueOn(weekday: number, hour: number, day: string, minutes: number): string | null {
  const week = 7 * 24 * 60;
  const sinceWeekStart = (weekdayOf(day) - 1) * 24 * 60 + minutes;
  const scheduled = (weekday - 1) * 24 * 60 + hour * 60;
  const late = (sinceWeekStart - scheduled + week) % week;
  if (late >= digestWindowMinutes) return null;
  return minutes >= late ? day : addDays(day, -1);
}
