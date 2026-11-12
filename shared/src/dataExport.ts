import { z } from 'zod';
import { CALENDAR_DAY_YEARS, queryCalendarDay } from './primitives.js';

const EXPORT_RANGE = `start_date and end_date must be dates in YYYY-MM-DD form, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}`;

/**
 * GET /api/export/transactions and /api/export/account-transactions/:accountUuid query: the
 * optional range, inclusive calendar days (queryCalendarDay). The backend's own date
 * check took years 1 to 9999, which no ledger holds.
 */
export const exportDateRangeQuery = z.object({
  start_date: queryCalendarDay({ message: EXPORT_RANGE }),
  end_date: queryCalendarDay({ message: EXPORT_RANGE }),
});
export type ExportDateRangeQuery = z.infer<typeof exportDateRangeQuery>;
