import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { createInstitutionsRoutes } from '../institutions.js';
import { createCategoriesRoutes } from '../categories.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Deleting an institution, or a category, while an account is being put at it (or a budget
 * item in it). The delete checked that nothing used the row, then deleted it: an account
 * linked by a transaction still open wasn't counted, and once that committed, the delete
 * went on and unlinked it (ON DELETE SET NULL), answering success. The delete now locks the
 * row first (FOR UPDATE), which waits for the link (its foreign key check holds the row FOR
 * KEY SHARE); the check then counts it, and the delete is refused.
 */
describe('deleting an institution or a category while something is being linked to it', () => {
  let app: Express;
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Reference data delete locks');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/institutions', createInstitutionsRoutes());
    app.use('/api/categories', createCategoriesRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const one = async <T = { id: number; uuid: string }>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockedBy = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.length;
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  /**
   * `link` runs in a transaction of its own, left open while `remove` starts; once `remove`
   * waits for it (or has answered), it commits. Answers `remove`'s answer.
   */
  const removeWhileLinking = async (link: (client: PoolClient) => Promise<unknown>, remove: () => request.Test) => {
    const linker = await tenant.pool.connect();
    try {
      await linker.query('BEGIN');
      await link(linker);
      const linkerPid = await pidOf(linker);
      let answered = false;
      const removing = remove().then((res) => {
        answered = true;
        return res;
      });
      await waitUntil(async () => answered || (await blockedBy(linkerPid)) > 0);
      await linker.query('COMMIT');
      return await removing;
    } finally {
      await linker.query('ROLLBACK').catch(() => undefined);
      linker.release();
    }
  };

  it('an institution an account is being linked to is refused as in use, and the account keeps it', async () => {
    const bank = await one(`INSERT INTO account_institutions (name) VALUES ('Linked meanwhile') RETURNING id, uuid`);
    let accountId = 0;
    const res = await removeWhileLinking(
      async (linker) => {
        accountId = (
          await linker.query<{ id: number }>(
            `INSERT INTO accounts (name, account_type, account_group, type, institution_id) VALUES ('New at bank', 'checking', 'cash', 'Asset', $1) RETURNING id`,
            [bank.id]
          )
        ).rows[0]!.id;
      },
      () => request(app).delete(`/api/institutions/${bank.uuid}`)
    );

    expect({ status: res.status, body: res.body }).toMatchObject({
      status: 400,
      body: { error: 'Cannot delete institution', message: expect.stringContaining('used by 1 account') },
    });
    expect(await one('SELECT institution_id AS id FROM accounts WHERE id = $1', [accountId])).toEqual({ id: bank.id });
    expect((await tenant.pool.query('SELECT 1 FROM account_institutions WHERE id = $1', [bank.id])).rowCount).toBe(1);
  });

  it('a category a budget item is being put in is refused as in use, and the budget item keeps it', async () => {
    const category = await one(`INSERT INTO categories (name, icon) VALUES ('Linked meanwhile', 'Box') RETURNING id, uuid`);
    let itemId = 0;
    const res = await removeWhileLinking(
      async (linker) => {
        itemId = (await linker.query<{ id: number }>(`INSERT INTO budget_items (name, category_id) VALUES ('New in category', $1) RETURNING id`, [category.id])).rows[0]!.id;
      },
      () => request(app).delete(`/api/categories/${category.uuid}`)
    );

    expect({ status: res.status, body: res.body }).toMatchObject({ status: 409, body: { error: 'Category in use' } });
    expect(await one('SELECT category_id AS id FROM budget_items WHERE id = $1', [itemId])).toEqual({ id: category.id });
    expect((await tenant.pool.query('SELECT 1 FROM categories WHERE id = $1', [category.id])).rowCount).toBe(1);
  });

  it('an institution nothing is linked to is still deleted, and a second delete is a 404', async () => {
    const bank = await one(`INSERT INTO account_institutions (name) VALUES ('Unused') RETURNING id, uuid`);
    expect((await request(app).delete(`/api/institutions/${bank.uuid}`)).status).toBe(200);
    expect((await request(app).delete(`/api/institutions/${bank.uuid}`)).status).toBe(404);
  });
});
