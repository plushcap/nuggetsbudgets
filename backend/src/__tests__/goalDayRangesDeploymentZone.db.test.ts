import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// A held lock answers in half a second, not the pool's 15.
vi.hoisted(() => {
  process.env.DB_LOCK_TIMEOUT_MS = '500';
});

import { clampTenantOnDeploymentZone, clampTenantsOnDeploymentZone, everyTenantId } from '../services/goalDayRanges.js';
import { getActiveTenantIds } from '../db/forEachTenant.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A change of the deployment's time zone moves today for every ledger without a zone of its own
 * (app_timezone() falls back to system_settings), and left the goal history's ranges written in
 * the old zone after the new today: only a ledger's own zone change clamped
 * them. clampTenantOnDeploymentZone, which the deployment-settings route runs for every active
 * ledger once the zone is written, clamps a ledger that follows the deployment's zone and leaves
 * one with its own alone. The route runs it on every save of the zone, for every ledger, a
 * suspended one's too, and counts the ledgers it couldn't clamp, which the next save clamps.
 *
 * The deployment's zone is every test file's, so it isn't changed here: the ranges are written
 * with days after today, as a zone ahead of the current one left them.
 */
describe("clampTenantOnDeploymentZone: a ledger following the deployment's zone", () => {
  let follows: TestTenant;
  let own: TestTenant;
  let busy: TestTenant;
  let suspended: TestTenant;

  beforeAll(async () => {
    follows = await createTestTenant('Deployment zone clamp');
    own = await createTestTenant('Deployment zone clamp, own zone');
    await own.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('application_timezone', 'Pacific/Kiritimati')`);
    busy = await createTestTenant('Deployment zone clamp, busy');
    suspended = await createTestTenant('Deployment zone clamp, suspended');
    await suspended.pool.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [suspended.organizationId]);
  });

  afterAll(async () => {
    await follows?.cleanup();
    await own?.cleanup();
    await busy?.cleanup();
    await suspended?.cleanup();
  });

  /** A goal with three account links and a hidden range, their days after the ledger's today. */
  async function rangesAfterToday(t: TestTenant) {
    const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await t.pool.query(text, params)).rows[0] as T;
    const today = (await one<{ d: string }>('SELECT app_today()::text AS d')).d;
    const goal = await one<{ id: number }>(
      `INSERT INTO budget_items (name, expense_type, type, subtype, goal_target_amount) VALUES ('House', 'Savings', 'Goal', 'Goal', 1000) RETURNING id`
    );
    const account = async (name: string) =>
      (await one<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'savings', 'cash', 'Asset') RETURNING id`, [name])).id;
    const [removed, added, ahead, hidden] = [await account('Removed'), await account('Added'), await account('Ahead'), await account('Hidden')];
    await t.pool.query(
      `INSERT INTO budget_item_accounts (budget_item_id, account_id, valid_from, valid_to) VALUES
         ($1, $2, '2020-01-01', $6::date + 1), ($1, $3, $6::date + 1, NULL), ($1, $4, $6::date + 1, $6::date + 2), ($1, $5, '2020-01-01', NULL)`,
      [goal.id, removed, added, ahead, hidden, today]
    );
    await t.pool.query(`INSERT INTO account_hidden_ranges (account_id, hidden_from) VALUES ($1, $2::date + 1)`, [hidden, today]);
    const read = async () => ({
      links: (await t.pool.query(
        'SELECT account_id, valid_from::text, valid_to::text FROM budget_item_accounts WHERE budget_item_id = $1 ORDER BY account_id', [goal.id]
      )).rows,
      hidden: (await t.pool.query('SELECT account_id, hidden_from::text, hidden_to::text FROM account_hidden_ranges ORDER BY account_id')).rows,
    });
    return { today, removed, added, hidden, read };
  }

  it('clamps a ledger without a zone of its own to its today', async () => {
    const { today, removed, added, hidden, read } = await rangesAfterToday(follows);
    expect(await clampTenantOnDeploymentZone(follows.tenantId)).toEqual({ linksDeleted: 1, linksMoved: 2, hiddenRangesDeleted: 0, hiddenRangesMoved: 1 });
    expect(await read()).toEqual({
      links: [
        { account_id: removed, valid_from: '2020-01-01', valid_to: today },
        { account_id: added, valid_from: today, valid_to: null },
        { account_id: hidden, valid_from: '2020-01-01', valid_to: null },
      ],
      hidden: [{ account_id: hidden, hidden_from: today, hidden_to: null }],
    });
    // Again: nothing left to clamp.
    expect(await clampTenantOnDeploymentZone(follows.tenantId)).toEqual({ linksDeleted: 0, linksMoved: 0, hiddenRangesDeleted: 0, hiddenRangesMoved: 0 });
  });

  it("clamps a ledger it couldn't clamp the next time: it counts it, and a run again clamps it", async () => {
    const { today, added, read } = await rangesAfterToday(busy);
    const before = await read();
    // A write holding one of the ledger's accounts (as hiding one does) past the lock timeout.
    const holder = await busy.pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM accounts WHERE id = $1 FOR NO KEY UPDATE', [added]);
      expect(await clampTenantsOnDeploymentZone([busy.tenantId])).toEqual({ total: 1, failed: 1 });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await read()).toEqual(before);
    // Saved again: clamped.
    expect(await clampTenantsOnDeploymentZone([busy.tenantId])).toEqual({ total: 1, failed: 0 });
    const after = await read();
    expect(after.links.find((l) => l.account_id === added)).toEqual({ account_id: added, valid_from: today, valid_to: null });
    expect(after.links.every((l) => l.valid_from <= today && (l.valid_to === null || l.valid_to <= today))).toBe(true);
  });

  it("clamps a suspended organization's ledger too", async () => {
    expect(await getActiveTenantIds()).not.toContain(suspended.tenantId);
    expect(await everyTenantId()).toContain(suspended.tenantId);
    const { today, added, read } = await rangesAfterToday(suspended);
    expect(await clampTenantsOnDeploymentZone([suspended.tenantId])).toEqual({ total: 1, failed: 0 });
    expect((await read()).links.find((l) => l.account_id === added)).toEqual({ account_id: added, valid_from: today, valid_to: null });
  });

  it('leaves a ledger with its own zone alone', async () => {
    const { read } = await rangesAfterToday(own);
    const before = await read();
    expect(await clampTenantOnDeploymentZone(own.tenantId)).toBeNull();
    expect(await read()).toEqual(before);
  });
});
