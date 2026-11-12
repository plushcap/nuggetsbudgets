import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A transaction (or an account's imported transactions) can only be assigned to someone
 * who can open the ledger. Before, any user id was accepted, and the ledger then
 * showed that user's full name, whichever organization they were in.
 */
describe('Assigning transactions', () => {
  const stamp = Date.now();
  let tenant: TestTenant;
  let other: TestTenant;
  let owner: Pool;
  let app: Express;
  let tx: { id: number; uuid: string };
  let account: { id: number; uuid: string };
  let orgAdminId: number;

  const assignedTo = async () =>
    (await tenant.pool.query('SELECT assigned_to FROM transactions WHERE id = $1', [tx.id])).rows[0].assigned_to;

  beforeAll(async () => {
    tenant = await createTestTenant('Assigning transactions');
    other = await createTestTenant('Assigning transactions, other organization');
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    // An admin of the ledger's organization, without a tenant_users row: they can open it.
    orgAdminId = (
      await owner.query(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Org', 'Admin') RETURNING id`,
        [`assignee-org-admin-${stamp}@example.com`]
      )
    ).rows[0].id;
    await owner.query('INSERT INTO organization_users (organization_id, user_id, is_admin) VALUES ($1, $2, true)', [
      tenant.organizationId,
      orgAdminId,
    ]);

    account = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
        [`Assignee account ${stamp}`]
      )
    ).rows[0];
    tx = (
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
         VALUES ($1, -12.34, '2026-10-20', 'expense', 'Coffee') RETURNING id, uuid`,
        [account.id]
      )
    ).rows[0];

    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.query('DELETE FROM organization_users WHERE user_id = $1', [orgAdminId]);
      await tenant.cleanup();
      await other.cleanup();
      await owner.query('DELETE FROM users WHERE id = $1', [orgAdminId]);
    } finally {
      await owner.end();
    }
  });

  it('assigns a member of the ledger, or an admin of its organization, and clears', async () => {
    await request(app).put(`/api/transactions/${tx.uuid}`).send({ assigned_to: tenant.userId }).expect(200);
    expect(await assignedTo()).toBe(tenant.userId);
    await request(app).put(`/api/transactions/${tx.uuid}`).send({ assigned_to: String(orgAdminId) }).expect(200);
    expect(await assignedTo()).toBe(orgAdminId);
    await request(app).put(`/api/transactions/${tx.uuid}`).send({ assigned_to: null }).expect(200);
    expect(await assignedTo()).toBeNull();
  });

  it.each([
    ['a user of another organization', () => other.userId],
    ['a user id that does not exist', () => 2147483000],
    ['an id larger than the users.id column holds', () => 2147483648],
    ['zero', () => 0],
    ['a non-numeric value', () => 'abc'],
  ])('refuses %s, on one transaction and in bulk', async (_label, value) => {
    const one = await request(app).put(`/api/transactions/${tx.uuid}`).send({ assigned_to: value() }).expect(400);
    expect(one.body.code).toBe('INVALID_ASSIGNEE');
    const bulk = await request(app)
      .put('/api/transactions/bulk')
      .send({ transactionUuids: [tx.uuid], updates: { assigned_to: value() } })
      .expect(400);
    expect(bulk.body.code).toBe('INVALID_ASSIGNEE');
    expect(await assignedTo()).toBeNull();
  });

  it("limits an account's default assignee for imports the same way", async () => {
    const setting = async () =>
      (await tenant.pool.query('SELECT import_default_assigned_to FROM accounts WHERE id = $1', [account.id])).rows[0]
        .import_default_assigned_to;
    await request(app).patch(`/api/accounts/${account.uuid}/import-settings`).send({ import_default_assigned_to: tenant.userId }).expect(200);
    expect(await setting()).toBe(tenant.userId);
    const res = await request(app)
      .patch(`/api/accounts/${account.uuid}/import-settings`)
      .send({ import_default_assigned_to: other.userId })
      .expect(400);
    expect(res.body.code).toBe('INVALID_ASSIGNEE');
    expect(await setting()).toBe(tenant.userId);
  });
});
