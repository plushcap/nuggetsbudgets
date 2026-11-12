import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A split's tags name tags of the ledger. A tag id of another ledger, or of no
 * tag, and a tag uuid that names none, were dropped: the split was saved without them, 200.
 * Now the split is refused, 400 INVALID_REFERENCE naming the list, and nothing is saved, as a
 * split's budget item or period that names nothing is refused.
 */
describe("A split's tags that aren't the ledger's", () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let accountId: number;
  let mine: { id: number; uuid: string };
  let theirs: { id: number; uuid: string };
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Split tag references');
    other = await createTestTenant('Split tag references, the other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    accountId = (await tenant.pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Split refs', 'checking', 'cash', 'Asset') RETURNING id`
    )).rows[0].id;
    mine = (await tenant.pool.query(`INSERT INTO tags (name) VALUES ('Mine') RETURNING id, uuid`)).rows[0];
    theirs = (await other.pool.query(`INSERT INTO tags (name) VALUES ('Theirs') RETURNING id, uuid`)).rows[0];
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const parent = async () => (await tenant.pool.query<{ id: number; uuid: string }>(
    `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -40, '2026-06-12', 'expense', $2) RETURNING id, uuid`,
    [accountId, `Shop ${++n}`]
  )).rows[0]!;
  const split = (uuid: string, first: Record<string, unknown>) =>
    request(app).post(`/api/transactions/${uuid}/split`).send({ splits: [{ amount: -25, ...first }, { amount: -15 }] }).then((r) => r);
  const splitsOf = async (id: number) =>
    Number((await tenant.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM transactions WHERE parent_transaction_id = $1', [id])).rows[0]!.n);

  it.each([
    ["another ledger's tag id", () => ({ tag_ids: [mine.id, theirs.id] }), 'tag_ids'],
    ['a tag id of no tag', () => ({ tag_ids: [2147480000] }), 'tag_ids'],
    ['a tag id that is not an id', () => ({ tag_ids: ['abc'] }), 'tag_ids'],
    ["another ledger's tag uuid", () => ({ tag_uuids: [mine.uuid, theirs.uuid] }), 'tag_uuids'],
    ['a tag uuid of no tag', () => ({ tag_uuids: ['019a3b2c-1d2e-7f00-8a00-0000000000ee'] }), 'tag_uuids'],
    // Text that isn't a uuid failed the lookup, a 500.
    ['a tag uuid that is not a uuid', () => ({ tag_uuids: [mine.uuid, 'not-a-uuid'] }), 'tag_uuids'],
  ] as const)('refuses %s with 400 INVALID_REFERENCE, nothing split', async (_what, tags, field) => {
    const tx = await parent();
    const res = await split(tx.uuid, tags());
    expect([res.status, res.body.code, res.body.field], JSON.stringify(res.body)).toEqual([400, 'INVALID_REFERENCE', field]);
    expect(await splitsOf(tx.id)).toBe(0);
  });

  it("splits with the ledger's own tags, by id and by uuid", async () => {
    const tx = await parent();
    const res = await split(tx.uuid, { tag_ids: [mine.id], tag_uuids: [mine.uuid.toUpperCase()] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const tagged = await tenant.pool.query<{ tag_id: number }>(
      `SELECT x.tag_id FROM taggings x JOIN transactions c ON c.id = x.taggable_id
        WHERE x.taggable_type = 'transaction' AND c.parent_transaction_id = $1`,
      [tx.id]
    );
    expect(tagged.rows.map((r) => r.tag_id)).toEqual([mine.id]);
  });
});
