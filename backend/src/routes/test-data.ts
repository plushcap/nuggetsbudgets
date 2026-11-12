// Admin test data generation routes. Mounted (routes.ts) behind requireDeploymentAdmin, and
// in production only when ENABLE_TEST_DATA=true. Every query runs on the request's tenant
// transaction (getDb()).
import { Router } from 'express';
import { sql, type Selectable } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { tenantHandler, type AuthenticatedRequest } from '../utils/routeHandler.js';
import { getDb, withSavepoint } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import BudgetService from '../services/BudgetService.js';
import { budgetExpenseType, assetType } from '@nuggets/shared';

const logger = createLogger({ service: 'TestDataRoute' });

/**
 * Development tooling (/api/admin/test-data): generate a ledger's worth of sample data, or
 * clear the active ledger. routes.ts mounts it outside production unless ENABLE_TEST_DATA,
 * behind authenticateToken, requireDeploymentAdmin, resolveTenant and requireTenantMember.
 */
export function createTestDataRoutes(): Router {
  const router = Router();

  // Generate test categories
  router.post('/categories', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    const categoriesData = [
      {
        name: 'Insurance',
        description: 'All Insurance',
        priority: 'Essential',
        notes: 'Must-pay expenses',
        icon: 'Home'
      },
      {
        name: 'Streaming',
        description: 'Entertainment and lifestyle services',
        priority: 'Optional',
        notes: 'Can be reduced if needed',
        icon: 'Smile'
      },
      {
        name: 'Essential Home',
        description: 'Housing-related expenses',
        priority: 'Essential',
        notes: 'Must-pay expenses',
        icon: 'Smile'
      }
    ];

    const results = [];
    for (const category of categoriesData) {
      const row = await getDb()
        .insertInto('categories')
        .values({
          name: category.name,
          description: category.description,
          priority: category.priority,
          notes: category.notes,
          icon: category.icon
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'name', 'description', 'priority'])
        .executeTakeFirst();

      if (row) {
        results.push(row);
      }
    }

    res.json({
      message: 'Test categories created successfully',
      categories: results,
      totalCreated: results.length
    });
  }));

  // Generate test account institutions
  router.post('/account-institutions', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    const institutionsData = [
      {
        name: 'Example Bank',
        notes: 'A made-up national bank'
      },
      {
        name: 'Sample Savings Bank',
        notes: 'A made-up savings bank'
      },
      {
        name: 'Acme Card Services',
        notes: 'A made-up card issuer'
      },
      {
        name: 'Example Brokerage',
        notes: 'Investment and banking services'
      },
      {
        name: 'Sample Investments',
        notes: 'Investment services and banking'
      },
      {
        name: 'Acme Credit Union',
        notes: 'A made-up credit union'
      },
      {
        name: 'Other',
        notes: 'Other financial institution not listed'
      }
    ];

    const results = [];
    for (const institution of institutionsData) {
      const row = await getDb()
        .insertInto('account_institutions')
        .values({
          name: institution.name,
          notes: institution.notes
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'name', 'notes'])
        .executeTakeFirst();

      if (row) {
        results.push(row);
      }
    }

    res.json({
      message: 'Test account institutions created successfully',
      institutions: results,
      totalCreated: results.length
    });
  }));

  // Generate test accounts
  router.post('/accounts', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    // First, get institution IDs for the test accounts
    const institutionRows = await getDb()
      .selectFrom('account_institutions')
      .select(['id', 'name'])
      .where('name', 'in', ['Example Bank', 'Example Brokerage'])
      .orderBy('name')
      .execute();

    const bankId = institutionRows.find(row => row.name === 'Example Bank')?.id;
    const brokerageId = institutionRows.find(row => row.name === 'Example Brokerage')?.id;

    if (!bankId) {
      res.status(400).json({
        error: 'Required institutions not found. Please create account institutions first.',
        code: 'MISSING_INSTITUTIONS'
      });
      return;
    }

    const accountsData = [
      {
        name: 'Example Checking',
        account_group: 'cash',
        account_type: 'checking',
        institution_id: bankId,
        type: 'Asset',
        icon: 'CreditCard'
      },
      {
        name: 'Example Savings',
        account_group: 'cash',
        account_type: 'savings',
        institution_id: bankId,
        type: 'Asset',
        icon: 'PiggyBank'
      },
      {
        name: 'Example Credit Card',
        account_group: 'credit_cards',
        account_type: 'credit_card',
        institution_id: bankId,
        type: 'Liability',
        icon: 'CreditCard'
      },
      {
        name: 'Investment Account',
        account_group: 'investments',
        account_type: 'investment',
        institution_id: brokerageId || bankId, // Fall back to the bank if the brokerage isn't found
        type: 'Asset',
        icon: 'TrendingUp'
      }
    ];

    const results = [];
    for (const account of accountsData) {
      const row = await getDb()
        .insertInto('accounts')
        .values({
          name: account.name,
          account_group: account.account_group,
          account_type: account.account_type,
          institution_id: account.institution_id,
          type: account.type,
          icon: account.icon
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'uuid', 'name', 'account_group', 'account_type'])
        .executeTakeFirst();

      if (row) {
        results.push(row);
      }
    }

    res.json({
      message: 'Test accounts created successfully',
      accounts: results,
      totalCreated: results.length
    });
  }));

  // Generate test budget periods
  router.post('/budget-periods', tenantHandler(async (req: AuthenticatedRequest, res) => {
    const { months } = req.body;

    if (!months || !Array.isArray(months)) {
      res.status(400).json({
        error: 'Months array is required',
        code: 'MISSING_MONTHS'
      });
      return;
    }

    const budgetService = new BudgetService();

    const results = [];

    for (const month of months) {
      const { year, monthNumber } = month;

      if (!year || !monthNumber) {
        res.status(400).json({
          error: 'Year and monthNumber are required for each month',
          code: 'INVALID_MONTH_DATA'
        });
        return;
      }

      const result = await budgetService.createBudgetPeriod(
        year,
        monthNumber,
        req.user.userId,
        false // auto_rollover = false for test data
      );

      results.push({
        year,
        monthNumber,
        periodId: result.periodId
      });
    }

    res.json({
      message: 'Budget periods created successfully',
      periods: results
    });
  }));

  // Generate test budget items
  router.post('/budget-items', tenantHandler(async (req: AuthenticatedRequest, res) => {
    const budgetItemsData = [
      {
        "name": "Utilities",
        "expense_type": "Expense", 
        "description": "Monthly utility bills",
        "priority": "Essential",
        "type": "Monthly",
        "subtype": "Fixed",
        "isbill": true,
        "default_budget_amount": 200.00,
        "category_id": 3,
        "icon": "Zap",
        "color": "#F59E0B"
      },
      {
        "name": "Transportation",
        "expense_type": "Expense",
        "description": "Gas and vehicle expenses", 
        "priority": "Essential",
        "type": "Monthly",
        "subtype": "Flexible",
        "isbill": false,
        "default_budget_amount": 300.00,
        "icon": "Car",
        "color": "#10B981"
      },
      {
        "name": "Insurance", 
        "expense_type": "Expense",
        "description": "Various insurance payments",
        "priority": "Essential",
        "type": "Monthly",
        "subtype": "Fixed",
        "isbill": true,
        "default_budget_amount": 180.00,
        "category_id": 1,
        "icon": "Shield", 
        "color": "#EF4444"
      },
      {
        "name": "Income",
        "expense_type": "Income",
        "description": "Salary and freelance income",
        "priority": "Essential",
        "type": "Monthly",
        "subtype": "Fixed",
        "isbill": false,
        "default_budget_amount": 5000.00,
        "icon": "DollarSign",
        "color": "#059669"
      }
    ];

    // kept as raw sql: PL/pgSQL function call
    await sql`
      SELECT bulk_create_budget_items(${JSON.stringify(budgetItemsData)}, ${req.user.userId})
    `.execute(getDb());

    // Get created budget items
    const budgetItems = await getDb()
      .selectFrom('budget_items')
      .select(['id', 'name', 'expense_type', 'default_budget_amount'])
      .orderBy('id', 'desc')
      .limit(4)
      .execute();

    res.json({
      message: 'Test budget items created successfully',
      budgetItems
    });
  }));

  // Generate test transactions
  router.post('/transactions', tenantHandler(async (req: AuthenticatedRequest, res) => {
    // First, get available accounts and budget items. The incomes go on the first account
    // that isn't a liability: a liability account takes no income, which the
    // database refuses.
    const accounts = await getDb().selectFrom('accounts').select('id').orderBy('id').limit(4).execute();
    const incomeAccount = await getDb()
      .selectFrom('accounts')
      .select('id')
      .where('type', '<>', assetType.enum.Liability)
      .orderBy('id')
      .limit(1)
      .executeTakeFirst();
    const budgetItems = await getDb()
      .selectFrom('budget_items')
      .select(['id', 'expense_type'])
      .orderBy('id')
      .execute();
    const periods = await getDb().selectFrom('budget_period').select('id').orderBy('id').execute();

    if (accounts.length === 0 || budgetItems.length === 0 || periods.length === 0) {
      res.status(400).json({
        error: 'Accounts, budget items, and budget periods must exist before creating test transactions',
        code: 'MISSING_PREREQUISITES'
      });
      return;
    }

    // Create starting balance transactions
    const startingBalances = [
      { account_id: accounts[0]?.id, amount: 2500.00 },
      { account_id: accounts[1]?.id, amount: 15000.00 },
      { account_id: accounts[2]?.id, amount: -1200.00 },
      { account_id: accounts[3]?.id, amount: 25000.00 }
    ];

    for (const balance of startingBalances) {
      if (balance.account_id) {
        await getDb()
          .insertInto('transactions')
          .values({
            description: 'Starting Balance',
            amount: balance.amount,
            type: 'starting balance',
            status: 'cleared',
            account_id: balance.account_id,
            review_status: 'reviewed',
            transaction_date: '2024-01-01'
          })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }

    // Find income and expense budget items
    const incomeBudgetItem = budgetItems.find(item => item.expense_type === budgetExpenseType.enum.Income);
    const expenseBudgetItems = budgetItems.filter(item => item.expense_type === budgetExpenseType.enum.Expense);

    // Create sample transactions
    const sampleTransactions = [
      // Income transactions
      ...(incomeBudgetItem ? [
        ['Salary Deposit', 4500.00, 'income', 'cleared', incomeAccount?.id, incomeBudgetItem.id, periods[0]?.id, 'reviewed', '2024-01-01'],
        ['Freelance Payment', 850.00, 'income', 'cleared', incomeAccount?.id, incomeBudgetItem.id, periods[0]?.id, 'reviewed', '2024-01-15'],
        ['Salary Deposit', 4500.00, 'income', 'cleared', incomeAccount?.id, incomeBudgetItem.id, periods[1]?.id, 'reviewed', '2024-02-01']
      ] : []),
      // Expense transactions
      ...(expenseBudgetItems.length > 0 ? [
        ['Grocery Store', 125.50, 'expense', 'cleared', accounts[0]?.id, expenseBudgetItems[0]?.id, periods[0]?.id, 'reviewed', '2024-01-02'],
        ['Water Bill Payment', 85.00, 'expense', 'cleared', accounts[0]?.id, expenseBudgetItems[0]?.id, periods[0]?.id, 'reviewed', '2024-01-05'],
        ['Gas Station', 45.75, 'expense', 'pending', accounts[0]?.id, expenseBudgetItems[1]?.id || expenseBudgetItems[0]?.id, periods[0]?.id, 'needs review', '2024-01-10'],
        ['Restaurant Dinner', 75.25, 'expense', 'cleared', accounts[0]?.id, null, periods[0]?.id, 'reviewed', '2024-01-12'],
        ['Home Insurance', 180.00, 'expense', 'cleared', accounts[0]?.id, expenseBudgetItems[2]?.id || expenseBudgetItems[0]?.id, periods[0]?.id, 'reviewed', '2024-01-15'],
        ['Online Shopping', 95.50, 'expense', 'pending', accounts[2]?.id, expenseBudgetItems[1]?.id || expenseBudgetItems[0]?.id, periods[0]?.id, 'needs review', '2024-01-18'],
        ['Coffee Shop', 12.75, 'expense', 'cleared', accounts[0]?.id, null, periods[0]?.id, 'flagged', '2024-01-20'],
        ['Grocery Store', 110.25, 'expense', 'cleared', accounts[0]?.id, expenseBudgetItems[0]?.id, periods[1]?.id, 'reviewed', '2024-02-03'],
        ['Electric Bill', 120.00, 'expense', 'cleared', accounts[0]?.id, expenseBudgetItems[0]?.id, periods[1]?.id, 'reviewed', '2024-02-08']
      ] : []),
      // Transfer transactions
      ['Transfer to Savings', 500.00, 'transfer', 'cleared', accounts[0]?.id, null, periods[0]?.id, 'reviewed', '2024-01-25'],
      ['Credit Card Payment', 300.00, 'transfer', 'cleared', accounts[2]?.id, null, periods[1]?.id, 'reviewed', '2024-02-26']
    ];

    let createdCount = 0;
    for (const transaction of sampleTransactions) {
      if (transaction[4]) { // Check if account_id exists
        try {
          // In a savepoint: a row the database refuses is skipped and the rest kept (its
          // error, caught without one, aborted the request's transaction, a 500).
          await withSavepoint(() =>
            getDb()
              .insertInto('transactions')
              .values({
                description: transaction[0] as string,
                amount: transaction[1] as number,
                type: transaction[2] as string,
                status: transaction[3] as string,
                account_id: transaction[4] as number,
                budget_item_id: transaction[5] as number | null,
                budget_period_id: transaction[6] as number | null,
                review_status: transaction[7] as string,
                transaction_date: transaction[8] as string
              })
              .onConflict((oc) => oc.doNothing())
              .execute()
          );
          createdCount++;
        } catch (err) {
          logger.warn({ err, transactionDescription: transaction[0], adminId: req.user.userId }, 'Failed to create test transaction');
        }
      }
    }

    res.json({
      message: 'Test transactions created successfully',
      transactionsCreated: createdCount
    });
  }));

  // Generate all test data at once
  router.post('/generate-all', tenantHandler(async (req: AuthenticatedRequest, res) => {
    const results: {
      categories: Array<Pick<Selectable<DB['categories']>, 'id' | 'name' | 'description' | 'priority'>>,
      institutions: Array<Pick<Selectable<DB['account_institutions']>, 'id' | 'name' | 'notes'>>,
      accounts: Array<Pick<Selectable<DB['accounts']>, 'id' | 'uuid' | 'name' | 'account_group' | 'account_type'>>,
      periods: Array<{year: number, monthNumber: number, periodId: number}>,
      budgetItems: Array<Pick<Selectable<DB['budget_items']>, 'id' | 'name' | 'expense_type' | 'default_budget_amount'>>,
      transactionsCreated: number
    } = {
      categories: [],
      institutions: [],
      accounts: [],
      periods: [],
      budgetItems: [],
      transactionsCreated: 0
    };

    // 1. Create categories
    const categoriesData = [
      {
        name: 'Insurance',
        description: 'All Insurance',
        priority: 'Essential',
        notes: 'Must-pay expenses',
        icon: 'Home'
      },
      {
        name: 'Streaming',
        description: 'Entertainment and lifestyle services',
        priority: 'Optional',
        notes: 'Can be reduced if needed',
        icon: 'Smile'
      },
      {
        name: 'Essential Home',
        description: 'Housing-related expenses',
        priority: 'Essential',
        notes: 'Must-pay expenses',
        icon: 'Smile'
      }
    ];

    for (const category of categoriesData) {
      const row = await getDb()
        .insertInto('categories')
        .values({
          name: category.name,
          description: category.description,
          priority: category.priority,
          notes: category.notes,
          icon: category.icon
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'name', 'description', 'priority'])
        .executeTakeFirst();

      if (row) {
        results.categories.push(row);
      }
    }

    // 2. Create account institutions
    const institutionsData = [
      {
        name: 'Example Bank',
        notes: 'A made-up national bank'
      },
      {
        name: 'Sample Savings Bank',
        notes: 'A made-up savings bank'
      },
      {
        name: 'Acme Card Services',
        notes: 'A made-up card issuer'
      },
      {
        name: 'Example Brokerage',
        notes: 'Investment and banking services'
      },
      {
        name: 'Sample Investments',
        notes: 'Investment services and banking'
      },
      {
        name: 'Acme Credit Union',
        notes: 'A made-up credit union'
      },
      {
        name: 'Other',
        notes: 'Other financial institution not listed'
      }
    ];

    for (const institution of institutionsData) {
      const row = await getDb()
        .insertInto('account_institutions')
        .values({
          name: institution.name,
          notes: institution.notes
        })
        .onConflict((oc) => oc.doNothing())
        .returning(['id', 'name', 'notes'])
        .executeTakeFirst();

      if (row) {
        results.institutions.push(row);
      }
    }

    // 3. Create test accounts
    // Get institution IDs for the test accounts
    const institutionRows = await getDb()
      .selectFrom('account_institutions')
      .select(['id', 'name'])
      .where('name', 'in', ['Example Bank', 'Example Brokerage'])
      .orderBy('name')
      .execute();

    const bankId = institutionRows.find(row => row.name === 'Example Bank')?.id;
    const brokerageId = institutionRows.find(row => row.name === 'Example Brokerage')?.id;

    if (bankId) {
      const accountsData = [
        {
          name: 'Example Checking',
          account_group: 'cash',
          account_type: 'checking',
          institution_id: bankId,
          type: 'Asset',
          icon: 'CreditCard'
        },
        {
          name: 'Example Savings',
          account_group: 'cash',
          account_type: 'savings',
          institution_id: bankId,
          type: 'Asset',
          icon: 'PiggyBank'
        },
        {
          name: 'Example Credit Card',
          account_group: 'credit_cards',
          account_type: 'credit_card',
          institution_id: bankId,
          type: 'Liability',
          icon: 'CreditCard'
        },
        {
          name: 'Investment Account',
          account_group: 'investments',
          account_type: 'investment',
          institution_id: brokerageId || bankId,
          type: 'Asset',
          icon: 'TrendingUp'
        }
      ];

      for (const account of accountsData) {
        const row = await getDb()
          .insertInto('accounts')
          .values({
            name: account.name,
            account_group: account.account_group,
            account_type: account.account_type,
            institution_id: account.institution_id,
            type: account.type,
            icon: account.icon
          })
          .onConflict((oc) => oc.doNothing())
          .returning(['id', 'uuid', 'name', 'account_group', 'account_type'])
          .executeTakeFirst();

        if (row) {
          results.accounts.push(row);
        }
      }
    }

    // 4. Create budget periods using BudgetService
    const budgetService = new BudgetService();

    const months = [
      { year: 2024, monthNumber: 1 },
      { year: 2024, monthNumber: 2 },
      { year: 2024, monthNumber: 3 }
    ];

    for (const month of months) {
      const result = await budgetService.createBudgetPeriod(
        month.year,
        month.monthNumber,
        req.user.userId,
        false // auto_rollover = false for test data
      );

      results.periods.push({
        year: month.year,
        monthNumber: month.monthNumber,
        periodId: result.periodId
      });
    }

    // 5. Create budget items
    const budgetItemsData = [
      {
        "name": "Utilities",
        "expense_type": "Expense", 
        "description": "Monthly utility bills",
        "priority": "Essential",
        "isbill": true,
        "default_budget_amount": 200.00,
        "category_id": 3,
        "icon": "Zap",
        "color": "#F59E0B"
      },
      {
        "name": "Transportation",
        "expense_type": "Expense",
        "description": "Gas and vehicle expenses", 
        "priority": "Essential",
        "isbill": false,
        "default_budget_amount": 300.00,
        "icon": "Car",
        "color": "#10B981"
      },
      {
        "name": "Insurance", 
        "expense_type": "Expense",
        "description": "Various insurance payments",
        "priority": "Essential",
        "isbill": true,
        "default_budget_amount": 180.00,
        "category_id": 1,
        "icon": "Shield", 
        "color": "#EF4444"
      },
      {
        "name": "Income",
        "expense_type": "Income",
        "description": "Salary and freelance income",
        "priority": "Essential", 
        "isbill": false,
        "default_budget_amount": 5000.00,
        "icon": "DollarSign",
        "color": "#059669"
      }
    ];

    // kept as raw sql: PL/pgSQL function call
    await sql`
      SELECT bulk_create_budget_items(${JSON.stringify(budgetItemsData)}, ${req.user.userId})
    `.execute(getDb());

    const budgetItems = await getDb()
      .selectFrom('budget_items')
      .select(['id', 'name', 'expense_type', 'default_budget_amount'])
      .orderBy('id', 'desc')
      .limit(4)
      .execute();
    results.budgetItems = budgetItems;

    // 6. Wait a moment for database consistency, then create transactions
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Create transactions using similar logic as above but simplified
    const accounts = await getDb().selectFrom('accounts').select('id').orderBy('id').limit(4).execute();

    if (accounts.length > 0) {
      // Starting balances
      const startingBalances = [
        [accounts[0]?.id, 2500.00],
        [accounts[1]?.id, 15000.00],
        [accounts[2]?.id, -1200.00],
        [accounts[3]?.id, 25000.00]
      ];

      for (const [accountId, amount] of startingBalances) {
        if (accountId) {
          try {
            // In a savepoint, so one the database refuses doesn't abort the request's transaction.
            await withSavepoint(() =>
              getDb()
                .insertInto('transactions')
                .values({
                  description: 'Starting Balance',
                  amount,
                  type: 'starting balance',
                  status: 'cleared',
                  account_id: accountId,
                  review_status: 'reviewed',
                  transaction_date: '2024-01-01'
                })
                .onConflict((oc) => oc.doNothing())
                .execute()
            );
            results.transactionsCreated++;
          } catch (err) {
            logger.warn({ err, accountId, amount, adminId: req.user.userId }, 'Failed to create starting balance transaction');
          }
        }
      }
    }

    res.json({
      message: 'All test data created successfully',
      results
    });
  }));

  // Clear all test data
  router.delete('/clear-all', tenantHandler(async (_req: AuthenticatedRequest, res) => {
    // Delete in correct order due to foreign key constraints (attachments and the budget
    // event log aren't deleted by a cascade)
    await getDb().deleteFrom('attachments').execute();
    await getDb().deleteFrom('budget_period_transactions').execute();
    await getDb().deleteFrom('transactions').execute();
    await getDb().deleteFrom('budget_period_items').execute();
    await getDb().deleteFrom('budget_period').execute();
    await getDb().deleteFrom('budget_items').where('id', '>', 0).execute(); // Keep any system items if they exist
    await getDb().deleteFrom('accounts').where('id', '>', 0).execute(); // Delete all test accounts
    await getDb().deleteFrom('categories').where('id', '>', 0).execute(); // Delete all test categories
    await getDb().deleteFrom('account_institutions').where('id', '>', 0).execute(); // Delete all test institutions

    res.json({
      message: 'All test data cleared successfully'
    });
  }));

  return router;
}