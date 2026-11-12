import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { answerProblem, zeroBalanceAuditResponseSchema } from '@nuggets/shared';

// GET /api/accounts/zero-balance/:periodUuid — the Close-Out adjustment audit,
// computed server-side (requires Postgres test DB). This replaced a client-side
// approach that fetched every transaction per account and summed in the browser.
// Covers: per-account period sum (pre-signed amounts), out-of-period activity
// excluded, require_zero_balance filter, adjustment direction, and 404.
describe('Zero-balance close-out API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let periodId: number;
  let periodUuid: string;
  let acctBalancedId: number;
  let acctUnbalancedId: number;
  let acctIgnoredId: number;
  let secondPeriodUuid: string;
  const stamp = Date.now();

  beforeAll(async () => {
    tenant = await createTestTenant('Zero-balance close-out API');
    pool = tenant.pool;

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());

    const yr = 4000 + Math.floor(Math.random() * 100000);
    const per = await pool.query(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ($1, 'January', $2, 1, make_date($2, 1, 1), make_date($2, 1, 31))
       RETURNING id, uuid`,
      [`ZeroBal Period ${yr}`, yr],
    );
    periodId = per.rows[0].id;
    periodUuid = per.rows[0].uuid;

    const mkAcct = async (name: string, requireZero: boolean) => {
      const r = await pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, require_zero_balance)
         VALUES ($1, 'checking', 'cash', 'Asset', $2) RETURNING id`,
        [name, requireZero],
      );
      return r.rows[0].id;
    };
    acctBalancedId = await mkAcct(`ZB Balanced ${stamp}`, true);
    acctUnbalancedId = await mkAcct(`ZB Unbalanced ${stamp}`, true);
    acctIgnoredId = await mkAcct(`ZB Ignored ${stamp}`, false);

    const addTxn = async (accountId: number, amount: number, inPeriod: boolean) => {
      await pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_period_id)
         VALUES ($1, $2, make_date(${yr}, 1, 15), 'expense', 'seed', $3)`,
        [accountId, amount, inPeriod ? periodId : null],
      );
    };
    // Balanced account: +100 / -100 in the period → nets to 0 (amounts pre-signed).
    await addTxn(acctBalancedId, 100, true);
    await addTxn(acctBalancedId, -100, true);
    // Unbalanced account: -40 in the period → needs a credit of 40 …
    await addTxn(acctUnbalancedId, -40, true);
    // … and out-of-period activity that must NOT count toward period_balance.
    await addTxn(acctUnbalancedId, 999, false);
    // Ignored account (require_zero_balance = false) must be excluded entirely.
    await addTxn(acctIgnoredId, -5, true);

    // A cent either way: a 0.01 test made these neither balanced nor
    // pointed anywhere. And one with nothing in the period at all.
    const second = await pool.query(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ($1, 'February', $2, 2, make_date($2, 2, 1), make_date($2, 2, 28))
       RETURNING id, uuid`,
      [`ZeroBal Period ${yr}-02`, yr],
    );
    secondPeriodUuid = second.rows[0].uuid;
    const addIn = async (accountId: number, amount: string, period: number, day: string) => {
      await pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_period_id)
         VALUES ($1, $2, $3::date, 'expense', 'seed', $4)`,
        [accountId, amount, day, period],
      );
    };
    const january = `${yr}-01-15`;
    const february = `${yr}-02-15`;
    await addIn(await mkAcct(`ZB Cent Short ${stamp}`, true), '-0.01', periodId, january);
    await addIn(await mkAcct(`ZB Cent Over ${stamp}`, true), '0.01', periodId, january);
    await mkAcct(`ZB Empty ${stamp}`, true);
    // February: two adjustments whose float sum isn't 0.30 (0.1 + 0.2 is 0.30000000000000004).
    // Named to come first, so they are added first.
    await addIn(await mkAcct(`ZB A1 Tenth ${stamp}`, true), '-0.10', second.rows[0].id, february);
    await addIn(await mkAcct(`ZB A2 Fifth ${stamp}`, true), '0.20', second.rows[0].id, february);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('sums each require_zero_balance account for the period and summarizes', async () => {
    const res = await request(app).get(`/api/accounts/zero-balance/${periodUuid}`).expect(200);
    const byName = (n: string) => res.body.accounts.find((a: { name: string }) => a.name.startsWith(n));

    // Account that does not require a zero balance is excluded entirely.
    expect(res.body.accounts.some((a: { name: string }) => a.name.startsWith(`ZB Ignored ${stamp}`))).toBe(false);

    const balanced = byName(`ZB Balanced ${stamp}`);
    expect(balanced.period_balance).toBeCloseTo(0, 2);
    expect(balanced.is_balanced).toBe(true);
    expect(balanced.adjustment_direction).toBe('balanced');

    const unbalanced = byName(`ZB Unbalanced ${stamp}`);
    // 999 is out-of-period and must be excluded — only the -40 counts.
    expect(unbalanced.period_balance).toBeCloseTo(-40, 2);
    expect(unbalanced.is_balanced).toBe(false);
    expect(unbalanced.adjustment_direction).toBe('credit');
    expect(unbalanced.adjustment_needed).toBeCloseTo(40, 2);

    // Summary counts at least our two seeded accounts (the DB may hold others).
    expect(res.body.summary.total_accounts).toBe(res.body.accounts.length);
    expect(res.body.summary.total_accounts).toBeGreaterThanOrEqual(2);
    expect(res.body.summary.balanced_count + res.body.summary.needs_adjustment_count).toBe(res.body.summary.total_accounts);
    // The whole answer is what the shared schema names.
    expect(answerProblem(zeroBalanceAuditResponseSchema, res.body)).toBeNull();
  });

  it('takes a cent either way as a cent to move, in its direction, and only 0 as balanced', async () => {
    const res = await request(app).get(`/api/accounts/zero-balance/${periodUuid}`).expect(200);
    const byName = (n: string) => res.body.accounts.find((a: { name: string }) => a.name === `${n} ${stamp}`);

    expect(byName('ZB Cent Short')).toMatchObject({
      period_balance: -0.01, is_balanced: false, adjustment_direction: 'credit', adjustment_needed: 0.01,
    });
    expect(byName('ZB Cent Over')).toMatchObject({
      period_balance: 0.01, is_balanced: false, adjustment_direction: 'debit', adjustment_needed: 0.01,
    });
    expect(byName('ZB Empty')).toMatchObject({
      period_balance: 0, is_balanced: true, adjustment_direction: 'balanced', adjustment_needed: 0,
    });
    expect(byName('ZB Balanced')).toMatchObject({ period_balance: 0, is_balanced: true, adjustment_direction: 'balanced' });
    // Every card agrees with itself: balanced exactly when it has no direction and needs nothing.
    for (const a of res.body.accounts) {
      expect(a.is_balanced).toBe(a.adjustment_direction === 'balanced');
      expect(a.is_balanced).toBe(a.adjustment_needed === 0);
      expect(a.adjustment_needed).toBe(Math.abs(a.period_balance));
    }
    expect(res.body.summary).toMatchObject({ needs_adjustment_count: 3, total_adjustment_amount: 40.02 });
  });

  it("adds the period's adjustments to the cent", async () => {
    const res = await request(app).get(`/api/accounts/zero-balance/${secondPeriodUuid}`).expect(200);
    const byName = (n: string) => res.body.accounts.find((a: { name: string }) => a.name === `${n} ${stamp}`);

    expect(byName('ZB A1 Tenth')).toMatchObject({ adjustment_direction: 'credit', adjustment_needed: 0.1 });
    expect(byName('ZB A2 Fifth')).toMatchObject({ adjustment_direction: 'debit', adjustment_needed: 0.2 });
    expect(res.body.summary).toMatchObject({ needs_adjustment_count: 2, total_adjustment_amount: 0.3 });
  });

  it('404s for an unknown period uuid', async () => {
    await request(app).get('/api/accounts/zero-balance/00000000-0000-0000-0000-000000000000').expect(404);
  });
});
