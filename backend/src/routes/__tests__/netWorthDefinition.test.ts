import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// The net-worth router's GET routes run authenticateToken themselves, which looks for a
// session cookie; the test context has signed the request in already. (Who may call each
// route is route-authorization.test.ts's job.)
vi.mock('../../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../middleware/auth.js')>()),
  authenticateToken: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { createNetWorthRoutes } from '../net-worth.js';
import { createExportRoutes } from '../export.js';
import { createAccountsRoutes } from '../accounts.js';
import type { Pool } from 'pg';
import { withTenant } from '../../db/withTenant.js';
import { BalanceRebalanceService } from '../../services/BalanceRebalanceService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { addDays } from '../../utils/calendarDate.js';
import { inTransaction } from '../../test/inTransaction.js';

// Net worth had three definitions. The live snapshot took
// ABS() of a liability (an overpaid card counted as debt), counted foreign-currency and
// points accounts as dollars and ignored "Exclude from net worth"; the rebuild also left
// out closed accounts and every transaction whose status wasn't in its list
// ('reconciled' among them); the Accounts page summed its own list by account_group.
// And a transaction dated after today counted in the account's balance but not in
// today's net worth. Every reader now uses the one balance (as of today) and the one
// set of accounts that count.
describe('One definition of balance and net worth', () => {
  let app: Express;
  let tenant: TestTenant;
  // The ledger's own time zone, so the deployment's (every test file's, and on a fresh
  // database the cluster's TimeZone, not always UTC) doesn't decide its day: one where it's
  // about noon as the file starts, so midnight doesn't pass during the run. Etc/GMT names
  // are signed the POSIX way: Etc/GMT-5 is UTC+5.
  const offset = 12 - new Date().getUTCHours();
  const zone = offset === 0 ? 'UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
  // Today as the routes have it, app_today() in that zone: read once the ledger has it.
  let today = '';
  let yesterday = '';
  let tomorrow = '';
  const ids = {} as Record<'checking' | 'card' | 'loan' | 'closed' | 'hidden' | 'excluded' | 'miles' | 'euro', { id: number; uuid: string }>;

  const totals = (row: Record<string, unknown>) => ({
    total_assets: Number(row.total_assets),
    total_liabilities: Number(row.total_liabilities),
    net_worth: Number(row.net_worth),
  });
  const TODAY = { total_assets: 640, total_liabilities: 430, net_worth: 210 };
  const YESTERDAY = { total_assets: 940, total_liabilities: 550, net_worth: 390 };

  beforeAll(async () => {
    tenant = await createTestTenant('Net worth definition');
    await tenant.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('application_timezone', $1)`, [zone]);
    today = (await tenant.pool.query<{ d: string }>('SELECT app_today()::text AS d')).rows[0].d;
    yesterday = addDays(today, -1);
    tomorrow = addDays(today, 1);
    const account = async (
      key: keyof typeof ids,
      type: 'Asset' | 'Liability',
      group: string,
      extra: { close?: boolean; hide?: boolean; exclude?: boolean; currency?: string } = {}
    ) => {
      ids[key] = (
        await tenant.pool.query<{ id: number; uuid: string }>(
          `INSERT INTO accounts (name, account_type, account_group, type, close_account, hide_account, exclude_account_balance, import_currency)
           VALUES ($1, 'checking', $2, $3, $4, $5, $6, $7) RETURNING id, uuid`,
          [`NW ${key}`, group, type, extra.close ?? false, extra.hide ?? false, extra.exclude ?? false, extra.currency ?? 'USD']
        )
      ).rows[0];
      return ids[key].id;
    };
    const txn = async (
      accountId: number,
      amount: number,
      date: string,
      opts: { status?: string; parentId?: number; splitParent?: boolean; type?: string } = {},
      db: Pick<Pool, 'query'> = tenant.pool
    ) =>
      (
        await db.query<{ id: number }>(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, status, is_split_parent, parent_transaction_id, description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'nw') RETURNING id`,
          [accountId, amount, date, opts.type ?? 'expense', opts.status ?? 'cleared', opts.splitParent ?? false, opts.parentId ?? null]
        )
      ).rows[0].id;

    // Checking: 1000 - 100 (reconciled) yesterday, a -300 split today (its children only
    // categorize it), and -25 dated tomorrow: 900 yesterday, 600 today.
    const checking = await account('checking', 'Asset', 'cash');
    await txn(checking, 1000, yesterday, { type: 'starting balance' });
    await txn(checking, -100, yesterday, { status: 'reconciled' });
    // One transaction: a split's splits must add up to it when it commits.
    await inTransaction(tenant.pool, async (client) => {
      const split = await txn(checking, -300, today, { splitParent: true }, client);
      await txn(checking, -100, today, { parentId: split }, client);
      await txn(checking, -200, today, { parentId: split }, client);
    });
    await txn(checking, -25, tomorrow);
    // A card overpaid by a refund: -50 yesterday, +70 today, which lowers the debts.
    const card = await account('card', 'Liability', 'credit_cards');
    await txn(card, -50, yesterday);
    await txn(card, 120, today);
    const loan = await account('loan', 'Liability', 'loans');
    await txn(loan, -500, yesterday);
    // A closed account still holding $40 counts; its money is still the household's.
    await txn(await account('closed', 'Asset', 'cash', { close: true }), 40, yesterday);
    // These don't count: hidden, excluded from net worth, points, another currency.
    await txn(await account('hidden', 'Asset', 'cash', { hide: true }), 999, yesterday);
    await txn(await account('excluded', 'Asset', 'cash', { exclude: true }), 777, yesterday);
    await txn(await account('miles', 'Asset', 'other', { currency: 'https://www.example.com/flights/miles' }), 85000, yesterday);
    await txn(await account('euro', 'Asset', 'cash', { currency: 'EUR' }), 300, yesterday);

    app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: true }));
    // What resolveTenant sets for a deployment admin: the rebuild takes one (requireDeploymentAdmin).
    app.use((req, _res, next) => {
      (req as TenantRequest).isDeploymentAdmin = true;
      next();
    });
    app.use('/api/net-worth', createNetWorthRoutes());
    app.use('/api/export', createExportRoutes());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const snapshotCount = async () =>
    Number((await tenant.pool.query<{ c: string }>('SELECT COUNT(*) AS c FROM net_worth_snapshots')).rows[0].c);

  it("answers today's net worth computed now, and writes nothing", async () => {
    const before = await snapshotCount();
    const res = await request(app).get('/api/net-worth/current').expect(200);
    expect(totals(res.body.current_net_worth)).toEqual(TODAY);
    expect(res.body.current_net_worth.snapshot_date).toBe(today);
    expect(await snapshotCount()).toBe(before);
  });

  it("records the same net worth in today's snapshot", async () => {
    // The snapshot a transaction write records (AccountBalanceService, the import).
    const snapshot = await withTenant(tenant.tenantId, async () => {
      const NetWorthService = (await import('../../services/NetWorthService.js')).default;
      return new NetWorthService().createSnapshotIfNeeded('manual');
    });
    expect(totals(snapshot as unknown as Record<string, unknown>)).toEqual(TODAY);
    expect(snapshot?.snapshot_date).toBe(today);
  });

  it('rebuilds each day with the same definition as the live snapshot', async () => {
    await request(app).post('/api/net-worth/rebuild').expect(200);
    const rows = (
      await tenant.pool.query(
        `SELECT snapshot_date::text AS d, total_assets, total_liabilities, net_worth
           FROM net_worth_snapshots WHERE aggregation_level = 'daily' ORDER BY snapshot_date`
      )
    ).rows;
    expect(rows.map((r) => [r.d, totals(r)])).toEqual([
      [yesterday, YESTERDAY],
      [today, TODAY],
    ]);

    // And the live snapshot of yesterday says the same.
    await tenant.pool.query(`DELETE FROM net_worth_snapshots WHERE snapshot_date = $1`, [yesterday]);
    const made = await tenant.pool.query("SELECT create_net_worth_snapshot($1::date, 'manual', 'daily') AS uuid", [yesterday]);
    const live = await tenant.pool.query('SELECT total_assets, total_liabilities, net_worth FROM net_worth_snapshots WHERE uuid = $1', [
      made.rows[0].uuid,
    ]);
    expect(totals(live.rows[0])).toEqual(YESTERDAY);
  });

  it('counts a transaction dated after today from its date, in every balance', async () => {
    const list = await request(app).get('/api/accounts').expect(200);
    const balances = Object.fromEntries(
      (list.body.accounts as Array<{ uuid: string; calculated_balance: number }>).map((a) => [a.uuid, a.calculated_balance])
    );
    expect(balances[ids.checking.uuid]).toBe(600);
    expect(balances[ids.card.uuid]).toBe(70);

    const detail = await request(app).get(`/api/accounts/${ids.checking.uuid}/balance`).expect(200);
    expect(detail.body.balance).toBe(600);

    // The register still shows the balance after each row, the future one included.
    const register = await request(app).get(`/api/accounts/${ids.checking.uuid}/transactions`).expect(200);
    expect(
      (register.body.transactions as Array<{ transaction_date: string; amount: number; running_account_balance: number }>).map(
        (t) => [t.transaction_date, t.amount, t.running_account_balance]
      )
    ).toEqual([
      [tomorrow, -25, 575],
      [today, -300, 600],
      [yesterday, -100, 900],
      [yesterday, 1000, 1000],
    ]);
  });

  it('exports the same balance', async () => {
    const res = await request(app).get('/api/export/accounts').expect(200);
    const [header, ...lines] = res.text.split('\n').map((l) => l.split(','));
    const at = (name: string) => header.indexOf(name);
    const balanceOf = Object.fromEntries(lines.map((l) => [l[at('uuid')], l[at('balance')]]));
    expect(balanceOf[ids.checking.uuid]).toBe('600.00');
    expect(balanceOf[ids.card.uuid]).toBe('70.00');
    expect(balanceOf[ids.closed.uuid]).toBe('40.00');
  });

  it("compares the bank's balance with today's, so a future-dated entry is no discrepancy", async () => {
    await tenant.pool.query('UPDATE accounts SET import_account_rebalance = true WHERE id = $1', [ids.checking.id]);
    const adjusted = await withTenant(tenant.tenantId, () =>
      new BalanceRebalanceService().checkAndRebalanceAccount(ids.checking.id, 600)
    );
    expect(adjusted).toBe(false);
  });
});
