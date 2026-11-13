import type { BudgetPeriodResponse } from '@nuggets/shared';
/**
 * Budget-period display helpers.
 *
 * The API returns budget periods in ascending chronological order (year, then
 * month), and several places depend on that: the Budget and Close-Out pages
 * navigate periods by array INDEX with prev/next arrows, and DashboardSummary
 * falls back to `periods[periods.length - 1]` to mean "newest". So the fetched
 * order must be left alone.
 *
 * Selection dropdowns want the opposite: the newest period first, so the one
 * you almost always want is at the top instead of the bottom of a long scroll.
 * (Picking a stale period by mistake silently mis-files a transaction — it
 * still shows a budget item, but lands in the wrong envelope.)
 *
 * Use this at the render site only; it returns a sorted COPY and never mutates
 * the query cache's array.
 */

/** Minimal shape needed to order a period — matches `BudgetPeriod`. */
interface PeriodLike {
  year: number;
  month_number: number;
}

/**
 * A copy of `periods` ordered newest first (most recent year+month at index 0).
 * Intended for selection dropdowns; leaves the source array untouched.
 */
export function periodsNewestFirst<T extends PeriodLike>(periods: readonly T[]): T[] {
  return [...periods].sort((a, b) => b.year - a.year || b.month_number - a.month_number);
}

/** What a picker needs to tell an archived period, and the one it has chosen: `BudgetPeriod`'s. */
interface ChoosablePeriod extends PeriodLike {
  id: number;
  uuid: string;
  archived_at?: string | null | undefined;
}

/**
 * The periods a picker offers, newest first: not the archived ones, which a member hid
 * (Settings → Budget Periods), but the one it has chosen, `selected` (its id or uuid), archived
 * or not, so the picker still shows what it holds: a transaction's period, the period shown.
 */
export function periodChoices<T extends ChoosablePeriod>(periods: readonly T[], selected?: number | string | null | undefined): T[] {
  return periodsNewestFirst(periods.filter((p) => !p.archived_at || p.id === selected || p.uuid === selected));
}

/** The `YYYY-MM` key a period goes by in the Budget page's URL and saved selection. */
export function periodKey(period: PeriodLike): string {
  return `${period.year}-${String(period.month_number).padStart(2, '0')}`;
}

/** The index of the period a `YYYY-MM` key names, or -1. */
function indexOfKey(periods: readonly PeriodLike[], key: string): number {
  const [yearStr = '', monthStr = ''] = key.split('-');
  const year = parseInt(yearStr);
  const month = parseInt(monthStr);
  if (isNaN(year) || isNaN(month)) return -1;
  return periods.findIndex((p) => p.year === year && p.month_number === month);
}

/**
 * Which period (an index into the chronological `periods`) the Budget page shows:
 * 1. the URL's `period`: a period's uuid or its `YYYY-MM` key;
 * 2. else the period saved this session (`YYYY-MM`);
 * 3. else the period of `today` (a `YYYY-MM-DD` calendar date), else the active
 *    period, else the newest.
 * A URL or saved value that names no period shows the first one (index 0); it
 * doesn't fall through to the next rule.
 */
export function resolvePeriodIndex(
  periods: readonly (PeriodLike & { uuid: string; status?: BudgetPeriodResponse['status'] | undefined })[],
  urlPeriod: string | null,
  savedPeriod: string | null,
  today: string,
): number {
  if (urlPeriod) {
    const byUuid = periods.findIndex((p) => p.uuid === urlPeriod);
    if (byUuid >= 0) return byUuid;
    return Math.max(indexOfKey(periods, urlPeriod), 0);
  }
  if (savedPeriod) return Math.max(indexOfKey(periods, savedPeriod), 0);
  const current = indexOfKey(periods, today.slice(0, 7));
  if (current >= 0) return current;
  const active = periods.findIndex((p) => p.status === 'active');
  if (active >= 0) return active;
  return periods.length > 0 ? periods.length - 1 : 0;
}
