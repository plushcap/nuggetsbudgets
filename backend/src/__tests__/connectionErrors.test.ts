import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { Pool } from 'pg';
import { handleConnectionErrors } from '../db/connectionErrors.js';

/**
 * A connection whose server session ends emits 'error', idle in its pool or checked out
 * (a shutdown ending a restore's migration crashed on its checked-out
 * lock connection). A stand-in client, so no database is needed: pg-pool takes a Client
 * class.
 */
class FakeClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(callback?: (err?: Error) => void) {
    if (callback) {
      callback();
      return undefined;
    }
    return Promise.resolve();
  }
  query() {
    return Promise.resolve({ rows: [] });
  }
  end(callback?: () => void) {
    this._ending = true;
    if (callback) callback();
    return Promise.resolve();
  }
}

const fakePool = () => new Pool({ Client: FakeClient as never, max: 2 });

describe('handleConnectionErrors', () => {
  it("without it, a checked-out connection's error is thrown", async () => {
    const pool = fakePool();
    const client = (await pool.connect()) as unknown as FakeClient;
    expect(() => client.emit('error', new Error('terminating connection due to administrator command'))).toThrow(/administrator command/);
  });

  it('passes on a checked-out connection\'s error, and an idle one\'s once', async () => {
    const pool = fakePool();
    const seen: string[] = [];
    handleConnectionErrors(pool, (err) => seen.push(err.message));

    const busy = (await pool.connect()) as unknown as FakeClient & { release: () => void };
    expect(() => busy.emit('error', new Error('ended while checked out'))).not.toThrow();
    expect(seen).toEqual(['ended while checked out']);

    const idle = (await pool.connect()) as unknown as FakeClient & { release: () => void };
    idle.release();
    // The pool's own listener re-emits it on the pool; the connection's listener hears it too.
    expect(() => idle.emit('error', new Error('ended while idle'))).not.toThrow();
    expect(seen).toEqual(['ended while checked out', 'ended while idle']);
  });
});
