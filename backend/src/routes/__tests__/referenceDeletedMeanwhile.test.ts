import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createAccountsRoutes } from '../accounts.js';
import { createBudgetRoutes } from '../budgets.js';
import { createCategoriesRoutes } from '../categories.js';
import { createInstitutionsRoutes } from '../institutions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Linking a budget item to a category, or an account to an institution, while the category
 * or institution is deleted. Nothing checked the id before the write, so when the
 * delete committed first the write's foreign key check failed (23503 on
 * budget_items_category_id_fkey or accounts_institution_id_fkey), a 500. The link now checks
 * the row under FOR KEY SHARE (tenantReferences.ts): the delete waits for the link and finds
 * the row in use, or the link waits for the delete and answers 400 INVALID_REFERENCE.
 */
describe('Linking a category or institution while it is deleted', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Reference deleted meanwhile');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/accounts', createAccountsRoutes());
    app.use('/api/budgets', createBudgetRoutes());
    app.use('/api/categories', createCategoriesRoutes());
    app.use('/api/institutions', createInstitutionsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedBy = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.length > 0;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const answer = (res: request.Response) => `${res.status} ${res.body.code ?? ''}${res.body.field ? ` ${res.body.field}` : ''}`.trim();

  let n = 0;
  const kinds = {
    category: {
      table: 'categories',
      inUse: '409 CONFLICT',
      deleted: '204',
      field: 'category_id',
      async parent() {
        return one<{ id: number; uuid: string }>('INSERT INTO categories (name) VALUES ($1) RETURNING id, uuid', [`Category ${++n}`]);
      },
      async child() {
        return one<{ id: number; uuid: string }>(`INSERT INTO budget_items (name, expense_type) VALUES ($1, 'Expense') RETURNING id, uuid`, [`Item ${++n}`]);
      },
      link: (child: { uuid: string }, parentId: number) => request(app).put(`/api/budgets/items/${child.uuid}`).send({ category_id: parentId }),
      remove: (parent: { uuid: string }) => request(app).delete(`/api/categories/${parent.uuid}`),
      linked: async (child: { id: number }) => (await one<{ ref: number | null }>('SELECT category_id AS ref FROM budget_items WHERE id = $1', [child.id])).ref,
    },
    institution: {
      table: 'account_institutions',
      inUse: '400 BAD_REQUEST',
      deleted: '200',
      field: 'institution_id',
      async parent() {
        return one<{ id: number; uuid: string }>('INSERT INTO account_institutions (name) VALUES ($1) RETURNING id, uuid', [`Bank ${++n}`]);
      },
      async child() {
        return one<{ id: number; uuid: string }>(
          `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
          [`Checking ${++n}`]
        );
      },
      link: (child: { uuid: string }, parentId: number) => request(app).put(`/api/accounts/${child.uuid}`)
        .send({ name: `Checking ${child.uuid.slice(-4)}`, account_type: 'checking', account_group: 'cash', type: 'Asset', institution_id: parentId }),
      remove: (parent: { uuid: string }) => request(app).delete(`/api/institutions/${parent.uuid}`),
      linked: async (child: { id: number }) => (await one<{ ref: number | null }>('SELECT institution_id AS ref FROM accounts WHERE id = $1', [child.id])).ref,
    },
  };

  describe.each(Object.keys(kinds) as Array<keyof typeof kinds>)('a %s', (kind) => {
    const k = kinds[kind];

    it('waited for by the link, deleted: 400 INVALID_REFERENCE, nothing linked', async () => {
      const parent = await k.parent();
      const child = await k.child();
      // The delete, as its service runs it: the row locked FOR UPDATE, then deleted, not yet committed.
      const deleter = await tenant.pool.connect();
      let linking: Promise<request.Response> | undefined;
      try {
        await deleter.query('BEGIN');
        await deleter.query(`SELECT id FROM ${k.table} WHERE id = $1 FOR UPDATE`, [parent.id]);
        await deleter.query(`DELETE FROM ${k.table} WHERE id = $1`, [parent.id]);
        const deleterPid = await pidOf(deleter);
        linking = k.link(child, parent.id).then((r) => r);
        await waitUntil(() => blockedBy(deleterPid));
        await deleter.query('COMMIT');
      } finally {
        await deleter.query('ROLLBACK').catch(() => undefined);
        deleter.release();
      }
      const res = await linking!;
      expect(answer(res), JSON.stringify(res.body)).toBe(`400 INVALID_REFERENCE ${k.field}`);
      expect(await k.linked(child)).toBeNull();
    });

    it('a link and a delete at once: one after the other, either way round, never a 500', async () => {
      const outcomes = new Set<string>();
      for (let round = 0; round < 20; round += 1) {
        const parent = await k.parent();
        const child = await k.child();
        // The delete sent 0 to 9 ms after the link, so either can go first.
        const [linked, removed] = await Promise.all([
          k.link(child, parent.id).then((r) => r),
          new Promise((r) => setTimeout(r, round % 10)).then(() => k.remove(parent).then((r) => r)),
        ]);
        const ref = await k.linked(child);
        const outcome = `link ${answer(linked)}, delete ${answer(removed)}, linked ${ref === parent.id}`;
        outcomes.add(outcome);
        expect([
          // The link first: the delete finds it in use.
          `link 200, delete ${k.inUse}, linked true`,
          // The delete first: the link finds it gone.
          `link 400 INVALID_REFERENCE ${k.field}, delete ${k.deleted}, linked false`,
        ], outcome).toContain(outcome);
      }
      if (process.env.SHOW_ROUNDS) process.stderr.write(`${kind}: ${[...outcomes].join(' | ')}\n`);
    }, 60_000);
  });
});
