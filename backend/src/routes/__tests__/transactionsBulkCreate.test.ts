import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import AccountBalanceService from '../../services/AccountBalanceService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// POST /api/transactions/bulk — agent-driven statement backfill (requires
// Postgres test DB). Covers: multi-row create with correct signing, idempotent
// skip on duplicate (account, external_transaction_id), per-row failure
// reporting, and dry-run parity (same validation, nothing persisted).
describe('Transactions bulk create API', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let accountId: number;
  let accountUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Transactions bulk create API');
    pool = tenant.pool;
    app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    const acct = await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1,'checking','cash','Asset') RETURNING id, uuid`, [`Bulk Checking ${Date.now()}`]);
    accountId = acct.rows[0].id;
    accountUuid = acct.rows[0].uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('creates a batch with correct per-type signing and returns per-row uuids', async () => {
    const res = await request(app).post('/api/transactions/bulk').send({
      transactions: [
        { account_uuid: accountUuid, amount: 50, transaction_date: '2026-06-01', type: 'expense', description: 'Groceries', external_transaction_id: 'stmt-1:l1' },
        { account_uuid: accountUuid, amount: 2500, transaction_date: '2026-06-02', type: 'income', description: 'Paycheck', external_transaction_id: 'stmt-1:l2' },
        { account_uuid: accountUuid, amount: -75.25, transaction_date: '2026-06-03', type: 'balance adjustment', external_transaction_id: 'stmt-1:l3' },
      ],
    }).expect(201);

    expect(res.body).toMatchObject({ dry_run: false, total: 3, created: 3, skipped: 0, failed: 0 });
    expect(res.body.results).toHaveLength(3);
    for (const r of res.body.results) expect(r.transaction_uuid).toBeTruthy();

    const rows = await pool.query(
      `SELECT amount, type, external_transaction_id FROM transactions WHERE account_id = $1 ORDER BY transaction_date`,
      [accountId],
    );
    expect(Number(rows.rows[0].amount)).toBe(-50);      // expense force-negated
    expect(Number(rows.rows[1].amount)).toBe(2500);     // income positive
    expect(Number(rows.rows[2].amount)).toBe(-75.25);   // adjustment sign preserved
    expect(rows.rows[0].external_transaction_id).toBe('stmt-1:l1');
  });

  it('is idempotent: re-sending the same statement skips existing external ids', async () => {
    const res = await request(app).post('/api/transactions/bulk').send({
      transactions: [
        { account_uuid: accountUuid, amount: 50, transaction_date: '2026-06-01', type: 'expense', external_transaction_id: 'stmt-1:l1' },
        { account_uuid: accountUuid, amount: 10, transaction_date: '2026-06-04', type: 'expense', external_transaction_id: 'stmt-1:l4' },
      ],
    }).expect(201);

    expect(res.body).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    const skipped = res.body.results.find((r: { status: string }) => r.status === 'skipped');
    expect(skipped.index).toBe(0);
    expect(skipped.transaction_uuid).toBeTruthy();

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1 AND external_transaction_id = 'stmt-1:l1'`,
      [accountId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('skips a second row with the same external id in one request', async () => {
    const res = await request(app).post('/api/transactions/bulk').send({
      transactions: [
        { account_uuid: accountUuid, amount: 12, transaction_date: '2026-06-08', type: 'expense', external_transaction_id: 'stmt-2:l1' },
        { account_uuid: accountUuid, amount: 12, transaction_date: '2026-06-08', type: 'expense', external_transaction_id: 'stmt-2:l1' },
      ],
    }).expect(201);

    expect(res.body).toMatchObject({ created: 1, skipped: 1, failed: 0 });
    expect(res.body.results[1]).toMatchObject({ index: 1, status: 'skipped', reason: expect.stringContaining('earlier row') });
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1 AND external_transaction_id = 'stmt-2:l1'`,
      [accountId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  it('lets a later row use an external id whose earlier row failed', async () => {
    const res = await request(app).post('/api/transactions/bulk').send({
      transactions: [
        { account_uuid: accountUuid, amount: 7, transaction_date: '2026-06-08', type: 'expense', external_transaction_id: 'p1:x', merchant_uuid: '00000000-0000-0000-0000-000000000000' },
        { account_uuid: accountUuid, amount: 7, transaction_date: '2026-06-08', type: 'expense', external_transaction_id: 'p1:x' },
      ],
    }).expect(201);

    expect(res.body).toMatchObject({ created: 1, skipped: 0, failed: 1 });
    expect(res.body.results.map((r: { status: string }) => r.status)).toEqual(['failed', 'created']);
  });

  it('creates each row once when the same statement is sent twice at once', async () => {
    // Hold each request after its insert until both get there; give up waiting after a
    // while, since a request that waits for the other to commit never gets there.
    let arrived = 0;
    let open!: () => void;
    const bothInserted = new Promise<void>((resolve) => (open = resolve));
    const snapshot = AccountBalanceService.prototype.triggerNetWorthSnapshot;
    const spy = vi.spyOn(AccountBalanceService.prototype, 'triggerNetWorthSnapshot').mockImplementation(async function (
      this: AccountBalanceService
    ) {
      if (++arrived >= 2) open();
      await Promise.race([bothInserted, new Promise((resolve) => setTimeout(resolve, 1500))]);
      return snapshot.call(this);
    });
    try {
      const statement = {
        transactions: [1, 2, 3].map((line) => ({
          account_uuid: accountUuid, amount: line, transaction_date: '2026-06-09', type: 'expense', external_transaction_id: `stmt-3:l${line}`,
        })),
      };
      const [first, second] = await Promise.all([
        request(app).post('/api/transactions/bulk').send(statement),
        request(app).post('/api/transactions/bulk').send(statement),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);
      expect(first.body.created + second.body.created).toBe(3);
      expect(first.body.skipped + second.body.skipped).toBe(3);
    } finally {
      spy.mockRestore();
    }
    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1 AND external_transaction_id LIKE 'stmt-3:%'`,
      [accountId],
    );
    expect(count.rows[0].n).toBe(3);
  });

  it('reports unresolvable references per row without aborting the batch', async () => {
    const res = await request(app).post('/api/transactions/bulk').send({
      transactions: [
        { account_uuid: '00000000-0000-0000-0000-000000000000', amount: 5, transaction_date: '2026-06-05', type: 'expense' },
        { account_uuid: accountUuid, amount: 5, transaction_date: '2026-06-05', type: 'expense', merchant_uuid: '00000000-0000-0000-0000-000000000000' },
        { account_uuid: accountUuid, amount: 5, transaction_date: '2026-06-05', type: 'expense', external_transaction_id: 'stmt-1:l5' },
      ],
    }).expect(201);

    expect(res.body).toMatchObject({ created: 1, skipped: 0, failed: 2 });
    expect(res.body.results[0]).toMatchObject({ status: 'failed', reason: expect.stringContaining('account not found') });
    expect(res.body.results[1]).toMatchObject({ status: 'failed', reason: expect.stringContaining('merchant not found') });
    expect(res.body.results[2].status).toBe('created');
  });

  it('dry-run previews per-row results without persisting anything', async () => {
    const before = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1', [accountId]);
    const res = await request(app).post('/api/transactions/bulk').send({
      dry_run: true,
      transactions: [
        { account_uuid: accountUuid, amount: 99, transaction_date: '2026-06-06', type: 'expense', external_transaction_id: 'stmt-1:l6' },
        { account_uuid: accountUuid, amount: 50, transaction_date: '2026-06-01', type: 'expense', external_transaction_id: 'stmt-1:l1' },
      ],
    }).expect(200);

    expect(res.body).toMatchObject({ dry_run: true, created: 1, skipped: 1 });
    const after = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE account_id = $1', [accountId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('dry-run rejects exactly what the real write rejects (schema parity)', async () => {
    for (const dryRun of [true, false]) {
      await request(app).post('/api/transactions/bulk').send({
        dry_run: dryRun,
        transactions: [{ account_uuid: accountUuid, amount: 5, transaction_date: '2026-06-07', type: 'withdrawal' }],
      }).expect(400);
      await request(app).post('/api/transactions/bulk').send({
        dry_run: dryRun,
        transactions: [{ account_uuid: accountUuid, amount: 0, transaction_date: '2026-06-07', type: 'expense' }],
      }).expect(400);
    }
  });

  it('rejects an empty batch', async () => {
    await request(app).post('/api/transactions/bulk').send({ transactions: [] }).expect(400);
  });
});
