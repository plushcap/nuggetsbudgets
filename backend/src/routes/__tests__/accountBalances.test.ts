import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import AccountBalanceService from '../../services/AccountBalanceService.js';
import { BalanceRebalanceService } from '../../services/BalanceRebalanceService.js';
import NetWorthService from '../../services/NetWorthService.js';
import { inTransaction } from '../../test/inTransaction.js';

// One account-balance definition. Every displayed balance is
// SUM(amount) of the account's non-child transactions, with the opening balance
// stored as a 'starting balance' transaction. These run the real routes under RLS
// and each reproduces a way the old snapshot cache / nuggets_balance model gave a
// wrong number.
describe('Account balances', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  const stamp = Date.now();
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Account balances');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  /** Create an account through POST /api/accounts, as the Add Account page does. */
  const createAccount = async (initialBalance: number, type: 'Asset' | 'Liability' = 'Asset') => {
    const res = await request(app)
      .post('/api/accounts')
      .send({
        name: `Bal ${stamp} ${++n}`,
        account_type: type === 'Asset' ? 'checking' : 'credit_card',
        account_group: type === 'Asset' ? 'cash' : 'credit_cards',
        type,
        initial_balance: initialBalance,
      })
      .expect(201);
    return { id: res.body.id as number, uuid: res.body.uuid as string, name: res.body.name as string };
  };

  const addTxn = async (accountId: number, amount: number, date: string, type = 'expense') => {
    const r = await pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, status)
       VALUES ($1, $2, $3::date, $4, 'seed', 'cleared') RETURNING id`,
      [accountId, amount, date, type],
    );
    return r.rows[0].id as number;
  };

  /** The balance as the Accounts list shows it. */
  const listBalance = async (uuid: string) => {
    const res = await request(app).get('/api/accounts').expect(200);
    const acct = res.body.accounts.find((a: { uuid: string }) => a.uuid === uuid);
    return acct.calculated_balance as number | null;
  };

  /** The balance as Account detail shows it. */
  const detailBalance = async (uuid: string) => {
    const res = await request(app).get(`/api/accounts/${uuid}/balance`).expect(200);
    const b = res.body.balance;
    return (typeof b === 'object' && b !== null ? b.nuggets_balance : b) as number | null;
  };

  it('opening balance then an expense shows the sum (was frozen at the opening balance)', async () => {
    const acct = await createAccount(1000);
    expect(await listBalance(acct.uuid)).toBeCloseTo(1000, 2);
    await addTxn(acct.id, -100, '2026-01-10');
    expect(await listBalance(acct.uuid)).toBeCloseTo(900, 2);
    expect(await detailBalance(acct.uuid)).toBeCloseTo(900, 2);

    // The opening balance is a 'starting balance' transaction; nuggets_balance stays 0.
    const sb = await pool.query(
      `SELECT amount, type FROM transactions WHERE account_id = $1 AND type = 'starting balance'`,
      [acct.id],
    );
    expect(sb.rows).toHaveLength(1);
    expect(Number(sb.rows[0].amount)).toBe(1000);
    const a = await pool.query('SELECT nuggets_balance FROM accounts WHERE id = $1', [acct.id]);
    expect(Number(a.rows[0].nuggets_balance ?? 0)).toBe(0);
  });

  it('sees an edit of an old transaction', async () => {
    const acct = await createAccount(0);
    const old = await addTxn(acct.id, -50, '2026-01-02');
    await addTxn(acct.id, -20, '2026-01-05');
    expect(await listBalance(acct.uuid)).toBeCloseTo(-70, 2);
    await pool.query('UPDATE transactions SET amount = -500 WHERE id = $1', [old]);
    expect(await listBalance(acct.uuid)).toBeCloseTo(-520, 2);
    expect(await detailBalance(acct.uuid)).toBeCloseTo(-520, 2);
  });

  it('sees the newest transaction deleted', async () => {
    const acct = await createAccount(300);
    await addTxn(acct.id, -10, '2026-01-02');
    const newest = await addTxn(acct.id, -250, '2026-01-09');
    expect(await listBalance(acct.uuid)).toBeCloseTo(40, 2);
    await pool.query('DELETE FROM transactions WHERE id = $1', [newest]);
    expect(await listBalance(acct.uuid)).toBeCloseTo(290, 2);
    expect(await detailBalance(acct.uuid)).toBeCloseTo(290, 2);
  });

  it('sees a back-dated insert', async () => {
    const acct = await createAccount(100);
    await addTxn(acct.id, -10, '2026-03-01');
    expect(await listBalance(acct.uuid)).toBeCloseTo(90, 2);
    await addTxn(acct.id, -40, '2025-12-01');
    expect(await listBalance(acct.uuid)).toBeCloseTo(50, 2);
    expect(await detailBalance(acct.uuid)).toBeCloseTo(50, 2);
  });

  it('counts a split once (the parent carries the money)', async () => {
    const acct = await createAccount(0);
    const parent = await addTxn(acct.id, -100, '2026-02-01');
    await inTransaction(pool, async (client) => {
      await client.query('UPDATE transactions SET is_split_parent = true WHERE id = $1', [parent]);
      await client.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id)
         VALUES ($1, -60, '2026-02-01', 'expense', $2), ($1, -40, '2026-02-01', 'expense', $2)`,
        [acct.id, parent],
      );
    });
    expect(await listBalance(acct.uuid)).toBeCloseTo(-100, 2);
  });

  it('Adjust Balance on an account with an opening balance does not double count it', async () => {
    const acct = await createAccount(500);
    const res = await request(app)
      .post(`/api/accounts/${acct.uuid}/adjust-balance`)
      .send({ targetBalance: 500 })
      .expect(200);
    expect(res.body.adjusted).toBe(false);
    expect(await listBalance(acct.uuid)).toBeCloseTo(500, 2);

    const res2 = await request(app)
      .post(`/api/accounts/${acct.uuid}/adjust-balance`)
      .send({ targetBalance: 480 })
      .expect(200);
    expect(res2.body.adjusted).toBe(true);
    expect(res2.body.adjustment).toBeCloseTo(-20, 2);
    expect(await listBalance(acct.uuid)).toBeCloseTo(480, 2);
  });

  describe('Adjust Balance sent more than once at a time', () => {
    const adjust = (uuid: string, targetBalance: number) =>
      // supertest sends a request only when it is awaited or .then()ed: start each now.
      request(app).post(`/api/accounts/${uuid}/adjust-balance`).send({ targetBalance }).then((r) => r);
    const adjustments = async (accountId: number) =>
      (await pool.query(`SELECT amount::text FROM transactions WHERE account_id = $1 AND type = 'balance adjustment'`, [accountId])).rows;
    const expectOneAdjustment = async (acct: { id: number; uuid: string }, responses: request.Response[]) => {
      for (const res of responses) expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(responses.filter((r) => r.body.adjusted === true)).toHaveLength(1);
      expect(responses.filter((r) => r.body.adjusted === false)).toHaveLength(responses.length - 1);
      expect(await adjustments(acct.id)).toEqual([{ amount: '-20.00' }]);
      expect(await listBalance(acct.uuid)).toBe(80);
    };

    it('three at once leave the balance at the target, with one adjustment', async () => {
      const acct = await createAccount(100);
      await expectOneAdjustment(acct, await Promise.all([adjust(acct.uuid, 80), adjust(acct.uuid, 80), adjust(acct.uuid, 80)]));
    });

    it('two that overlap: the second waits for the first, reads its balance and adjusts nothing', async () => {
      const acct = await createAccount(100);
      // Hold the account row. Without the route's own lock on it, both requests read the
      // balance (100) and wait only to insert their adjustment (its foreign key checks
      // the row), so each adds -20.
      const holder = await pool.connect();
      let both: Promise<request.Response[]> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [acct.id]);
        const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        both = Promise.all([adjust(acct.uuid, 80), adjust(acct.uuid, 80)]);
        // Wait until both are blocked behind the holder, directly or behind each other.
        const blocked = async () =>
          (await holder.query<{ n: number }>(
            `WITH RECURSIVE waiting(pid) AS (
               SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
               UNION
               SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY (pg_blocking_pids(a.pid))
             ) SELECT count(*)::int AS n FROM waiting`,
            [holderPid],
          )).rows[0].n;
        const deadline = Date.now() + 15_000;
        while ((await blocked()) < 2) {
          if (Date.now() > deadline) throw new Error('The two requests never both waited for the account row');
          await new Promise((r) => setTimeout(r, 25));
        }
      } finally {
        await holder.query('COMMIT');
        holder.release();
      }
      await expectOneAdjustment(acct, await both!);
    });
  });

  it('the SimpleFin rebalance does not double count an opening balance', async () => {
    const acct = await createAccount(500);
    await pool.query('UPDATE accounts SET import_account_rebalance = true WHERE id = $1', [acct.id]);
    const adjusted = await withTenant(tenant.tenantId, () =>
      new BalanceRebalanceService().checkAndRebalanceAccount(acct.id, 500),
    );
    expect(adjusted).toBe(false);
    expect(await listBalance(acct.uuid)).toBeCloseTo(500, 2);
  });

  it('renaming in Edit Account leaves the balance unchanged', async () => {
    const acct = await createAccount(1000);
    await addTxn(acct.id, -70, '2026-01-03');
    expect(await listBalance(acct.uuid)).toBeCloseTo(930, 2);

    // The payload the Edit Account form used to send: initial_balance seeded from
    // the calculated balance.
    await request(app)
      .put(`/api/accounts/${acct.uuid}`)
      .send({
        name: `${acct.name} renamed`,
        account_type: 'checking',
        account_group: 'cash',
        type: 'Asset',
        initial_balance: 930,
      })
      .expect(200);
    expect(await listBalance(acct.uuid)).toBeCloseTo(930, 2);

    // Omitting initial_balance must not reset anything either.
    await request(app)
      .put(`/api/accounts/${acct.uuid}`)
      .send({ name: `${acct.name} again`, account_type: 'checking', account_group: 'cash', type: 'Asset' })
      .expect(200);
    expect(await listBalance(acct.uuid)).toBeCloseTo(930, 2);
  });

  it('a GET writes no balance snapshot', async () => {
    const acct = await createAccount(10);
    for (let i = 0; i < 3; i++) await addTxn(acct.id, -1, '2026-01-0' + (i + 1));
    // The GETs once wrote balance snapshots to a cache (account_balance_cache, dropped
    // before v3.0.0); the net-worth snapshots are the only ones left.
    const snapshots = async () => (await pool.query('SELECT COUNT(*)::int AS c FROM net_worth_snapshots')).rows[0].c;
    const before = await snapshots();
    await request(app).get('/api/accounts').expect(200);
    await request(app).get(`/api/accounts/${acct.uuid}/balance`).expect(200);
    await request(app).get(`/api/accounts/${acct.uuid}/transactions`).expect(200);
    expect(await snapshots()).toBe(before);
  });

  it('a failed balance is unavailable, not $0', async () => {
    const acct = await createAccount(250);
    // The batch read every list goes through.
    vi.spyOn(AccountBalanceService.prototype, 'getBalances').mockRejectedValue(new Error('boom'));

    const res = await request(app).get('/api/accounts').expect(200);
    const row = res.body.accounts.find((a: { uuid: string }) => a.uuid === acct.uuid);
    expect(row.calculated_balance).toBeNull();
    expect(row.balance_unavailable).toBe(true);
  });

  it('a failed balance on account detail is unavailable, not $0', async () => {
    const acct = await createAccount(250);
    vi.spyOn(AccountBalanceService.prototype, 'getBalance').mockRejectedValue(new Error('boom'));
    const res = await request(app).get(`/api/accounts/${acct.uuid}/balance`).expect(200);
    expect(res.body.balance).toBeNull();
    expect(res.body.balance_unavailable).toBe(true);
  });

  it('net worth equals the sum of the displayed balances', async () => {
    const asset = await createAccount(1000);
    await addTxn(asset.id, -100, '2026-01-04');
    const liability = await createAccount(-300, 'Liability');
    await addTxn(liability.id, -25, '2026-01-04');

    const list = await request(app).get('/api/accounts').expect(200);
    let expected = 0;
    for (const a of list.body.accounts as Array<{ type: string; calculated_balance: number }>) {
      expected += a.type === 'Asset' ? a.calculated_balance : -Math.abs(a.calculated_balance);
    }
    const snap = await withTenant(tenant.tenantId, () =>
      new NetWorthService().createSnapshotIfNeeded('manual'),
    );
    expect(snap).not.toBeNull();
    expect(Number(snap!.net_worth)).toBeCloseTo(expected, 2);
    expect(Number(snap!.total_liabilities)).toBeGreaterThanOrEqual(325);
  });

  it('balance history comes from the transactions', async () => {
    const acct = await createAccount(100);
    await addTxn(acct.id, -30, '2026-01-15');
    const res = await request(app).get(`/api/accounts/${acct.uuid}/balance-history?limit=3`).expect(200);
    expect(Array.isArray(res.body.balance_history)).toBe(true);
    expect(res.body.balance_history.length).toBeGreaterThan(0);
    // Newest point first: the current balance.
    expect(Number(res.body.balance_history[0].balance)).toBeCloseTo(70, 2);
  });
});
