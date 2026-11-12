import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import type { PoolClient } from 'pg';
import { withTenant } from '../db/withTenant.js';
import { saveGeneralSettings } from '../services/generalSettings.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A ledger's time zone change and a goal or an account added at the same moment. The change
 * locks every goal and account, writes the zone and clamps the goal history's ranges to the new
 * today, but a row not yet committed can't be locked: a goal created and linked in
 * one transaction, or an account created hidden, wrote its range's first day in the old zone and
 * committed after the clamp, a day after the new today. An insert now holds the ledger's
 * day-ranges lock shared, and the change waits for it, then clamps the new rows with the rest.
 *
 * Kiritimati (UTC+14) is always a day or two ahead of Pago Pago (UTC-11).
 */
describe('A time zone change and a goal or account being added', () => {
  const AHEAD = 'Pacific/Kiritimati';
  const BEHIND = 'Pacific/Pago_Pago';
  let tenant: TestTenant;

  const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const today = async () => (await one<{ d: string }>('SELECT app_today()::text AS d')).d;
  const setZone = (zone: string, stored: string | null) =>
    withTenant(tenant.tenantId, () => saveGeneralSettings({ application_timezone: zone }, { application_timezone: stored }, tenant.userId));
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  /** 'waited' once a backend waits for `pid`, or 'went through' once `pending` settled without. */
  const waitedFor = async (pending: Promise<unknown>, pid: number): Promise<'waited' | 'went through'> => {
    let settled = false;
    void pending.then(() => (settled = true), () => (settled = true));
    const deadline = Date.now() + 10_000;
    for (;;) {
      if ((await waitersOf(pid)).length > 0) return 'waited';
      if (settled) return 'went through';
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  /** A session in the ledger, in a transaction, and its pid. */
  const session = async (): Promise<{ client: PoolClient; pid: number }> => {
    const client = await tenant.pool.connect();
    await client.query('BEGIN');
    return { client, pid: (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid };
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Zone change and new rows');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('clamps a goal created and linked while the zone changes, and an account created and hidden', async () => {
    await setZone(AHEAD, null);
    const k = await today();
    const account = await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Savings', 'savings', 'cash', 'Asset') RETURNING id`);

    // A request creates a goal and links the account to it from today (Kiritimati's), and
    // creates an account and hides it from today, not committed yet.
    const adding = await session();
    let changing: Promise<unknown> | undefined;
    let goalId: number;
    let hiddenId: number;
    try {
      goalId = (await adding.client.query<{ id: number }>(
        `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('Boat', 'Savings', 'Goal', 'Goal', 5000) RETURNING id`
      )).rows[0]!.id;
      await adding.client.query('INSERT INTO budget_item_accounts (budget_item_id, account_id) VALUES ($1, $2)', [goalId, account.id]);
      hiddenId = (await adding.client.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Hidden', 'savings', 'cash', 'Asset') RETURNING id`
      )).rows[0]!.id;
      await adding.client.query('UPDATE accounts SET hide_account = true WHERE id = $1', [hiddenId]);
      const written = (await adding.client.query<{ d: string }>('SELECT valid_from::text AS d FROM budget_item_accounts WHERE budget_item_id = $1', [goalId])).rows[0]!.d;
      expect(written).toBe(k);

      // The zone moves today back. It waits for the request (it went through, and clamped
      // nothing it couldn't see).
      changing = setZone(BEHIND, AHEAD);
      changing.catch(() => undefined);
      expect(await waitedFor(changing, adding.pid)).toBe('waited');
      await adding.client.query('COMMIT');
    } finally {
      await adding.client.query('ROLLBACK').catch(() => undefined);
      adding.client.release();
    }
    await changing;
    const n = await today();
    expect(n < k).toBe(true);
    // The link and the hidden range start on the new today, not after it.
    expect((await one<{ d: string }>('SELECT valid_from::text AS d FROM budget_item_accounts WHERE budget_item_id = $1', [goalId])).d).toBe(n);
    expect(await one('SELECT hidden_from::text, hidden_to::text FROM account_hidden_ranges WHERE account_id = $1', [hiddenId])).toEqual({ hidden_from: n, hidden_to: null });
  });

  it('a budget item added once the change holds the lock waits for it', async () => {
    await setZone(AHEAD, BEHIND);
    // Something holds a goal, so the change waits there, holding the day-ranges lock.
    const item = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('Held', 'Savings', 'Goal', 'Goal', 100) RETURNING id`
    );
    const holder = await session();
    let changing: Promise<unknown> | undefined;
    let creating: Promise<unknown> | undefined;
    try {
      await holder.client.query('SELECT id FROM budget_items WHERE id = $1 FOR UPDATE', [item.id]);
      changing = setZone(BEHIND, AHEAD);
      changing.catch(() => undefined);
      expect(await waitedFor(changing, holder.pid)).toBe('waited');
      creating = tenant.pool.query(`INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('Car', 'Savings', 'Goal', 'Goal', 900)`);
      creating.catch(() => undefined);
      // The insert waits behind the change.
      const deadline = Date.now() + 10_000;
      while ((await tenant.pool.query(
        `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND mode = 'ShareLock' AND classid = 1145133394 AND objid = $1`, [tenant.tenantId]
      )).rowCount === 0) {
        if (Date.now() > deadline) throw new Error('the insert never waited');
        await new Promise((r) => setTimeout(r, 20));
      }
      await holder.client.query('COMMIT');
    } finally {
      await holder.client.query('ROLLBACK').catch(() => undefined);
      holder.client.release();
    }
    await changing;
    await creating;
    expect(await one<{ n: string }>(`SELECT count(*) AS n FROM budget_items WHERE name = 'Car'`)).toEqual({ n: '1' });
  });
});
