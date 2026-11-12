import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A retried buy, sale or dividend: the same external_reference for the same account and
 * security. The insert failed on the unique index (uq_holding_events_external_ref), a
 * 500. It is a 409 that names the event recorded, the dry run's too, and writes nothing.
 */
describe('Investment events retried with their external_reference', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  let account: string;
  let otherAccount: string;
  const stamp = Date.now() % 1_000_000;
  let n = 0;
  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);
  const security = async () => (await post('/securities', { ticker: `XR${stamp}${(n += 1)}`, name: 'Retried', security_type: 'stock' }).expect(201)).body.uuid as string;
  const eventCount = async () => (await pool.query<{ n: number }>('SELECT (SELECT count(*) FROM holding_events) + (SELECT count(*) FROM tax_lots) + (SELECT count(*) FROM lot_consumptions) + (SELECT count(*) FROM dividend_records) AS n')).rows[0].n;
  /** The first call is recorded; the same call again, and its dry run, are a 409 naming it. */
  const retried = async (path: string, body: object) => {
    const first = await post(path, body);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const before = await eventCount();
    for (const dryRun of [true, false]) {
      const again = await post(path, { ...body, dry_run: dryRun });
      expect(again.status, `dry_run ${dryRun}: ${JSON.stringify(again.body)}`).toBe(409);
      expect(again.body).toMatchObject({
        code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED',
        error: 'An event with this external_reference is already recorded for this account and security.',
        event_uuid: first.body.event_uuid,
      });
    }
    expect(await eventCount()).toBe(before);
    return first.body;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Retried investment events');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const insertAccount = async (name: string) =>
      (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [name])).rows[0].uuid as string;
    account = await insertAccount(`Brokerage ${stamp}`);
    otherAccount = await insertAccount(`IRA ${stamp}`);
  });
  afterAll(async () => { await tenant.cleanup(); });

  it('a buy', async () => {
    const sec = await security();
    const buy = { account_uuid: account, security_uuid: sec, event_date: '2025-01-02', shares: '10', price_per_share: '10', external_reference: 'buy-1' };
    await retried('/events/buy', buy);
    // The same reference in another account, or for another security, is another event.
    await post('/events/buy', { ...buy, account_uuid: otherAccount }).expect(201);
    await post('/events/buy', { ...buy, security_uuid: await security() }).expect(201);
  });

  it('a sale, before its shares are found sold', async () => {
    const sec = await security();
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2025-01-02', shares: '10', price_per_share: '10' }).expect(201);
    // All 10 shares: the retry would otherwise be "Insufficient shares", the wrong reason.
    await retried('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-02-03', shares: '10', price_per_share: '12', external_reference: 'sell-1' });
  });

  it('a dividend, reinvested or not', async () => {
    const sec = await security();
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2025-01-02', shares: '10', price_per_share: '10' }).expect(201);
    await retried('/events/dividend', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', total_amount: '5', external_reference: 'div-1' });
    await retried('/events/dividend', { account_uuid: account, security_uuid: sec, event_date: '2025-06-02', total_amount: '5', reinvest: true, price_per_share: '10', external_reference: 'drip-1' });
  });

  it('a reference another kind of event has: a buy after a sale, a fee or an import after a dividend', async () => {
    const sec = await security();
    await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2025-01-02', shares: '10', price_per_share: '10' }).expect(201);
    const sale = await post('/events/sell', { account_uuid: account, security_uuid: sec, event_date: '2025-02-03', shares: '1', price_per_share: '12', external_reference: 'shared-1' }).expect(201);
    const buy = await post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: '2025-02-04', shares: '1', price_per_share: '12', external_reference: 'shared-1' });
    expect(buy.status, JSON.stringify(buy.body)).toBe(409);
    expect(buy.body).toMatchObject({ code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED', event_uuid: sale.body.event_uuid, event_type: 'sell' });

    const dividend = await post('/events/dividend', { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', total_amount: '5', external_reference: 'shared-2' }).expect(201);
    const fee = await post('/events/fee', { account_uuid: account, security_uuid: sec, fee_type: 'commission', amount: '1', event_date: '2025-03-04', external_reference: 'shared-2' });
    expect(fee.status, JSON.stringify(fee.body)).toBe(409);
    // Named, as for the other kinds (it came from the unique index, which names nothing).
    expect(fee.body).toMatchObject({ code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED', event_uuid: dividend.body.event_uuid, event_type: 'dividend' });
    for (const dryRun of [true, false]) {
      const imported = await post('/lots/batch-import', { lots: [{ account_uuid: account, security_uuid: sec, acquisition_date: '2025-03-05', shares: '1', total_cost_basis: '10', external_reference: 'shared-2' }], dry_run: dryRun });
      expect(imported.status, `dry_run ${dryRun}: ${JSON.stringify(imported.body)}`).toBe(409);
      expect(imported.body).toMatchObject({ code: 'EXTERNAL_REFERENCE_ALREADY_RECORDED', event_uuid: dividend.body.event_uuid, event_type: 'dividend' });
    }
    // An imported lot's own reference is still a skipped re-import, not a conflict.
    const lot = { account_uuid: account, security_uuid: sec, acquisition_date: '2025-03-05', shares: '1', total_cost_basis: '10', external_reference: 'import-1' };
    const firstImport = await post('/lots/batch-import', { lots: [lot] }).expect(201);
    const again = await post('/lots/batch-import', { lots: [lot] }).expect(201);
    expect(again.body.results).toEqual([{ index: 0, status: 'skipped', reason: 'duplicate external_reference', lot_uuid: firstImport.body.results[0].lot_uuid }]);
  });

  it('two retries at once: one is recorded, the other is the 409', async () => {
    // Both wait on the security's row, held FOR UPDATE: at the lock a buy takes before it checks
    // the reference. Let go, the first records it and the second is told it's taken; when both
    // passed the check before either wrote, the second insert met the unique index, a 500. Only
    // these two requests touch that row, so only they wait on it.
    const sec = await security();
    const buy = { account_uuid: account, security_uuid: sec, event_date: '2025-01-02', shares: '1', price_per_share: '10', external_reference: 'race-1' };
    const blocker = await pool.connect();
    let results: request.Response[];
    let bothWaited = false;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM securities WHERE uuid = $1 FOR UPDATE', [sec]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const both = Promise.all([post('/events/buy', buy), post('/events/buy', buy)]);
      for (let i = 0; i < 400; i++) {
        // Waiting on the row: the first on the blocker, the second on the first.
        const waiting = await pool.query<{ n: number }>(
          `WITH first AS (SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)))
           SELECT (SELECT count(*) FROM first)::int
                + (SELECT count(*) FROM pg_stat_activity s WHERE s.pid NOT IN (SELECT pid FROM first) AND pg_blocking_pids(s.pid) && ARRAY(SELECT pid FROM first))::int AS n`,
          [blockerPid]
        );
        if (waiting.rows[0].n >= 2) { bothWaited = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await blocker.query('COMMIT');
      results = await both;
    } finally {
      blocker.release();
    }
    expect(bothWaited, 'both buys reached their insert before the row was let go').toBe(true);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('EXTERNAL_REFERENCE_ALREADY_RECORDED');
    const recorded = await pool.query("SELECT count(*)::int AS n FROM holding_events WHERE external_reference = 'race-1'");
    expect(recorded.rows[0].n).toBe(1);
  });

  // A fee retried is skipped, not refused (its idempotent re-import), but two retries at once
  // gave the second a 409; and a fee without a security, whose NULL the unique index counts
  // as distinct, was recorded twice.
  it.each([
    ['with a security', true],
    ['without one', false],
  ])('two fee retries at once, %s: one is recorded, the other skipped', async (_name, withSecurity) => {
    const sec = withSecurity ? await security() : undefined;
    const reference = `fee-race-${withSecurity ? 'sec' : 'none'}`;
    const fee = { account_uuid: account, ...(sec ? { security_uuid: sec } : {}), fee_type: 'commission', amount: '1.25', event_date: '2025-03-04', external_reference: reference };
    // The account's row, held FOR UPDATE, stops the first insert at its foreign key check,
    // after its duplicate check: the second has to have reached its own by then.
    const blocker = await pool.connect();
    let results: request.Response[];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM accounts WHERE uuid = $1 FOR UPDATE', [account]);
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const both = Promise.all([post('/events/fee', fee), post('/events/fee', fee)]);
      let first = false;
      for (let i = 0; i < 400 && !first; i++) {
        first = (await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [blockerPid])).rows[0].n >= 1;
        if (!first) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(first, 'a fee reached its insert').toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await blocker.query('COMMIT');
      results = await both;
    } finally {
      blocker.release();
    }
    expect(results.map((r) => `${r.status} ${r.body.status ?? r.body.code}`).sort()).toEqual(['201 created', '201 skipped']);
    expect(results[0].body.event_uuid).toBe(results[1].body.event_uuid);
    const recorded = await pool.query('SELECT count(*)::int AS n FROM holding_events WHERE external_reference = $1', [reference]);
    expect(recorded.rows[0].n).toBe(1);
  });
});
