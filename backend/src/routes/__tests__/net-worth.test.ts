import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';

// The router's GET routes run authenticateToken themselves, which looks for a session
// cookie; the test context below has signed the request in already. (Who may call each
// route is route-authorization.test.ts's job.)
vi.mock('../../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth.js')>()),
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createNetWorthRoutes } from '../net-worth.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { addDays, addMonths, daysBetween, firstOfMonth } from '../../utils/calendarDate.js';
import { inTransaction } from '../../test/inTransaction.js';
import { answerProblem, netWorthHistoryAnswerSchema } from '@nuggets/shared';

// Integration tests for the net-worth /rebuild and /history endpoints. These require a
// Postgres test database. The net-worth router uses the shared singleton pool
// from src/db.js, which reads DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD — CI's
// test-backend job sets those (and loads schema + migrations). They will not run
// in an environment without a database.
describe('Net worth API', () => {
  // The rebuild covers the whole tenant, so the tenant holds only this file's fixtures.
  let tenant: TestTenant;
  let pool: Pool;
  let adminApp: Express;
  let userApp: Express;

  // Build an app that mounts the real router behind a mock auth middleware.
  const buildApp = (isAdmin: boolean): Express => {
    const app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: isAdmin }));
    // What resolveTenant sets: the rebuild takes a deployment admin (requireDeploymentAdmin).
    app.use((req, _res, next) => {
      (req as TenantRequest).isDeploymentAdmin = isAdmin;
      next();
    });
    app.use('/api/net-worth', createNetWorthRoutes());
    return app;
  };

  // Accounts created by a test, cleaned up afterwards (their transactions and all
  // net_worth_snapshots go with them).
  let createdAccountIds: number[] = [];

  // Today as the database has it (app_today(): its clock, in the application_timezone
  // setting), which is the day the rebuild and /history count to. Read before each test, not
  // once from the test's own clock and the default zone when the file loads:
  // a run across midnight, or a setting other than the default, then still agrees with it.
  let d0 = '';
  let dm1 = '';
  // The Monday of d0's week (2024-01-01 is a Monday, where DATE_TRUNC starts a week).
  let weekStart = '';

  const insertAccount = async (type: 'Asset' | 'Liability') => {
    const res = await pool.query(
      `INSERT INTO accounts (name, account_group, account_type, type)
       VALUES ($1, 'other', 'checking', $2) RETURNING id`,
      [`NW Test ${type} ${Date.now()}-${Math.random()}`, type]
    );
    createdAccountIds.push(res.rows[0].id);
    return res.rows[0].id as number;
  };

  const insertTxn = async (
    accountId: number,
    amount: number,
    dateStr: string,
    opts: { status?: string; isSplitParent?: boolean; parentId?: number } = {},
    db: Pick<Pool, 'query'> = pool
  ) => {
    const res = await db.query(
      `INSERT INTO transactions
         (account_id, amount, type, status, transaction_date, is_split_parent, parent_transaction_id, description)
       VALUES ($1, $2, 'expense', $3, $4::date, $5, $6, 'nw-test') RETURNING id`,
      [accountId, amount, opts.status || 'cleared', dateStr, opts.isSplitParent || false, opts.parentId ?? null]
    );
    return res.rows[0].id as number;
  };

  const insertDailySnapshot = (day: string, netWorth: number) =>
    pool.query(
      `INSERT INTO net_worth_snapshots (snapshot_date, total_assets, total_liabilities, net_worth, aggregation_level)
       VALUES ($1::date, $2, 0, $2, 'daily')`,
      [day, netWorth]
    );

  const history = async (query: string) => {
    const res = await request(userApp).get(`/api/net-worth/history?${query}`).expect(200);
    return (res.body.history as Array<{ snapshot_date: string; net_worth: number; is_interpolated: boolean }>)
      .map(({ snapshot_date, net_worth, is_interpolated }) => ({ snapshot_date, net_worth, is_interpolated }));
  };

  // Fetch daily snapshots keyed by date for assertions.
  // NUMERIC columns arrive from pg as strings.
  const dailySnapshots = async () => {
    const res = await pool.query<{
      d: string;
      total_assets: string;
      total_liabilities: string;
      net_worth: string;
      account_count: number | null;
    }>(
      `SELECT snapshot_date::text AS d, total_assets, total_liabilities, net_worth, account_count
       FROM net_worth_snapshots WHERE aggregation_level = 'daily' ORDER BY snapshot_date`
    );
    return res.rows;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Net worth rebuild API');
    pool = tenant.pool;
    adminApp = buildApp(true);
    userApp = buildApp(false);
  });

  beforeEach(async () => {
    d0 = (await pool.query<{ d: string }>('SELECT app_today()::text AS d')).rows[0].d;
    dm1 = addDays(d0, -1);
    weekStart = addDays(d0, -(daysBetween('2024-01-01', d0) % 7));
  });

  afterEach(async () => {
    await pool.query('DELETE FROM net_worth_snapshots');
    if (createdAccountIds.length > 0) {
      await pool.query('DELETE FROM transactions WHERE account_id = ANY($1)', [createdAccountIds]);
      await pool.query('DELETE FROM accounts WHERE id = ANY($1)', [createdAccountIds]);
    }
    createdAccountIds = [];
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('rejects non-admin callers with 403', async () => {
    await request(userApp).post('/api/net-worth/rebuild').expect(403);
  });

  it('rebuilds daily snapshots with correct running balances (incremental parity)', async () => {
    const asset = await insertAccount('Asset');
    const liab = await insertAccount('Liability');
    // Asset: +1000 yesterday, +500 today  -> 1000 then 1500.
    await insertTxn(asset, 1000, dm1);
    await insertTxn(asset, 500, d0);
    // Liability: -200 today -> abs 200. Not active yesterday (no txn yet).
    await insertTxn(liab, -200, d0);

    await request(adminApp).post('/api/net-worth/rebuild').expect(200);

    const rows = await dailySnapshots();
    const byDate = new Map(rows.map((r) => [r.d, r]));

    // One snapshot per day across [yesterday, today].
    expect(byDate.has(dm1)).toBe(true);
    expect(byDate.has(d0)).toBe(true);

    const y = byDate.get(dm1)!;
    expect(parseFloat(y.total_assets)).toBe(1000);
    expect(parseFloat(y.total_liabilities)).toBe(0);
    expect(parseFloat(y.net_worth)).toBe(1000);
    expect(y.account_count).toBe(1); // liability not active yet

    const t = byDate.get(d0)!;
    expect(parseFloat(t.total_assets)).toBe(1500);
    expect(parseFloat(t.total_liabilities)).toBe(200);
    expect(parseFloat(t.net_worth)).toBe(1300);
    expect(t.account_count).toBe(2);
  });

  it('counts a split transaction once, not parent + children', async () => {
    const asset = await insertAccount('Asset');
    // Split parent keeps its amount; children carry the breakdown. Canonical
    // balance (parent_transaction_id IS NULL) counts the parent (300) only.
    // One transaction: a split's splits must add up to it when it commits.
    await inTransaction(pool, async (client) => {
      const parentId = await insertTxn(asset, 300, d0, { isSplitParent: true }, client);
      await insertTxn(asset, 100, d0, { parentId }, client);
      await insertTxn(asset, 200, d0, { parentId }, client);
    });

    await request(adminApp).post('/api/net-worth/rebuild').expect(200);

    const rows = await dailySnapshots();
    const todayRow = rows.find((r) => r.d === d0)!;
    // 300 (parent counted once), NOT 600 (parent + both children).
    expect(parseFloat(todayRow.total_assets)).toBe(300);

    // Cross-check against the canonical balance function.
    const canonical = await pool.query('SELECT calculate_account_balance($1) AS bal', [asset]);
    expect(parseFloat(canonical.rows[0].bal)).toBe(300);
  });

  // The gap fill was COALESCE(x, LAG(x)), which reaches back one row
  // only, so the second day of a gap read the first's NULL and the API sent null (NaN).
  it('carries the last snapshot across a gap of several days', async () => {
    const day = (n: number) => addDays(d0, n);
    await pool.query(
      `INSERT INTO net_worth_snapshots (snapshot_date, total_assets, total_liabilities, net_worth, account_count, aggregation_level)
       VALUES ($1, 150, 50, 100, 2, 'daily'), ($2, 400, 100, 300, 3, 'daily')`,
      [day(-6), day(-2)]
    );

    const res = await request(userApp).get('/api/net-worth/history').query({ period: 'day', limit: 30 }).expect(200);
    const rows = (res.body.history as Array<Record<string, unknown>>).map((r) => [
      r.snapshot_date, r.total_assets, r.total_liabilities, r.net_worth, r.account_count, r.is_interpolated,
    ]);
    expect(rows).toEqual([
      [d0, 400, 100, 300, 3, true],
      [day(-1), 400, 100, 300, 3, true],
      [day(-2), 400, 100, 300, 3, false],
      [day(-3), 150, 50, 100, 2, true],
      [day(-4), 150, 50, 100, 2, true],
      [day(-5), 150, 50, 100, 2, true],
      [day(-6), 150, 50, 100, 2, false],
    ]);
  });

  it('is idempotent: re-running produces identical snapshots, no duplicate-key error', async () => {
    const asset = await insertAccount('Asset');
    await insertTxn(asset, 1000, d0);

    await request(adminApp).post('/api/net-worth/rebuild').expect(200);
    const first = await dailySnapshots();

    await request(adminApp).post('/api/net-worth/rebuild').expect(200);
    const second = await dailySnapshots();

    expect(second.length).toBe(first.length);
    const todayRow = second.find((r) => r.d === d0)!;
    expect(parseFloat(todayRow.total_assets)).toBe(1000);
    // Exactly one daily row for today (upsert, not duplicate insert).
    expect(second.filter((r) => r.d === d0).length).toBe(1);
  });

  describe('GET /history', () => {
    it('answers weeks from the daily snapshots alone', async () => {
      await insertDailySnapshot(addDays(weekStart, -7), 200);
      await insertDailySnapshot(d0, 300);

      expect(await history('period=week&limit=2&fill_gaps=true')).toEqual([
        { snapshot_date: weekStart, net_worth: 300, is_interpolated: false },
        { snapshot_date: addDays(weekStart, -7), net_worth: 200, is_interpolated: false },
      ]);
    });

    it('answers months from the daily snapshots alone', async () => {
      await insertDailySnapshot(addMonths(firstOfMonth(d0), -1), 100);
      await insertDailySnapshot(d0, 300);

      expect(await history('period=month&limit=12&fill_gaps=true')).toEqual([
        { snapshot_date: firstOfMonth(d0), net_worth: 300, is_interpolated: false },
        { snapshot_date: addMonths(firstOfMonth(d0), -1), net_worth: 100, is_interpolated: false },
      ]);
    });

    it('averages the daily snapshots of a period', async () => {
      await insertDailySnapshot(addDays(weekStart, -7), 100);
      await insertDailySnapshot(addDays(weekStart, -6), 201);

      expect(await history('period=week&limit=1&fill_gaps=false')).toEqual([
        { snapshot_date: addDays(weekStart, -7), net_worth: 150.5, is_interpolated: false },
      ]);
    });

    it('fills an empty period with the last snapshot before it, not that period\'s average', async () => {
      // Monday 100, Sunday 900: that week averages 500, but 900 holds after it.
      await insertDailySnapshot(addDays(weekStart, -21), 100);
      await insertDailySnapshot(addDays(weekStart, -15), 900);

      expect(await history('period=week&limit=4&fill_gaps=true')).toEqual([
        { snapshot_date: weekStart, net_worth: 900, is_interpolated: true },
        { snapshot_date: addDays(weekStart, -7), net_worth: 900, is_interpolated: true },
        { snapshot_date: addDays(weekStart, -14), net_worth: 900, is_interpolated: true },
        { snapshot_date: addDays(weekStart, -21), net_worth: 500, is_interpolated: false },
      ]);
    });

    it('fills a gap with the last net worth before it', async () => {
      await insertDailySnapshot(addDays(d0, -4), 80);
      await insertDailySnapshot(d0, 150);

      expect(await history('period=day&limit=5&fill_gaps=true')).toEqual([
        { snapshot_date: d0, net_worth: 150, is_interpolated: false },
        { snapshot_date: addDays(d0, -1), net_worth: 80, is_interpolated: true },
        { snapshot_date: addDays(d0, -2), net_worth: 80, is_interpolated: true },
        { snapshot_date: addDays(d0, -3), net_worth: 80, is_interpolated: true },
        { snapshot_date: addDays(d0, -4), net_worth: 80, is_interpolated: false },
      ]);
      expect(await history('period=day&limit=5&fill_gaps=false')).toEqual([
        { snapshot_date: d0, net_worth: 150, is_interpolated: false },
        { snapshot_date: addDays(d0, -4), net_worth: 80, is_interpolated: false },
      ]);
    });

    // A snapshot stored without an account count (the column is nullable) came
    // back as NaN, which JSON sends as null, and the answer's schema refused it.
    it('answers a snapshot stored without an account count as null, which its schema takes', async () => {
      await pool.query(
        `INSERT INTO net_worth_snapshots (snapshot_date, total_assets, total_liabilities, net_worth, account_count, aggregation_level)
         VALUES ($1::date, 10, 0, 10, NULL, 'daily')`,
        [addDays(d0, -2)]
      );
      const res = await request(userApp).get('/api/net-worth/history?period=day&limit=3&fill_gaps=true').expect(200);
      expect(answerProblem(netWorthHistoryAnswerSchema, res.body)).toBeNull();
      expect(res.body.history.map((point: { account_count: unknown }) => point.account_count)).toEqual([null, null, null]);
    });

    it('answers no history for a ledger without snapshots', async () => {
      expect(await history('period=week&limit=13&fill_gaps=true')).toEqual([]);
    });
  });
});
