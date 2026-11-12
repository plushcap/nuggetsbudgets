import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A split's budget item and period named by uuid. Text that isn't a uuid failed the
 * lookup, a 500; a uuid of no row, or of another ledger's, was dropped and the split saved
 * without its item or period, 200. Now the first is refused by the body's schema, 400
 * VALIDATION_ERROR, and the second by the service, 400 INVALID_REFERENCE naming the field;
 * either way nothing is split. Empty or null is none.
 */
describe("A split's budget item and period uuids", () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let accountId: number;
  const own = { item: { id: 0, uuid: '' }, period: { id: 0, uuid: '' } };
  const theirs = { item: '', period: '' };
  let n = 0;

  const period = (t: TestTenant) =>
    t.pool
      .query(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('June 2026', 'June', 2026, 6, '2026-06-01', '2026-06-30') RETURNING id, uuid`
      )
      .then((r) => r.rows[0]);

  beforeAll(async () => {
    tenant = await createTestTenant('Split uuid references');
    other = await createTestTenant('Split uuid references, the other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    accountId = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Split uuids', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
    own.item = (await tenant.pool.query(`INSERT INTO budget_items (name, expense_type) VALUES ('Groceries', 'Expense') RETURNING id, uuid`)).rows[0];
    own.period = await period(tenant);
    theirs.item = (await other.pool.query(`INSERT INTO budget_items (name, expense_type) VALUES ('Theirs', 'Expense') RETURNING uuid`)).rows[0].uuid;
    theirs.period = (await period(other)).uuid;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const parent = async () =>
    (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -40, '2026-06-12', 'expense', $2) RETURNING id, uuid`,
        [accountId, `Shop ${++n}`]
      )
    ).rows[0]!;
  const split = (uuid: string, first: Record<string, unknown>) =>
    request(app).post(`/api/transactions/${uuid}/split`).send({ splits: [{ amount: -25, ...first }, { amount: -15 }] }).then((r) => r);
  const splitsOf = async (id: number) =>
    (
      await tenant.pool.query<{ budget_item_id: number | null; budget_period_id: number | null }>(
        'SELECT budget_item_id, budget_period_id FROM transactions WHERE parent_transaction_id = $1 ORDER BY id',
        [id]
      )
    ).rows;

  it.each([
    ['a budget item uuid that is not a uuid', () => ({ budget_item_uuid: 'not-a-uuid' }), 'splits.0.budget_item_uuid'],
    ['a budget period uuid that is not a uuid', () => ({ budget_period_uuid: 'nope' }), 'splits.0.budget_period_uuid'],
    ['a budget item uuid that is a number', () => ({ budget_item_uuid: 42 }), 'splits.0.budget_item_uuid'],
  ] as const)('refuses %s with 400 VALIDATION_ERROR, nothing split', async (_what, refs, field) => {
    const tx = await parent();
    const res = await split(tx.uuid, refs());
    expect([res.status, res.body.code, res.body.details?.[0]?.field], JSON.stringify(res.body)).toEqual([400, 'VALIDATION_ERROR', field]);
    expect(await splitsOf(tx.id)).toEqual([]);
  });

  it.each([
    ['a budget item uuid of no row', () => ({ budget_item_uuid: '019a3b2c-1d2e-7f00-8a00-0000000000ee' }), 'budget_item_uuid'],
    ["another ledger's budget item", () => ({ budget_item_uuid: theirs.item }), 'budget_item_uuid'],
    ['a budget period uuid of no row', () => ({ budget_period_uuid: '019a3b2c-1d2e-7f00-8a00-0000000000ef' }), 'budget_period_uuid'],
    ["another ledger's budget period", () => ({ budget_item_uuid: own.item.uuid, budget_period_uuid: theirs.period }), 'budget_period_uuid'],
  ] as const)('refuses %s with 400 INVALID_REFERENCE, nothing split', async (_what, refs, field) => {
    const tx = await parent();
    const res = await split(tx.uuid, refs());
    expect([res.status, res.body.code, res.body.field], JSON.stringify(res.body)).toEqual([400, 'INVALID_REFERENCE', field]);
    expect(await splitsOf(tx.id)).toEqual([]);
  });

  it("splits with the ledger's own budget item and period by uuid (any case); empty or null is none", async () => {
    const tx = await parent();
    const res = await split(tx.uuid, { budget_item_uuid: own.item.uuid.toUpperCase(), budget_period_uuid: own.period.uuid });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await splitsOf(tx.id)).toEqual([
      { budget_item_id: own.item.id, budget_period_id: own.period.id },
      { budget_item_id: null, budget_period_id: null },
    ]);

    for (const none of [{ budget_item_uuid: '', budget_period_uuid: '' }, { budget_item_uuid: null, budget_period_uuid: null }]) {
      const plain = await parent();
      const answer = await split(plain.uuid, none);
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      expect((await splitsOf(plain.id))[0]).toEqual({ budget_item_id: null, budget_period_id: null });
    }
  });
});
