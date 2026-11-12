import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The account rules the other account suites leave out: one envelope account,
 * the legacy 'other' group's mapping, the instructions endpoint, reading one account,
 * and deleting an account that has only its opening balance.
 */
describe('Account routes: envelope, classification, instructions, read and delete', () => {
  let app: Express;
  let tenant: TestTenant;
  let n = 0;

  const create = async (body: object = {}) => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ name: `Rules account ${++n}`, account_type: 'checking', account_group: 'cash', type: 'Asset', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: number; uuid: string; name: string };
  };
  const MISSING = '00000000-0000-7000-8000-000000000000';

  beforeAll(async () => {
    tenant = await createTestTenant('Account service rules');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('keeps one envelope account: a new one, or one edited into it, clears the flag on the other', async () => {
    const first = await create({ is_envelope_account: true });
    const second = await create({ is_envelope_account: true });
    const flags = async () =>
      (await tenant.pool.query<{ uuid: string }>('SELECT uuid FROM accounts WHERE is_envelope_account ORDER BY id')).rows.map((r) => r.uuid);
    expect(await flags()).toEqual([second.uuid]);

    const edited = await request(app)
      .put(`/api/accounts/${first.uuid}`)
      .send({ name: first.name, account_type: 'checking', account_group: 'cash', is_envelope_account: true });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(await flags()).toEqual([first.uuid]);
  });

  it("saves the legacy group 'other' as the group its type belongs in", async () => {
    const account = await create();
    const groupFor = async (account_type: string) => {
      const res = await request(app)
        .put(`/api/accounts/${account.uuid}`)
        .send({ name: account.name, account_type, account_group: 'other' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body.account_group;
    };
    expect(await groupFor('credit_card')).toBe('credit_cards');
    expect(await groupFor('savings')).toBe('cash');
    expect(await groupFor('investment')).toBe('investments');
  });

  it('sets only the instructions, or clears them, and refuses anything but a string or null', async () => {
    const account = await create({ notes: 'kept' });
    const set = await request(app).put(`/api/accounts/${account.uuid}/instructions`).send({ instructions: 'Pay in full' });
    expect(set.status).toBe(200);
    expect(Object.keys(set.body).sort()).toEqual(['id', 'instructions', 'name', 'updated_at', 'uuid']);
    expect(set.body.instructions).toBe('Pay in full');

    // Checked with the shared schema (validateBody), as every body is: 400 VALIDATION_ERROR naming the field.
    for (const body of [{ instructions: 5 }, {}, { instructions: ['Pay in full'] }]) {
      const refused = await request(app).put(`/api/accounts/${account.uuid}/instructions`).send(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(refused.body).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'instructions must be text, or null to clear them',
        details: [{ field: 'instructions', message: 'instructions must be text, or null to clear them' }],
      });
    }
    expect((await tenant.pool.query('SELECT instructions FROM accounts WHERE id = $1', [account.id])).rows[0].instructions).toBe('Pay in full');

    expect((await request(app).put(`/api/accounts/${account.uuid}/instructions`).send({ instructions: null })).body.instructions).toBeNull();
    const row = (await tenant.pool.query('SELECT notes, instructions FROM accounts WHERE id = $1', [account.id])).rows[0];
    expect(row).toEqual({ notes: 'kept', instructions: null });

    expect((await request(app).put(`/api/accounts/${MISSING}/instructions`).send({ instructions: 'x' })).status).toBe(404);
  });

  it('reads one account with its institution columns and balance, and without the retired nuggets_balance', async () => {
    const account = await create({ initial_balance: 12.34 });
    const res = await request(app).get(`/api/accounts/${account.uuid}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ uuid: account.uuid, calculated_balance: 12.34, balance_unavailable: false, institution_balance: 0, institution_id: null });
    expect(res.body).not.toHaveProperty('nuggets_balance');

    const missing = await request(app).get(`/api/accounts/${MISSING}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Account not found');
  });

  it('deletes an account that has only its opening balance, with the opening balance', async () => {
    const account = await create({ initial_balance: 5 });
    const res = await request(app).delete(`/api/accounts/${account.uuid}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      message: 'Account deleted successfully',
      details: `Account "${account.name}" and all associated records have been permanently deleted.`,
    });
    const left = await tenant.pool.query('SELECT 1 FROM transactions WHERE account_id = $1 UNION ALL SELECT 1 FROM accounts WHERE id = $1', [account.id]);
    expect(left.rowCount).toBe(0);
    expect((await request(app).delete(`/api/accounts/${account.uuid}`)).status).toBe(404);
  });
});
