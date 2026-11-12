import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A tag deleted while a request applies it. The request finds the tag, and its
 * tagging's foreign key check then waits for the delete, which commits: the insert is
 * refused (23503), and the request answered a 500. It answers what the same request answers
 * once the tag is gone: 400 INVALID_REFERENCE for a tag_id in the body, 404 for a tag named
 * in the URL. Nothing is saved.
 */
describe('a tag deleted while a request applies it', () => {
  let app: Express;
  let tenant: TestTenant;
  let transaction: { id: number; uuid: string };
  let item: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Tag deleted while applied');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/tags', createTagsRoutes());
    const account = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Tag race checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
    transaction = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -9, '2022-08-01', 'expense', 'Tag race') RETURNING id, uuid`,
        [account]
      )
    ).rows[0]!;
    item = (await tenant.pool.query<{ id: number; uuid: string }>(`INSERT INTO budget_items (name, expense_type) VALUES ('Tag race item', 'Expense') RETURNING id, uuid`)).rows[0]!;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  let tagCount = 0;
  const newTag = async (columns: { parent_id?: number; is_report_root?: boolean } = {}) =>
    (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO tags (name, parent_id, is_report_root) VALUES ($1, $2, $3) RETURNING id, uuid`,
        [`Race tag ${++tagCount}`, columns.parent_id ?? null, columns.is_report_root ?? false]
      )
    ).rows[0]!;

  /** Send the request while another connection deletes tag `tagId`; that delete commits once the request waits for it. */
  const whileDeleted = async (tagId: number, send: () => request.Test) => {
    const deleter: PoolClient = await tenant.pool.connect();
    try {
      await deleter.query('BEGIN');
      const pid = (await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await deleter.query('DELETE FROM tags WHERE id = $1', [tagId]);
      const sending = send().then((res) => res);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const { rows } = await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
        if (rows.length > 0) break;
        if (Date.now() > deadline) throw new Error('the request never waited for the delete');
        await new Promise((r) => setTimeout(r, 20));
      }
      await deleter.query('COMMIT');
      return await sending;
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      deleter.release();
    }
  };

  const taggingsOf = async (type: string, id: number) =>
    (await tenant.pool.query('SELECT 1 FROM taggings WHERE taggable_type = $1 AND taggable_id = $2', [type, id])).rowCount;

  it('tagging a transaction by tag_id answers 400 INVALID_REFERENCE', async () => {
    const tag = await newTag();
    const res = await whileDeleted(tag.id, () => request(app).post(`/api/tags/transaction/${transaction.uuid}`).send({ tag_id: tag.id }));
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 400, body: { code: 'INVALID_REFERENCE', field: 'tag_id' } });
    expect(await taggingsOf('transaction', transaction.id)).toBe(0);
  });

  it('tagging a transaction by the tag in the URL answers 404', async () => {
    const tag = await newTag();
    const res = await whileDeleted(tag.id, () => request(app).post(`/api/transactions/${transaction.uuid}/tags/${tag.uuid}`));
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 404, body: { error: 'Tag not found' } });
    expect(await taggingsOf('transaction', transaction.id)).toBe(0);
  });

  it('tagging a budget item answers 400 INVALID_REFERENCE', async () => {
    const tag = await newTag();
    const res = await whileDeleted(tag.id, () => request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: tag.id }));
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 400, body: { code: 'INVALID_REFERENCE', field: 'tag_id' } });
    expect(await taggingsOf('budget_item', item.id)).toBe(0);
  });

  it("setting a budget item's namespace tag answers 404, keeping the one it had", async () => {
    const root = await newTag({ is_report_root: true });
    const kept = await newTag({ parent_id: root.id });
    const chosen = await newTag({ parent_id: root.id });
    const set = (tagUuid: string) => request(app).put(`/api/tags/budget-items/${item.uuid}/namespace/${root.uuid}`).send({ tag_uuid: tagUuid });
    expect((await set(kept.uuid)).status).toBe(200);

    const res = await whileDeleted(chosen.id, () => set(chosen.uuid));
    expect({ status: res.status, body: res.body }).toMatchObject({ status: 404, body: { error: 'Tag not found' } });
    const tags = await tenant.pool.query<{ tag_id: number }>(`SELECT tag_id FROM taggings WHERE taggable_type = 'budget_item' AND taggable_id = $1`, [item.id]);
    expect(tags.rows.map((r) => r.tag_id)).toEqual([kept.id]);
  });
});
