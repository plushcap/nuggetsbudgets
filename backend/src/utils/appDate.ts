import { sql, type Kysely } from 'kysely';
import { currentDbOrGlobal, inTenantTransaction, withTenant } from '../db/withTenant.js';
import { getCurrentTenantId } from '../context/requestContext.js';
import type { DB } from '../db/schema.generated.js';
import { isValidTimeZone } from './syncSchedule.js';
import { oneRow, present } from './present.js';

/**
 * The household's calendar day. "Today", and the day an instant falls on,
 * come from the ledger's `application_timezone` setting (`tenant_settings`; the
 * deployment's in `system_settings` when the ledger has none), never from the Node
 * process TZ, the Postgres session TimeZone or UTC. SQL has the same rule in
 * `app_today()` / `app_timezone()`, so code and queries agree on the day; use
 * those in SQL instead of `CURRENT_DATE` or `now()::date`.
 */

/**
 * Run a query where `app_timezone()` reads the current ledger's zone: in the open tenant
 * transaction; for work in a ledger's scope between transactions (a bank sync), in a short
 * one of the ledger's; outside any ledger, on the global pool (the deployment's zone).
 */
async function inZoneScope<T>(query: (db: Kysely<DB>) => Promise<T>): Promise<T> {
  if (inTenantTransaction()) return query(currentDbOrGlobal());
  const tenantId = getCurrentTenantId();
  if (tenantId != null) return withTenant(tenantId, (trx) => query(trx));
  return query(currentDbOrGlobal());
}

/** The zone when `application_timezone` is unset or not a zone; `app_timezone()` falls back the same way. */
export const DEFAULT_APP_TIMEZONE = 'UTC';

/**
 * A zone name (America/New_York, UTC, Etc/GMT+5), not an offset. JavaScript reads
 * '+05:00' as UTC+5 and Postgres as POSIX UTC−5, so an offset would give the app
 * and SQL two different days; app_timezone() refuses one the same way.
 */
export function isTimeZoneName(zone: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_+/-]*$/.test(zone) && isValidTimeZone(zone);
}

/**
 * Whether `zone` may be the application time zone: a name JavaScript and Postgres read
 * as the same zone. Postgres reads a name that is also an abbreviation (CET, EST, MST…)
 * as that abbreviation's fixed offset, where JavaScript applies the zone's daylight
 * saving; and its tzdata may lack a name JavaScript knows (US/Eastern, Asia/Calcutta,
 * IST), which app_timezone() would read as UTC. Checked when the setting is written:
 * app_timezone() runs too often to read the zone catalog itself.
 */
export async function isAppTimeZone(zone: string): Promise<boolean> {
  if (!isTimeZoneName(zone)) return false;
  if (zone === DEFAULT_APP_TIMEZONE) return true;
  const { rows } = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${zone})
       AND NOT EXISTS (SELECT 1 FROM pg_timezone_abbrevs WHERE lower(abbrev) = lower(${zone})) AS ok
  `.execute(currentDbOrGlobal());
  return rows[0]?.ok === true;
}

/**
 * The application time zone: the current ledger's `application_timezone` as SQL's
 * `app_timezone()` reads it, in the caller's transaction when there is one (UTC when
 * it is unset or not a zone Postgres knows). Compute days with it in SQL
 * ({@link appDatesOf}), not with Intl.
 */
export async function appTimezone(): Promise<string> {
  const { rows } = await inZoneScope((db) => sql<{ zone: string | null }>`SELECT app_timezone() AS zone`.execute(db));
  return rows[0]?.zone || DEFAULT_APP_TIMEZONE;
}

// The days below are computed by Postgres, not by Intl: the two carry their own copies
// of the time-zone database, and where their versions disagree on a zone's rules
// (Morocco's, in 2026) JavaScript's day and app_today() differed for an hour a night.

/** Today's calendar date ('YYYY-MM-DD') in the application time zone, as `app_today()` has it. */
export async function appToday(now: Date = new Date()): Promise<string> {
  return appDateOf(now);
}

/** The calendar date ('YYYY-MM-DD') `instant` falls on in the application time zone. */
export async function appDateOf(instant: Date): Promise<string> {
  return present((await appDatesOf([instant]))[0], 'the day of the instant');
}

/**
 * {@link appDateOf} for many instants in one query, in order; in `zone` when given (one
 * {@link appTimezone} read, for work that reads the zone once).
 */
export async function appDatesOf(instants: readonly Date[], zone?: string): Promise<string[]> {
  if (instants.length === 0) return [];
  const { rows } = await inZoneScope((db) => sql<{ day: string }>`
    SELECT (t.instant AT TIME ZONE ${zone ?? sql`app_timezone()`})::date::text AS day
      FROM unnest(${instants.map((instant) => instant.toISOString())}::timestamptz[]) WITH ORDINALITY AS t(instant, n)
     ORDER BY t.n
  `.execute(db));
  return rows.map((row) => row.day);
}

/** The day and the minutes since midnight at `now` in the application time zone, from Postgres. */
export async function appLocalTime(now: Date = new Date()): Promise<{ day: string; minutes: number }> {
  const { rows } = await inZoneScope((db) => sql<{ day: string; minutes: number }>`
    SELECT local::date::text AS day, (extract(hour FROM local) * 60 + extract(minute FROM local))::int AS minutes
      FROM (SELECT ${now.toISOString()}::timestamptz AT TIME ZONE app_timezone() AS local) AS t
  `.execute(db));
  return oneRow(rows, 'the zone clock');
}
