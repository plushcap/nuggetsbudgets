import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// Long enough that the deadlock detector (1 s) decides the race below, short enough for the
// lock-timeout case to end in this test's time. db.ts reads it as it's imported.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '3000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createMerchantsRoutes } from '../merchants.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Merging a merchant against removing the unused ones. The merge moved the source's
 * matching rules to the target (locking those rules), and only at its end deleted the
 * source; the cleanup locks the unused merchants (the source among them: rules don't count
 * as a use) and deletes them, which deletes their rules (ON DELETE CASCADE). Each then
 * waited for what the other held: a deadlock, which Postgres broke by failing one of them,
 * a 500. The merge now locks the source and the target first, in id order, so it waits for
 * the cleanup holding nothing, or the cleanup waits for it; and a lock it can't get in time
 * is a 409 RECORD_BUSY.
 *
 * The race is set up from a third connection holding the target FOR UPDATE: the merge
 * waits for it (moving a rule to the target checks the target, FOR KEY SHARE), then the
 * cleanup starts, then the target is let go.
 */
describe('merging a merchant while the unused merchants are removed', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant merge locks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
    accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Merge locks', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  type Merchant = { id: number; uuid: string };
  const query = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows as T[];
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedBy = async (pid: number) =>
    (await query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /**
   * A source with a matching rule and nothing else (so the cleanup takes it for unused),
   * and a target with a transaction (so it doesn't), created in `order`.
   */
  const fixtures = async (label: string, order: 'source first' | 'target first') => {
    const make = (name: string) => query<Merchant>(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [name]).then((r) => r[0]!);
    const [first, second] = [await make(`${label} one`), await make(`${label} two`)];
    const [source, target] = order === 'source first' ? [first, second] : [second, first];
    await query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', $2)`, [source.id, label.toUpperCase()]);
    await query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id) VALUES ($1, -5, '2026-05-01', 'expense', 'Keeps the target used', $2)`,
      [accountId, target.id]
    );
    return { source, target };
  };

  const race = async ({ source, target }: { source: Merchant; target: Merchant }) => {
    const gate: PoolClient = await tenant.pool.connect();
    let merging: Promise<request.Response> | undefined;
    let removing: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM merchants WHERE id = $1 FOR UPDATE', [target.id]);
      merging = request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: target.uuid }).then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      const mergerPid = (await blockedBy(gatePid))[0]!;
      let removed = false;
      removing = request(app)
        .post('/api/merchants/admin/remove-unused')
        .then((res) => {
          removed = true;
          return res;
        });
      // The cleanup either goes through (the merge holds none of its rows) or waits for
      // the merge.
      await waitUntil(async () => removed || (await blockedBy(mergerPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [merged, cleaned] = await Promise.all([merging!, removing!]);
    return { merged, cleaned };
  };

  const merchantsLeft = async (ids: number[]) => (await query<{ id: number }>('SELECT id FROM merchants WHERE id = ANY($1::int[]) ORDER BY id', [ids])).map((r) => r.id);

  for (const order of ['source first', 'target first'] as const) {
    it(`neither answers a server error, ${order}`, async () => {
      const merchants = await fixtures(`Merge race ${order}`, order);
      const { merged, cleaned } = await race(merchants);
      expect([merged.status, cleaned.status], JSON.stringify({ merged: merged.body, cleaned: cleaned.body })).not.toContain(500);
      expect(cleaned.status).toBe(200);
      // The source went one way or the other, and the target, which has a transaction, stays.
      expect(await merchantsLeft([merchants.source.id, merchants.target.id])).toEqual([merchants.target.id]);
      if (merged.status === 200) {
        // The merge went first: the rule moved to the target, and the cleanup found nothing.
        expect(await query('SELECT 1 FROM merchant_matching_rules WHERE merchant_id = $1', [merchants.target.id])).toHaveLength(1);
        expect(cleaned.body.removedCount).toBe(0);
      } else {
        // The cleanup went first: the source and its rule are gone, so there was nothing to merge.
        expect({ status: merged.status, error: merged.body.error }).toEqual({ status: 404, error: 'Merchant not found' });
        expect(cleaned.body.removedMerchants.map((m: { uuid: string }) => m.uuid)).toContain(merchants.source.uuid);
      }
    });
  }

  // A delete with a replacement moved the merchant's transactions first and locked the
  // merchant only as it deleted it; a merge of that merchant, which locks it first, then
  // waited for its transactions: a deadlock. The delete locks its merchants first too.
  // The race: a third connection holds the replacement, so the delete waits there (moving a
  // transaction to it checks it), and the merge then starts.
  it('a merge and a delete with a replacement of the same merchant go one after the other, without a deadlock', async () => {
    const make = (name: string) => query<Merchant>(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [name]).then((r) => r[0]!);
    const source = await make('Delete race source');
    const replacement = await make('Delete race replacement');
    const target = await make('Delete race target');
    await query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id) VALUES ($1, -7, '2026-05-02', 'expense', 'Delete race', $2)`,
      [accountId, source.id]
    );

    const gate: PoolClient = await tenant.pool.connect();
    let deleting: Promise<request.Response> | undefined;
    let merging: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      const gatePid = await pidOf(gate);
      await gate.query('SELECT 1 FROM merchants WHERE id = $1 FOR UPDATE', [replacement.id]);
      deleting = request(app).delete(`/api/merchants/${source.uuid}`).send({ replacementMerchantId: replacement.uuid }).then((res) => res);
      await waitUntil(async () => (await blockedBy(gatePid)).length > 0);
      let merged = false;
      merging = request(app)
        .post(`/api/merchants/${source.uuid}/merge`)
        .send({ targetMerchantUuid: target.uuid })
        .then((res) => {
          merged = true;
          return res;
        });
      const deleterPid = (await blockedBy(gatePid))[0]!;
      await waitUntil(async () => merged || (await blockedBy(deleterPid)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [deleted, merged] = await Promise.all([deleting!, merging!]);
    // The delete went first and the merge found the source gone; without the delete's lock
    // the two deadlocked, and Postgres failed one (the merge, 409 TRANSACTION_BUSY, or the
    // delete, a 500).
    expect({ deleted: deleted.status, merged: merged.status }, JSON.stringify({ deleted: deleted.body, merged: merged.body })).toEqual({ deleted: 204, merged: 404 });
    expect(await merchantsLeft([source.id])).toEqual([]);
  });

  it('a merge whose source the cleanup holds answers 409 RECORD_BUSY, merging nothing', async () => {
    const { source, target } = await fixtures('Merge busy', 'source first');
    const holder: PoolClient = await tenant.pool.connect();
    let res: request.Response;
    try {
      await holder.query('BEGIN');
      // What the cleanup holds while it deletes the unused merchants.
      await holder.query('SELECT 1 FROM merchants WHERE id = $1 FOR UPDATE', [source.id]);
      res = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: target.uuid });
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
    expect({ status: res.status, code: res.body.code }).toEqual({ status: 409, code: 'RECORD_BUSY' });
    expect(JSON.stringify(res.body)).not.toMatch(/lock|timeout|55P03/i);
    expect(await merchantsLeft([source.id, target.id])).toEqual([source.id, target.id]);
    expect(await query('SELECT 1 FROM merchant_matching_rules WHERE merchant_id = $1', [source.id])).toHaveLength(1);

    const retried = await request(app).post(`/api/merchants/${source.uuid}/merge`).send({ targetMerchantUuid: target.uuid });
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
  });
});
