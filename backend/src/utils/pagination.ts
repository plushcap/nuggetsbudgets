import { QUERY_MAX_PAGE } from '@nuggets/shared';

/**
 * Paging parameters from a query string, bounded. A route that validates its
 * query (validateQuery) reads them the same way with the shared `queryPage` / `queryInt`.
 *
 * A list route read `parseInt(req.query.limit) || N` and used it as is: `?limit=1000000`
 * returned a whole table, and `?page=0` or a negative limit made a negative LIMIT or
 * OFFSET, which Postgres refuses (a 500). These read the value the same way, fall back
 * to the default for one that is missing, not a number, or below the minimum (as `|| N`
 * did for 0), and cap it at the route's maximum.
 */

/** A whole number from a query parameter: `fallback` when absent, not a number or below `min`; at most `max`. */
export function boundedQueryInt(value: unknown, opts: { fallback: number; min: number; max: number }): number {
  const n = parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < opts.min) return opts.fallback;
  return Math.min(n, opts.max);
}

/** The highest page number accepted; past it the offset would only scan to return nothing. */
const MAX_PAGE = QUERY_MAX_PAGE;

/** `page` (from 1) and `limit` (1..maxLimit), and the offset they make. */
export function pageParams(
  query: Record<string, unknown>,
  opts: { defaultLimit: number; maxLimit: number }
): { page: number; limit: number; offset: number } {
  const limit = boundedQueryInt(query.limit, { fallback: opts.defaultLimit, min: 1, max: opts.maxLimit });
  const page = boundedQueryInt(query.page, { fallback: 1, min: 1, max: MAX_PAGE });
  return { page, limit, offset: (page - 1) * limit };
}

/** `limit` (1..maxLimit) and `offset` (0 or more) for a route paged by offset. */
export function offsetParams(
  query: Record<string, unknown>,
  opts: { defaultLimit: number; maxLimit: number }
): { limit: number; offset: number } {
  const limit = boundedQueryInt(query.limit, { fallback: opts.defaultLimit, min: 1, max: opts.maxLimit });
  const offset = boundedQueryInt(query.offset, { fallback: 0, min: 0, max: MAX_PAGE * opts.maxLimit });
  return { limit, offset };
}
