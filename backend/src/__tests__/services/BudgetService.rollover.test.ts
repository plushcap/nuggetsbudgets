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
const isTxControl = (sql: string) =>
  sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK';

describe('BudgetService - Rollover Calculations', () => {
  let budgetService: BudgetService;

  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) so per-test mockImplementation queues
    // do not leak between tests.
    vi.resetAllMocks();
    budgetService = new BudgetService();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  describe('Rollover Logic Tests', () => {
    describe('Period Creation with Rollover', () => {
      it('should create period with rollover enabled', async () => {
        const year = 2025;
        const month = 12;
        const userId = 1;

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

        const result = await budgetService.createBudgetPeriod(year, month, userId, true);

        expect(result).toEqual({
          periodId: 15,
          budgetItemsCreated: 5,
          created: true
        });

        // Verify rollover was enabled in the period creation call
        expect(mockClient.query).toHaveBeenCalledWith(
          'SELECT create_budget_period_with_items($1, $2, $3, $4) as period_id',
          [year, month, userId, true] // autoRollover = true
        );
      });

      it('should create period without rollover when disabled', async () => {
        const year = 2025;
        const month = 12;
        const userId = 1;

        mockClient.query.mockImplementation((sql: string) => {
          if (isTxControl(sql)) return Promise.resolve({});
          if (sql.includes('SELECT id FROM budget_period WHERE year')) {
            return Promise.resolve({ rows: [] });
          }
          if (sql.includes('create_budget_period_with_items')) {
            return Promise.resolve({ rows: [{ period_id: 16 }] });
          }
          if (sql.includes('COUNT(*)')) {
            return Promise.resolve({ rows: [{ count: '4' }] });
          }
          return Promise.resolve({ rows: [] });
        });

        const result = await budgetService.createBudgetPeriod(year, month, userId, false);

        expect(result.periodId).toBe(16);
        expect(mockClient.query).toHaveBeenCalledWith(
          'SELECT create_budget_period_with_items($1, $2, $3, $4) as period_id',
          [year, month, userId, false] // autoRollover = false
        );
      });
    });

    // A budget update and a transfer, and the rollover after them, are tested on the
    // database, through their routes (routes/__tests__/budgets.test.ts and
    // budgetEventLog.test.ts): mocked SQL can't show the locks or the figures.
  });
});
