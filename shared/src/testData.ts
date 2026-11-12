import { z } from 'zod';
import { nullableResponseAmount } from './responses.js';

/**
 * Test data a deployment admin makes outside production (/api/admin/test-data, dev tooling,
 * mounted only with ENABLE_TEST_DATA): the answers of its routes.
 */

// ---- Test data (/api/admin/test-data) -------------------------------------------------

const testCategory = z.object({
  id: z.number().int(),
  name: z.string(),
  description: z.string().nullable(),
  priority: z.string().nullable(),
});
const testInstitution = z.object({ id: z.number().int(), name: z.string(), notes: z.string().nullable() });
const testAccount = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  name: z.string(),
  account_group: z.string(),
  account_type: z.string(),
});
const testPeriod = z.object({ year: z.number().int(), monthNumber: z.number().int(), periodId: z.number().int() });
const testBudgetItem = z.object({
  id: z.number().int(),
  name: z.string(),
  expense_type: z.string().nullable(),
  default_budget_amount: nullableResponseAmount,
});

/** POST /api/admin/test-data/categories: the categories it made (one that existed is left out). */
export const testCategoriesResponseSchema = z.object({
  message: z.string(),
  categories: z.array(testCategory),
  totalCreated: z.number().int(),
});
/** POST /api/admin/test-data/account-institutions. */
export const testInstitutionsResponseSchema = z.object({
  message: z.string(),
  institutions: z.array(testInstitution),
  totalCreated: z.number().int(),
});
/** POST /api/admin/test-data/accounts. */
export const testAccountsResponseSchema = z.object({
  message: z.string(),
  accounts: z.array(testAccount),
  totalCreated: z.number().int(),
});
/** POST /api/admin/test-data/budget-periods. */
export const testBudgetPeriodsResponseSchema = z.object({ message: z.string(), periods: z.array(testPeriod) });
/** POST /api/admin/test-data/budget-items: the newest four. */
export const testBudgetItemsResponseSchema = z.object({ message: z.string(), budgetItems: z.array(testBudgetItem) });
/** POST /api/admin/test-data/transactions. */
export const testTransactionsResponseSchema = z.object({ message: z.string(), transactionsCreated: z.number().int() });
/** POST /api/admin/test-data/generate-all: everything it made. */
export const testDataGeneratedResponseSchema = z.object({
  message: z.string(),
  results: z.object({
    categories: z.array(testCategory),
    institutions: z.array(testInstitution),
    accounts: z.array(testAccount),
    periods: z.array(testPeriod),
    budgetItems: z.array(testBudgetItem),
    transactionsCreated: z.number().int(),
  }),
});
/** DELETE /api/admin/test-data/clear-all. */
export const testDataClearedResponseSchema = z.object({ message: z.string() });
