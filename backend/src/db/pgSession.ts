import pg from 'pg';
import { config } from '../config.js';

/**
 * How every connection the backend opens reads dates and times, whatever the
 * Node process TZ or the Postgres server's default zone.
 *
 * - **A `date` stays a `'YYYY-MM-DD'` string.** node-postgres turns a `date`
 *   (OID 1082) into a JS `Date` at *local* midnight by default, so a calendar day
 *   depended on the process TZ and came out a day early once code (or
 *   `JSON.stringify`) read it back in UTC. Registered once for the process, as
 *   `pg.types` is shared by every pool. `date[]` (OID 1182) is parsed like
 *   `text[]`. `timestamptz` is unchanged: an instant is still a `Date`.
 * - **Sessions run UTC** ({@link sessionOptions}), so `now()::date`,
 *   `date_trunc` on a `timestamptz` and the text form of an instant don't follow
 *   the server's default zone (initdb takes it from the container's TZ). The
 *   household's calendar day comes from the ledger's `application_timezone`
 *   setting instead: `app_today()` in SQL, utils/appDate.ts in code.
 *
 * Imported by db.ts and db/migrationPool.ts.
 */

type TypeId = typeof pg.types.builtins.DATE;
const parseTimestampDefault = pg.types.getTypeParser(pg.types.builtins.TIMESTAMP);
const PLAIN_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;
// Array types aren't in pg-types' TypeId enum.
const DATE_ARRAY_OID = 1182 as TypeId;
const TEXT_ARRAY_OID = 1009 as TypeId;

pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);
pg.types.setTypeParser(DATE_ARRAY_OID, pg.types.getTypeParser(TEXT_ARRAY_OID));
// A `timestamp` without a zone (`'2026-12-31'::date + interval '1 day'`, say) is a UTC
// wall clock in these UTC sessions; node-postgres would read it in the process TZ.
// Infinity and BC values keep the default parser.
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (value: string) =>
  PLAIN_TIMESTAMP.test(value) ? new Date(`${value.replace(' ', 'T')}Z`) : parseTimestampDefault(value));

/**
 * The `options` startup parameter for a pool: `PGOPTIONS` (which node-postgres
 * would otherwise use on its own), then `TimeZone=UTC` and `DateStyle=ISO, MDY`,
 * which win over the same settings there and over the database's, role's or
 * server's default. node-postgres reads dates and timestamps only in the ISO style:
 * under `DateStyle=SQL, DMY` a date came back as '31/12/2026' and a timestamptz as
 * null. The field order (MDY, Postgres's default) is pinned too: `ISO` alone kept a
 * configured DMY, which read an input '01/02/2026' as February 1.
 *
 * `applicationName` names the pool's sessions in pg_stat_activity and the server's log.
 * It comes first, so an `application_name` in PGOPTIONS (or PGAPPNAME) wins.
 */
export function sessionOptions(applicationName?: string): string {
  return [
    applicationName ? `-c application_name=${applicationName}` : undefined,
    config().PGOPTIONS,
    '-c TimeZone=UTC',
    '-c DateStyle=ISO,MDY',
  ].filter(Boolean).join(' ');
}
