import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { sql } from 'kysely';
import pool from '../../db.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createAccountsRoutes } from '../accounts.js';
import { createDataManagementRoutes } from '../data-management.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { BackupService } from '../../services/BackupService.js';

/**
 * A bank sync against its account becoming a liability. A sync decides at its start,
 * from the account's type, whether a deposit imports as an income; a liability takes none
 * (check_transaction_type_for_account). It read the type unlocked, so an account made a
 * liability after that read and before the sync's first income had every income of the
 * sync refused, each counted as failed. It now reads the type FOR KEY SHARE: the edit
 * (FOR UPDATE) waits for the sync and then finds its incomes (409 ACCOUNT_HAS_INCOME), and
 * a sync that starts during the edit waits for it and imports the deposits as a
 * liability's.
 *
 * The importer runs as a sync runs it, in a transaction of its own, paused in one of its
 * savepoints; AccountSyncer.upsertAccount, which takes the account's row first in a real
 * sync, isn't in the way here, so the importer's own lock is what's tested. And with Delete
 * Transactions of the same rows waiting too, the three finish in turn: no deadlock.
 */
describe("a bank sync against its account's type changing", () => {
  let app: Express;
  let tenant: TestTenant;
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Import account type race');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type Account = { id: number; uuid: string; name: string; importId: string };
  /** An asset account linked to SimpleFin (budget auto-assignment off, so syncs are deterministic). */
  const linkedAccount = async (): Promise<Account> => {
    const importId = `SF-type-race-${++n}-${Date.now()}`;
    const row = (
      await tenant.pool.query<Omit<Account, 'importId'>>(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item, import_auto_match_merchants)
         VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, false, false, false) RETURNING id, uuid, name`,
        [`Type race ${n}`, importId]
      )
    ).rows[0];
    return { ...row, importId };
  };
  /** Noon UTC on `day`, as SimpleFin dates a posted transaction. */
  const postedOn = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;
  const deposits = (account: Account, month: string): SimplefinTransaction[] => [
    { id: `${account.importId}-1`, amount: '50.00', description: 'DEPOSIT ONE', posted: postedOn(`${month}-05`) },
    { id: `${account.importId}-2`, amount: '60.00', description: 'DEPOSIT TWO', posted: postedOn(`${month}-06`) },
  ];
  const importer = () => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    return { periods, importer: new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher()) };
  };
  const sync = (accountId: number, feed: SimplefinTransaction[]) => {
    const { importer: run } = importer();
    return withTenant(tenant.tenantId, () => run.importTransactions(accountId, feed));
  };
  /**
   * A sync paused as it enters its `nth` savepoint (1: just after it read the account; 4: rows
   * locked, none written; 2 locks what its new rows name, 3 its rows).
   */
  const pausedSync = async (accountId: number, feed: SimplefinTransaction[], nth: number) => {
    const next = importer();
    const original = next.periods.savepoint;
    let calls = 0;
    let pid = 0;
    let paused!: () => void;
    let resume!: () => void;
    const atPause = new Promise<void>((resolve) => (paused = resolve));
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    vi.spyOn(next.periods, 'savepoint').mockImplementation((async (fn: () => Promise<unknown>) => {
      if (++calls === nth) {
        pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0].pid;
        paused();
        await resumed;
      }
      return original(fn);
    }) as typeof original);
    const syncing = withTenant(tenant.tenantId, () => next.importer.importTransactions(accountId, feed));
    await atPause;
    return { pid, resume, syncing };
  };

  const makeLiability = (account: Account) =>
    request(app)
      .put(`/api/accounts/${account.uuid}`)
      .send({ name: account.name, account_type: 'credit_card', account_group: 'credit_cards', type: 'Liability' })
      .then((res) => res);
  const typeOf = async (id: number) => (await tenant.pool.query<{ type: string }>('SELECT type FROM accounts WHERE id = $1', [id])).rows[0].type;
  const typesOn = async (id: number) =>
    (await tenant.pool.query<{ type: string }>('SELECT type FROM transactions WHERE account_id = $1 ORDER BY id', [id])).rows.map((r) => r.type);

  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  /** 'waited' once a backend waits for `pid`, or 'went through' once `pending` has settled without. */
  const waitedFor = async (pending: Promise<unknown>, pid: number): Promise<'waited' | 'went through'> => {
    let settled = false;
    let waiting = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    await waitUntil(async () => settled || (waiting = (await waitersOf(pid)).length > 0));
    return waiting ? 'waited' : 'went through';
  };

  it('the sync first: the edit waits for it, then finds its incomes (409 ACCOUNT_HAS_INCOME)', async () => {
    const account = await linkedAccount();
    const { pid, resume, syncing } = await pausedSync(account.id, deposits(account, '2024-03'), 1);
    let editing: ReturnType<typeof makeLiability> | undefined;
    try {
      editing = makeLiability(account);
      // It waits for the sync's lock of the account; it went straight through, and the
      // sync's incomes were then refused.
      expect(await waitedFor(editing, pid)).toBe('waited');
    } finally {
      resume();
    }
    expect(await syncing).toMatchObject({ imported: 2, failed: 0 });
    const edited = await editing!;
    expect(edited.status, JSON.stringify(edited.body)).toBe(409);
    expect(edited.body.code).toBe('ACCOUNT_HAS_INCOME');
    expect(await typeOf(account.id)).toBe('Asset');
    expect(await typesOn(account.id)).toEqual(['income', 'income']);
  });

  it("the edit first: the sync waits for it, then imports the deposits as a liability's", async () => {
    const account = await linkedAccount();
    const edit: PoolClient = await tenant.pool.connect();
    let syncing: ReturnType<typeof sync> | undefined;
    try {
      await edit.query('BEGIN');
      // As AccountService.updateAccount makes it a liability: its row locked, then written.
      await edit.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [account.id]);
      await edit.query(`UPDATE accounts SET type = 'Liability', account_type = 'credit_card', account_group = 'credit_cards' WHERE id = $1`, [account.id]);
      const editPid = (await edit.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      syncing = sync(account.id, deposits(account, '2024-04'));
      expect(await waitedFor(syncing, editPid)).toBe('waited');
      await edit.query('COMMIT');
    } finally {
      await edit.query('ROLLBACK').catch(() => undefined);
      edit.release();
    }
    // It read 'Liability' once the edit committed: none refused.
    expect(await syncing).toMatchObject({ imported: 2, failed: 0 });
    expect(await typesOn(account.id)).toEqual(['expense', 'expense']);
  });

  it('a resync holding its account and its rows, an edit and Delete Transactions all finish, one after another', async () => {
    const account = await linkedAccount();
    const feed: SimplefinTransaction[] = [
      { id: `${account.importId}-1`, amount: '-11.00', description: 'FIRST', posted: postedOn('2024-05-05') },
      { id: `${account.importId}-2`, amount: '-22.00', description: 'SECOND', posted: postedOn('2024-05-06') },
    ];
    expect(await sync(account.id, feed)).toMatchObject({ imported: 2 });
    const range = { dateFrom: '2024-05-01', dateTo: '2024-05-28', excludeBudgetPeriod: false };
    const previewed = await request(app).post('/api/data-management/preview-delete-transactions').send(range);
    expect(previewed.body.count).toBe(2);

    // The bank's answer the other way round, paused once its rows are locked.
    const { pid, resume, syncing } = await pausedSync(account.id, [feed[1], feed[0]], 4);
    let editing: ReturnType<typeof makeLiability> | undefined;
    let deleting: Promise<request.Response> | undefined;
    try {
      deleting = request(app)
        .post('/api/data-management/delete-transactions')
        .send({ ...range, createBackup: false, selectionKey: previewed.body.selectionKey })
        .then((res) => res);
      expect(await waitedFor(deleting, pid)).toBe('waited');
      editing = makeLiability(account);
      await waitUntil(async () => (await waitersOf(pid)).length >= 2);
    } finally {
      resume();
    }
    const [synced, edited, deleted] = await Promise.all([syncing, editing!, deleting!]);
    expect(synced).toMatchObject({ updated: 2, failed: 0 });
    // No deadlock (a 500): the edit finds no income, Delete deletes what its preview found.
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.count).toBe(2);
    expect(await typeOf(account.id)).toBe('Liability');
    expect(await typesOn(account.id)).toEqual([]);
  });
});

/** Resolve once `check` answers true, polling; fail after 5 s. */
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
