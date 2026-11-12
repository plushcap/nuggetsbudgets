import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool, type PoolClient } from 'pg';
import { sql } from 'kysely';
import pool from '../../db.js';
import { getDb, withTenant } from '../../db/withTenant.js';
import { BudgetService } from '../../services/BudgetService.js';
import { BudgetItemMatcher } from '../../services/BudgetItemMatcher.js';
import { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { MerchantMatcher } from '../../services/import/MerchantMatcher.js';
import { TransactionImporter } from '../../services/import/TransactionImporter.js';
import type { SimplefinTransaction } from '../../services/import/types.js';
import { createDataManagementRoutes } from '../data-management.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { BackupService } from '../../services/BackupService.js';

/**
 * Delete Transactions against the writes that lock the same rows.
 * Delete locks its rows in id order; a write that took the same rows in another order
 * (unsplit: the splits, then the parent; a transfer edit: one side, then the other) could
 * hold one Delete waits for while it waits for one Delete holds. Postgres then fails one of
 * them (40P01), and Delete answered 500. Every write now locks in id order, so each race
 * below ends with one of them waiting for the other: Delete answers 200 or 409, never 500,
 * and nothing is half-deleted. A deadlock that happens anyway (a write outside the app) is
 * answered 409 DELETION_CONFLICT, with nothing deleted.
 *
 * Each race is set up from other connections: a third one holds a lock that stops the write
 * (or Delete) part-way, so the two meet in the order that deadlocked.
 */
describe('delete-transactions against writes that lock the same rows', () => {
  let app: Express;
  let tenant: TestTenant;
  let checking: { id: number; uuid: string };
  let savings: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Delete transactions deadlocks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/transfer', createTransferRoutes());
    const account = async (name: string) =>
      (
        await tenant.pool.query<{ id: number; uuid: string }>(
          `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
          [name]
        )
      ).rows[0];
    checking = await account('Deadlock checking');
    savings = await account('Deadlock savings');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const exists = async (id: number) => (await tenant.pool.query('SELECT 1 FROM transactions WHERE id = $1', [id])).rowCount === 1;

  /** A -20.00 expense split into two -10.00 splits through the split route; the first split carries a tag. */
  const tagged = async (date: string) => {
    const parent = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -20, $2, 'expense', 'Deadlock fixture') RETURNING id, uuid`,
        [checking.id, date]
      )
    ).rows[0];
    const res = await request(app).post(`/api/transactions/${parent.uuid}/split`).send({ splits: [{ amount: -10 }, { amount: -10 }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const splits = (await tenant.pool.query<{ id: number }>('SELECT id FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [parent.id])).rows.map((r) => r.id);
    const tag = (await tenant.pool.query<{ id: number }>(`INSERT INTO tags (name) VALUES ($1) RETURNING id`, [`Deadlock ${date}`])).rows[0].id;
    const tagging = (
      await tenant.pool.query<{ id: number }>(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2) RETURNING id`, [tag, splits[0]])
    ).rows[0].id;
    return { parent, splits, tagging };
  };

  /** A transfer from checking to savings through the transfer route; its two sides by id. */
  const transfer = async (date: string, amount = 75) => {
    const res = await request(app).post('/api/transfer').send({
      source_account_uuid: checking.uuid,
      destination_account_uuid: savings.uuid,
      amount,
      transaction_date: date,
      type: 'transfer',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const sides = (
      await tenant.pool.query<{ id: number; uuid: string; amount: string }>(
        'SELECT id, uuid, amount FROM transactions WHERE uuid = ANY($1::uuid[]) ORDER BY id',
        [[res.body.source_transaction_uuid, res.body.destination_transaction_uuid]]
      )
    ).rows;
    return { lower: sides[0], higher: sides[1] };
  };

  const preview = async (range: object) => {
    const res = await request(app).post('/api/data-management/preview-delete-transactions').send(range);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { count: number; selectionKey: string };
  };

  const startDelete = (range: object, previewed: { selectionKey: string }) =>
    request(app)
      .post('/api/data-management/delete-transactions')
      .send({ ...range, createBackup: false, selectionKey: previewed.selectionKey })
      .then((res) => res);

  /** Another connection, holding a transaction open until `release()`. */
  const holder = async () => {
    const client: PoolClient = await tenant.pool.connect();
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    return {
      client,
      pid,
      release: async () => {
        await client.query('COMMIT').catch(() => client.query('ROLLBACK'));
        client.release();
      },
    };
  };

  /** The backend that waits for `pid`, once there is one (excluding `others`). */
  const waiterOf = async (pid: number, others: number[] = []): Promise<number> => {
    let found: number | undefined;
    await waitUntil(async () => {
      const { rows } = await tenant.pool.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid)) AND NOT (pid = ANY($2::int[]))',
        [pid, others]
      );
      found = rows[0]?.pid;
      return found !== undefined;
    });
    return found!;
  };

  it('unsplit: the two wait for each other at the parent, never deadlock', async () => {
    const { parent, splits, tagging } = await tagged('2023-03-14');
    const range = { dateFrom: '2023-03-01', dateTo: '2023-03-31', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    // A tag of the first split is held: unsplit stops as it deletes the splits (its trigger
    // deletes their taggings), after it has locked them.
    const gate = await holder();
    let unsplitting: Promise<request.Response> | undefined;
    let deleting: Promise<request.Response> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM taggings WHERE id = $1 FOR UPDATE', [tagging]);
      unsplitting = request(app).delete(`/api/transactions/${parent.uuid}/unsplit`).then((res) => res);
      const unsplitPid = await waiterOf(gate.pid);
      // Delete starts, and waits for unsplit: at the parent now, at a split before (holding
      // the parent, which unsplit then waited for).
      deleting = startDelete(range, previewed);
      await waiterOf(unsplitPid, [gate.pid]);
    } finally {
      await gate.release();
    }
    const [unsplit, deleted] = await Promise.all([unsplitting!, deleting!]);

    expect(unsplit.status, JSON.stringify(unsplit.body)).toBe(200);
    // Delete went second, and found the transaction unsplit since its preview.
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.code).toBe('PREVIEW_OUTDATED');
    expect(await exists(parent.id)).toBe(true);
    for (const id of splits) expect(await exists(id), `split ${id}`).toBe(false);
    const row = (await tenant.pool.query('SELECT is_split_parent FROM transactions WHERE id = $1', [parent.id])).rows[0];
    expect(row.is_split_parent).toBe(false);
  });

  it('re-split: the two wait for each other at the parent, never deadlock', async () => {
    const { parent, splits, tagging } = await tagged('2023-04-14');
    const range = { dateFrom: '2023-04-01', dateTo: '2023-04-30', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    const gate = await holder();
    let resplitting: Promise<request.Response> | undefined;
    let deleting: Promise<request.Response> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM taggings WHERE id = $1 FOR UPDATE', [tagging]);
      resplitting = request(app)
        .post(`/api/transactions/${parent.uuid}/split`)
        .send({ splits: [{ amount: -15 }, { amount: -5 }] })
        .then((res) => res);
      const resplitPid = await waiterOf(gate.pid);
      deleting = startDelete(range, previewed);
      await waiterOf(resplitPid, [gate.pid]);
    } finally {
      await gate.release();
    }
    const [resplit, deleted] = await Promise.all([resplitting!, deleting!]);

    expect(resplit.status, JSON.stringify(resplit.body)).toBe(200);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.code).toBe('PREVIEW_OUTDATED');
    expect(await exists(parent.id)).toBe(true);
    for (const id of splits) expect(await exists(id), `old split ${id}`).toBe(false);
    const now = await tenant.pool.query('SELECT amount FROM transactions WHERE parent_transaction_id = $1 ORDER BY id', [parent.id]);
    expect(now.rows.map((r) => r.amount)).toEqual(['-15.00', '-5.00']);
  });

  /**
   * A write of both sides of a transfer, racing Delete: a third connection holds the lower
   * side, so Delete waits there first, then `write` starts. Locking the higher side first, the
   * write held it while it waited for the lower, which Delete then held while it waited for
   * the higher.
   */
  const raceOnTransfer = async (date: string, write: (sides: Awaited<ReturnType<typeof transfer>>) => Promise<request.Response>) => {
    const sides = await transfer(date);
    // The lower side is written again (a note), so a scan of the table meets the higher one first.
    await tenant.pool.query(`UPDATE transactions SET notes = 'Rewritten' WHERE id = $1`, [sides.lower.id]);
    const month = date.slice(0, 7);
    const range = { dateFrom: `${month}-01`, dateTo: `${month}-28`, excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    const gate = await holder();
    let writing: Promise<request.Response> | undefined;
    let deleting: Promise<request.Response> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM transactions WHERE id = $1 FOR SHARE', [sides.lower.id]);
      deleting = startDelete(range, previewed);
      const deletePid = await waiterOf(gate.pid);
      writing = write(sides);
      // The write waits too: for the lower side, behind Delete.
      await waiterOf(deletePid, [gate.pid]);
    } finally {
      await gate.release();
    }
    const [written, deleted] = await Promise.all([writing!, deleting!]);
    return { sides, written, deleted };
  };

  it('a transfer edit of the higher side waits for Delete at the lower side', async () => {
    const { sides, written, deleted } = await raceOnTransfer('2023-05-10', ({ higher }) =>
      request(app).put(`/api/transactions/${higher.uuid}`).send({ amount: 80 }).then((res) => res)
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.count).toBe(2);
    // Delete went first: the edit finds the transfer gone.
    expect(written.status, JSON.stringify(written.body)).toBe(404);
    expect([await exists(sides.lower.id), await exists(sides.higher.id)]).toEqual([false, false]);
  });

  it('deleting one side of a transfer (both go) waits for Delete at the lower side', async () => {
    const { sides, written, deleted } = await raceOnTransfer('2023-06-10', ({ higher }) =>
      request(app).delete(`/api/transactions/${higher.uuid}`).then((res) => res)
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(written.status, JSON.stringify(written.body)).toBe(404);
    expect([await exists(sides.lower.id), await exists(sides.higher.id)]).toEqual([false, false]);
  });

  it('a bulk edit of both sides waits for Delete at the lower side', async () => {
    const { sides, written, deleted } = await raceOnTransfer('2023-07-10', ({ lower, higher }) =>
      request(app)
        .put('/api/transactions/bulk')
        .send({ transactionUuids: [higher.uuid, lower.uuid], updates: { review_status: 'flagged' } })
        .then((res) => res)
    );
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    // Its rows were looked up before Delete committed, and were gone when it wrote.
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body.updated).toBe(0);
    expect([await exists(sides.lower.id), await exists(sides.higher.id)]).toEqual([false, false]);
  });

  it('a bulk edit of a split and a later transaction waits for Delete, which locks splits in id order too', async () => {
    // Delete locked the parents first and their splits after, so a write of a split and of a
    // transaction with a higher id, in id order, could hold the split while Delete held the other.
    const { parent, splits } = await tagged('2023-09-14');
    const later = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -30, '2023-09-20', 'expense', 'Later') RETURNING id, uuid`,
        [checking.id]
      )
    ).rows[0];
    const split = (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM transactions WHERE id = $1', [splits[0]])).rows[0];
    const range = { dateFrom: '2023-09-01', dateTo: '2023-09-28', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    const gate = await holder();
    let writing: Promise<request.Response> | undefined;
    let deleting: Promise<request.Response> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM transactions WHERE id = $1 FOR SHARE', [later.id]);
      deleting = startDelete(range, previewed);
      const deletePid = await waiterOf(gate.pid);
      writing = request(app)
        .put('/api/transactions/bulk')
        .send({ transactionUuids: [later.uuid, split.uuid], updates: { review_status: 'flagged' } })
        .then((res) => res);
      await waiterOf(deletePid, [gate.pid]);
    } finally {
      await gate.release();
    }
    const [written, deleted] = await Promise.all([writing!, deleting!]);

    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.count).toBe(2);
    expect(written.status, JSON.stringify(written.body)).toBe(200);
    expect(written.body.updated).toBe(0);
    for (const id of [parent.id, ...splits, later.id]) expect(await exists(id), `row ${id}`).toBe(false);
  });

  /** A bank account linked to SimpleFin (budget auto-assignment off, so syncs are deterministic). */
  const linkedAccount = async (label: string) => {
    const importId = `SF-deadlock-${label}-${Date.now()}`;
    const id = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type, import_account_id, import_provider, import_enabled,
                               import_auto_assign_budget_period, import_auto_assign_budget_item)
         VALUES ($1, 'checking', 'cash', 'Asset', $2, 'simplefin', true, false, false) RETURNING id`,
        [`Synced ${label}`, importId]
      )
    ).rows[0].id;
    return { id, importId };
  };
  const importer = () => {
    const periods = new BudgetPeriodResolver(new BudgetService());
    return { periods, importer: new TransactionImporter(periods, new MerchantMatcher(periods.savepoint), new BudgetItemMatcher()) };
  };
  /** One sync of `feed`, in its own transaction, as a sync runs. */
  const sync = (accountId: number, feed: SimplefinTransaction[]) => {
    const { importer: run } = importer();
    return withTenant(tenant.tenantId, () => run.importTransactions(accountId, feed));
  };
  /** Noon UTC on `day`, as SimpleFin dates a posted transaction. */
  const postedOn = (day: string) => Date.parse(`${day}T12:00:00Z`) / 1000;

  /**
   * A sync of `feed`, in its own transaction, paused at the step (each runs in a savepoint)
   * after the one that wrote its first row. Answers its backend's pid, to see who waits for
   * it, and `resume`.
   */
  const pausedSync = async (accountId: number, feed: SimplefinTransaction[]) => {
    const next = importer();
    const original = next.periods.savepoint;
    let pausedOnce = false;
    let pid = 0;
    let paused!: () => void;
    let resume!: () => void;
    const atPause = new Promise<void>((resolve) => (paused = resolve));
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    vi.spyOn(next.periods, 'savepoint').mockImplementation((async (fn: () => Promise<unknown>) => {
      if (!pausedOnce) {
        // Rows this sync has written: stamped with its transaction's time.
        const written = (
          await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM transactions WHERE account_id = ${accountId} AND import_imported_at = CURRENT_TIMESTAMP
          `.execute(getDb())
        ).rows[0].n;
        if (written === 1) {
          pausedOnce = true;
          pid = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0].pid;
          paused();
          await resumed;
        }
      }
      return original(fn);
    }) as typeof original);
    const syncing = withTenant(tenant.tenantId, () => next.importer.importTransactions(accountId, feed));
    await atPause;
    return { pid, resume, syncing };
  };

  /**
   * A bank sync of an account whose two transactions the bank sends higher id first, paused
   * after it has written the first. It updated each row as it came to it, in the bank's
   * order; it now locks the rows it will write first, in id order.
   */
  const pausedResync = async (month: string) => {
    const account = await linkedAccount(month);
    const feed: SimplefinTransaction[] = [
      { id: `${account.importId}-1`, amount: '-11.00', description: 'FIRST', posted: postedOn(`${month}-05`) },
      { id: `${account.importId}-2`, amount: '-22.00', description: 'SECOND', posted: postedOn(`${month}-06`) },
    ];
    expect(await sync(account.id, feed)).toMatchObject({ imported: 2 });
    const [lower, higher] = (
      await tenant.pool.query<{ id: number; uuid: string }>('SELECT id, uuid FROM transactions WHERE account_id = $1 ORDER BY id', [account.id])
    ).rows;
    // The next sync, with the bank's answer the other way round.
    const { pid, resume, syncing } = await pausedSync(account.id, [feed[1], feed[0]]);
    return { lower, higher, pid, resume, syncing };
  };

  it('a bank sync locks the rows it writes in id order, so Delete waits for it', async () => {
    const { lower, higher, pid, resume, syncing } = await pausedResync('2023-10');
    const range = { dateFrom: '2023-10-01', dateTo: '2023-10-28', excludeBudgetPeriod: false };
    try {
      const previewed = await preview(range);
      expect(previewed.count).toBe(2);
      const deleting = startDelete(range, previewed);
      // Delete waits for the sync: at the lower row now; at the higher before, holding the lower.
      await waiterOf(pid);
      resume();
      const [synced, deleted] = await Promise.all([syncing, deleting]);
      expect(synced).toMatchObject({ updated: 2, failed: 0 });
      // The sync changed nothing, so Delete deletes what its preview found.
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body.count).toBe(2);
      expect([await exists(lower.id), await exists(higher.id)]).toEqual([false, false]);
    } finally {
      resume();
      await syncing.catch(() => undefined);
    }
  });

  it('a bank sync and a bulk edit of the same rows wait for each other', async () => {
    const { lower, higher, pid, resume, syncing } = await pausedResync('2023-11');
    try {
      const writing = request(app)
        .put('/api/transactions/bulk')
        .send({ transactionUuids: [lower.uuid, higher.uuid], updates: { review_status: 'flagged' } })
        .then((res) => res);
      await waiterOf(pid);
      resume();
      const [synced, written] = await Promise.all([syncing, writing]);
      expect(synced).toMatchObject({ updated: 2, failed: 0 });
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      expect(written.body.updated).toBe(2);
    } finally {
      resume();
      await syncing.catch(() => undefined);
    }
  });

  /**
   * A sync that links a new import to a manual entry: M (-50.00, entered by hand, the lower
   * id) and P1 (imported, the higher). The next sync's answer is [P1, N], N (-50.00) being
   * M at the bank. Paused after it has written P1, it then updates M, which its lock before
   * the loop left out.
   */
  const pausedManualLink = async (month: string) => {
    const account = await linkedAccount(`manual-${month}`);
    const manual = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, status, description)
         VALUES ($1, -50, $2, 'expense', 'cleared', 'Electrician, by hand') RETURNING id, uuid`,
        [account.id, `${month}-10`]
      )
    ).rows[0];
    const p1: SimplefinTransaction = { id: `${account.importId}-P1`, amount: '-20.00', description: 'PHARMACY', posted: postedOn(`${month}-11`) };
    const n: SimplefinTransaction = { id: `${account.importId}-N`, amount: '-50.00', description: 'ELECTRICIAN', posted: postedOn(`${month}-12`) };
    expect(await sync(account.id, [p1])).toMatchObject({ imported: 1 });
    const imported = (
      await tenant.pool.query<{ id: number; uuid: string }>('SELECT id, uuid FROM transactions WHERE account_id = $1 AND id <> $2', [account.id, manual.id])
    ).rows[0];
    expect(manual.id).toBeLessThan(imported.id);
    return { account, manual, imported, start: () => pausedSync(account.id, [p1, n]) };
  };
  const linkedTo = async (id: number) =>
    (await tenant.pool.query('SELECT import_transaction_id FROM transactions WHERE id = $1', [id])).rows[0]?.import_transaction_id;

  it('a bank sync locks the manual entry it links an import to with the rest, so Delete waits for it', async () => {
    const { account, manual, imported, start } = await pausedManualLink('2023-06');
    const range = { dateFrom: '2023-06-01', dateTo: '2023-06-28', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);
    const { pid, resume, syncing } = await start();
    try {
      const deleting = startDelete(range, previewed);
      await waiterOf(pid);
      resume();
      const [synced, deleted] = await Promise.all([syncing, deleting]);
      // N was linked to M, not added beside it.
      expect(synced).toMatchObject({ imported: 0, updated: 2, failed: 0 });
      // The link changed none of M's content (it was cleared already), so Delete deletes both.
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
      expect(deleted.body.count).toBe(2);
      expect([await exists(manual.id), await exists(imported.id)]).toEqual([false, false]);
      expect((await tenant.pool.query('SELECT 1 FROM transactions WHERE account_id = $1', [account.id])).rowCount).toBe(0);
    } finally {
      resume();
      await syncing.catch(() => undefined);
    }
  });

  it('a bank sync that links a manual entry and a bulk edit of it wait for each other', async () => {
    const { manual, imported, start } = await pausedManualLink('2023-05');
    const { pid, resume, syncing } = await start();
    try {
      const writing = request(app)
        .put('/api/transactions/bulk')
        .send({ transactionUuids: [manual.uuid, imported.uuid], updates: { review_status: 'flagged' } })
        .then((res) => res);
      await waiterOf(pid);
      resume();
      const [synced, written] = await Promise.all([syncing, writing]);
      expect(synced).toMatchObject({ imported: 0, updated: 2, failed: 0 });
      expect(await linkedTo(manual.id)).toMatch(/-N$/);
      expect(written.status, JSON.stringify(written.body)).toBe(200);
      expect(written.body.updated).toBe(2);
    } finally {
      resume();
      await syncing.catch(() => undefined);
    }
  });

  it('answers a deadlock 409 DELETION_CONFLICT, with nothing deleted', async () => {
    const { lower, higher } = await transfer('2023-08-10');
    const range = { dateFrom: '2023-08-01', dateTo: '2023-08-28', excludeBudgetPeriod: false };
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);

    // A write outside the app (a script, as the database owner) that takes the higher side,
    // then the lower: Delete holds the lower and waits for the higher, so Postgres fails one
    // of them. The one that notices first does, after deadlock_timeout: Delete (1 s), as the
    // script waits 10 s before it looks.
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    const other = await owner.connect();
    let deleted: request.Response;
    try {
      await other.query('BEGIN');
      await other.query(`SET LOCAL deadlock_timeout = '10s'`);
      const otherPid = (await other.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await other.query(`UPDATE transactions SET notes = 'Other side first' WHERE id = $1`, [higher.id]);
      const deleting = startDelete(range, previewed);
      await waiterOf(otherPid);
      const lowerWrite = other.query(`UPDATE transactions SET notes = 'Other side first' WHERE id = $1`, [lower.id]);
      deleted = await deleting;
      await lowerWrite;
      await other.query('COMMIT');
    } catch (err) {
      await other.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      other.release();
      await owner.end();
    }

    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.code).toBe('DELETION_CONFLICT');
    expect(deleted.body.error).toMatch(/nothing was deleted.*try again/i);
    expect([await exists(lower.id), await exists(higher.id)]).toEqual([true, true]);

    // Tried again, with a new preview (the other write changed both sides), it deletes them.
    const again = await preview(range);
    const retried = await startDelete(range, again);
    expect(retried.status, JSON.stringify(retried.body)).toBe(200);
    expect([await exists(lower.id), await exists(higher.id)]).toEqual([false, false]);
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
