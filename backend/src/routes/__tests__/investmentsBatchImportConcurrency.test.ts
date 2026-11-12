import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Two batch imports at once, of lots in the same two securities in opposite orders.
 * Each lot's wash-sale detection took its security's lock as the row came: one import held
 * A's and waited for B's, the other held B's and waited for A's, and Postgres ended one with
 * a deadlock (40P01, a 500, everything it wrote rolled back). An import now takes the locks
 * of every security it writes, in id order, before its first insert, so the second waits for
 * the first and both succeed.
 */
describe('Two batch imports at once', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  let account: string;
  const stamp = Date.now() % 1_000_000;
  let n = 0;
  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
  const security = async () => (await post('/securities', { ticker: `BC${stamp}${(n += 1)}`, name: 'Concurrent import', security_type: 'stock' }).expect(201)).body.uuid as string;
  /** A sale at a loss on 2024-05-01, which a lot acquired within 30 days replaces; its consumption's id. */
  const lossSale = async (sec: string) => {
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2024-01-02', shares: '1', price_per_share: '10' }).expect(201);
    const sold = await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2024-05-01', shares: '1', price_per_share: '5' }).expect(201);
    return (await pool.query<{ id: number }>('SELECT lc.id FROM lot_consumptions lc JOIN holding_events he ON he.id = lc.sell_event_id WHERE he.uuid = $1', [sold.body.event_uuid])).rows[0].id;
  };
  const lotsIn = (...securities: string[]) => ({
    lots: securities.map((sec) => ({ account_uuid: account, security_uuid: sec, acquisition_date: '2024-05-10', shares: '1', total_cost_basis: '6' })),
  });

  beforeAll(async () => {
    tenant = await createTestTenant('Concurrent batch imports');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    account = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`Brokerage ${stamp}`])).rows[0].uuid;
  });
  afterAll(async () => { await tenant.cleanup(); });

  it('imports [A, B] and [B, A] at once without a deadlock', async () => {
    const a = await security();
    const b = await security();
    const losses = [await lossSale(a), await lossSale(b)];
    // Each import's first lot replaces its security's loss, which writes that loss's row: held
    // here, each import stops there, holding its first security's lock, until both have.
    const blocker = await pool.connect();
    let results: request.Response[];
    let bothWaited = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM lot_consumptions WHERE id = ANY($1) FOR UPDATE', [losses]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const both = Promise.all([post('/lots/batch-import', lotsIn(a, b)), post('/lots/batch-import', lotsIn(b, a))]);
      // Both waiting: on the blocker, or on a session that waits on it.
      for (let i = 0; i < 400; i++) {
        const waiting = await pool.query<{ n: number }>(
          `WITH first AS (SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))
           SELECT (SELECT count(*) FROM first)::int
                + (SELECT count(*) FROM pg_stat_activity s WHERE s.pid NOT IN (SELECT pid FROM first) AND pg_blocking_pids(s.pid) && ARRAY(SELECT pid FROM first))::int AS n`,
          [blockerPid]
        );
        if (waiting.rows[0].n >= 2) { bothWaited = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await blocker.query('ROLLBACK');
      results = await both;
    } finally {
      blocker.release();
    }
    expect(bothWaited, 'both imports reached the held row (or its lock) before it was let go').toBe(true);
    expect(results.map((r) => `${r.status} ${r.body.code ?? ''}`.trim())).toEqual(['201', '201']);
    // Four lots; each loss replaced once, by whichever import came first.
    const counts = (await pool.query<{ lots: number; washes: number }>(
      `SELECT (SELECT count(*) FROM tax_lots tl JOIN securities s ON s.id = tl.security_id WHERE s.uuid = ANY($1) AND tl.acquisition_date = '2024-05-10')::int AS lots,
              (SELECT count(*) FROM wash_sale_records WHERE loss_lot_consumption_id = ANY($2))::int AS washes`,
      [[a, b], losses]
    )).rows[0];
    expect(counts).toEqual({ lots: 4, washes: 2 });
  });

  // A buy or a reinvested dividend wrote its event, with its reference, and then waited for
  // the security's lock to look for wash sales; an import holding that lock then inserted the
  // same reference and waited on the buy's row: a deadlock, and the buy answered 500. They now
  // take the lock before they write, as a sale does, so one records the reference and the
  // other is told it's taken (409) or skips it.
  it.each([
    ['a buy', (account: string, security: string) => ['/events/buy', { account_uuid: account, security_uuid: security, event_date: '2024-05-11', shares: '1', price_per_share: '10', external_reference: 'RACE-REF' }] as const],
    ['a reinvested dividend', (account: string, security: string) => ['/events/dividend', { account_uuid: account, security_uuid: security, event_date: '2024-05-11', total_amount: '5', reinvest: true, price_per_share: '10', external_reference: 'RACE-REF' }] as const],
  ])('%s and an import of the same reference at once: no deadlock', async (_name, write) => {
    const a = await security();
    const b = await security();
    const loss = await lossSale(b);
    // The import's first lot (in B) replaces B's loss, whose row is held here: the import stops
    // there holding A's and B's locks, before its second lot, in A with the reference.
    const blocker = await pool.connect();
    let results: request.Response[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM lot_consumptions WHERE id = $1 FOR UPDATE', [loss]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const waitingOnBlocker = async (n: number) => {
        for (let i = 0; i < 400; i++) {
          const waiting = await pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
                OR pg_blocking_pids(pid) && ARRAY(SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))`,
            [blockerPid]
          );
          if (waiting.rows[0].n >= n) return true;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return false;
      };
      const imported = post('/lots/batch-import', {
        lots: [
          { account_uuid: account, security_uuid: b, acquisition_date: '2024-05-10', shares: '1', total_cost_basis: '6' },
          { account_uuid: account, security_uuid: a, acquisition_date: '2024-05-10', shares: '1', total_cost_basis: '6', external_reference: 'RACE-REF' },
        ],
      }).then((r) => r);
      expect(await waitingOnBlocker(1), 'the import reached the held row').toBe(true);
      const [path, body] = write(account, a);
      const written = post(path, body).then((r) => r);
      expect(await waitingOnBlocker(2), 'the write waits behind the import').toBe(true);
      await blocker.query('ROLLBACK');
      results = await Promise.all([imported, written]);
    } finally {
      blocker.release();
    }
    const [importAnswer, writeAnswer] = results;
    expect(importAnswer.status).toBe(201);
    expect(`${writeAnswer.status} ${writeAnswer.body.code ?? ''}`.trim()).toBe('409 EXTERNAL_REFERENCE_ALREADY_RECORDED');
    const recorded = (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM holding_events he JOIN securities s ON s.id = he.security_id WHERE s.uuid = $1 AND he.external_reference = 'RACE-REF'`,
      [a]
    )).rows[0].n;
    expect(recorded).toBe(1);
  });
});
