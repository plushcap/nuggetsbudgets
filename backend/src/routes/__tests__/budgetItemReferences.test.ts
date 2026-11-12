import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createBudgetRoutes } from '../budgets.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A budget item's merchant_id and transaction_auto_tag_id. Nothing checked them before
 * the write, so an id that names no merchant or tag of the ledger (another ledger's, none, one
 * past `integer`, not a number) failed the write: a 23503 or a 22P02, a 500. They are now
 * checked as category_id is, under FOR KEY SHARE: 400 INVALID_REFERENCE naming the field,
 * and a delete running at once goes before the link (which then answers 400) or after it.
 */
describe("A budget item's merchant and auto-tag references", () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let otherMerchant: number;
  let otherTag: number;
  let n = 0;

  beforeAll(async () => {
    tenant = await createTestTenant('Budget item references');
    other = await createTestTenant('Budget item references, the other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/tags', createTagsRoutes());
    otherMerchant = (await other.pool.query<{ id: number }>(`INSERT INTO merchants (name) VALUES ('Theirs') RETURNING id`)).rows[0]!.id;
    otherTag = (await other.pool.query<{ id: number }>(`INSERT INTO tags (name) VALUES ('Theirs') RETURNING id`)).rows[0]!.id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const answer = (res: request.Response) => `${res.status} ${res.body.code ?? ''}${res.body.field ? ` ${res.body.field}` : ''}`.trim();
  const budgetItem = () => one<{ id: number; uuid: string }>(`INSERT INTO budget_items (name, expense_type) VALUES ($1, 'Expense') RETURNING id, uuid`, [`Item ${++n}`]);
  const merchant = () => one<{ id: number; uuid: string }>('INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid', [`Merchant ${++n}`]);
  const tag = () => one<{ id: number; uuid: string }>('INSERT INTO tags (name) VALUES ($1) RETURNING id, uuid', [`Tag ${++n}`]);
  const create = (fields: Record<string, unknown>) =>
    request(app).post('/api/budgets/items').send({ name: `Created ${++n}`, expense_type: 'Expense', ...fields }).then((r) => r);
  const update = (uuid: string, fields: Record<string, unknown>) => request(app).put(`/api/budgets/items/${uuid}`).send(fields).then((r) => r);

  const bad = () => [
    ['another ledger\'s', { merchant_id: otherMerchant, transaction_auto_tag_id: otherTag }],
    ['no row', { merchant_id: 2147480000, transaction_auto_tag_id: 2147480000 }],
    ['past integer', { merchant_id: 2147483648, transaction_auto_tag_id: 2147483648 }],
    ['not a number', { merchant_id: 'abc', transaction_auto_tag_id: 'abc' }],
  ] as const;

  it('create: a merchant_id that names no merchant of the ledger is 400 INVALID_REFERENCE, nothing created', async () => {
    for (const [what, ids] of bad()) {
      const before = await one<{ n: string }>('SELECT COUNT(*) AS n FROM budget_items');
      const res = await create({ merchant_id: ids.merchant_id });
      expect(answer(res), `${what}: ${JSON.stringify(res.body)}`).toBe('400 INVALID_REFERENCE merchant_id');
      expect((await one<{ n: string }>('SELECT COUNT(*) AS n FROM budget_items')).n).toBe(before.n);
    }
    const mine = await merchant();
    const res = await create({ merchant_id: mine.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.merchant_id).toBe(mine.id);
  });

  it.each(['merchant_id', 'transaction_auto_tag_id'] as const)('update: a %s that names no row of the ledger is 400 INVALID_REFERENCE, nothing changed', async (field) => {
    const item = await budgetItem();
    for (const [what, ids] of bad()) {
      const res = await update(item.uuid, { [field]: ids[field] });
      expect(answer(res), `${what}: ${JSON.stringify(res.body)}`).toBe(`400 INVALID_REFERENCE ${field}`);
    }
    expect((await one<Record<string, unknown>>(`SELECT ${field} AS ref FROM budget_items WHERE id = $1`, [item.id])).ref).toBeNull();
    const mine = field === 'merchant_id' ? await merchant() : await tag();
    const res = await update(item.uuid, { [field]: mine.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body[field]).toBe(mine.id);
    // Sent back unchanged (as the edit form does), and cleared.
    expect((await update(item.uuid, { [field]: mine.id, name: `Renamed ${++n}` })).status).toBe(200);
    expect((await update(item.uuid, { [field]: null })).body[field]).toBeNull();
  });

  // The forms send null for none; '' passed the check and failed the write, 22P02, a 500.
  it.each(['category_id', 'merchant_id', 'transaction_auto_tag_id'] as const)("refuses %s '' with 400 INVALID_REFERENCE, on create and update", async (field) => {
    const before = await one<{ n: string }>('SELECT COUNT(*) AS n FROM budget_items');
    const created = await create({ [field]: '' });
    expect(answer(created), JSON.stringify(created.body)).toBe(`400 INVALID_REFERENCE ${field}`);
    expect((await one<{ n: string }>('SELECT COUNT(*) AS n FROM budget_items')).n).toBe(before.n);
    const item = await budgetItem();
    const updated = await update(item.uuid, { [field]: '', name: `Not renamed ${++n}` });
    expect(answer(updated), JSON.stringify(updated.body)).toBe(`400 INVALID_REFERENCE ${field}`);
    expect((await one<{ name: string }>('SELECT name FROM budget_items WHERE id = $1', [item.id])).name).toMatch(/^Item /);
    // null is none, as the forms send it.
    expect((await create({ [field]: null })).status).toBe(201);
    expect((await update(item.uuid, { [field]: null })).status).toBe(200);
  });

  // createBudgetItem left transaction_auto_tag_id out of the insert, so the auto-tag
  // the Add page chose was dropped.
  it('create: keeps the auto-tag sent, and refuses one that names no tag of the ledger', async () => {
    const mine = await tag();
    const res = await create({ transaction_auto_tag_id: mine.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.transaction_auto_tag_id).toBe(mine.id);
    expect((await one<{ ref: number | null }>('SELECT transaction_auto_tag_id AS ref FROM budget_items WHERE uuid = $1', [res.body.uuid])).ref).toBe(mine.id);
    for (const [what, ids] of bad()) {
      const refused = await create({ transaction_auto_tag_id: ids.transaction_auto_tag_id });
      expect(answer(refused), `${what}: ${JSON.stringify(refused.body)}`).toBe('400 INVALID_REFERENCE transaction_auto_tag_id');
    }
  });

  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedBy = async (pid: number) =>
    (await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const kinds = {
    merchant: {
      table: 'merchants', field: 'merchant_id' as const, parent: merchant,
      remove: (uuid: string) => request(app).delete(`/api/merchants/${uuid}`).then((r) => r),
      // The link first: the delete finds the merchant in use.
      linkFirst: 'link 200, delete 409 CONFLICT, linked true',
      deleted: '204',
    },
    tag: {
      table: 'tags', field: 'transaction_auto_tag_id' as const, parent: tag,
      remove: (uuid: string) => request(app).delete(`/api/tags/${uuid}`).then((r) => r),
      // The link first: the delete clears it (ON DELETE SET NULL).
      linkFirst: 'link 200, delete 200, linked false',
      deleted: '200',
    },
  };

  describe.each(Object.keys(kinds) as Array<keyof typeof kinds>)('a %s deleted meanwhile', (kind) => {
    const k = kinds[kind];

    it('waited for by the link, deleted: 400 INVALID_REFERENCE, not a 500', async () => {
      const parent = await k.parent();
      const item = await budgetItem();
      const deleter = await tenant.pool.connect();
      let linking: Promise<request.Response> | undefined;
      try {
        await deleter.query('BEGIN');
        await deleter.query(`SELECT id FROM ${k.table} WHERE id = $1 FOR UPDATE`, [parent.id]);
        await deleter.query(`DELETE FROM ${k.table} WHERE id = $1`, [parent.id]);
        const deleterPid = await pidOf(deleter);
        linking = update(item.uuid, { [k.field]: parent.id });
        await waitUntil(() => blockedBy(deleterPid));
        await deleter.query('COMMIT');
      } finally {
        await deleter.query('ROLLBACK').catch(() => undefined);
        deleter.release();
      }
      const res = await linking!;
      expect(answer(res), JSON.stringify(res.body)).toBe(`400 INVALID_REFERENCE ${k.field}`);
    });

    it('a link and a delete at once: one after the other, either way round, never a 500 (20 rounds)', async () => {
      const outcomes = new Set<string>();
      for (let round = 0; round < 20; round += 1) {
        const parent = await k.parent();
        const item = await budgetItem();
        const [linked, removed] = await Promise.all([
          update(item.uuid, { [k.field]: parent.id }),
          new Promise((r) => setTimeout(r, round % 10)).then(() => k.remove(parent.uuid)),
        ]);
        const ref = (await one<{ ref: number | null }>(`SELECT ${k.field} AS ref FROM budget_items WHERE id = $1`, [item.id])).ref;
        const outcome = `link ${answer(linked)}, delete ${answer(removed)}, linked ${ref === parent.id}`;
        outcomes.add(outcome);
        expect([
          k.linkFirst,
          `link 400 INVALID_REFERENCE ${k.field}, delete ${k.deleted}, linked false`,
        ], outcome).toContain(outcome);
      }
      if (process.env.SHOW_ROUNDS) process.stderr.write(`${kind}: ${[...outcomes].join(' | ')}\n`);
    }, 60_000);
  });
});
