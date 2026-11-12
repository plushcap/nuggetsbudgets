import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '5000';
  process.env.LOG_LEVEL ??= 'silent';
  return previous;
});

import request from 'supertest';
import express, { type Express } from 'express';
import type { PoolClient } from 'pg';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { saveGeneralSettings } from '../../services/generalSettings.js';
import { BillService } from '../../services/bills/BillService.js';
import { MerchantService } from '../../services/merchants/MerchantService.js';
import { createMerchantsRoutes } from '../merchants.js';
import { createTagsRoutes } from '../tags.js';
import { createAccountsRoutes } from '../accounts.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Writes of several budget items, and a time zone change.
 *
 * - A zone change locked every budget item, so it deadlocked with a write that locked several
 *   out of id order. It locks only the goals (and accounts) again, whose ranges it rewrites.
 * - Those writes lock their items in id order first: a merchant merge's or delete's move of its
 *   items, a tag delete's emptying of its auto-tag, a bill sync's last-paid dates. Each took them
 *   in the order its statement found them. Here an item with a higher id is written first, so it
 *   is found first, and a held lower one shows which the write took before it waited.
 * - Creating the envelope account cleared the old one's flag (a row lock) before its insert took
 *   the day-ranges lock shared, which a zone change holds alone while it locks every account.
 */
describe('Writes of several budget items, and a time zone change', () => {
  let app: Express;
  let tenant: TestTenant;
  let n = 0;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const pidOf = async (client: PoolClient) => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  const waitUntil = async (check: () => Promise<boolean>, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /**
   * In the caller's transaction: plans that read budget items in the order they're stored (a
   * sequential scan, a hash join), as a ledger of many gets, not by an index on their ids.
   */
  const forceStoredOrderScans = async () => {
    for (const setting of ['enable_nestloop', 'enable_mergejoin', 'enable_indexscan', 'enable_bitmapscan']) {
      await sql`SELECT set_config(${setting}, 'off', true)`.execute(getDb());
    }
  };
  /** Whether another session can lock `id` at once (none holds it). */
  const free = async (id: number) => {
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [id]);
      return true;
    } catch {
      return false;
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };
  /**
   * Two budget items with `columns`: the first written has the higher id, so a statement finds it
   * first (asserted on their places in the table).
   */
  const twoItems = async (columns: Record<string, unknown>) => {
    const keys = Object.keys(columns);
    const values = Object.values(columns);
    const insert = (id: string | null) =>
      one<{ id: number }>(
        `INSERT INTO budget_items (${id === null ? '' : 'id, '}name, expense_type, rollover, type, ${keys.join(', ')})
         VALUES (${id === null ? '' : `${id}, `}$1, 'Expense', false, 'Monthly', ${keys.map((_, i) => `$${i + 2}`).join(', ')}) RETURNING id`,
        [`Lock order ${++n}`, ...values]
      );
    // Far above any id the sequence hands out in a test run.
    const { next } = await one<{ next: string }>(`SELECT nextval(pg_get_serial_sequence('budget_items', 'id')) + 1000000 AS next`);
    const high = await insert(next);
    const low = await insert(null);
    const order = await tenant.pool.query<{ id: number }>('SELECT id FROM budget_items WHERE id IN ($1, $2) ORDER BY ctid', [high.id, low.id]);
    expect(high.id).toBeGreaterThan(low.id);
    expect(order.rows.map((r) => r.id), 'the higher id is found first').toEqual([high.id, low.id]);
    return { high: high.id, low: low.id };
  };
  /** `write` run while the lower item is held: it waits on it, and the higher one is free then (in id order) or not. */
  const takesInIdOrder = async (low: number, high: number, write: () => Promise<unknown>) => {
    const gate = await tenant.pool.connect();
    let writing: Promise<unknown> | undefined;
    let highFree: boolean;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [low]);
      const gatePid = await pidOf(gate);
      writing = write();
      writing.catch(() => undefined);
      await waitUntil(async () => (await waitersOf(gatePid)).length > 0);
      highFree = await free(high);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    return { highFree, result: await writing };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Budget item write lock order');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/tags', createTagsRoutes());
    app.use('/api/accounts', createAccountsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  it('a merchant merge takes the items it moves in id order', async () => {
    const source = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [`Merge order ${n}`]);
    const target = await one<{ uuid: string }>(`INSERT INTO merchants (name) VALUES ($1) RETURNING uuid`, [`Merge order target ${n}`]);
    const { high, low } = await twoItems({ merchant_id: source.id });
    // The plan a ledger of many items gets: a scan in the order they're stored, which finds the
    // higher id first (by the index the planner chose for two, the old UPDATE took them
    // in id order by chance, and this case passed without the fix).
    const merge = () =>
      withTenant(tenant.tenantId, async () => {
        await forceStoredOrderScans();
        await new MerchantService().merge(source.uuid, target.uuid);
      });
    const { highFree } = await takesInIdOrder(low, high, merge);
    expect(highFree).toBe(true);
    expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM budget_items WHERE id IN ($1, $2) AND merchant_id = $3', [high, low, source.id])).n).toBe(0);
  });

  it("a tag delete takes the items whose auto-tag it empties in id order", async () => {
    const tag = await one<{ id: number; uuid: string }>(`INSERT INTO tags (name) VALUES ($1) RETURNING id, uuid`, [`Order tag ${n}`]);
    const { high, low } = await twoItems({ transaction_auto_tag_id: tag.id });
    const { highFree, result } = await takesInIdOrder(low, high, () => request(app).delete(`/api/tags/${tag.uuid}`).then((r) => r));
    expect(highFree).toBe(true);
    expect((result as request.Response).status).toBe(200);
    expect((await tenant.pool.query('SELECT 1 FROM budget_items WHERE transaction_auto_tag_id = $1', [tag.id])).rowCount).toBe(0);
  });

  it("a bill sync takes the bills' items in id order", async () => {
    const { high, low } = await twoItems({ isbill: true, recurring_payment: true });
    for (const id of [high, low]) {
      await tenant.pool.query(
        `INSERT INTO bill_occurrences (budget_item_id, due_date, expected_amount, resolution, manual_paid_date) VALUES ($1, '2026-01-05', -50, 'paid_manually', '2026-01-04')`,
        [id]
      );
    }
    // The plan the old statement takes when the ledger's bills are many: a hash join probed by a scan
    // of the items in the order they're stored, which finds the higher id first (with
    // the planner's choice for two items it took them in id order by chance, and this case passed
    // without the fix).
    const sync = () =>
      withTenant(tenant.tenantId, async () => {
        await forceStoredOrderScans();
        await new BillService().sync('2026-01-10');
      });
    const { highFree } = await takesInIdOrder(low, high, sync);
    expect(highFree).toBe(true);
    const paid = await tenant.pool.query<{ d: string }>('SELECT recurring_last_payment_date::text AS d FROM budget_items WHERE id IN ($1, $2)', [high, low]);
    expect(paid.rows.map((r) => r.d)).toEqual(['2026-01-04', '2026-01-04']);
  });

  it('a zone change waits for no budget item that is not a goal', async () => {
    await withTenant(tenant.tenantId, () => saveGeneralSettings({ application_timezone: 'Pacific/Kiritimati' }, { application_timezone: null }, tenant.userId));
    const item = await one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`Plain ${n}`]);
    const holder = await tenant.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [item.id]);
      const started = Date.now();
      await withTenant(tenant.tenantId, () => saveGeneralSettings({ application_timezone: 'Pacific/Pago_Pago' }, { application_timezone: 'Pacific/Kiritimati' }, tenant.userId));
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  });

  it('creating the envelope account and a zone change both finish', async () => {
    await one(`INSERT INTO accounts (name, account_type, account_group, type, is_envelope_account) VALUES ('Old envelope', 'savings', 'cash', 'Asset', true) RETURNING id`);
    const goal = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('Lock order goal', 'Savings', 'Goal', 'Goal', 100) RETURNING id`
    );
    // The zone change, paused on a goal once it holds the day-ranges lock alone.
    const gate = await tenant.pool.connect();
    let changing: Promise<unknown> | undefined;
    let creating: Promise<request.Response> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [goal.id]);
      const gatePid = await pidOf(gate);
      changing = withTenant(tenant.tenantId, () => saveGeneralSettings({ application_timezone: 'UTC' }, { application_timezone: 'Pacific/Pago_Pago' }, tenant.userId));
      changing.catch(() => undefined);
      let changePid = 0;
      await waitUntil(async () => {
        [changePid = 0] = await waitersOf(gatePid);
        return changePid !== 0;
      });
      creating = request(app).post('/api/accounts').send({ name: 'New envelope', account_type: 'savings', account_group: 'cash', type: 'Asset', is_envelope_account: true }).then((r) => r);
      // It waits for the change (before, it held the old envelope account and the change waited for that).
      await waitUntil(async () => (await waitersOf(changePid)).length > 0);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    await expect(changing).resolves.toBeUndefined();
    const created = await creating!;
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const envelopes = await tenant.pool.query<{ name: string }>('SELECT name FROM accounts WHERE is_envelope_account');
    expect(envelopes.rows).toEqual([{ name: 'New envelope' }]);
  }, 30_000);

  it('an item becoming a goal waits for a zone change under way, which then locks it with the goals', async () => {
    const goal = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('Held goal', 'Savings', 'Goal', 'Goal', 100) RETURNING id`
    );
    const item = await one<{ id: number }>(`INSERT INTO budget_items (name, expense_type, rollover, type) VALUES ($1, 'Expense', false, 'Monthly') RETURNING id`, [`To goal ${n}`]);
    const gate = await tenant.pool.connect();
    let changing: Promise<unknown> | undefined;
    let editing: Promise<unknown> | undefined;
    try {
      await gate.query('BEGIN');
      await gate.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [goal.id]);
      const gatePid = await pidOf(gate);
      changing = withTenant(tenant.tenantId, () => saveGeneralSettings({ application_timezone: 'Pacific/Kiritimati' }, { application_timezone: 'UTC' }, tenant.userId));
      changing.catch(() => undefined);
      let changePid = 0;
      await waitUntil(async () => {
        [changePid = 0] = await waitersOf(gatePid);
        return changePid !== 0;
      });
      editing = tenant.pool.query(`UPDATE budget_items SET expense_type = 'Savings', type = 'Goal', subtype = 'Goal' WHERE id = $1`, [item.id]);
      editing.catch(() => undefined);
      // The edit waits for the change (before, it went through, a goal the change hadn't locked).
      let settled = false;
      void editing.then(() => (settled = true), () => (settled = true));
      await waitUntil(async () => settled || (await waitersOf(changePid)).length > 0);
      expect(settled).toBe(false);
      await gate.query('COMMIT');
    } finally {
      await gate.query('ROLLBACK').catch(() => undefined);
      gate.release();
    }
    await changing;
    await editing;
    expect((await one<{ type: string }>('SELECT type FROM budget_items WHERE id = $1', [item.id])).type).toBe('Goal');
  }, 30_000);
});
