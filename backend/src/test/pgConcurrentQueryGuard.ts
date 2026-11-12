import pg from 'pg';
import { SingleConnectionProvider } from 'kysely';
import { afterAll, afterEach } from 'vitest';

/**
 * Fails a test that sends a query on a database connection while that connection is
 * still running one. pg 8 queues the second query and prints a DeprecationWarning
 * (once per process, so a run shows only the first); pg 9 refuses it. Inside a
 * transaction it is also a sign of code that expects parallelism a single connection
 * can't give: the queries only wait for each other.
 *
 * Two places are watched, both once per process:
 * - `pg.Client.prototype.query`: a raw query sent while its client has one running or
 *   queued (a `Promise.all` over `client.query`, a query not awaited before the next).
 * - Kysely's `SingleConnectionProvider`, which runs a transaction's queries (a
 *   `withTenant` transaction's, getDb()'s) one at a time on its connection, so pg never
 *   sees them overlap: a query started while another of the same transaction is still
 *   running (a `Promise.all` over getDb()).
 *
 * Each is recorded with its stack, and the test it ran in fails when it ends (afterEach),
 * or the file at its end (afterAll) for one sent from a hook outside a test. The query
 * itself still runs as it would have, so code that catches the error can't hide one, and
 * one sent between tests (a timer) is still reported. Loaded by src/test/setup.ts for
 * every test.
 */

const STATE = Symbol.for('nuggets.pgConcurrentQueryGuard');

interface GuardState {
  /** The stack of each query sent while its connection was busy, since the last check. */
  violations: string[];
}

/** pg's own fields for the query in flight and the queries waiting behind it (pg 8). */
interface ClientInternals {
  _activeQuery?: unknown;
  _queryQueue?: unknown[];
  pipeline?: boolean;
}

/** The first line of a query's SQL, to say which one it was. */
function sqlHead(query: unknown): string {
  const text = typeof query === 'string' ? query : (query as { text?: unknown } | undefined)?.text;
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 120) : '(a query object)';
}

function installGuard(): GuardState {
  const holder = globalThis as typeof globalThis & { [STATE]?: GuardState };
  const installed = holder[STATE];
  if (installed) return installed;

  // A pg upgrade that renamed these would turn the guard off without a word: refuse instead.
  const probe = new pg.Client() as unknown as ClientInternals;
  if (!('_activeQuery' in probe) || !Array.isArray(probe._queryQueue)) {
    throw new Error(
      "src/test/pgConcurrentQueryGuard.ts reads pg.Client's _activeQuery and _queryQueue, which this pg version lacks: update the guard"
    );
  }

  const state: GuardState = { violations: [] };
  const record = (where: string) => {
    state.violations.push(`${where}\n${new Error('sent while the connection was busy').stack ?? ''}`);
  };

  const originalQuery = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  // pg 8 warns on `_queryQueue.length > 0`; a query running counts too, so two at once are
  // caught, not only the third.
  pg.Client.prototype.query = function guardedQuery(this: ClientInternals, ...args: unknown[]) {
    if (!this.pipeline && (this._activeQuery || (this._queryQueue?.length ?? 0) > 0)) record(`pg client.query(): ${sqlHead(args[0])}`);
    return originalQuery.apply(this, args);
  } as typeof pg.Client.prototype.query;

  // How many of each transaction's queries are running or waiting for its connection.
  const inFlight = new WeakMap<object, number>();
  const originalProvide = SingleConnectionProvider.prototype.provideConnection;
  SingleConnectionProvider.prototype.provideConnection = async function guardedProvideConnection(this: SingleConnectionProvider, consumer) {
    const running = inFlight.get(this) ?? 0;
    if (running > 0) record('a query on a Kysely transaction (getDb())');
    inFlight.set(this, running + 1);
    try {
      return await originalProvide.call(this, consumer);
    } finally {
      inFlight.set(this, (inFlight.get(this) ?? 1) - 1);
    }
  } as typeof SingleConnectionProvider.prototype.provideConnection;

  holder[STATE] = state;
  return state;
}

const state = installGuard();

/**
 * What the guard has recorded since the last check, cleared: for its own test, which
 * sends overlapping queries on purpose.
 */
export function takeConcurrentQueries(): string[] {
  return state.violations.splice(0);
}

function failOnConcurrentQueries(when: string): void {
  const found = takeConcurrentQueries();
  if (found.length === 0) return;
  throw new Error(
    `${found.length} quer${found.length === 1 ? 'y was' : 'ies were'} sent on a database connection that was still running one ${when}. ` +
    'Run them one after another (await each), or on separate pool connections outside a transaction:\n\n' +
    found.join('\n\n')
  );
}

afterEach(() => failOnConcurrentQueries('during this test'));
afterAll(() => failOnConcurrentQueries("in this file's hooks"));
