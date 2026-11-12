/**
 * Telling "the database isn't reachable (yet)" from every other database error.
 *
 * A connection refused or timed out, a name that doesn't resolve yet (its container
 * isn't up), a server starting up or shutting down (57P01-57P03) or out of connections
 * (53300), or a connection that dropped: waiting may fix these. A wrong password, an
 * unknown role or database, a missing table or a bug won't go away by trying again.
 * docker-entrypoint.sh's wait (`migrate check`) and the startup of the schedulers
 * (ApplicationLifecycleService.initializeServices) use it. A database that refuses every
 * connection (55000, ALLOW_CONNECTIONS off) isn't one of these: see allowConnectionsHint.
 */

const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
  '57P01', '57P02', '57P03', '53300',
]);

/** One line saying what went wrong, including each address a connection was tried at. */
export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string; errors?: unknown[] };
  const message = e.message || (Array.isArray(e.errors) ? e.errors.map((inner) => (inner as Error).message).join('; ') : '');
  return [e.code, message || String(err)].filter(Boolean).join(': ');
}

/**
 * What to do about a database that refuses every connection (`database "…" is not
 * currently accepting connections`, SQLSTATE 55000): its ALLOW_CONNECTIONS is off. A
 * restore turns it off while it swaps the databases, and one stopped part way leaves it
 * so; waiting doesn't help, an owner has to turn it back on.
 */
export function allowConnectionsHint(database: string): string {
  return (
    `The database ${quotedName(database)} doesn't accept connections (ALLOW_CONNECTIONS is off). A restore that was ` +
    `stopped while it swapped the databases leaves it so, still holding the data from before the restore. ${allowConnectionsFix(database)}`
  );
}

/** The fix allowConnectionsHint gives: the statement to run, and where. */
export function allowConnectionsFix(database: string): string {
  return (
    `Connected to another database (postgres) as its owner or a superuser, run: ALTER DATABASE ${quotedName(database)} ` +
    'ALLOW_CONNECTIONS true; then start the backend again.'
  );
}

const quotedName = (database: string) => `"${database.replace(/"/g, '""')}"`;

/** Whether `err` says the database refuses every connection: see allowConnectionsHint. */
export function isDatabaseNotAcceptingConnections(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '55000' && /not currently accepting connections/i.test(e.message ?? '');
}

/** Whether `err` (or what caused it) says the database can't be reached right now. */
export function isDatabaseUnreachable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: string }).code;
    if (code && (UNREACHABLE_CODES.has(code) || code.startsWith('08'))) return true;
    // node-postgres and its pool say so in words.
    if (/timeout expired|connection timeout|timeout exceeded when trying to connect|Connection terminated/i.test(describeError(e))) {
      return true;
    }
  }
  return false;
}
