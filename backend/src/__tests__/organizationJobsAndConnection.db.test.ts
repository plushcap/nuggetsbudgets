import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import { globalDb, withTenant } from '../db/withTenant.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';
import { getConnectionForTenant } from '../services/OrganizationSimpleFinService.js';
import { PriceSyncService } from '../services/investments/PriceSyncService.js';

/**
 * Two organization leftovers from earlier work:
 *
 * - The price-sync scheduler's list of enabled organizations (listEnabledSettings) took
 *   every organization, a suspended or deleted one too, while the ledger jobs take only
 *   active ledgers of active organizations (getActiveTenantIds).
 * - getConnectionForTenant, called inside the ledger's own transaction (linking an account
 *   to the bank), read `tenants` on a second pooled connection to find the organization the
 *   transaction had already set.
 *
 * Other files' organizations share the database, so the scheduler's list is checked for
 * these organizations only (in it or not), never as a whole.
 */
describe('organization jobs and the ledger transaction', () => {
  let owner: Pool;
  let active: TestTenant;
  let suspended: TestTenant;
  let deleted: TestTenant;
  let connectionId: number;

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
    active = await createTestTenant('Org jobs active');
    suspended = await createTestTenant('Org jobs suspended');
    deleted = await createTestTenant('Org jobs deleted');
    for (const t of [active, suspended, deleted]) {
      await owner.query(
        `INSERT INTO organization_price_sync_settings (organization_id, enabled, schedule_time, timezone) VALUES ($1, true, '00:00', 'UTC')`,
        [t.organizationId]
      );
    }
    await owner.query(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [suspended.organizationId]);
    await owner.query(`UPDATE organizations SET status = 'deleted' WHERE id = $1`, [deleted.organizationId]);
    connectionId = (
      await owner.query<{ id: number }>(
        `INSERT INTO organization_simplefin_connections (organization_id, access_url, label) VALUES ($1, 'sealed', 'Org jobs') RETURNING id`,
        [active.organizationId]
      )
    ).rows[0].id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await owner?.query(`UPDATE organizations SET status = 'active' WHERE id = ANY($1)`, [[suspended?.organizationId, deleted?.organizationId]]);
    await owner?.end();
    await active?.cleanup();
    await suspended?.cleanup();
    await deleted?.cleanup();
  });

  it("lists the price sync of active organizations only, as the ledger jobs take active ledgers", async () => {
    const listed = (await new PriceSyncService().listEnabledSettings()).map((s) => s.organization_id);
    expect(listed).toContain(active.organizationId);
    expect(listed).not.toContain(suspended.organizationId);
    expect(listed).not.toContain(deleted.organizationId);
  });

  it("finds the connection inside the ledger's transaction from the organization it set, with no second query", async () => {
    const selectFrom = vi.spyOn(globalDb, 'selectFrom');
    const inside = await withTenant(active.tenantId, () => getConnectionForTenant(active.tenantId));
    expect(inside?.id).toBe(connectionId);
    expect(selectFrom).not.toHaveBeenCalled();

    // Outside one (and for another ledger than the open one's), it reads `tenants` first, as before.
    expect((await getConnectionForTenant(active.tenantId))?.id).toBe(connectionId);
    expect(selectFrom).toHaveBeenCalledWith('tenants');
    // A ledger with no connection, and one that doesn't exist, have none, in its transaction or not.
    expect(await getConnectionForTenant(suspended.tenantId)).toBeUndefined();
    expect(await withTenant(suspended.tenantId, () => getConnectionForTenant(suspended.tenantId))).toBeUndefined();
    expect(await getConnectionForTenant(2147483000)).toBeUndefined();
    expect(await withTenant(2147483000, () => getConnectionForTenant(2147483000))).toBeUndefined();
  });
});
