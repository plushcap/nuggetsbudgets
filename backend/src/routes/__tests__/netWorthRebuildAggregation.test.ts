import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { sql } from 'kysely';
import { createNetWorthRoutes } from '../net-worth.js';
import NetWorthService from '../../services/NetWorthService.js';
import { getDb } from '../../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';

/**
 * A rebuild whose aggregation fails (a database error in aggregate_net_worth_snapshots).
 * The rebuild caught it and answered "Snapshots created but aggregation partially failed",
 * but the error had aborted the request's transaction: the daily snapshots it had written
 * were lost, and the request failed with a 500 when it tried to commit. The aggregation runs
 * in a savepoint now, so the daily snapshots are kept and the answer says what happened.
 */
describe('a net worth rebuild whose aggregation fails', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Net worth rebuild aggregation');
    app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: true }));
    app.use((req, _res, next) => {
      (req as TenantRequest).isDeploymentAdmin = true;
      next();
    });
    app.use('/api/net-worth', createNetWorthRoutes());
    const account = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Aggregated', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, 50, app_today() - 3, 'income', 'Pay')`,
      [account]
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('keeps the daily snapshots and says the aggregation failed', async () => {
    vi.spyOn(NetWorthService.prototype, 'aggregateSnapshots').mockImplementation(async () => {
      await sql`SELECT 1 / 0`.execute(getDb());
      return 0;
    });

    const res = await request(app).post('/api/net-worth/rebuild').send({});
    expect({ status: res.status, body: res.body }).toMatchObject({
      status: 200,
      body: {
        message: 'Snapshots created but aggregation partially failed',
        snapshots_created: 4,
        total_days: 4,
        warning: 'Aggregation may need to be run manually',
      },
    });
    const daily = await tenant.pool.query(`SELECT 1 FROM net_worth_snapshots WHERE aggregation_level = 'daily'`);
    expect(daily.rowCount).toBe(4);
  });
});
