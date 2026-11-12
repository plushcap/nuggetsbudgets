import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

// Mock database setup. Hoisted so the vi.mock factory below can reference mockPool.
const { mockPool, mockClient } = vi.hoisted(() => ({
  mockPool: {
    connect: vi.fn(),
    query: vi.fn(),
    end: vi.fn(),
  },
  mockClient: {
    query: vi.fn(),
    release: vi.fn(),
  },
}));

// BudgetService now reads/writes via the request transaction (getDb()). Back
// getDb() with the mocked pool so the SQL-string mocks below still apply.
vi.mock('../../db/withTenant.js', () => ({
  getDb: () => new Kysely({ dialect: new PostgresDialect({ pool: mockPool as unknown as Pool }) }),
}));

import { BudgetService } from '../../services/BudgetService.js';

// Transaction control statements are issued as plain query() calls; treat them
// as no-ops so the data-query routing below is independent of call order.
// Kysely issues them lowercase ('begin'/'commit'/'rollback').
const isTxControl = (sql: string) => {
  const s = sql.toLowerCase();
  return s === 'begin' || s === 'commit' || s === 'rollback';
};

describe('BudgetService', () => {
  let budgetService: BudgetService;

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so per-test mockImplementation/Once
    // queues do not leak between tests.
    vi.resetAllMocks();
    budgetService = new BudgetService();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  // updateBudgetAmount and transferBetweenBudgetItems lock rows and read the log
  // they write to, which mocked SQL can't show: they're tested on the database,
  // through their routes (routes/__tests__/budgets.test.ts, budgetEventLog.test.ts).

  describe('createBudgetPeriod', () => {
    it('should successfully create a new budget period', async () => {
      const year = 2025;
      const month = 10;
      const userId = 1;
      const autoRollover = true;

      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        if (sql.includes('SELECT id FROM budget_period WHERE year')) {
          return Promise.resolve({ rows: [] }); // No existing period
        }
        if (sql.includes('create_budget_period_with_items')) {
          return Promise.resolve({ rows: [{ period_id: 15 }] });
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '5' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await budgetService.createBudgetPeriod(year, month, userId, autoRollover);

      expect(result).toEqual({
        periodId: 15,
        budgetItemsCreated: 5,
        created: true
      });

      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT id FROM budget_period WHERE year = $1 AND month_number = $2',
        [year, month]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT create_budget_period_with_items($1, $2, $3, $4) as period_id',
        [year, month, userId, autoRollover]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT COUNT(*) as count FROM budget_period_items WHERE budget_period_id = $1',
        [15]
      );
    });

    it('returns the existing period instead of creating a second one', async () => {
      const year = 2025;
      const month = 10;

      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        if (sql.includes('SELECT id FROM budget_period WHERE year')) {
          return Promise.resolve({ rows: [{ id: 10 }] }); // Period already exists
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(budgetService.createBudgetPeriod(year, month))
        .resolves.toEqual({ periodId: 10, budgetItemsCreated: 0, created: false });

      expect(mockClient.query).not.toHaveBeenCalledWith(expect.stringContaining('create_budget_period_with_items'), expect.anything());
      expect(mockClient.release).toHaveBeenCalled();
    });

    it('returns the period a concurrent call created after the check (the function returns NULL)', async () => {
      let checks = 0;
      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        if (sql.includes('SELECT id FROM budget_period WHERE year')) {
          // Not there at the check; there once the insert has waited for the other call.
          return Promise.resolve({ rows: checks++ === 0 ? [] : [{ id: 12 }] });
        }
        if (sql.includes('create_budget_period_with_items')) {
          return Promise.resolve({ rows: [{ period_id: null }] });
        }
        return Promise.resolve({ rows: [] });
      });

      await expect(budgetService.createBudgetPeriod(2025, 11))
        .resolves.toEqual({ periodId: 12, budgetItemsCreated: 0, created: false });
      expect(checks).toBe(2);
    });
  });

  describe('autoCreateNextPeriod', () => {
    it('should create next month period successfully', async () => {
      const currentPeriodId = 10;
      const userId = 1;

      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        if (sql.includes('SELECT year, month_number FROM budget_period')) {
          return Promise.resolve({ rows: [{ year: 2025, month_number: 9 }] });
        }
        if (sql.includes('SELECT id FROM budget_period WHERE year')) {
          return Promise.resolve({ rows: [] }); // Doesn't exist (both checks)
        }
        if (sql.includes('create_budget_period_with_items')) {
          return Promise.resolve({ rows: [{ period_id: 11 }] });
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '3' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await budgetService.autoCreateNextPeriod(currentPeriodId, userId);

      expect(result).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT year, month_number FROM budget_period WHERE id = $1',
        [currentPeriodId]
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT id FROM budget_period WHERE year = $1 AND month_number = $2',
        [2025, 10] // Next month
      );
    });

    it('should handle year rollover correctly', async () => {
      const currentPeriodId = 10;

      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        if (sql.includes('SELECT year, month_number FROM budget_period')) {
          return Promise.resolve({ rows: [{ year: 2025, month_number: 12 }] }); // December
        }
        if (sql.includes('SELECT id FROM budget_period WHERE year')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('create_budget_period_with_items')) {
          return Promise.resolve({ rows: [{ period_id: 12 }] });
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve({ rows: [{ count: '4' }] });
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await budgetService.autoCreateNextPeriod(currentPeriodId);

      expect(result).toBe(true);
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT id FROM budget_period WHERE year = $1 AND month_number = $2',
        [2026, 1] // January of next year
      );
    });

    it('should return false if next period already exists', async () => {
      const currentPeriodId = 10;

      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        if (sql.includes('SELECT year, month_number FROM budget_period')) {
          return Promise.resolve({ rows: [{ year: 2025, month_number: 9 }] });
        }
        if (sql.includes('SELECT id FROM budget_period WHERE year')) {
          return Promise.resolve({ rows: [{ id: 15 }] }); // Next period already exists
        }
        return Promise.resolve({ rows: [] });
      });

      const result = await budgetService.autoCreateNextPeriod(currentPeriodId);

      expect(result).toBe(false);
    });

    it('should handle current period not found', async () => {
      const currentPeriodId = 999;

      mockClient.query.mockImplementation((sql: string) => {
        if (isTxControl(sql)) return Promise.resolve({});
        return Promise.resolve({ rows: [] });
      });

      const result = await budgetService.autoCreateNextPeriod(currentPeriodId);

      expect(result).toBe(false);
    });
  });
});
