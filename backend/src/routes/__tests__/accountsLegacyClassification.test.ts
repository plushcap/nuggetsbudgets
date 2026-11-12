import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { insertLegacyRow } from '../../test/legacyRows.js';
import { accountListResponseSchema, accountResponseSchema, answerProblem } from '@nuggets/shared';

// An account saved before today's classification enums can hold another value
// (account_group 'Banking', account_type 'Checking'). The edit form shows it as
// "(legacy value)"; saving the account with it unchanged must work, while any other
// value outside the enums is still refused.
describe('PUT /api/accounts/:uuid with a legacy classification', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  const stamp = Date.now();
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Account legacy classification');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  // The database takes only today's values for a new account, so an account from
  // before them is written as an older install has it.
  const createAccount = async (accountType: string, accountGroup: string, type: string | null) => {
    const name = `Legacy ${stamp}-${++n}`;
    const r = await insertLegacyRow<{ id: number; uuid: string }>(
      `INSERT INTO accounts (tenant_id, name, account_type, account_group, type)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, uuid`,
      [tenant.tenantId, name, accountType, accountGroup, type],
    );
    return { id: r.id, uuid: r.uuid, name };
  };

  const stored = async (id: number) =>
    (await pool.query('SELECT name, type, account_type, account_group FROM accounts WHERE id = $1', [id])).rows[0];

  it('saves an account whose legacy classification is unchanged, as the edit form sends it', async () => {
    const acct = await createAccount('Checking', 'Banking', 'Asset');

    // The edit form's multipart body.
    await request(app)
      .put(`/api/accounts/${acct.uuid}`)
      .field('name', `${acct.name} renamed`)
      .field('type', 'Asset')
      .field('account_type', 'Checking')
      .field('account_group', 'Banking')
      .field('icon', 'CreditCard')
      .field('is_active', 'true')
      .field('hide_transactions', 'false')
      .field('hide_account', 'false')
      .field('exclude_account_balance', 'false')
      .field('is_envelope_account', 'false')
      .field('require_zero_balance', 'false')
      .field('default_pay_from_account_id', '')
      .expect(200);

    expect(await stored(acct.id)).toEqual({
      name: `${acct.name} renamed`,
      type: 'Asset',
      account_type: 'Checking',
      account_group: 'Banking',
    });
  });

  it('keeps a legacy category (type) that is unchanged', async () => {
    const acct = await createAccount('checking', 'cash', 'asset');
    await request(app)
      .put(`/api/accounts/${acct.uuid}`)
      .send({ name: acct.name, type: 'asset', account_type: 'checking', account_group: 'cash' })
      .expect(200);
    expect((await stored(acct.id)).type).toBe('asset');
  });

  it('lets a legacy value be replaced by one of today’s values', async () => {
    const acct = await createAccount('Checking', 'Banking', 'Asset');
    await request(app)
      .put(`/api/accounts/${acct.uuid}`)
      .send({ name: acct.name, type: 'Asset', account_type: 'checking', account_group: 'cash' })
      .expect(200);
    expect(await stored(acct.id)).toMatchObject({ account_type: 'checking', account_group: 'cash' });
  });

  it('refuses any other value outside the enums, legacy account or not', async () => {
    const legacy = await createAccount('Checking', 'Banking', 'Asset');
    const res = await request(app)
      .put(`/api/accounts/${legacy.uuid}`)
      .send({ name: legacy.name, type: 'Asset', account_type: 'Checking', account_group: 'Brokerage' })
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['account_group']);
    expect((await stored(legacy.id)).account_group).toBe('Banking');

    // A value another account holds is no exception: only this row's stored value is.
    const current = await createAccount('checking', 'cash', 'Asset');
    await request(app)
      .put(`/api/accounts/${current.uuid}`)
      .send({ name: current.name, type: 'Asset', account_type: 'Checking', account_group: 'Banking' })
      .expect(400);
    expect(await stored(current.id)).toMatchObject({ account_type: 'checking', account_group: 'cash' });
  });

  // The strict answer schema refused '' (storedValue), so these answers failed their
  // contract; '' now reads as no class (null), as the page shows an account saved without one.
  it("answers an account saved with type '' within its schema, reading the type as none", async () => {
    const acct = await createAccount('savings', 'cash', '');
    const list = await request(app).get('/api/accounts').expect(200);
    expect(answerProblem(accountListResponseSchema, list.body)).toBeNull();
    expect(accountListResponseSchema.parse(list.body).accounts.find((a) => a.uuid === acct.uuid)?.type).toBeNull();
    const one = await request(app).get(`/api/accounts/${acct.uuid}`).expect(200);
    expect(answerProblem(accountResponseSchema, one.body)).toBeNull();
    expect(accountResponseSchema.parse(one.body).type).toBeNull();
  });

  it('answers 404 for an account that does not exist', async () => {
    await request(app)
      .put('/api/accounts/00000000-0000-7000-8000-000000000000')
      .send({ name: 'x', type: 'Asset', account_type: 'checking', account_group: 'cash' })
      .expect(404);
  });
});
