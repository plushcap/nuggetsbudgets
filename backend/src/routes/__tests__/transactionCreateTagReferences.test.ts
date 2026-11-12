import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A new transaction's tags name tags of the ledger. A tag id of another
 * ledger, or of no tag, and a tag uuid that names none, were dropped: the transaction was
 * saved without them, 201. Now the create is refused, 400 INVALID_REFERENCE naming the list,
 * and nothing is saved, as a split's tags are (transactionSplitTagReferences.test.ts).
 *
 * Tags sent as anything but a list of ids or of uuids (one id, a string, an object, text
 * that isn't an id: '0x3' and '3e0' read as 3) were dropped the same way; the body's schema
 * now refuses them, 400 VALIDATION_ERROR naming the field.
 */
describe("A new transaction's tags that aren't the ledger's", () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let accountUuid: string;
  let mine: { id: number; uuid: string };
  let theirs: { id: number; uuid: string };
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Create tag references');
    other = await createTestTenant('Create tag references, the other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    accountUuid = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Create refs', 'checking', 'cash', 'Asset') RETURNING uuid`
      )
    ).rows[0].uuid;
    mine = (await tenant.pool.query(`INSERT INTO tags (name) VALUES ('Mine') RETURNING id, uuid`)).rows[0];
    theirs = (await other.pool.query(`INSERT INTO tags (name) VALUES ('Theirs') RETURNING id, uuid`)).rows[0];
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const create = (tags: Record<string, unknown>, description = `Shop ${++n}`) =>
    request(app)
      .post('/api/transactions')
      .send({ account_uuid: accountUuid, amount: 12.5, transaction_date: '2026-06-12', type: 'expense', description, ...tags });
  const saved = async (description: string) =>
    Number((await tenant.pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM transactions WHERE description = $1', [description])).rows[0]!.n);

  it.each([
    ["another ledger's tag id", () => ({ tag_ids: [mine.id, theirs.id] }), 'tag_ids'],
    ['a tag id of no tag', () => ({ tag_ids: [2147480000] }), 'tag_ids'],
    ["another ledger's tag uuid", () => ({ tag_uuids: [mine.uuid, theirs.uuid] }), 'tag_uuids'],
    ['a tag uuid of no tag', () => ({ tag_uuids: ['019a3b2c-1d2e-7f00-8a00-0000000000ee'] }), 'tag_uuids'],
  ] as const)('refuses %s with 400 INVALID_REFERENCE, nothing saved', async (_what, tags, field) => {
    const description = `Refused ${++n}`;
    const res = await create(tags(), description);
    expect([res.status, res.body.code, res.body.field], JSON.stringify(res.body)).toEqual([400, 'INVALID_REFERENCE', field]);
    expect(res.body.error).toBe(`${field} names a tag that isn't in this tenant`);
    expect(await saved(description)).toBe(0);
  });

  it.each([
    ["one tag id, another ledger's", () => ({ tag_ids: theirs.id }), 'tag_ids'],
    ['one tag id, its own', () => ({ tag_ids: mine.id }), 'tag_ids'],
    ['a string', () => ({ tag_ids: 'abc' }), 'tag_ids'],
    ['an object', () => ({ tag_ids: { 0: theirs.id } }), 'tag_ids'],
    ['a tag id that is not an id', () => ({ tag_ids: [mine.id, 'abc'] }), 'tag_ids'],
    ['a tag id in hex', () => ({ tag_ids: [`0x${mine.id.toString(16)}`] }), 'tag_ids'],
    ['a tag id with an exponent', () => ({ tag_ids: [`${mine.id}e0`] }), 'tag_ids'],
    ['a list in the list', () => ({ tag_ids: [[mine.id]] }), 'tag_ids'],
    ['a tag id of 0', () => ({ tag_ids: [0] }), 'tag_ids'],
    ["one tag uuid, another ledger's", () => ({ tag_uuids: theirs.uuid }), 'tag_uuids'],
    ['a tag uuid that is not a uuid', () => ({ tag_uuids: ['not-a-uuid'] }), 'tag_uuids'],
    ['a tag uuid in braces', () => ({ tag_uuids: [`{${mine.uuid}}`] }), 'tag_uuids'],
  ] as const)('refuses tags sent as %s with 400 VALIDATION_ERROR, nothing saved', async (_what, tags, field) => {
    const description = `Refused ${++n}`;
    const res = await create(tags(), description);
    expect([res.status, res.body.code], JSON.stringify(res.body)).toEqual([400, 'VALIDATION_ERROR']);
    expect(res.body.details?.[0]?.field, JSON.stringify(res.body)).toMatch(new RegExp(`^${field}(\\.|$)`));
    expect(await saved(description)).toBe(0);
  });

  it('takes empty lists and null as no tags', async () => {
    for (const tags of [{ tag_ids: [], tag_uuids: [] }, { tag_ids: null, tag_uuids: null }]) {
      const res = await create(tags);
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const tagged = await tenant.pool.query(
        `SELECT 1 FROM taggings x JOIN transactions t ON t.id = x.taggable_id WHERE x.taggable_type = 'transaction' AND t.uuid = $1`,
        [res.body.transaction.uuid]
      );
      expect(tagged.rowCount).toBe(0);
    }
  });

  it("creates with the ledger's own tags, by id (also as text) and by uuid (any case), once each", async () => {
    // A uuid in upper case is the same tag (Postgres reads either case).
    const res = await create({ tag_ids: [mine.id, String(mine.id)], tag_uuids: [mine.uuid.toUpperCase()] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const tagged = await tenant.pool.query<{ tag_id: number }>(
      `SELECT x.tag_id FROM taggings x JOIN transactions t ON t.id = x.taggable_id
        WHERE x.taggable_type = 'transaction' AND t.uuid = $1`,
      [res.body.transaction.uuid]
    );
    expect(tagged.rows.map((r) => r.tag_id)).toEqual([mine.id]);
  });
});
