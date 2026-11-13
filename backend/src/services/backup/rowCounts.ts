import { escapeIdentifier, type ClientBase } from 'pg';

/**
 * Row counts of a backup's data: the rows in every `public` table, counted in the snapshot
 * pg_dump dumps and recorded in the signed manifest (format 5), then counted again in the
 * scratch database right after pg_restore, before the migrations change any. A dump cut
 * short, or one pg_restore only partly put back, shows here as a table with fewer rows.
 */

/**
 * The rows in every table of the `public` schema, as `client` sees them, by table name. The
 * caller runs it with `row_security = off`, so a table row-level security would filter errors
 * rather than undercounts (the owner that makes and restores backups bypasses it).
 */
export async function countPublicTables(client: ClientBase): Promise<Record<string, number>> {
  const { rows: tables } = await client.query<{ name: string }>(
    "SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename"
  );
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const { rows } = await client.query<{ n: string }>(`SELECT count(*) AS n FROM public.${escapeIdentifier(name)}`);
    counts[name] = Number(rows[0]?.n ?? 0);
  }
  return counts;
}

/** At most this many differences a mismatch names. */
const NAMED_DIFFERENCES = 5;

/**
 * How `restored` differs from what the backup recorded (`recorded`), for people: null when
 * they are the same tables with the same numbers of rows.
 */
export function rowCountMismatch(recorded: Readonly<Record<string, number>>, restored: Readonly<Record<string, number>>): string | null {
  const differences: string[] = [];
  for (const table of [...new Set([...Object.keys(recorded), ...Object.keys(restored)])].sort()) {
    const want = recorded[table];
    const got = restored[table];
    if (want === got) continue;
    if (want === undefined) differences.push(`${table} is in the restored data but not in the backup's counts`);
    else if (got === undefined) differences.push(`${table} (${want} rows in the backup) is missing`);
    else differences.push(`${table} has ${got} rows, the backup ${want}`);
  }
  if (differences.length === 0) return null;
  const named = differences.slice(0, NAMED_DIFFERENCES).join('; ');
  const more = differences.length - NAMED_DIFFERENCES;
  return more > 0 ? `${named}; and ${more} more` : named;
}
