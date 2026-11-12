import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import globalPool from '../db.js';
import { withTenant } from '../db/withTenant.js';
import { createAccountsRoutes } from '../routes/accounts.js';
import { ImportService } from '../services/ImportService.js';
import AccountBalanceService from '../services/AccountBalanceService.js';
import { BalanceRebalanceService } from '../services/BalanceRebalanceService.js';
import NetWorthService from '../services/NetWorthService.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * Adjust Balance and the SimpleFin sync of the same account take its row and today's
 * net-worth snapshot row in one order: the account's, then the snapshot's.
 * Adjust Balance locks the account, adds the adjustment and records the snapshot.
 * A transaction that records the snapshot and then waits for the account's row (a
 * stand-in for the sync: triggerNetWorthSnapshot(), then
 * checkAndRebalanceAccount()) deadlocks with it (40P01). The sync recorded the snapshot
 * after its import, before its rebalance; it now records it once, last, after locking the
 * account where the account's transaction starts.
 *
 * Runs the real sync (SimpleFin's answer stubbed at fetch, as importSync.db.test.ts does)
 * and the real route, with a third session holding the budget period's row, which an
 * adjustment's foreign key reads, to stop each transaction where the other can catch it.
 */

vi.mock('../services/OrganizationSimpleFinService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/OrganizationSimpleFinService.js')>();
  return {
    ...actual,
    getAccessUrlForTenant: vi.fn(async () => 'https://user:secret@bridge.simplefin.org/simplefin'),
  };
});

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const now = Math.floor(Date.now() / 1000);
const CONNECTION = {
  conn_id: `CONN-${stamp}`,
  name: 'Lock Bank',
  org_id: `org-${stamp}`,
  org_url: `https://lockbank-${stamp}.example`,
  sfin_url: 'https://bridge.simplefin.org/simplefin',
};

describe('Adjust Balance and a SimpleFin sync of the same account', () => {
  let tenant: TestTenant;
  let app: Express;
  let periodId: number;
  let n = 0;
  const service = new ImportService(globalPool);
  let feed: unknown;
  /** What the sync and the route did, in order: 'snapshot', 'rebalance', or a snapshot's error code. */
  const events: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant('Adjust Balance vs sync lock order');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
    await tenant.pool.query(`INSERT INTO account_institutions (name, import_domain) VALUES ('Lock Bank', $1)`, [
      new URL(CONNECTION.org_url).hostname,
    ]);
    periodId = (
      await tenant.pool.query(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         SELECT 'Lock order', to_char(d, 'FMMonth'), extract(year FROM d)::int, extract(month FROM d)::int,
                date_trunc('month', d)::date, (date_trunc('month', d) + interval '1 month - 1 day')::date
           FROM (SELECT app_today() AS d) t
         RETURNING id`
      )
    ).rows[0].id;
  });

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(feed), { status: 200 })));
    // triggerNetWorthSnapshot catches a snapshot's error (a deadlock among them) so as not
    // to fail the write: record it here.
    const snapshot = NetWorthService.prototype.createSnapshotIfNeeded;
    vi.spyOn(NetWorthService.prototype, 'createSnapshotIfNeeded').mockImplementation(async function (this: NetWorthService, ...args) {
      try {
        const result = await snapshot.apply(this, args);
        events.push('snapshot');
        return result;
      } catch (err) {
        events.push(`snapshot failed: ${(err as { code?: string }).code ?? String(err)}`);
        throw err;
      }
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** An account linked to SimpleFin that rebalances, with `opening` as its balance and today's snapshot recorded. */
  async function linkedAccount(opening: number) {
    const importId = `SF-lock-${stamp}-${++n}`;
    const row = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item, import_account_rebalance)
         VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, false, false, true) RETURNING id, uuid`,
        [`Lock ${stamp} ${n}`, importId]
      )
    ).rows[0];
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description, status)
       VALUES ($1, $2, app_today(), 'starting balance', 'Starting Balance', 'cleared')`,
      [row.id, opening]
    );
    // Today's snapshot exists, so recording it again updates (and locks) its row.
    await withTenant(tenant.tenantId, () => new AccountBalanceService().triggerNetWorthSnapshot());
    events.length = 0;
    return { id: row.id as number, uuid: row.uuid as string, importId };
  }

  /** The bank's answer: one new purchase on the account, and its posted balance. */
  function bankSays(acct: { importId: string }, balance: string) {
    feed = {
      errlist: [],
      connections: [CONNECTION],
      accounts: [
        {
          id: acct.importId,
          conn_id: CONNECTION.conn_id,
          name: 'Lock account',
          currency: 'USD',
          balance,
          'balance-date': now,
          transactions: [{ id: `LT-${stamp}-${n}`, amount: '-10.00', description: 'LOCK SHOP', posted: now - 3600 }],
        },
      ],
    };
  }

  /** Record each rebalance, pausing it until `release()`; `reached` resolves when one waits. */
  function pauseRebalance() {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let arrive!: () => void;
    const reached = new Promise<void>((resolve) => (arrive = resolve));
    const rebalance = BalanceRebalanceService.prototype.checkAndRebalanceAccount;
    vi.spyOn(BalanceRebalanceService.prototype, 'checkAndRebalanceAccount').mockImplementation(async function (this: BalanceRebalanceService, ...args) {
      events.push('rebalance');
      arrive();
      await released;
      return rebalance.apply(this, args);
    });
    return { reached, release };
  }

  /** Hold the budget period's row (FOR UPDATE), which an adjustment's foreign key reads. */
  async function holdPeriod(): Promise<{ holder: PoolClient; pid: number }> {
    const holder = await tenant.pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT id FROM budget_period WHERE id = $1 FOR UPDATE', [periodId]);
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return { holder, pid };
  }

  /** Wait until `count` sessions wait for `pid`, directly or behind each other. */
  async function waitForWaiters(pid: number, count: number) {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const waiting = (
        await globalPool.query<{ n: number }>(
          `WITH RECURSIVE waiting(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY (pg_blocking_pids(a.pid))
           ) SELECT count(*)::int AS n FROM waiting`,
          [pid]
        )
      ).rows[0].n;
      if (waiting >= count) return;
      if (Date.now() > deadline) throw new Error(`only ${waiting} of ${count} sessions waited`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  const adjust = (uuid: string, targetBalance: number) =>
    request(app).post(`/api/accounts/${uuid}/adjust-balance`).send({ targetBalance }).then((r) => r);

  const sync = (uuid: string) =>
    service.runSingleAccountSync(tenant.tenantId, uuid, { syncType: 'manual', syncTrigger: 'user', userId: tenant.userId });

  const balance = async (accountId: number) =>
    (await tenant.pool.query<{ b: string }>('SELECT calculate_account_balance($1)::text AS b', [accountId])).rows[0].b;

  /** Today's snapshot and today's net worth, which it should equal. */
  const netWorth = async () => {
    const recorded = await tenant.pool.query<{ net_worth: string }>(
      `SELECT net_worth::text FROM net_worth_snapshots WHERE snapshot_date = app_today() AND aggregation_level = 'daily'`
    );
    const actual = await tenant.pool.query<{ net_worth: string }>('SELECT net_worth::text FROM net_worth_as_of(app_today())');
    return { recorded: recorded.rows[0]?.net_worth, actual: actual.rows[0].net_worth };
  };

  const deadlocks = () => events.filter((e) => e.startsWith('snapshot failed'));

  it("the sync's account transaction records today's net worth once, after its rebalance", async () => {
    const acct = await linkedAccount(100);
    bankSays(acct, '40.00');
    const { release } = pauseRebalance();
    release();
    const result = await sync(acct.uuid);
    expect(result).toMatchObject({ success: true, transactionsImported: 1, balanceAdjustments: 1 });
    // The account's transaction: the rebalance, then one snapshot; then the sync's last
    // transaction, with the sync log, records it again. It recorded it twice after the
    // import, before the rebalance, then held the snapshot's row while the rebalance
    // locked the account's.
    expect(events).toEqual(['rebalance', 'snapshot', 'snapshot']);
    expect(await balance(acct.id)).toBe('40.00');
    const { recorded, actual } = await netWorth();
    expect(recorded).toBe(actual);
  });

  it('an Adjust Balance sent while the sync is at its rebalance waits for it, and neither deadlocks', async () => {
    const acct = await linkedAccount(100);
    bankSays(acct, '40.00');
    const { reached, release } = pauseRebalance();
    const { holder, pid } = await holdPeriod();
    let synced: Awaited<ReturnType<typeof sync>>;
    let adjusted: request.Response;
    try {
      const syncing = sync(acct.uuid);
      syncing.catch(() => undefined);
      await reached;
      // The sync holds the account's row: Adjust Balance waits for it.
      const adjusting = adjust(acct.uuid, 75);
      release();
      // The sync's adjustment waits for the budget period's row, the Adjust Balance for the sync.
      await waitForWaiters(pid, 2);
      await holder.query('COMMIT');
      [synced, adjusted] = await Promise.all([syncing, adjusting]);
    } finally {
      holder.release();
    }
    expect(synced).toMatchObject({ success: true, balanceAdjustments: 1 });
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    // It read the balance the sync left (40), and adjusted from there.
    expect(adjusted.body).toMatchObject({ adjusted: true, adjustment: 35, balance: 75 });
    expect(deadlocks()).toEqual([]);
    expect(await balance(acct.id)).toBe('75.00');
    const { recorded, actual } = await netWorth();
    expect(recorded).toBe(actual);
  });

  it('a sync that starts while Adjust Balance holds the account waits for it, and neither deadlocks', async () => {
    const acct = await linkedAccount(100);
    bankSays(acct, '40.00');
    const { release } = pauseRebalance();
    release();
    const { holder, pid } = await holdPeriod();
    let synced: Awaited<ReturnType<typeof sync>>;
    let adjusted: request.Response;
    try {
      // Adjust Balance locks the account, then its adjustment waits for the budget period's row.
      const adjusting = adjust(acct.uuid, 75);
      await waitForWaiters(pid, 1);
      // The sync waits for the account's row.
      const syncing = sync(acct.uuid);
      syncing.catch(() => undefined);
      await waitForWaiters(pid, 2);
      await holder.query('COMMIT');
      [synced, adjusted] = await Promise.all([syncing, adjusting]);
    } finally {
      holder.release();
    }
    expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
    expect(adjusted.body).toMatchObject({ adjusted: true, adjustment: -25, balance: 75 });
    expect(synced).toMatchObject({ success: true, balanceAdjustments: 1 });
    expect(deadlocks()).toEqual([]);
    // The bank's balance wins: the sync's rebalance read the 75 the adjustment left.
    expect(await balance(acct.id)).toBe('40.00');
    const { recorded, actual } = await netWorth();
    expect(recorded).toBe(actual);
  });
});
