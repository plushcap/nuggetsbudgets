import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The household's today: mid-November, so "two months ahead" crosses into the next year.
vi.mock('../../utils/appDate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/appDate.js')>()),
  appToday: async () => '2026-11-15',
}));

import globalPool from '../../db.js';
import { withTenant } from '../../db/withTenant.js';
import { ImportService } from '../../services/ImportService.js';
import type { BudgetPeriodResolver } from '../../services/import/BudgetPeriodResolver.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A sync makes the budget period for a transaction's month up to two months after today's.
 * The limit was year * 100 + month plus 2, so from November it reached 202613, a month that
 * doesn't exist, and January (202701) was refused: a January transaction synced in November
 * or December got no budget period.
 */
describe('A sync makes budget periods up to two months ahead, across a new year', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('Import period months ahead');
    await tenant.pool.query(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ('Nov 2026', 'November', 2026, 11, '2026-11-01', '2026-11-30')`
    );
    // A sync makes periods as the ledger's import user.
    await tenant.pool.query(
      `INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_user_id', $1)`,
      [String(tenant.userId)]
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const periodFor = async (day: string) => {
    const resolver = (new ImportService(globalPool) as unknown as { periods: BudgetPeriodResolver }).periods;
    // As a sync makes them, before it locks any transaction (preparePeriods).
    return withTenant(tenant.tenantId, () => resolver.findBudgetPeriodForDate(day, { create: 'wait' }));
  };

  it("makes January's period in November, and not March's", async () => {
    expect(await periodFor('2027-01-10')).toEqual(expect.any(Number));
    expect(await periodFor('2027-03-10')).toBeNull();
    const made = await tenant.pool.query<{ year: number; month_number: number }>(
      'SELECT year, month_number FROM budget_period ORDER BY start_date'
    );
    expect(made.rows.map((r) => `${r.year}-${r.month_number}`)).toContain('2027-1');
    expect(made.rows.map((r) => `${r.year}-${r.month_number}`)).not.toContain('2027-3');
  });
});
