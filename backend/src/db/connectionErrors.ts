import type { Pool, PoolClient } from 'pg';

/**
 * Hand every failure of `pool`'s connections to `onError`, once each.
 *
 * pg emits 'error' on a connection whose server session ends (pg_terminate_backend, a
 * restart, a restore's swap or its shutdown ending the work on the scratch database),
 * whether it is idle in the pool or checked out. The pool listens only while a connection
 * is idle in it, and re-emits that as its own 'error'; a checked-out connection has no
 * listener unless its user adds one. Either one unheard is an uncaught exception, which
 * stops the server (ApplicationLifecycleService) or the script. A query running on the
 * connection fails as itself either way, and the pool drops the connection when it is
 * released.
 *
 * An idle connection's failure reaches both the pool's listener and the connection's:
 * it is passed on once.
 */
export function handleConnectionErrors(pool: Pool, onError: (err: Error) => void): Pool {
  const passedOn = new WeakSet<object>();
  const once = (err: Error) => {
    if (typeof err === 'object' && err !== null) {
      if (passedOn.has(err)) return;
      passedOn.add(err);
    }
    onError(err);
  };
  pool.on('error', once);
  pool.on('connect', (client: PoolClient) => {
    client.on('error', once);
  });
  return pool;
}
