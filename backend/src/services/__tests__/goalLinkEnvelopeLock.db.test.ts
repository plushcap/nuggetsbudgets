import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The app pool's lock_timeout, short here so a wait for a held goal ends in this test's time
// (and still longer than deadlock_timeout); db.ts reads it as it's imported.
const previousLockTimeout = vi.hoisted(() => {
  const previous = process.env.DB_LOCK_TIMEOUT_MS;
  process.env.DB_LOCK_TIMEOUT_MS = '3000';
  return previous;
});

import type { PoolClient } from 'pg';
import { sql } from 'kysely';
import { getDb, withTenant } from '../../db/withTenant.js';
import { GoalService } from '../GoalService.js';
import { BudgetItemArchiveService } from '../budgetItems/BudgetItemArchiveService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Linking an envelope to a goal locks the envelope and refuses an archived one.
 * It locked only the goal: a link made while a merge of the envelope ran waited for nothing
 * (its foreign key takes FOR KEY SHARE, which the merge's lock on the item allows), so the
 * merge moved the goal links it had read and archived the item, and the new link stayed open
 * on the archived item. The race is driven with the merge held open before it commits.
 *
 * The link takes the goal's and the envelope's rows in id order, as a merge takes its two items:
 * taking the envelope first deadlocked with a merge of the envelope into that
 * goal when the goal's id was lower, a 500. A merge of an item the goal links into the envelope
 * takes the goal with its two items, so that one waits too. A lock conflict is a 409 to try
 * again, never a 500.
 */
describe('linking an envelope to a goal', () => {
  let tenant: TestTenant;
  let seq = 0;
  type Ref = { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Goal link envelope lock');
  });

  afterAll(async () => {
    await tenant?.cleanup();
    if (previousLockTimeout === undefined) delete process.env.DB_LOCK_TIMEOUT_MS;
    else process.env.DB_LOCK_TIMEOUT_MS = previousLockTimeout;
  });

  const one = async (text: string, params: unknown[] = []) => (await tenant.pool.query<Ref>(text, params)).rows[0]!;
  const envelope = (status = 'active') =>
    one(`INSERT INTO budget_items (name, expense_type, type, rollover, status) VALUES ($1, 'Expense', 'Envelope', true, $2) RETURNING id, uuid`, [
      `Lock envelope ${++seq}`,
      status,
    ]);
  const goal = () =>
    one(`INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount, goal_target_date)
         VALUES ($1, 'Savings', 'Goal', 'Goal', 1000, '2027-06-30') RETURNING id, uuid`, [`Lock goal ${++seq}`]);
  const openLinks = async (g: Ref) =>
    (await tenant.pool.query<{ budget_item_id: number }>('SELECT budget_item_id FROM goal_budget_items WHERE goal_id = $1 AND valid_to IS NULL', [g.id])).rows;
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (err: { status?: number; code?: string }) => `${err.status} ${err.code}`
    );
  const link = (g: Ref, item: Ref) => withTenant(tenant.tenantId, () => new GoalService().associateBudgetItem(g.id, item.id));
  const merge = (from: Ref, into: Ref) => withTenant(tenant.tenantId, () => new BudgetItemArchiveService().merge(from.uuid, into.uuid, false, tenant.userId));
  /** A session in the tenant, in a transaction, and its pid. */
  const session = async (): Promise<{ client: PoolClient; pid: number }> => {
    const client = await tenant.pool.connect();
    await client.query('BEGIN');
    return { client, pid: (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid };
  };
  /** Wait until `count` sessions wait for `pid`, directly or behind each other. */
  const waitForWaiters = async (pid: number, count: number) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const { n } = (
        await tenant.pool.query<{ n: number }>(
          `WITH RECURSIVE waiting(pid) AS (
             SELECT pid FROM pg_stat_activity WHERE $1 = ANY (pg_blocking_pids(pid))
             UNION
             SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY (pg_blocking_pids(a.pid))
           ) SELECT count(*)::int AS n FROM waiting`,
          [pid]
        )
      ).rows[0]!;
      if (n >= count) return;
      if (Date.now() > deadline) throw new Error(`only ${n} of ${count} sessions waited`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  /** What a call ended with: ok, a refusal's status and code, or an error's class and code. */
  const ending = (promise: Promise<unknown>) =>
    promise.then(
      () => 'ok',
      (err: { status?: number; code?: string; constructor: { name: string } }) =>
        err.status !== undefined ? `${err.status} ${err.code}` : `${err.constructor.name} ${err.code ?? ''}`.trim()
    );

  it('refuses an archived envelope', async () => {
    const g = await goal();
    const archived = await envelope('archived');
    expect(await refusal(link(g, archived))).toBe('400 BUDGET_ITEM_ARCHIVED');
    expect(await openLinks(g)).toEqual([]);
  });

  it('links an active envelope', async () => {
    const g = await goal();
    const item = await envelope();
    expect(await refusal(link(g, item))).toBeNull();
    expect(await openLinks(g)).toEqual([{ budget_item_id: item.id }]);
  });

  it('made during a merge of the envelope, waits for it and is refused, leaving no link on the archived item', async () => {
    const g = await goal();
    const merged = await envelope();
    const into = await envelope();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let reached!: (pid: number) => void;
    const mergedNotCommitted = new Promise<number>((resolve) => (reached = resolve));
    const merging = withTenant(tenant.tenantId, async () => {
      await new BudgetItemArchiveService().merge(merged.uuid, into.uuid, false, tenant.userId);
      reached((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(getDb())).rows[0]!.pid);
      await released;
    });
    let linking: Promise<string | null> | undefined;
    try {
      const pid = await mergedNotCommitted;
      linking = refusal(link(g, merged));
      // The link waits for the merge. It didn't: it was made at once, and committed.
      const deadline = Date.now() + 5_000;
      let waited = false;
      let settled = false;
      void linking.then(() => (settled = true));
      while (!waited && !settled && Date.now() < deadline) {
        waited = (await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount! > 0;
        if (!waited) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect.soft(waited).toBe(true);
    } finally {
      release();
      await merging;
    }
    expect(await linking).toBe('400 BUDGET_ITEM_ARCHIVED');
    expect(await openLinks(g)).toEqual([]);
  });

  it('made while the envelope is merged into that goal (the goal\'s id lower), waits for the merge and is refused', async () => {
    const g = await goal();
    const e = await envelope();
    expect(g.id).toBeLessThan(e.id);
    // Something holds the goal's row (another change of its links), so the merge, then the link, queue on it.
    const holder = await session();
    let merging: Promise<string> | undefined;
    let linking: Promise<string> | undefined;
    try {
      await holder.client.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [g.id]);
      merging = ending(merge(e, g));
      await waitForWaiters(holder.pid, 1);
      linking = ending(link(g, e));
      await waitForWaiters(holder.pid, 2);
    } finally {
      await holder.client.query('ROLLBACK').catch(() => undefined);
      holder.client.release();
    }
    // The link took the envelope first, then waited for the goal the merge held, while the merge
    // waited for the envelope: a deadlock, which the link answered with a 500.
    expect({ merge: await merging, link: await linking }).toEqual({ merge: 'ok', link: '400 BUDGET_ITEM_ARCHIVED' });
    expect(await openLinks(g)).toEqual([]);
  }, 30_000);

  it('made while an item the goal links is merged into the envelope, waits for the merge, and both finish', async () => {
    // The goal links F, and is linked to E while F is merged into E. The merge took F and E, then
    // (moving the goal's link) the goal; the link takes the goal, then E: each held what the other
    // waited for, a deadlock Postgres broke by failing one (a 409). The merge now takes the goals
    // linking F with F and E, in id order.
    const g = await goal();
    const f = await envelope();
    const e = await envelope();
    expect(g.id).toBeLessThan(e.id);
    await tenant.pool.query('INSERT INTO goal_budget_items (goal_id, budget_item_id) VALUES ($1, $2)', [g.id, f.id]);
    const period = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('Lock period', 'January', 2099, 1, '2099-01-01', '2099-01-31') RETURNING id`
      )
    ).rows[0]!.id;
    const fRow = (await tenant.pool.query<{ id: number }>('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id', [period, f.id])).rows[0]!.id;
    // Hold F's period row, which the merge locks after its items and before it moves the goal's link.
    const holder = await session();
    let merging: Promise<string> | undefined;
    let linking: Promise<string> | undefined;
    try {
      await holder.client.query('SELECT id FROM budget_period_items WHERE id = $1 FOR UPDATE', [fRow]);
      merging = ending(merge(f, e));
      await waitForWaiters(holder.pid, 1);
      linking = ending(link(g, e));
      // The link waits behind the merge (before, it held the goal and waited for E).
      await waitForWaiters(holder.pid, 2);
    } finally {
      await holder.client.query('ROLLBACK').catch(() => undefined);
      holder.client.release();
    }
    expect({ merge: await merging, link: await linking }).toEqual({ merge: 'ok', link: 'ok' });
    // The goal links E (the merge moved F's link to it, and the link found it there), not F.
    expect(await openLinks(g)).toEqual([{ budget_item_id: e.id }]);
  }, 30_000);

  it("a change of a goal's links that waits past the lock timeout for the goal is a 409, not a 500", async () => {
    const g = await goal();
    const e = await envelope();
    const holder = await session();
    try {
      await holder.client.query('SELECT id FROM budget_items WHERE id = $1 FOR NO KEY UPDATE', [g.id]);
      const unlinking = withTenant(tenant.tenantId, () => new GoalService().removeBudgetItemAssociation(g.id, e.id));
      expect(await ending(unlinking)).toBe('409 RECORD_BUSY');
    } finally {
      await holder.client.query('ROLLBACK').catch(() => undefined);
      holder.client.release();
    }
  }, 30_000);
});
