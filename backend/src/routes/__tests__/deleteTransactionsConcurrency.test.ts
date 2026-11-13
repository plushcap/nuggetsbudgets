import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import pool from '../../db.js';
import { createDataManagementRoutes } from '../data-management.js';
import { selectionKeyNow } from '../../services/transactions/rangeDeletion.js';
import { BackupService } from '../../services/BackupService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import type { TenantRequest } from '../../middleware/tenant.js';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';

/**
 * Delete Transactions while other writes run. Delete deletes exactly
 * what the preview found (its selectionKey) or nothing, so it decides on the range as it
 * is once its rows are locked: a split given a budget period, or a transaction moved out
 * of the range, while it waits leaves its set different from the preview's, and it
 * refuses (409 PREVIEW_OUTDATED). And it holds no row locks while its backup runs, so an
 * edit, a bank sync or an import isn't held up, or failed, by a backup.
 */
describe('delete-transactions with concurrent writes', () => {
  let app: Express;
  let tenant: TestTenant;
  let accountId: number;
  let april: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Delete transactions concurrency');
    app = express();
    app.use(express.json());
    app.use(tenant.context({ deploymentAdmin: true }));
    // What resolveTenant sets for a deployment admin: only one may back up first.
    app.use((req, _res, next) => {
      (req as TenantRequest).isDeploymentAdmin = true;
      next();
    });
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
    accountId = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Concurrent deletion', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    april = (
      await tenant.pool.query(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('April 2025', 'April', 2025, 4, '2025-04-01', '2025-04-30') RETURNING id`
      )
    ).rows[0].id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const add = async (date: string, amount: number) =>
    (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, $2, $3, 'expense', 'Concurrency fixture') RETURNING id`,
        [accountId, amount, date]
      )
    ).rows[0].id;

  /** A split of -20 into two -10 splits, written in one transaction. */
  const split = async (date: string) => {
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      const parent = (
        await client.query<{ id: number }>(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, is_split_parent) VALUES ($1, -20, $2, 'expense', true) RETURNING id`,
          [accountId, date]
        )
      ).rows[0].id;
      const splits = (
        await client.query<{ id: number }>(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, parent_transaction_id)
           VALUES ($1, -10, $2, 'expense', $3), ($1, -10, $2, 'expense', $3) RETURNING id`,
          [accountId, date, parent]
        )
      ).rows.map((row) => row.id);
      await client.query('COMMIT');
      return { parent, splits };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  const exists = async (id: number) => (await tenant.pool.query('SELECT 1 FROM transactions WHERE id = $1', [id])).rowCount === 1;

  const preview = async (range: object) => {
    const res = await request(app).post('/api/data-management/preview-delete-transactions').send(range);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { count: number; selectionKey: string };
  };

  /** Delete what `previewed` found for `range`, started now and awaited later. */
  const startDelete = (range: object, previewed: { selectionKey: string }, createBackup: boolean) =>
    request(app)
      .post('/api/data-management/delete-transactions')
      .send({ ...range, createBackup, selectionKey: previewed.selectionKey })
      .then((res) => res);

  /** A backup that starts, then waits for `finish()`; it writes nothing. */
  const heldBackup = () => {
    let started!: () => void;
    let finish!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const spy = vi.spyOn(BackupService.prototype, 'createBackup').mockImplementation(async () => {
      started();
      await finished;
      return { filePath: '/nowhere/held.backup', fileName: 'held.backup', fileSize: 0, sha256: null };
    });
    return { running, finish, spy };
  };

  it('refuses, and keeps the split, when one of its splits got a budget period during the backup', async () => {
    const { parent, splits } = await split('2025-04-14');
    const range = { dateFrom: '2025-04-01', dateTo: '2025-04-30', excludeBudgetPeriod: true };
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    const backup = heldBackup();
    const deleting = startDelete(range, previewed, true);
    try {
      await backup.running;
      // The budget-item matcher, or a member, puts a split in April while the backup runs.
      await tenant.pool.query('UPDATE transactions SET budget_period_id = $1 WHERE id = $2', [april, splits[0]]);
    } finally {
      backup.finish();
    }
    const res = await deleting;

    expect(backup.spy).toHaveBeenCalledTimes(1);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREVIEW_OUTDATED');
    for (const id of [parent, ...splits]) expect(await exists(id), `row ${id}`).toBe(true);
  });

  it("doesn't hold the range's rows locked while the backup runs", async () => {
    const edited = await add('2025-06-10', -30);
    const other = await add('2025-06-11', -31);
    const range = { dateFrom: '2025-06-01', dateTo: '2025-06-30', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    const backup = heldBackup();
    const deleting = startDelete(range, previewed, true);
    const client: PoolClient = await tenant.pool.connect();
    let edit: Promise<unknown>;
    try {
      await backup.running;
      // A member edits a transaction in the range while the backup runs: it isn't held up
      // until the backup ends (this one gives up after 700 ms, as a bank sync or an edit
      // gives up after lock_timeout).
      await client.query(`SET lock_timeout = '700ms'`);
      edit = client.query(`UPDATE transactions SET description = 'Edited during the backup' WHERE id = $1`, [edited]);
      await edit.catch(() => undefined);
    } finally {
      client.release(true);
      backup.finish();
    }
    const res = await deleting;

    await expect(edit!).resolves.toMatchObject({ rowCount: 1 });
    // The backup may not have the edit, so the edited transaction isn't deleted.
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREVIEW_OUTDATED');
    expect([await exists(edited), await exists(other)]).toEqual([true, true]);

    // A new preview has the edit, and Delete deletes what it found.
    const again = await preview(range);
    const deleted = await startDelete(range, again, false);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.count).toBe(2);
    expect([await exists(edited), await exists(other)]).toEqual([false, false]);
  });

  it('refuses, and deletes nothing, when a transaction was edited after its backup read it', async () => {
    const x = await add('2024-01-10', -5);
    const range = { dateFrom: '2024-01-01', dateTo: '2024-01-31', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    // The backup reads X, then another member changes its amount before Delete takes its locks.
    let backedUp: string | undefined;
    const spy = vi.spyOn(BackupService.prototype, 'createBackup').mockImplementation(async () => {
      backedUp = (await tenant.pool.query('SELECT amount FROM transactions WHERE id = $1', [x])).rows[0].amount;
      await tenant.pool.query('UPDATE transactions SET amount = -500 WHERE id = $1', [x]);
      return { filePath: '/nowhere/read-x.backup', fileName: 'read-x.backup', fileSize: 0, sha256: null };
    });
    const res = await startDelete(range, previewed, true);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(backedUp).toBe('-5.00');
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREVIEW_OUTDATED');
    const kept = await tenant.pool.query('SELECT amount FROM transactions WHERE id = $1', [x]);
    expect(kept.rows[0]?.amount).toBe('-500.00');
  });

  /** What another member changes, during the backup, on a split in `month` (parent, splits). */
  const changesDuringBackup: Array<[string, string, (rows: { parent: number; splits: number[] }) => Promise<unknown>]> = [
    ['a split edited', '2024-02', ({ splits }) => tenant.pool.query(`UPDATE transactions SET description = 'Re-described' WHERE id = $1`, [splits[1]])],
    ['a tag put on a split', '2024-03', async ({ splits }) => {
      const tag = (await tenant.pool.query<{ id: number }>(`INSERT INTO tags (name) VALUES ('Tagged during the backup') RETURNING id`)).rows[0].id;
      await tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tag, splits[0]]);
    }],
    ['a note left on it', '2024-04', ({ parent }) =>
      tenant.pool.query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', $1, 'note', 'Left during the backup')`, [parent])],
    ['a receipt attached', '2024-05', ({ parent }) =>
      tenant.pool.query(
        `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, transaction_id)
         VALUES ('Receipt', 'r.pdf', 'r.pdf', 'pdf', 'r.pdf', $1)`,
        [parent]
      )],
  ];

  /** A bank account linked to SimpleFin, and the importer a sync writes its transactions with. */
  const linkedAccount = async (label: string) => {
    const importId = `SF-${label}-${Date.now()}`;
    const id = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item)
         VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, false, false) RETURNING id`,
        [label, importId]
      )
    ).rows[0].id;
    return { id, importId };
  };
  const sync = (accountId: number, feed: SimplefinTransaction[]) => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    const importer = new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher());
    return withTenant(tenant.tenantId, () => importer.importTransactions(accountId, feed));
  };
  /** Noon UTC on `day`, as SimpleFin dates a posted transaction. */
  const postedOn = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;

  // A bank sync rewrites every row the bank sends again (import_imported_at, and so
  // updated_at), changed or not: Delete refused (409) after any sync, though nothing it
  // deletes had changed.
  it('deletes what the preview found after a bank sync that changed nothing', async () => {
    const account = await linkedAccount('Synced checking');
    const feed: SimplefinTransaction[] = [
      { id: `NOOP-1-${account.id}`, amount: '-12.34', description: 'COFFEE', posted: postedOn('2023-11-03') },
      { id: `NOOP-2-${account.id}`, amount: '-45.00', description: 'GROCER', posted: postedOn('2023-11-09') },
      { id: `NOOP-3-${account.id}`, amount: '2500.00', description: 'PAYROLL', posted: postedOn('2023-11-15') },
    ];
    expect(await sync(account.id, feed)).toMatchObject({ imported: 3 });
    const range = { dateFrom: '2023-11-01', dateTo: '2023-11-30', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(3);

    // The next sync: the same answer from the bank.
    expect(await sync(account.id, feed)).toMatchObject({ imported: 0, updated: 3 });
    const res = await startDelete(range, previewed, false);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ count: 3, totalExpenses: 57.34, totalIncome: 2500 });
  });

  it('refuses after a bank sync that changed an amount, and keeps the transactions', async () => {
    const account = await linkedAccount('Synced card');
    const feed: SimplefinTransaction[] = [
      { id: `TIP-1-${account.id}`, amount: '-30.00', description: 'RESTAURANT', posted: postedOn('2023-12-05') },
      { id: `TIP-2-${account.id}`, amount: '-8.00', description: 'PARKING', posted: postedOn('2023-12-06') },
    ];
    await sync(account.id, feed);
    const range = { dateFrom: '2023-12-01', dateTo: '2023-12-28', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    // The restaurant's charge posts with the tip: the row follows the bank's amount.
    await sync(account.id, [{ ...feed[0], amount: '-36.00' }, feed[1]]);
    const res = await startDelete(range, previewed, false);
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREVIEW_OUTDATED');
    const kept = await tenant.pool.query('SELECT amount FROM transactions WHERE account_id = $1 ORDER BY id', [account.id]);
    expect(kept.rows.map((r) => r.amount)).toEqual(['-36.00', '-8.00']);
  });

  // The fingerprint printed an annotation's resolved_at, a timestamptz, in the session's time
  // zone: the same rows gave another key on a connection set to another zone.
  it("names the same rows with the same key whatever the session's time zone", async () => {
    const x = await add('2023-07-10', -15);
    await tenant.pool.query(
      `INSERT INTO annotations (subject_type, subject_id, kind, body, status, resolved_at)
       VALUES ('transaction', $1, 'question', 'Which card?', 'resolved', '2023-07-11T23:30:00Z')`,
      [x]
    );
    const range = { dateFrom: '2023-07-01', dateTo: '2023-07-31', excludeBudgetPeriod: false };
    const keyIn = (zone: string) =>
      withTenant(tenant.tenantId, async () => {
        await sql`SELECT set_config('TimeZone', ${zone}, true)`.execute(getDb());
        await sql`SELECT set_config('DateStyle', ${zone === 'UTC' ? 'ISO, MDY' : 'SQL, DMY'}, true)`.execute(getDb());
        return selectionKeyNow(range);
      });
    const utc = await keyIn('UTC');
    expect(await keyIn('Asia/Kathmandu')).toBe(utc);
    expect(await keyIn('America/Los_Angeles')).toBe(utc);
    // And it's the key the preview answers (the app's connections are set to UTC).
    expect((await preview(range)).selectionKey).toBe(utc);
  });

  it.each(changesDuringBackup)('refuses, and keeps the split, after %s during the backup', async (_change, month, change) => {
    const rows = await split(`${month}-14`);
    const range = { dateFrom: `${month}-01`, dateTo: `${month}-28`, excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    vi.spyOn(BackupService.prototype, 'createBackup').mockImplementation(async () => {
      await change(rows);
      return { filePath: '/nowhere/changed.backup', fileName: 'changed.backup', fileSize: 0, sha256: null };
    });
    const res = await startDelete(range, previewed, true);

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREVIEW_OUTDATED');
    for (const id of [rows.parent, ...rows.splits]) expect(await exists(id), `row ${id}`).toBe(true);
  });

  it('refuses when a transaction it waited on was moved out of the range', async () => {
    const moved = await add('2025-05-10', -40);
    const stays = await add('2025-05-20', -41);
    const range = { dateFrom: '2025-05-01', dateTo: '2025-05-31', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    // Another member's edit, under way when Delete runs: it moves a transaction to July.
    const editor: PoolClient = await tenant.pool.connect();
    let deleting: ReturnType<typeof startDelete> | undefined;
    try {
      await editor.query('BEGIN');
      await editor.query(`UPDATE transactions SET transaction_date = '2025-07-15' WHERE id = $1`, [moved]);
      const editorPid = (await editor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;

      deleting = startDelete(range, previewed, false);
      // Delete waits on the edit's row lock; the edit commits while it does.
      await waitUntil(async () => {
        const { rows } = await tenant.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [editorPid]
        );
        return rows[0].n > 0;
      });
      await editor.query('COMMIT');
    } catch (err) {
      await editor.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      editor.release();
    }
    const res = await deleting!;

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.code).toBe('PREVIEW_OUTDATED');
    expect([await exists(moved), await exists(stays)]).toEqual([true, true]);
    const date = (await tenant.pool.query(`SELECT transaction_date::text AS day FROM transactions WHERE id = $1`, [moved])).rows[0].day;
    expect(date).toBe('2025-07-15');

    // A new preview finds only what's in the range now, and Delete deletes that.
    const again = await preview(range);
    expect(again.count).toBe(1);
    const deleted = await startDelete(range, again, false);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect([await exists(moved), await exists(stays)]).toEqual([true, false]);
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
