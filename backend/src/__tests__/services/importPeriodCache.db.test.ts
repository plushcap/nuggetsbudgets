import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import globalPool from '../../db.js';
import { withTenant } from '../../db/withTenant.js';
import { ImportService } from '../../services/ImportService.js';
import type { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The import routes share one ImportService, so two ledgers' manual syncs can run at
 * once. Its budget period cache was one map, so the second sync to start replaced the
 * first's, and the first ledger's transactions got the second ledger's budget periods.
 */
describe("ImportService's budget period cache", () => {
  let a: TestTenant;
  let b: TestTenant;
  const periods: Record<string, number> = {};

  beforeAll(async () => {
    a = await createTestTenant('Import period cache A');
    b = await createTestTenant('Import period cache B');
    for (const [name, tenant] of [['a', a], ['b', b]] as const) {
      periods[name] = (
        await tenant.pool.query(
          `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
           VALUES ('Oct 2026', 'October', 2026, 10, '2026-10-01', '2026-10-31') RETURNING id`
        )
      ).rows[0].id;
    }
  });

  afterAll(async () => {
    await a?.cleanup();
    await b?.cleanup();
  });

  it("keeps each ledger's budget periods apart", async () => {
    const service = new ImportService(globalPool);
    const internals = (service as unknown as { periods: BudgetPeriodResolver }).periods;
    // A's sync loads its cache, then B's sync starts and loads B's.
    await withTenant(a.tenantId, () => internals.loadBudgetPeriodCache());
    await withTenant(b.tenantId, () => internals.loadBudgetPeriodCache());

    const date = '2026-10-15';
    expect(await withTenant(a.tenantId, () => internals.findBudgetPeriodForDate(date))).toBe(periods.a);
    expect(await withTenant(b.tenantId, () => internals.findBudgetPeriodForDate(date))).toBe(periods.b);
  });
});
