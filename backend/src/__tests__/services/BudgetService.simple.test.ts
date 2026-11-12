import { describe, test, expect, vi } from 'vitest';
import { BudgetService } from '../../services/BudgetService.js';

// BudgetService now imports getDb from withTenant.js, which loads db.js (and its
// secret bootstrap). This test only instantiates the service, so stub the module
// to keep the import side-effect-free.
vi.mock('../../db/withTenant.js', () => ({ getDb: vi.fn() }));

describe('BudgetService - Simple Test', () => {
  test('should create BudgetService instance', () => {
    const budgetService = new BudgetService();
    
    expect(budgetService).toBeDefined();
    expect(budgetService).toBeInstanceOf(BudgetService);
  });
});
