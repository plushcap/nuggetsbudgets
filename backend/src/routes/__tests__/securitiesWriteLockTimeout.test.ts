import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A short wait, so a held security times the write out quickly.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '300';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A write to several securities locks them first, in id order (lockSecuritiesForWrite). One
 * that can't within the pool's lock_timeout (a delete of one of them, say, holds it) is a 409
 * RECORD_BUSY to try again, with nothing written, not a 500.
 */
describe('a write to several securities that finds one busy', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Securities write lock timeout');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  /** `write` while a third connection holds `securityId` FOR UPDATE (as a delete would). */
  const whileHeld = async (securityId: number, write: () => Promise<request.Response>) => {
    const gate: PoolClient = await tenant.pool.connect();
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT 1 FROM securities WHERE id = $1 FOR UPDATE', [securityId]);
      return await write();
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
  };

  it('a bulk price upsert answers 409 RECORD_BUSY and saves none of its prices', async () => {
    const rows = (await tenant.pool.query<{ id: number; uuid: string }>(
      `INSERT INTO securities (ticker, name) VALUES ('BSYA', 'Busy A'), ('BSYB', 'Busy B') RETURNING id, uuid`
    )).rows;
    const res = await whileHeld(rows[1]!.id, () =>
      request(app).post('/api/investments/prices/bulk').send({ prices: rows.map((r) => ({ security_uuid: r.uuid, price_date: '2026-03-02', close: '5' })) })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body).toMatchObject({ code: 'RECORD_BUSY', error: 'Another change to these securities was being saved at the same time, so nothing was saved. Try again.' });
    expect((await tenant.pool.query('SELECT 1 FROM security_prices WHERE security_id = ANY($1::int[])', [rows.map((r) => r.id)])).rowCount).toBe(0);
  });

  it('an underlying-holdings snapshot answers 409 RECORD_BUSY and writes nothing', async () => {
    const rows = (await tenant.pool.query<{ id: number; uuid: string; ticker: string }>(
      `INSERT INTO securities (ticker, name, security_type) VALUES ('BSYF', 'Busy fund', 'etf'), ('BSYU', 'Busy underlying', 'stock') RETURNING id, uuid, ticker`
    )).rows;
    const [fund, underlying] = rows as [typeof rows[0], typeof rows[0]];
    const res = await whileHeld(underlying.id, () =>
      request(app).post('/api/investments/underlying-holdings').send({
        security_uuid: fund.uuid, snapshot_date: '2026-03-02', holdings: [{ underlying_ticker: underlying.ticker, weight_percentage: '50' }],
      })
    );
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('RECORD_BUSY');
    expect((await tenant.pool.query('SELECT 1 FROM fund_underlying_holdings WHERE security_id = $1', [fund.id])).rowCount).toBe(0);
  });
});
