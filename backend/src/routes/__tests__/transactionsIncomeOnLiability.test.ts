import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { insertLegacyRow } from '../../test/legacyRows.js';

// An income on a liability account. The database refuses one
// (trigger_check_transaction_type_for_account, on every install),
// which the routes answered with a 500. Create, bulk create and edit refuse it first, with
// a reason and a code the UI can branch on (requires Postgres test DB).
describe('An income on a liability account', () => {
  const stamp = Date.now();
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let checking: { id: number; uuid: string };
  let card: { id: number; uuid: string };

  const insert = async (amount: number, type: string, accountId: number) =>
    (await pool.query<{ id: number; uuid: string }>(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, $2, '2026-10-20', $3, 'Fixture') RETURNING id, uuid`,
      [accountId, amount, type],
    )).rows[0];
  const incomesOn = async (accountId: number): Promise<number> =>
    (await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM transactions WHERE account_id = $1 AND type = 'income'`, [accountId],
    )).rows[0].n;

  beforeAll(async () => {
    tenant = await createTestTenant('Income on a liability account');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/accounts', createAccountsRoutes());

    checking = (await pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
      [`Income Checking ${stamp}`],
    )).rows[0];
    card = (await pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'credit_card', 'credit_cards', 'Liability') RETURNING id, uuid`,
      [`Income Card ${stamp}`],
    )).rows[0];
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('is refused on create with INCOME_ON_LIABILITY; an income on an asset and an expense on the card are created', async () => {
    const refused = await request(app).post('/api/transactions').send({
      account_uuid: card.uuid, amount: 25, transaction_date: '2026-10-20', type: 'income', description: 'Refund',
    }).expect(400);
    expect(refused.body.code).toBe('INCOME_ON_LIABILITY');
    expect(refused.body.error).toMatch(/liability account/);
    expect(refused.body.error).toMatch(/payment/);
    expect(await incomesOn(card.id)).toBe(0);

    await request(app).post('/api/transactions').send({
      account_uuid: checking.uuid, amount: 25, transaction_date: '2026-10-20', type: 'income',
    }).expect(201);
    await request(app).post('/api/transactions').send({
      account_uuid: card.uuid, amount: 25, transaction_date: '2026-10-20', type: 'expense',
    }).expect(201);
  });

  it.each([true, false])('fails that row of a bulk create (dry_run %s) with a reason, and keeps the others', async (dryRun) => {
    const res = await request(app).post('/api/transactions/bulk').send({
      dry_run: dryRun,
      transactions: [
        { account_uuid: card.uuid, amount: 40, transaction_date: '2026-10-21', type: 'income', external_transaction_id: `bulk-${dryRun}-1` },
        { account_uuid: card.uuid, amount: 40, transaction_date: '2026-10-21', type: 'expense', external_transaction_id: `bulk-${dryRun}-2` },
        { account_uuid: checking.uuid, amount: 40, transaction_date: '2026-10-21', type: 'income', external_transaction_id: `bulk-${dryRun}-3` },
      ],
    }).expect(dryRun ? 200 : 201);

    expect(res.body).toMatchObject({ dry_run: dryRun, total: 3, created: 2, skipped: 0, failed: 1 });
    expect(res.body.results[0]).toMatchObject({ index: 0, status: 'failed' });
    expect(res.body.results[0].reason).toMatch(/liability account/);
    expect(res.body.results.slice(1).map((r: { status: string }) => r.status)).toEqual(['created', 'created']);
    expect(await incomesOn(card.id)).toBe(0);
  });

  it('is refused on an edit that makes a transaction on the card an income', async () => {
    const charge = await insert(-30, 'expense', card.id);
    const refused = await request(app).put(`/api/transactions/${charge.uuid}`).send({ type: 'income' }).expect(400);
    expect(refused.body.code).toBe('INCOME_ON_LIABILITY');
    expect(refused.body.error).toMatch(/liability account/);
    // A whole-form save that changes the type is refused the same way.
    await request(app).put(`/api/transactions/${charge.uuid}`).send({ type: 'income', amount: 30, notes: 'n' }).expect(400);
    const row = (await pool.query('SELECT type, amount, notes FROM transactions WHERE id = $1', [charge.id])).rows[0];
    expect(row).toEqual({ type: 'expense', amount: '-30.00', notes: null });
  });

  it('saves an income on the card from before the rule when its type is sent back as it was', async () => {
    // Written as an install from before the rule has it: the trigger would refuse it now.
    const legacy = await insertLegacyRow<{ id: number; uuid: string }>(
      `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type, description)
       VALUES ($1, $2, 12, '2026-10-20', 'income', 'Fixture') RETURNING id, uuid`,
      [tenant.tenantId, card.id],
    );
    await request(app).put(`/api/transactions/${legacy.uuid}`).send({ type: 'income', amount: 12, notes: 'kept' }).expect(200);
    const row = (await pool.query('SELECT type, amount, notes FROM transactions WHERE id = $1', [legacy.id])).rows[0];
    expect(row).toEqual({ type: 'income', amount: '12.00', notes: 'kept' });
    // And it can become an expense, which is the fix.
    await request(app).put(`/api/transactions/${legacy.uuid}`).send({ type: 'expense' }).expect(200);
    expect((await pool.query('SELECT type FROM transactions WHERE id = $1', [legacy.id])).rows[0].type).toBe('expense');
  });

  // Splits take their parent's type and account: an income on the card from before the
  // rule can't be split as it is (the database refused the splits, a 500).
  it('refuses to split an income on the card from before the rule, saying to change its type first', async () => {
    const legacy = await insertLegacyRow<{ id: number; uuid: string }>(
      `INSERT INTO transactions (tenant_id, account_id, amount, transaction_date, type, description)
       VALUES ($1, $2, 20, '2026-10-22', 'income', 'Fixture') RETURNING id, uuid`,
      [tenant.tenantId, card.id],
    );
    const split = (sign: number) =>
      request(app).post(`/api/transactions/${legacy.uuid}/split`).send({ splits: [{ amount: 12 * sign }, { amount: 8 * sign }] });
    const refused = await split(1).expect(400);
    expect(refused.body.code).toBe('INCOME_ON_LIABILITY');
    expect(refused.body.error).toMatch(/liability account/);
    expect(refused.body.error).toMatch(/payment or an expense/);
    const row = (await pool.query('SELECT type, is_split_parent FROM transactions WHERE id = $1', [legacy.id])).rows[0];
    expect(row).toEqual({ type: 'income', is_split_parent: false });
    expect((await pool.query('SELECT 1 FROM transactions WHERE parent_transaction_id = $1', [legacy.id])).rowCount).toBe(0);

    // As an expense (its amount turns negative) it splits.
    await request(app).put(`/api/transactions/${legacy.uuid}`).send({ type: 'expense' }).expect(200);
    expect((await pool.query('SELECT amount FROM transactions WHERE id = $1', [legacy.id])).rows[0].amount).toBe('-20.00');
    await split(-1).expect(200);
    expect((await pool.query('SELECT 1 FROM transactions WHERE parent_transaction_id = $1', [legacy.id])).rowCount).toBe(2);
  });

  // Transaction Detail offers Income only on an asset account, as Add Transaction does: it
  // reads the account's type from the transaction (the list rows have it too), as
  // account_class: the account answers' account_type is accounts.account_type.
  it("answers the account's type with one transaction, as account_class", async () => {
    const onCard = await insert(-12, 'expense', card.id);
    const onChecking = await insert(-13, 'expense', checking.id);
    const cardAnswer = (await request(app).get(`/api/transactions/${onCard.uuid}`).expect(200)).body;
    expect(cardAnswer.account_class).toBe('Liability');
    expect(cardAnswer).not.toHaveProperty('account_type');
    expect((await request(app).get(`/api/transactions/${onChecking.uuid}`).expect(200)).body.account_class).toBe('Asset');

    // The list rows, and an account's transactions, the same.
    const listed = (await request(app).get('/api/transactions/paginated').query({ account_uuid: card.uuid, limit: 100 }).expect(200)).body.transactions;
    const row = listed.find((t: { uuid: string }) => t.uuid === onCard.uuid);
    expect(row).toMatchObject({ account_class: 'Liability' });
    expect(row).not.toHaveProperty('account_type');
    const registered = (await request(app).get(`/api/accounts/${card.uuid}/transactions`).query({ limit: 200 }).expect(200)).body.transactions;
    const entry = registered.find((t: { uuid: string }) => t.uuid === onCard.uuid);
    expect(entry).toMatchObject({ account_class: 'Liability' });
    expect(entry).not.toHaveProperty('account_type');
  });
});
