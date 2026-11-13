import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createBudgetRoutes } from '../budgets.js';
import { rejectMalformedIds } from '../../middleware/routeParams.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// Close-Out and the Budget page reconcile a period's envelopes (their remaining, which counts what
// is filed under each period) against the envelope account's money through that period. Counted
// by date instead, a past month disagreed by whatever was filed across its end: a close-out
// transfer filed under October and dated November 2 counted in November.
describe('GET /api/budgets/periods/:uuid/envelope-balance', () => {
  let app: Express;
  let tenant: TestTenant;
  let october: string;
  let november: string;
  let envelope: string;

  const one = async <T,>(text: string, values: unknown[] = []) => (await tenant.pool.query<T & object>(text, values)).rows[0] as T;
  const period = async (month: number, start: string, end: string) =>
    (await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date, status)
       VALUES ($1, $1, 2026, $2, $3, $4, 'active') RETURNING id, uuid`,
      [`2026-${month}`, month, start, end],
    ));
  const account = async (name: string, values: { envelope?: boolean } = {}) =>
    one<{ id: number; uuid: string }>(
      `INSERT INTO accounts (name, account_type, account_group, type, is_envelope_account)
       VALUES ($1, 'savings', 'cash', 'Asset', $2) RETURNING id, uuid`,
      [name, values.envelope ?? false],
    );
  const tx = (accountId: number, amount: number, date: string, periodId: number | null, type = amount > 0 ? 'income' : 'expense') =>
    tenant.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, budget_period_id, description)
       VALUES ($1, $2, $3, $4, $5, 'seed')`,
      [accountId, amount, date, type, periodId],
    );
  const balances = async (periodUuid: string) => {
    const res = await request(app).get(`/api/budgets/periods/${periodUuid}/envelope-balance`).expect(200);
    return res.body.data.accounts as Array<{ uuid: string; balance: number }>;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Envelope balance through a period');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', rejectMalformedIds(createBudgetRoutes()));

    const oct = await period(10, '2026-10-01', '2026-10-31');
    const nov = await period(11, '2026-11-01', '2026-11-30');
    october = oct.uuid;
    november = nov.uuid;
    const acct = await account('Envelopes', { envelope: true });
    envelope = acct.uuid;
    // The opening balance, dated in November and filed under no period: by its date, as an
    // envelope's starting balance is filed under the period of the day it was set.
    await tx(acct.id, 1000, '2026-11-13', null, 'starting balance');
    await tx(acct.id, 500, '2026-10-02', oct.id);
    // October's close-out withdrawal, made on November 2 and filed under October.
    await tx(acct.id, -200, '2026-11-02', oct.id);
    // Filed under no period: by its date.
    await tx(acct.id, 50, '2026-10-20', null);
    await tx(acct.id, 70, '2026-11-05', null);
    // Dated in October, filed under November.
    await tx(acct.id, 30, '2026-10-25', nov.id);
    // A split counts once, by its parent: its parts and the parent in one statement.
    await tenant.pool.query(
      `WITH parent AS (
         INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent, budget_period_id, description)
         VALUES ($1, -40, '2026-10-10', 'expense', true, $2, 'Split') RETURNING id
       )
       INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id, budget_period_id, description)
       SELECT $1, v.amount, '2026-10-10', 'expense', parent.id, $2, 'Part'
         FROM parent, (VALUES (-25::numeric), (-15::numeric)) AS v(amount)`,
      [acct.id, oct.id],
    );
    // Another account's money isn't in it.
    const other = await account('Checking');
    await tx(other.id, 999, '2026-10-05', oct.id);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('counts what is filed under the period and those before it, and what is filed under none by its date', async () => {
    // 500 - 200 (filed under October, dated November) + 50 (no period, October) - 40 (the split, once).
    expect(await balances(october)).toEqual([{ uuid: envelope, balance: 310 }]);
    // November adds the opening balance (1000, no period, November), 70 (no period, November) and
    // 30 (filed under November, dated October).
    expect(await balances(november)).toEqual([{ uuid: envelope, balance: 1410 }]);
  });

  it('leaves out a hidden envelope account, as the Accounts list does', async () => {
    await tenant.pool.query('UPDATE accounts SET hide_account = true WHERE uuid = $1', [envelope]);
    try {
      expect(await balances(october)).toEqual([]);
    } finally {
      await tenant.pool.query('UPDATE accounts SET hide_account = false WHERE uuid = $1', [envelope]);
    }
  });

  it('answers 404 for a period that does not exist', async () => {
    await request(app).get('/api/budgets/periods/0190a000-0000-7000-8000-000000000000/envelope-balance').expect(404);
  });
});
