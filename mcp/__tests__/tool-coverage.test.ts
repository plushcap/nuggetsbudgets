import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  callTool,
  callToolValidated,
  describeCall,
  inputSchemaOf,
  makeFetchStub,
  registeredTools,
  type CapturedCall,
  type RegisteredTool,
  type StubResponse,
} from './harness.js';

/**
 * Every registered MCP tool, table-driven: the request(s) each one sends (verb,
 * path, query and body), and how its input schema treats the ids and amounts it takes.
 *
 * A tool with no entry in CASES fails "covers every registered tool", so a new tool ships
 * with its test. For each case the tests check that:
 *  - the handler sends exactly the listed requests, in order;
 *  - the same arguments pass the tool's input schema (the SDK's parse) unchanged;
 *  - every number the schema takes still works sent as a string, as models often send one;
 *  - every decimal it takes as a number or text (an amount, a price, a share count) arrives
 *    at the backend as the text sent, unchanged, so the backend reads it exactly;
 *  - every uuid the schema takes refuses a path in its place (`../admin/...`);
 *  - an id that ends up in a URL goes there as one encoded segment, even past the schema.
 */

const U = (n: number) => `019a3b2c-1d2e-7f00-8a00-${n.toString(16).padStart(12, '0')}`;
const ACCOUNT = U(1);
const ACCOUNT2 = U(2);
const SECURITY = U(3);
const SECURITY2 = U(4);
const LOT = U(5);
const TXN = U(6);
const MERCHANT = U(7);
const MERCHANT2 = U(8);
const RULE = U(9);
const ITEM = U(10);
const PERIOD = U(11);
const TAG = U(12);
const TAG2 = U(13);
const GOAL = U(14);
const THREAD = U(15);
const CATEGORY = U(16);
const DATE = '2026-07-01';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Expected {
  method: Method;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}
interface ToolCase {
  /** What the case shows, when a tool has several. */
  label?: string;
  args: Record<string, unknown>;
  /** The requests the tool sends, in order. */
  calls: Expected[];
  /** What the stubbed API answers each call (default `{ ok: true }`). */
  responses?: StubResponse[];
  /** The tool refuses these arguments itself: its result is an error matching this. */
  error?: RegExp;
  /** Changes to `args` the input schema must refuse, before any request. */
  rejects?: Record<string, unknown>[];
}

const get = (path: string, query?: Record<string, string>): Expected => ({ method: 'GET', path, ...(query ? { query } : {}) });
const send = (method: Method, path: string, body?: unknown): Expected => ({ method, path, ...(body !== undefined ? { body } : {}) });

const CASES: Record<string, ToolCase[]> = {
  // ------------------------------------------------------------------- tasks
  list_tasks: [
    {
      label: 'assigned to someone, or unassigned',
      args: { assignedTo: 3, includeUnassigned: true, page: 2, limit: 10 },
      calls: [get('/api/transactions/paginated', { review_status: 'needs review', page: '2', limit: '10', assigned_to_or_unassigned: '3' })],
      rejects: [{ page: 0 }, { limit: 201 }, { assignedTo: 1.5 }, { assignedTo: 0 }, { assignedTo: -3 }],
    },
    {
      label: 'assigned to someone',
      args: { assignedTo: 3 },
      calls: [get('/api/transactions/paginated', { review_status: 'needs review', page: '1', limit: '25', assigned_to: '3' })],
    },
  ],
  accept_task: [
    {
      args: { uuid: TXN, budgetItemId: 7, budgetPeriodId: 3, merchantId: 4, notes: 'n' },
      calls: [send('PUT', `/api/transactions/${TXN}`, { budget_item_id: 7, review_status: 'reviewed', budget_period_id: 3, merchant_id: 4, notes: 'n' })],
      rejects: [{ budgetItemId: undefined }, { budgetItemId: 'seven' }],
    },
  ],

  // ------------------------------------------------------------ transactions
  list_transactions: [
    {
      args: {
        search: 'coffee', dateFrom: '2026-01-01', dateTo: '2026-01-31', accountUuid: ACCOUNT, merchantUuid: MERCHANT,
        merchantId: 5, budgetItemUuid: ITEM, budgetItemId: 8, budgetPeriodId: 9, reviewStatus: 'reviewed',
        type: 'expense', assignedTo: 2, page: 3, limit: 50,
      },
      calls: [get('/api/transactions/paginated', {
        search: 'coffee', date_from: '2026-01-01', date_to: '2026-01-31', account_uuid: ACCOUNT, merchant_uuid: MERCHANT,
        merchant_id: '5', budget_item_uuid: ITEM, budget_item_id: '8', budget_period_id: '9', review_status: 'reviewed',
        type: 'expense', assigned_to: '2', page: '3', limit: '50',
      })],
      // A date is a calendar day: the backend answers a timestamp, or another format, 400.
      // An id is a positive whole number.
      rejects: [
        { dateFrom: '2026-01-01T00:00:00Z' }, { dateTo: '2026-01-31T23:59:59.999Z' }, { dateFrom: '01/31/2026' }, { dateTo: '2026-1-31' },
        { merchantId: 0 }, { budgetItemId: -1 }, { budgetPeriodId: 0 }, { assignedTo: -2 }, { merchantId: 1.5 },
      ],
    },
  ],
  get_transaction: [{ args: { uuid: TXN }, calls: [get(`/api/transactions/${TXN}`)] }],
  classify_transaction: [
    {
      args: { uuid: TXN, budgetItemId: 8, budgetPeriodId: 9, merchantId: 5, tagUuids: [TAG] },
      calls: [
        send('PUT', `/api/transactions/${TXN}`, { budget_item_id: 8, budget_period_id: 9, merchant_id: 5 }),
        send('POST', `/api/transactions/${TXN}/tags/${TAG}`),
        get(`/api/transactions/${TXN}`),
      ],
    },
  ],
  update_transaction: [
    {
      args: {
        uuid: TXN, description: 'd', amount: -12.5, transactionDate: '2026-02-01', notes: 'n', assignedTo: 2,
        externalTransactionId: 'ext-1', externalLink: 'https://example.com/order/1',
      },
      calls: [send('PUT', `/api/transactions/${TXN}`, {
        description: 'd', amount: -12.5, transaction_date: '2026-02-01', notes: 'n', assigned_to: 2,
        external_transaction_id: 'ext-1', external_link: 'https://example.com/order/1',
      })],
      rejects: [{ amount: 'twelve' }, { externalLink: 'not a url' }],
    },
  ],
  create_transaction: [
    {
      args: {
        accountUuid: ACCOUNT, amount: 42.5, transactionDate: DATE, type: 'expense', description: 'd', merchantUuid: MERCHANT,
        budgetItemUuid: ITEM, budgetPeriodUuid: PERIOD, tagUuids: [TAG], reviewStatus: 'reviewed', status: 'pending',
        externalTransactionId: 'stmt:1',
      },
      calls: [send('POST', '/api/transactions', {
        account_uuid: ACCOUNT, amount: 42.5, transaction_date: DATE, type: 'expense', description: 'd', merchant_uuid: MERCHANT,
        budget_item_uuid: ITEM, budget_period_uuid: PERIOD, review_status: 'reviewed', status: 'pending',
        external_transaction_id: 'stmt:1', tag_uuids: [TAG],
      })],
      rejects: [{ amount: undefined }, { type: 'withdrawal' }],
    },
  ],
  create_transactions: [
    {
      args: {
        transactions: [{
          accountUuid: ACCOUNT, amount: 12.34, transactionDate: DATE, type: 'expense', description: 'Coffee', merchantUuid: MERCHANT,
          budgetItemUuid: ITEM, budgetPeriodUuid: PERIOD, externalTransactionId: 'l1', reviewStatus: 'reviewed', status: 'cleared',
        }],
        dryRun: true,
      },
      calls: [send('POST', '/api/transactions/bulk', {
        transactions: [{
          account_uuid: ACCOUNT, amount: 12.34, transaction_date: DATE, type: 'expense', description: 'Coffee', merchant_uuid: MERCHANT,
          budget_item_uuid: ITEM, budget_period_uuid: PERIOD, external_transaction_id: 'l1', review_status: 'reviewed', status: 'cleared',
        }],
        dry_run: true,
      })],
      rejects: [{ transactions: [] }],
    },
  ],
  split_transaction: [
    {
      args: {
        uuid: TXN,
        splits: [
          { amount: -30, description: 'Groceries', budgetItemUuid: ITEM, budgetPeriodUuid: PERIOD, tagUuids: [TAG] },
          { amount: -20.5 },
        ],
      },
      calls: [send('POST', `/api/transactions/${TXN}/split`, {
        splits: [
          { amount: -30, description: 'Groceries', budget_item_uuid: ITEM, budget_period_uuid: PERIOD, tag_uuids: [TAG] },
          { amount: -20.5 },
        ],
      })],
      rejects: [{ splits: [{ amount: -50 }] }, { splits: [{ amount: 'lots' }, { amount: -1 }] }],
    },
  ],
  bulk_classify: [
    {
      args: { uuids: [TXN], budgetItemId: 8, budgetPeriodId: 9, merchantId: 5, reviewStatus: 'reviewed' },
      calls: [send('PUT', '/api/transactions/bulk', {
        transactionUuids: [TXN],
        updates: { budget_item_id: 8, budget_period_id: 9, merchant_id: 5, review_status: 'reviewed' },
      })],
      rejects: [{ uuids: [] }],
    },
  ],

  // --------------------------------------------------------------- merchants
  list_merchants: [
    {
      args: { page: 2, limit: 30, search: 'kro', lite: true },
      calls: [get('/api/merchants/paginated', { page: '2', limit: '30', search: 'kro', fields: 'lite' })],
      rejects: [{ limit: 101 }],
    },
  ],
  search_merchants: [{ args: { q: 'kro' }, calls: [get('/api/merchants/search', { q: 'kro' })] }],
  get_merchant: [{ args: { uuid: MERCHANT }, calls: [get(`/api/merchants/${MERCHANT}`)] }],
  create_merchant: [
    {
      args: { name: 'Local Coffee', website: 'https://example.com', accountId: 'acct-1', notes: 'n', instructions: 'i' },
      calls: [send('POST', '/api/merchants', {
        name: 'Local Coffee', merchant_website: 'https://example.com', merchant_accountid: 'acct-1', notes: 'n', instructions: 'i',
      })],
    },
  ],
  update_merchant: [
    {
      label: 'merges the change into the merchant as it is',
      args: { uuid: MERCHANT, name: 'New', notes: 'n2' },
      responses: [
        { name: 'Old', merchant_website: 'https://w', merchant_accountid: null, merchant_image: '/img.png', notes: 'old', instructions: 'keep', transaction_auto_tag_id: 4 },
        { ok: true },
      ],
      calls: [
        get(`/api/merchants/${MERCHANT}`),
        send('PUT', `/api/merchants/${MERCHANT}`, {
          name: 'New', merchant_website: 'https://w', merchant_accountid: null, merchant_image: '/img.png', notes: 'n2',
          instructions: 'keep', transaction_auto_tag_id: 4,
        }),
      ],
    },
  ],
  list_merchant_rules: [{ args: { uuid: MERCHANT }, calls: [get(`/api/merchants/${MERCHANT}/rules`)] }],
  create_merchant_rule: [
    {
      args: { uuid: MERCHANT, method: 'contains', matchingText: 'EXAMPLE GROCER' },
      calls: [send('POST', `/api/merchants/${MERCHANT}/rules`, { method: 'contains', matching_text: 'EXAMPLE GROCER' })],
      rejects: [{ method: 'merchant_exact' }, { matchingText: '' }],
    },
  ],
  update_merchant_rule: [
    {
      args: { ruleUuid: RULE, method: 'exact', matchingText: 'EXAMPLE GROCER ' + '#' + '123' },
      calls: [send('PUT', `/api/merchants/rules/${RULE}`, { method: 'exact', matching_text: 'EXAMPLE GROCER ' + '#' + '123' })],
    },
  ],
  delete_merchant_rule: [{ args: { ruleUuid: RULE }, calls: [send('DELETE', `/api/merchants/rules/${RULE}`)] }],
  test_merchant_rules: [{ args: { uuid: MERCHANT }, calls: [send('POST', `/api/merchants/${MERCHANT}/test-rules`)] }],
  apply_merchant_rules: [
    {
      args: { uuid: MERCHANT, transactionIds: [101, 102] },
      calls: [send('POST', `/api/merchants/${MERCHANT}/apply-rules`, { transactionIds: [101, 102] })],
    },
  ],
  merge_merchants: [
    {
      args: { sourceUuid: MERCHANT, targetUuid: MERCHANT2 },
      calls: [send('POST', `/api/merchants/${MERCHANT}/merge`, { targetMerchantUuid: MERCHANT2 })],
    },
    { label: 'refuses to merge a merchant into itself', args: { sourceUuid: MERCHANT, targetUuid: MERCHANT }, calls: [], error: /must differ/ },
  ],

  // ------------------------------------------------- budget items, categories
  list_budget_items: [{ args: { includeArchived: true }, responses: [[]], calls: [get('/api/budgets/items')] }],
  create_budget_item: [
    {
      args: {
        name: 'Groceries', expense_type: 'Expense', type: 'Monthly', subtype: 'Flexible', priority: 'Optional',
        default_budget_amount: 400, rollover: true, category_id: 3, merchant_id: 5, recurring_payment_frequency: 6,
        recurring_payment_amount: 600, rollover_target_amount: 1000, rollover_starting_balance: 50,
      },
      calls: [send('POST', '/api/budgets/items', {
        name: 'Groceries', expense_type: 'Expense', type: 'Monthly', subtype: 'Flexible', priority: 'Optional',
        default_budget_amount: 400, rollover: true, category_id: 3, merchant_id: 5, recurring_payment_frequency: 6,
        recurring_payment_amount: 600, rollover_target_amount: 1000, rollover_starting_balance: 50,
      })],
      rejects: [{ name: '' }, { expense_type: 'Transfer' }, { recurring_payment_frequency: 1.5 }],
    },
  ],
  update_budget_item: [
    {
      args: {
        uuid: ITEM, name: 'Food', default_budget_amount: 450, category_id: 3, merchant_id: 5, recurring_payment_frequency: 12,
        recurring_payment_amount: 100, rollover_target_amount: 900, rollover_starting_balance: 25, rollover_target_date: null,
        instructions: null,
      },
      calls: [send('PUT', `/api/budgets/items/${ITEM}`, {
        name: 'Food', default_budget_amount: 450, category_id: 3, merchant_id: 5, recurring_payment_frequency: 12,
        recurring_payment_amount: 100, rollover_target_amount: 900, rollover_starting_balance: 25, rollover_target_date: null,
        instructions: null,
      })],
    },
    // A calendarDay alone refused null, so the tool could no longer clear the date.
    {
      args: { uuid: ITEM, recurring_next_payment_date: null },
      calls: [send('PUT', `/api/budgets/items/${ITEM}`, { recurring_next_payment_date: null })],
    },
    {
      args: { uuid: ITEM, recurring_next_payment_date: '2026-12-01' },
      calls: [send('PUT', `/api/budgets/items/${ITEM}`, { recurring_next_payment_date: '2026-12-01' })],
      rejects: [{ recurring_next_payment_date: '2026-02-30' }],
    },
  ],
  list_categories: [{ args: {}, calls: [get('/api/categories')] }],
  create_category: [
    {
      args: { name: 'Food', icon: 'Utensils', description: 'd', priority: 'High', notes: 'n' },
      calls: [send('POST', '/api/categories', { name: 'Food', icon: 'Utensils', description: 'd', priority: 'High', notes: 'n' })],
      rejects: [{ icon: undefined }],
    },
  ],
  update_category: [
    {
      args: { uuid: CATEGORY, name: 'Food', icon: 'Utensils', notes: 'n' },
      calls: [send('PUT', `/api/categories/${CATEGORY}`, { name: 'Food', icon: 'Utensils', notes: 'n' })],
    },
  ],

  // ----------------------------------------------------------- budget periods
  list_budget_periods: [{ args: {}, calls: [get('/api/budget-periods/management')] }],
  get_budget_period_summary: [{ args: { uuid: PERIOD }, calls: [get(`/api/budgets/periods/${PERIOD}/summary`)] }],
  list_budget_period_items: [{ args: { uuid: PERIOD }, calls: [get(`/api/budgets/periods/${PERIOD}/items`)] }],

  // ----------------------------------------------------------------- accounts
  list_accounts: [{ args: {}, calls: [get('/api/accounts')] }],
  get_account: [{ args: { uuid: ACCOUNT }, calls: [get(`/api/accounts/${ACCOUNT}`)] }],
  get_account_balance: [{ args: { uuid: ACCOUNT }, calls: [get(`/api/accounts/${ACCOUNT}/balance`)] }],
  get_account_balance_history: [
    {
      args: { uuid: ACCOUNT, limit: 12 },
      calls: [get(`/api/accounts/${ACCOUNT}/balance-history`, { limit: '12' })],
      rejects: [{ limit: 0 }, { limit: 501 }],
    },
  ],
  set_account_instructions: [
    {
      args: { uuid: ACCOUNT, instructions: 'Advisor goal 123' },
      calls: [send('PUT', `/api/accounts/${ACCOUNT}/instructions`, { instructions: 'Advisor goal 123' })],
    },
    { label: 'clears them', args: { uuid: ACCOUNT, instructions: null }, calls: [send('PUT', `/api/accounts/${ACCOUNT}/instructions`, { instructions: null })] },
  ],
  create_account: [
    {
      args: {
        name: 'Savings', category: 'Asset', accountType: 'savings', accountGroup: 'cash', initialBalance: 1000.5, notes: 'n',
        instructions: 'i', icon: 'PiggyBank',
      },
      calls: [send('POST', '/api/accounts', {
        name: 'Savings', account_type: 'savings', type: 'Asset', account_group: 'cash', initial_balance: 1000.5, notes: 'n',
        instructions: 'i', icon: 'PiggyBank',
      })],
      rejects: [{ accountType: 'brokerage' }, { initialBalance: 'a lot' }],
    },
  ],
  adjust_account_balance: [
    {
      args: { uuid: ACCOUNT, targetBalance: -250.75 },
      calls: [send('POST', `/api/accounts/${ACCOUNT}/adjust-balance`, { targetBalance: -250.75 })],
      rejects: [{ targetBalance: undefined }, { targetBalance: 'zero' }],
    },
  ],

  // -------------------------------------------------------------------- goals
  list_goals: [{ args: {}, calls: [get('/api/goals')] }],
  get_goal: [{ args: { uuid: GOAL }, calls: [get(`/api/goals/${GOAL}`)] }],
  get_goal_progress_history: [
    { args: { uuid: GOAL }, calls: [get(`/api/goals/${GOAL}/progress-history`)] },
    {
      args: { uuid: GOAL, startDate: '2026-01-01', endDate: DATE },
      calls: [get(`/api/goals/${GOAL}/progress-history`, { start_date: '2026-01-01', end_date: DATE })],
      rejects: [{ startDate: '01/01/2026' }, { endDate: '2026-01-01T00:00:00Z' }],
    },
  ],
  get_goal_balance_history: [{ args: { uuid: GOAL }, calls: [get(`/api/goals/${GOAL}/balance-history`)] }],

  // --------------------------------------------------------------------- tags
  list_tags: [{ args: {}, calls: [get('/api/tags')] }],
  get_tag: [{ args: { uuid: TAG }, calls: [get(`/api/tags/${TAG}`)] }],
  create_tag: [
    {
      args: { name: 'Trips', color: '#3B82F6', icon: 'Plane', description: 'd', parentId: 4, sortOrder: 2, isActive: true },
      calls: [send('POST', '/api/tags', { name: 'Trips', color: '#3B82F6', icon: 'Plane', description: 'd', parent_id: 4, sort_order: 2, is_active: true })],
      rejects: [{ name: '' }, { parentId: 'parent' }],
    },
  ],
  update_tag: [
    {
      label: 'merges the change into the tag as it is',
      args: { uuid: TAG, name: 'Travel', parentId: null, sortOrder: 3 },
      responses: [
        { name: 'Trips', color: '#111111', icon: 'Plane', description: 'old', parent_id: 4, sort_order: 1, is_active: true },
        { ok: true },
      ],
      calls: [
        get(`/api/tags/${TAG}`),
        send('PUT', `/api/tags/${TAG}`, { name: 'Travel', color: '#111111', icon: 'Plane', description: 'old', parent_id: null, sort_order: 3, is_active: true }),
      ],
    },
  ],
  list_transaction_tags: [{ args: { transactionUuid: TXN }, calls: [get(`/api/tags/transaction/${TXN}`)] }],
  add_tag_to_transaction: [{ args: { transactionUuid: TXN, tagUuid: TAG }, calls: [send('POST', `/api/transactions/${TXN}/tags/${TAG}`)] }],
  remove_tag_from_transaction: [{ args: { transactionUuid: TXN, tagUuid: TAG }, calls: [send('DELETE', `/api/transactions/${TXN}/tags/${TAG}`)] }],
  list_report_roots: [{ args: {}, calls: [get('/api/tags/report-roots')] }],
  set_tag_report_root: [
    {
      args: { uuid: TAG, isReportRoot: true, reportFlowMeasure: 'actual' },
      calls: [send('PUT', `/api/tags/${TAG}/report-root`, { is_report_root: true, report_flow_measure: 'actual' })],
    },
  ],
  list_budget_item_tags: [{ args: { budgetItemUuid: ITEM }, calls: [get(`/api/tags/budget-items/${ITEM}/tags`)] }],
  add_tag_to_budget_item: [
    {
      args: { budgetItemUuid: ITEM, tagId: 12 },
      calls: [send('POST', `/api/tags/budget-items/${ITEM}/tags`, { tag_id: 12 })],
      rejects: [{ tagId: 1.5 }],
    },
  ],
  remove_tag_from_budget_item: [
    {
      args: { budgetItemUuid: ITEM, tagId: 12 },
      calls: [send('DELETE', `/api/tags/budget-items/${ITEM}/tags/12`)],
      rejects: [{ tagId: '12/../../..' }],
    },
  ],
  set_budget_item_namespace_tag: [
    {
      args: { budgetItemUuid: ITEM, rootTagUuid: TAG, tagUuid: TAG2 },
      calls: [send('PUT', `/api/tags/budget-items/${ITEM}/namespace/${TAG}`, { tag_uuid: TAG2 })],
    },
    {
      label: 'clears it',
      args: { budgetItemUuid: ITEM, rootTagUuid: TAG, tagUuid: null },
      calls: [send('PUT', `/api/tags/budget-items/${ITEM}/namespace/${TAG}`, { tag_uuid: null })],
    },
  ],

  // ---------------------------------------------------- budget matching rules
  list_budget_matching_rules: [
    { args: { budgetItemUuid: ITEM }, calls: [get('/api/budgets/item-matching-rules', { budget_item_uuid: ITEM })] },
  ],
  create_budget_matching_rule: [
    {
      label: 'a text rule',
      args: { budgetItemUuid: ITEM, method: 'contains', matchingText: 'SAMPLE WHSE', amountMin: -500, amountMax: -10, priority: 50, notes: 'n' },
      calls: [send('POST', '/api/budgets/item-matching-rules', {
        budget_item_uuid: ITEM, method: 'contains', matching_text: 'SAMPLE WHSE', amount_min: -500, amount_max: -10, priority: 50, notes: 'n',
      })],
    },
    {
      label: 'a merchant rule',
      args: { budgetItemUuid: ITEM, method: 'merchant_exact', merchantUuid: MERCHANT },
      calls: [send('POST', '/api/budgets/item-matching-rules', { budget_item_uuid: ITEM, merchant_uuid: MERCHANT, method: 'merchant_exact' })],
    },
    { label: 'a merchant rule needs the merchant', args: { budgetItemUuid: ITEM, method: 'merchant_exact' }, calls: [], error: /merchantUuid is required/ },
    { label: 'a text rule needs the text', args: { budgetItemUuid: ITEM, method: 'regex', matchingText: '  ' }, calls: [], error: /matchingText is required/ },
  ],
  update_budget_matching_rule: [
    {
      label: 'merges the change into the rule as it is',
      args: { ruleUuid: RULE, matchingText: 'SAMPLE WHSE 9', amountMax: -5, priority: 10 },
      responses: [
        [{ uuid: RULE, budget_item_id: 8, merchant_id: 5, method: 'contains', matching_text: 'SAMPLE WHSE', amount_min: null, amount_max: null, priority: 100, is_active: true, notes: null }],
        { ok: true },
      ],
      calls: [
        get('/api/budgets/item-matching-rules'),
        send('PUT', `/api/budgets/item-matching-rules/${RULE}`, {
          method: 'contains', matching_text: 'SAMPLE WHSE 9', amount_min: null, amount_max: -5, priority: 10, is_active: true, notes: null,
          budget_item_id: 8, merchant_id: 5,
        }),
      ],
    },
    {
      label: 'moves it to another budget item and merchant',
      args: {
        ruleUuid: RULE, budgetItemUuid: ITEM, merchantUuid: MERCHANT, method: 'regex', matchingText: '^A', amountMin: -100,
        amountMax: -1, priority: 5, isActive: false, notes: 'x',
      },
      responses: [[{ uuid: RULE, budget_item_id: 8, merchant_id: null, method: 'contains', matching_text: 'A', amount_min: null, amount_max: null, priority: 100, is_active: true, notes: null }], { ok: true }],
      calls: [
        get('/api/budgets/item-matching-rules'),
        send('PUT', `/api/budgets/item-matching-rules/${RULE}`, {
          method: 'regex', matching_text: '^A', amount_min: -100, amount_max: -1, priority: 5, is_active: false, notes: 'x',
          budget_item_uuid: ITEM, merchant_uuid: MERCHANT,
        }),
      ],
    },
    {
      // The list answers inactive rules too (is_active false), so one can be found
      // and switched on again, keeping its 0 bound.
      label: 'switches an inactive rule on again',
      args: { ruleUuid: RULE, isActive: true },
      responses: [
        [{ uuid: RULE, budget_item_id: 8, merchant_id: null, method: 'contains', matching_text: 'REFUND', amount_min: '0.00', amount_max: null, priority: 100, is_active: false, notes: null }],
        { ok: true },
      ],
      calls: [
        get('/api/budgets/item-matching-rules'),
        send('PUT', `/api/budgets/item-matching-rules/${RULE}`, {
          method: 'contains', matching_text: 'REFUND', amount_min: '0.00', amount_max: null, priority: 100, is_active: true, notes: null,
          budget_item_id: 8,
        }),
      ],
    },
    {
      label: 'says so when the rule is not there',
      args: { ruleUuid: RULE, priority: 1 },
      responses: [[]],
      calls: [get('/api/budgets/item-matching-rules')],
      error: /not found/,
    },
  ],
  delete_budget_matching_rule: [{ args: { ruleUuid: RULE }, calls: [send('DELETE', `/api/budgets/item-matching-rules/${RULE}`)] }],

  // ---------------------------------------------------------------- transfers
  create_transfer: [
    {
      args: {
        sourceAccountUuid: ACCOUNT, destinationAccountUuid: ACCOUNT2, amount: 250, transactionDate: DATE, type: 'payment',
        description: 'Card payment', budgetPeriodUuid: PERIOD,
      },
      calls: [send('POST', '/api/transfer', {
        source_account_uuid: ACCOUNT, destination_account_uuid: ACCOUNT2, amount: 250, transaction_date: DATE, type: 'payment',
        description: 'Card payment', budget_period_uuid: PERIOD,
      })],
      rejects: [{ amount: 0 }, { amount: -250 }, { type: 'withdrawal' }],
    },
    {
      label: 'refuses a transfer from an account to itself',
      args: { sourceAccountUuid: ACCOUNT, destinationAccountUuid: ACCOUNT, amount: 1, transactionDate: DATE, type: 'transfer' },
      calls: [],
      error: /must differ/,
    },
  ],

  // -------------------------------------------------------------- securities
  list_securities: [{ args: { includeInactive: true }, calls: [get('/api/investments/securities', { include_inactive: 'true' })] }],
  get_security: [{ args: { uuid: SECURITY }, calls: [get(`/api/investments/securities/${SECURITY}`)] }],
  create_security: [
    {
      args: {
        ticker: 'STKIDX', name: 'Sample Total Market', securityType: 'etf', exchange: 'NYSE', currency: 'USD', isActive: true, isCustom: false,
        isPassThrough: true, trackUnderlyingHoldings: false, expenseRatioPercentage: 0.03, notes: 'n',
      },
      calls: [send('POST', '/api/investments/securities', {
        ticker: 'STKIDX', name: 'Sample Total Market', security_type: 'etf', exchange: 'NYSE', currency: 'USD', is_active: true, is_custom: false,
        is_pass_through: true, track_underlying_holdings: false, expense_ratio_percentage: 0.03, notes: 'n',
      })],
      rejects: [{ securityType: 'warrant' }],
    },
  ],
  update_security: [
    {
      args: { uuid: SECURITY, ticker: 'STKIDX', expenseRatioPercentage: 0.04, isActive: false },
      calls: [send('PUT', `/api/investments/securities/${SECURITY}`, { ticker: 'STKIDX', is_active: false, expense_ratio_percentage: 0.04 })],
    },
  ],
  list_unused_securities: [
    {
      args: { search: 'AAP', customOnly: true, limit: 100 },
      calls: [get('/api/investments/securities/cleanup/unused', { search: 'AAP', custom_only: 'true', limit: '100' })],
    },
  ],
  delete_securities: [
    {
      args: { uuids: [SECURITY, SECURITY2] },
      calls: [send('POST', '/api/investments/securities/bulk-delete', { uuids: [SECURITY, SECURITY2] })],
      rejects: [{ uuids: [] }],
    },
  ],
  get_security_price_history: [{ args: { uuid: SECURITY }, calls: [get(`/api/investments/securities/${SECURITY}/prices`)] }],
  update_security_price: [
    {
      args: { securityUuid: SECURITY, priceDate: DATE, close: 250.5, adjustedClose: 250.1, volume: 1000, source: 'manual' },
      calls: [send('POST', '/api/investments/prices', {
        security_uuid: SECURITY, price_date: DATE, close: 250.5, adjusted_close: 250.1, volume: 1000, source: 'manual',
      })],
      rejects: [{ close: undefined }],
    },
  ],
  update_security_prices_bulk: [
    {
      args: { prices: [{ securityUuid: SECURITY, priceDate: DATE, close: 100, adjustedClose: 99.5, volume: 10, source: 's' }] },
      calls: [send('POST', '/api/investments/prices/bulk', {
        prices: [{ security_uuid: SECURITY, price_date: DATE, close: 100, adjusted_close: 99.5, volume: 10, source: 's' }],
      })],
      rejects: [{ prices: [] }],
    },
  ],

  // ------------------------------------------------------------------ events
  record_buy_event: [
    {
      args: {
        accountUuid: ACCOUNT, securityUuid: SECURITY, eventDate: DATE, shares: 10, pricePerShare: 250, fees: 1.5,
        acquisitionMethod: 'purchase', source: 's', description: 'd', externalReference: 'x', dataQuality: 'imputed_basis', isCovered: false, dryRun: true,
        adjustedForSplits: true,
      },
      calls: [send('POST', '/api/investments/events/buy', {
        account_uuid: ACCOUNT, security_uuid: SECURITY, event_date: DATE, shares: 10, price_per_share: 250, fees: 1.5,
        acquisition_method: 'purchase', source: 's', description: 'd', external_reference: 'x', data_quality: 'imputed_basis', is_covered: false,
        adjusted_for_splits: true, dry_run: true,
      })],
      rejects: [{ shares: undefined }, { dataQuality: 'guessed' }, { isCovered: 'maybe' }, { adjustedForSplits: 'maybe' }],
    },
    {
      // Text reaches the backend as sent, which reads it exactly and refuses a share count
      // with more than 6 places; coerced, it arrived as 12.34.
      label: 'decimal text, sent on unchanged',
      args: { accountUuid: ACCOUNT, securityUuid: SECURITY, eventDate: DATE, shares: '12.3400000000000001', pricePerShare: '250.1000', fees: '1.50' },
      calls: [send('POST', '/api/investments/events/buy', {
        account_uuid: ACCOUNT, security_uuid: SECURITY, event_date: DATE, shares: '12.3400000000000001', price_per_share: '250.1000', fees: '1.50',
      })],
    },
  ],
  record_sell_event: [
    {
      args: {
        accountUuid: ACCOUNT, securityUuid: SECURITY, eventDate: DATE, shares: 5, pricePerShare: 260, fees: 1, method: 'specific_id',
        specificLots: [{ lotUuid: LOT, shares: 5 }], source: 's', description: 'd', externalReference: 'x', adjustedForSplits: true, dryRun: false,
      },
      calls: [send('POST', '/api/investments/events/sell', {
        account_uuid: ACCOUNT, security_uuid: SECURITY, event_date: DATE, shares: 5, price_per_share: 260, fees: 1, method: 'specific_id',
        specific_lots: [{ lot_uuid: LOT, shares: 5 }], source: 's', description: 'd', external_reference: 'x', adjusted_for_splits: true, dry_run: false,
      })],
      rejects: [{ method: 'random' }],
    },
  ],
  record_dividend_event: [
    {
      args: {
        accountUuid: ACCOUNT, securityUuid: SECURITY, eventDate: DATE, totalAmount: 42.5, amountPerShare: 0.5, exDate: '2026-06-20',
        recordDate: '2026-06-22', payDate: DATE, isQualified: true, reinvest: true, pricePerShare: 55.25,
        reinvestIntoSecurityUuid: SECURITY2, source: 's', externalReference: 'x', adjustedForSplits: true, dryRun: true,
      },
      calls: [send('POST', '/api/investments/events/dividend', {
        account_uuid: ACCOUNT, security_uuid: SECURITY, event_date: DATE, total_amount: 42.5, amount_per_share: 0.5, ex_date: '2026-06-20',
        record_date: '2026-06-22', pay_date: DATE, is_qualified: true, reinvest: true, price_per_share: 55.25,
        reinvest_into_security_uuid: SECURITY2, source: 's', external_reference: 'x', adjusted_for_splits: true, dry_run: true,
      })],
      rejects: [{ totalAmount: undefined }],
    },
  ],
  record_fee_event: [
    {
      args: {
        accountUuid: ACCOUNT, securityUuid: SECURITY, feeType: 'advisory', amount: 3.5, eventDate: DATE, description: 'd',
        externalReference: 'advisor:fee:2026-07',
      },
      calls: [send('POST', '/api/investments/events/fee', {
        account_uuid: ACCOUNT, fee_type: 'advisory', amount: 3.5, event_date: DATE, security_uuid: SECURITY, description: 'd',
        external_reference: 'advisor:fee:2026-07',
      })],
      rejects: [{ feeType: 'tip' }, { amount: undefined }],
    },
  ],
  list_holding_events: [
    {
      args: { accountUuid: ACCOUNT, securityUuid: SECURITY, eventType: 'buy', startDate: '2026-01-01', endDate: DATE, page: 2, limit: 50 },
      calls: [get('/api/investments/events', {
        account: ACCOUNT, security: SECURITY, event_type: 'buy', start_date: '2026-01-01', end_date: DATE, page: '2', limit: '50',
      })],
      rejects: [{ limit: 201 }],
    },
  ],

  // --------------------------------------------------------- holdings, lots
  list_holdings: [{ args: { accountUuid: ACCOUNT }, calls: [get('/api/investments/holdings', { account: ACCOUNT })] }],
  get_holding_lots: [
    {
      args: { securityUuid: SECURITY, accountUuid: ACCOUNT },
      calls: [get(`/api/investments/holdings/${SECURITY}/lots`, { account: ACCOUNT })],
    },
  ],
  set_cost_basis_method: [
    {
      args: { accountUuid: ACCOUNT, securityUuid: SECURITY, method: 'hifo', dripEnabled: true },
      calls: [send('POST', '/api/investments/cost-basis-method', { account_uuid: ACCOUNT, method: 'hifo', security_uuid: SECURITY, drip_enabled: true })],
      rejects: [{ method: 'best' }],
    },
  ],
  set_lot_covered: [
    {
      args: { lotUuid: LOT, isCovered: false },
      calls: [send('PATCH', `/api/investments/lots/${LOT}`, { is_covered: false })],
      rejects: [{ isCovered: 'no' }, { isCovered: undefined }],
    },
  ],
  batch_import_lots: [
    {
      args: {
        lots: [{
          account_uuid: ACCOUNT, security_uuid: SECURITY, acquisition_date: '2020-01-02', shares: 10, total_cost_basis: 500,
          acquisition_method: 'transfer_in', data_quality: 'imputed_basis', holding_period_start: '2019-12-01', external_reference: 'x',
          is_covered: false, adjusted_for_splits: true,
        }],
        dryRun: true,
      },
      calls: [send('POST', '/api/investments/lots/batch-import', {
        lots: [{
          account_uuid: ACCOUNT, security_uuid: SECURITY, acquisition_date: '2020-01-02', shares: 10, total_cost_basis: 500,
          acquisition_method: 'transfer_in', data_quality: 'imputed_basis', holding_period_start: '2019-12-01', external_reference: 'x',
          is_covered: false, adjusted_for_splits: true,
        }],
        dry_run: true,
      })],
      rejects: [
        { lots: [] },
        { lots: [{ account_uuid: ACCOUNT, security_uuid: SECURITY, acquisition_date: '2020-01-02', shares: -1, total_cost_basis: 500 }] },
      ],
    },
  ],

  // ------------------------------------------------------- corporate actions
  record_split_event: [
    {
      args: { securityUuid: SECURITY, actionDate: DATE, numerator: 4, denominator: 1, reverse: false, dryRun: true },
      calls: [send('POST', '/api/investments/corporate-actions/split', {
        security_uuid: SECURITY, action_date: DATE, numerator: 4, denominator: 1, reverse: false, dry_run: true,
      })],
      rejects: [{ numerator: 0 }, { denominator: -1 }],
    },
    {
      label: 'a reverse split, for real by default',
      args: { securityUuid: SECURITY, actionDate: DATE, numerator: 1, denominator: 10, reverse: true },
      calls: [send('POST', '/api/investments/corporate-actions/split', {
        security_uuid: SECURITY, action_date: DATE, numerator: 1, denominator: 10, reverse: true, dry_run: false,
      })],
    },
  ],
  record_return_of_capital_event: [
    {
      args: { securityUuid: SECURITY, actionDate: DATE, amountPerShare: 0.25, dryRun: true },
      calls: [send('POST', '/api/investments/corporate-actions/return-of-capital', {
        security_uuid: SECURITY, action_date: DATE, amount_per_share: 0.25, dry_run: true,
      })],
      rejects: [{ amountPerShare: 0 }],
    },
  ],
  record_spinoff_event: [
    {
      args: { sourceSecurityUuid: SECURITY, newSecurityUuid: SECURITY2, actionDate: DATE, allocationFraction: 0.2, shareRatio: 0.5, dryRun: true },
      calls: [send('POST', '/api/investments/corporate-actions/spinoff', {
        source_security_uuid: SECURITY, new_security_uuid: SECURITY2, action_date: DATE, allocation_fraction: 0.2, share_ratio: 0.5, dry_run: true,
      })],
      rejects: [{ allocationFraction: 1.5 }, { shareRatio: 0 }],
    },
  ],
  record_merger_event: [
    {
      label: 'for cash',
      args: { type: 'cash', securityUuid: SECURITY, actionDate: DATE, cashPerShare: 50 },
      calls: [send('POST', '/api/investments/corporate-actions/merger-cash', {
        security_uuid: SECURITY, action_date: DATE, cash_per_share: 50, dry_run: false,
      })],
      rejects: [{ type: 'barter' }],
    },
    {
      label: 'for stock',
      args: { type: 'stock', securityUuid: SECURITY, actionDate: DATE, acquirerSecurityUuid: SECURITY2, exchangeRatio: 1.5, dryRun: true },
      calls: [send('POST', '/api/investments/corporate-actions/merger-stock', {
        security_uuid: SECURITY, acquirer_security_uuid: SECURITY2, action_date: DATE, exchange_ratio: 1.5, dry_run: true,
      })],
    },
  ],

  // ----------------------------------------------------------------- reports
  get_unrealized_gain_loss: [
    { args: { accountUuid: ACCOUNT }, calls: [get('/api/investments/reports/unrealized-gain-loss', { account: ACCOUNT })] },
  ],
  get_realized_gain_loss: [
    {
      args: { startDate: '2026-01-01', endDate: DATE, accountUuid: ACCOUNT },
      calls: [get('/api/investments/reports/realized-gain-loss', { start_date: '2026-01-01', end_date: DATE, account: ACCOUNT })],
    },
  ],
  get_data_freshness_report: [
    { args: { minHoldingValue: 100 }, calls: [get('/api/investments/reports/data-freshness', { min_holding_value: '100' })] },
  ],
  get_fees_summary: [
    {
      args: { startDate: '2026-01-01', endDate: DATE, accountUuid: ACCOUNT },
      calls: [get('/api/investments/reports/fees', { start_date: '2026-01-01', end_date: DATE, account: ACCOUNT })],
    },
  ],
  get_total_cost_of_ownership: [
    { args: { accountUuid: ACCOUNT }, calls: [get('/api/investments/reports/cost-of-ownership', { account: ACCOUNT })] },
  ],
  preview_sell_tax_impact: [
    {
      args: {
        accountUuid: ACCOUNT, securityUuid: SECURITY, shares: 10, date: DATE, method: 'fifo', pricePerShare: 100, shortTermRate: 0.24,
        longTermRate: 0.15,
      },
      calls: [get('/api/investments/reports/sell-tax-impact', {
        account: ACCOUNT, security: SECURITY, shares: '10', date: DATE, method: 'fifo', price: '100', st_rate: '0.24', lt_rate: '0.15',
      })],
      rejects: [{ shares: 0 }],
    },
  ],
  find_tax_loss_harvest_candidates: [
    {
      args: { accountUuid: ACCOUNT, minLoss: 100 },
      calls: [get('/api/investments/reports/tax-loss-harvest', { account: ACCOUNT, min_loss: '100' })],
      // Coerced, 1e2 and 0x10 reached the backend as 100 and 16.
      rejects: [{ minLoss: '1e2' }, { minLoss: '0x10' }, { minLoss: 'lots' }],
    },
    {
      // Sent as given, for the backend to read in cents; coerced, it arrived as 99.5.
      label: 'decimal text, sent on unchanged',
      args: { minLoss: '99.50' },
      calls: [get('/api/investments/reports/tax-loss-harvest', { min_loss: '99.50' })],
    },
  ],
  suggest_lot_selection: [
    {
      args: { accountUuid: ACCOUNT, securityUuid: SECURITY, objective: 'minimize_gain', date: DATE, pricePerShare: 99.5 },
      calls: [get('/api/investments/reports/lot-suggestions', { account: ACCOUNT, security: SECURITY, objective: 'minimize_gain', date: DATE, price: '99.5' })],
      rejects: [{ objective: 'maximize_gain' }, { date: '2026-02-30' }],
    },
  ],
  get_concentration_risk: [{ args: { thresholdPct: 15 }, calls: [get('/api/investments/reports/concentration', { threshold: '15' })] }],
  get_wash_sale_report: [
    {
      args: { startDate: '2026-01-01', endDate: DATE },
      calls: [get('/api/investments/reports/wash-sales', { start_date: '2026-01-01', end_date: DATE })],
    },
  ],
  get_reconciliation_status: [{ args: {}, calls: [get('/api/investments/reports/reconciliation')] }],
  get_securities_needing_data: [
    { args: { category: 'composition' }, calls: [get('/api/investments/reports/securities-needing-data', { category: 'composition' })] },
    { label: 'prices by default', args: {}, calls: [get('/api/investments/reports/securities-needing-data', { category: 'price' })] },
  ],
  get_price_history_gaps: [
    {
      args: { securityUuid: SECURITY, thresholdDays: 7 },
      calls: [get(`/api/investments/securities/${SECURITY}/price-gaps`, { threshold_days: '7' })],
      rejects: [{ thresholdDays: 0 }],
    },
  ],
  get_portfolio_performance: [
    {
      args: { accountUuid: ACCOUNT, startDate: '2026-01-01', endDate: DATE },
      calls: [get('/api/investments/reports/performance', { account: ACCOUNT, start_date: '2026-01-01', end_date: DATE })],
    },
  ],
  get_dividend_history: [
    {
      args: { startDate: '2026-01-01', endDate: DATE, accountUuid: ACCOUNT },
      calls: [get('/api/investments/reports/dividend-history', { start_date: '2026-01-01', end_date: DATE, account: ACCOUNT })],
    },
  ],
  get_portfolio_value_series: [
    {
      args: { startDate: '2026-01-01', limit: 90 },
      calls: [get('/api/investments/reports/value-series', { start_date: '2026-01-01', limit: '90' })],
      rejects: [{ limit: 0 }, { limit: 1.5 }],
    },
  ],

  // ------------------------------------------------------- funds, look-through
  update_fund_composition: [
    {
      args: { securityUuid: SECURITY, snapshotDate: DATE, dimensions: { asset_class: [{ dimension_value: 'Domestic Stock', weight_percentage: 100 }] } },
      calls: [send('POST', '/api/investments/compositions', {
        security_uuid: SECURITY, snapshot_date: DATE, dimensions: { asset_class: [{ dimension_value: 'Domestic Stock', weight_percentage: 100 }] },
        source: 'mcp_manual',
      })],
      rejects: [{ dimensions: { asset_class: [] } }],
    },
  ],
  update_expense_ratio: [
    {
      args: { securityUuid: SECURITY, expenseRatioPercentage: 0.03 },
      calls: [send('POST', '/api/investments/expense-ratio', { security_uuid: SECURITY, expense_ratio_percentage: 0.03 })],
      rejects: [{ expenseRatioPercentage: 'low' }],
    },
  ],
  get_fund_composition: [{ args: { securityUuid: SECURITY }, calls: [get(`/api/investments/securities/${SECURITY}/composition`)] }],
  get_lookthrough_allocation: [
    { args: { dimension: 'sector', accountUuid: ACCOUNT }, calls: [get('/api/investments/reports/lookthrough', { dimension: 'sector', account: ACCOUNT })] },
    { label: 'by asset class by default', args: {}, calls: [get('/api/investments/reports/lookthrough', { dimension: 'asset_class' })] },
  ],
  update_underlying_holdings: [
    {
      args: {
        securityUuid: SECURITY, snapshotDate: DATE, source: 'issuer',
        holdings: [{ underlying_ticker: 'ACMEC', underlying_name: 'Acme Corp', weight_percentage: 7, shares: 12 }],
      },
      calls: [send('POST', '/api/investments/underlying-holdings', {
        security_uuid: SECURITY, snapshot_date: DATE, source: 'issuer',
        holdings: [{ underlying_ticker: 'ACMEC', underlying_name: 'Acme Corp', weight_percentage: 7, shares: 12 }],
      })],
      rejects: [{ holdings: [] }, { holdings: [{ underlying_ticker: '', weight_percentage: 1 }] }],
    },
  ],
  set_underlying_holdings_tracking: [
    {
      args: { securityUuid: SECURITY, trackUnderlyingHoldings: false },
      calls: [send('POST', '/api/investments/underlying-tracking', { security_uuid: SECURITY, track_underlying_holdings: false })],
    },
  ],
  get_underlying_holdings: [{ args: { securityUuid: SECURITY }, calls: [get(`/api/investments/securities/${SECURITY}/underlying-holdings`)] }],
  find_underlying_exposure: [
    { args: { accountUuid: ACCOUNT }, calls: [get('/api/investments/reports/underlying-exposure', { account: ACCOUNT })] },
  ],

  // ------------------------------------------------------------- annotations
  list_annotations: [
    {
      args: { subjectType: 'transaction', subjectUuid: TXN },
      calls: [get('/api/annotations', { subject_type: 'transaction', subject_uuid: TXN })],
      rejects: [{ subjectType: 'account' }],
    },
  ],
  create_annotation: [
    {
      label: 'a new thread',
      args: {
        subjectType: 'transaction', subjectUuid: TXN, kind: 'question', body: 'Groceries or Household?', notify: true,
        severity: 'action_required', meta: { confidence: 0.62 }, agentName: 'classifier', agentRunId: 'run-1',
      },
      calls: [send('POST', '/api/annotations', {
        kind: 'question', body: 'Groceries or Household?', author_kind: 'agent', subject_type: 'transaction', subject_uuid: TXN,
        notify: true, severity: 'action_required', meta: { confidence: 0.62 }, agent_name: 'classifier', agent_run_id: 'run-1',
      })],
      rejects: [{ body: '' }, { kind: 'rant' }],
    },
    {
      label: 'a reply',
      args: { parentUuid: THREAD, kind: 'answer', body: 'Groceries.' },
      calls: [send('POST', '/api/annotations', { kind: 'answer', body: 'Groceries.', author_kind: 'agent', parent_uuid: THREAD })],
    },
  ],
  get_annotation_inbox: [
    {
      args: { since: '2026-06-28T00:00:00Z', limit: 25 },
      calls: [get('/api/annotations/inbox', { since: '2026-06-28T00:00:00Z', limit: '25' })],
      rejects: [{ limit: 0 }],
    },
    {
      args: { since: '2026-06-28T00:00:00.123Z', sinceUuid: THREAD },
      calls: [get('/api/annotations/inbox', { since: '2026-06-28T00:00:00.123Z', since_uuid: THREAD })],
      rejects: [{ sinceUuid: 'not-a-uuid' }],
    },
    {
      // An answer with no threads gives next_since_uuid null; passed back, it's no cursor uuid.
      args: { since: '2026-06-28T00:00:00Z', sinceUuid: null },
      calls: [get('/api/annotations/inbox', { since: '2026-06-28T00:00:00Z' })],
    },
  ],
  reply_annotation: [
    {
      args: { parentUuid: THREAD, kind: 'decision', body: 'Done.', meta: { rule: 1 }, agentName: 'classifier', agentRunId: 'run-2' },
      calls: [send('POST', '/api/annotations', {
        parent_uuid: THREAD, kind: 'decision', body: 'Done.', author_kind: 'agent', meta: { rule: 1 }, agent_name: 'classifier', agent_run_id: 'run-2',
      })],
    },
  ],
  resolve_annotation: [
    {
      label: 'with a closing note',
      args: { uuid: THREAD, note: 'Done.', agentRunId: 'run-3' },
      calls: [
        send('POST', '/api/annotations', { parent_uuid: THREAD, kind: 'decision', body: 'Done.', author_kind: 'agent', agent_run_id: 'run-3' }),
        send('PATCH', `/api/annotations/${THREAD}`, { status: 'resolved' }),
      ],
    },
    { label: 'without one', args: { uuid: THREAD }, calls: [send('PATCH', `/api/annotations/${THREAD}`, { status: 'resolved' })] },
  ],
  set_annotation_feedback: [
    {
      args: { uuid: THREAD, feedback: 'incorrect', reason: 'Reimbursable.' },
      calls: [send('PATCH', `/api/annotations/${THREAD}`, { feedback: 'incorrect', feedback_reason: 'Reimbursable.' })],
      rejects: [{ feedback: 'meh' }],
    },
  ],
  apply_annotation_learning: [
    {
      args: { uuid: THREAD, note: 'Updated the instructions.', appliedRef: { type: 'budget_item', uuid: ITEM }, agentRunId: 'run-4' },
      calls: [
        send('POST', '/api/annotations', {
          parent_uuid: THREAD, kind: 'correction', body: 'Updated the instructions.', author_kind: 'agent',
          meta: { type: 'budget_item', uuid: ITEM }, agent_run_id: 'run-4',
        }),
        send('PATCH', `/api/annotations/${THREAD}`, { learning_status: 'applied', applied_ref: { type: 'budget_item', uuid: ITEM } }),
      ],
    },
  ],

  // ----------------------------------------------------------- notifications
  get_notification_rules: [{ args: {}, calls: [get('/api/notifications/rules')] }],
  get_general_settings: [{ args: {}, calls: [get('/api/settings/general')] }],
  set_notification_rules: [
    {
      args: {
        rules: [
          { key: 'large_purchase', label: 'Large', enabled: true, sendBy: 'both', kind: 'transaction', audience: 'everyone', when: { fact: 'size', gte: 500 } },
          { key: 'weekly_digest', label: 'The week', enabled: false, sendBy: 'email', kind: 'digest', weekday: 7, hour: 18 },
        ],
      },
      calls: [send('PUT', '/api/notifications/rules', {
        rules: [
          { key: 'large_purchase', label: 'Large', enabled: true, sendBy: 'both', kind: 'transaction', audience: 'everyone', when: { fact: 'size', gte: 500 } },
          { key: 'weekly_digest', label: 'The week', enabled: false, sendBy: 'email', kind: 'digest', weekday: 7, hour: 18 },
        ],
      })],
      rejects: [{ rules: [{ key: 'x', label: 'X', enabled: true, kind: 'digest', weekday: 8, hour: 18 }] }],
    },
  ],
  get_my_notification_preferences: [{ args: {}, calls: [get('/api/notifications/preferences')] }],
  set_my_notification_preferences: [
    {
      args: { rules: [{ rule: 'over_budget', email: true, push: false }] },
      calls: [send('PUT', '/api/notifications/preferences', { rules: [{ rule: 'over_budget', email: true, push: false }] })],
      rejects: [{ rules: [] }],
    },
  ],
};

// ---------------------------------------------------------------------------------
// Walking a tool's arguments alongside its input schema (as JSON Schema, the form
// tools/list publishes), to find the numbers and uuids in them.

type JsonSchema = {
  type?: string | string[];
  format?: string;
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};
/** `decimal`: a number the schema also takes as text, which the tool sends on as it came. */
type Position = { path: (string | number)[]; kind: 'number' | 'decimal' | 'uuid' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const jsonSchemaOf = (tool: RegisteredTool) => z.toJSONSchema(inputSchemaOf(tool), { io: 'input' }) as JsonSchema;

const typeOf = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' ? 'number' : typeof value;

function admits(schema: JsonSchema, value: unknown): boolean {
  const types = schema.type === undefined ? undefined : ([] as string[]).concat(schema.type);
  if (types && !types.some((t) => t === typeOf(value) || (t === 'integer' && typeof value === 'number'))) return false;
  if (schema.const !== undefined && schema.const !== value) return false;
  if (schema.properties && value && typeof value === 'object') {
    for (const [key, prop] of Object.entries(schema.properties)) {
      const fixed = prop.const ?? (prop.enum?.length === 1 ? prop.enum[0] : undefined);
      if (fixed !== undefined && (value as Record<string, unknown>)[key] !== fixed) return false;
    }
  }
  return true;
}

function positions(schema: JsonSchema | undefined, value: unknown, path: (string | number)[] = []): Position[] {
  if (!schema) return [];
  const branches = schema.anyOf ?? schema.oneOf;
  if (branches) {
    const found = positions(branches.find((b) => admits(b, value)), value, path);
    const takesText = branches.some((b) => ([] as string[]).concat(b.type ?? []).includes('string'));
    return takesText ? found.map((p) => (p.kind === 'number' ? { ...p, kind: 'decimal' as const } : p)) : found;
  }
  const types = ([] as string[]).concat(schema.type ?? []);
  if (typeof value === 'number' && (types.includes('number') || types.includes('integer'))) {
    return [{ path, kind: types.includes('string') ? 'decimal' : 'number' }];
  }
  // A uuid by its schema, or by its value: an id argument the schema takes as any string
  // is one the checks below must see (and fail).
  if (typeof value === 'string' && (schema.format === 'uuid' || (types.includes('string') && UUID.test(value)))) {
    return [{ path, kind: 'uuid' }];
  }
  if (Array.isArray(value) && schema.items) return value.flatMap((item, i) => positions(schema.items, item, [...path, i]));
  if (value && typeof value === 'object' && !Array.isArray(value) && schema.properties) {
    return Object.entries(value).flatMap(([key, field]) => positions(schema.properties![key], field, [...path, key]));
  }
  return [];
}

/** `value` with every string `replace` maps replaced, at any depth. */
function mapStrings(value: unknown, replace: (s: string) => unknown): unknown {
  if (typeof value === 'string') return replace(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, replace));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, replace)]));
  return value;
}

/** Where a case's arguments hold a calendar day (YYYY-MM-DD), at any depth. */
function dayPositions(value: unknown, path: (string | number)[] = []): (string | number)[][] {
  if (typeof value === 'string') return /^\d{4}-\d{2}-\d{2}$/.test(value) ? [path] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => dayPositions(v, [...path, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => dayPositions(v, [...path, k]));
  return [];
}

/**
 * What a date a tool writes may not be: a timestamp, another format, a day that
 * doesn't exist, a year outside @nuggets/shared's calendarDay (1800 to 2999), nothing.
 */
const NOT_DAYS = ['2026-07-01T00:00:00Z', '07/01/2026', '2026-7-1', '2026-02-30', '1799-12-31', '3000-01-01', ''];

function withValueAt(args: Record<string, unknown>, path: (string | number)[], replace: (old: unknown) => unknown) {
  const copy = structuredClone(args);
  let at: Record<string | number, unknown> = copy;
  for (const key of path.slice(0, -1)) at = at[key] as Record<string | number, unknown>;
  const last = path[path.length - 1];
  at[last] = replace(at[last]);
  return copy;
}

/** The top-level arguments a tool takes that are ids or amounts: numbers or uuids, or lists of them. */
function idAndAmountArguments(schema: JsonSchema): string[] {
  const isIdOrAmount = (s: JsonSchema | undefined): boolean => {
    if (!s) return false;
    if (s.anyOf ?? s.oneOf) return (s.anyOf ?? s.oneOf)!.some(isIdOrAmount);
    const types = ([] as string[]).concat(s.type ?? []);
    if (types.includes('number') || types.includes('integer') || s.format === 'uuid') return true;
    return types.includes('array') && isIdOrAmount(s.items);
  };
  return Object.entries(schema.properties ?? {})
    .filter(([, s]) => isIdOrAmount(s))
    .map(([key]) => key);
}

// ---------------------------------------------------------------------------------

async function run(toolCase: ToolCase, name: string, args: Record<string, unknown>, validated: boolean) {
  const responses = toolCase.responses ?? [];
  const stub = makeFetchStub((_call: CapturedCall, i: number) => (i < responses.length ? responses[i] : { ok: true }));
  const result = validated ? await callToolValidated(stub.fetchImpl, name, args) : await callTool(stub.fetchImpl, name, args);
  return { result, calls: stub.calls };
}

const expectedCalls = (toolCase: ToolCase) =>
  toolCase.calls.map((c) => ({ method: c.method, path: c.path, query: c.query ?? {}, body: c.body }));

const ALL_TOOLS = registeredTools(makeFetchStub().fetchImpl);
const TRAVERSAL = '../admin/users/019a3b2c-1d2e-7f00-8a00-0000000000ff/deployment-admin';
const SLASHED = `${U(0xfe)}/rules`;

describe('MCP tool coverage', () => {
  it('covers every registered tool', () => {
    expect(Object.keys(CASES).sort()).toEqual([...ALL_TOOLS.keys()].sort());
  });

  it('exercises every id and amount argument a tool takes', () => {
    const missing: string[] = [];
    for (const [name, tool] of ALL_TOOLS) {
      const given = new Set((CASES[name] ?? []).flatMap((c) => Object.keys(c.args)));
      for (const key of idAndAmountArguments(jsonSchemaOf(tool))) {
        if (!given.has(key)) missing.push(`${name}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

for (const [name, cases] of Object.entries(CASES)) {
  describe(name, () => {
    const tool = ALL_TOOLS.get(name);
    const schema = tool ? jsonSchemaOf(tool) : {};

    for (const toolCase of cases) {
      const label = toolCase.label ? ` (${toolCase.label})` : '';
      const where = positions(schema, toolCase.args);
      const numbers = where.filter((p) => p.kind === 'number');
      const decimals = where.filter((p) => p.kind === 'decimal');
      const uuids = where.filter((p) => p.kind === 'uuid');
      // A tool that writes takes its dates as calendar days; a read tool's filters are its own.
      const days = tool?.config.annotations?.readOnlyHint ? [] : dayPositions(toolCase.args);

      it(`sends ${toolCase.calls.map((c) => `${c.method} ${c.path}`).join(', ') || 'nothing'}${label}`, async () => {
        const { result, calls } = await run(toolCase, name, toolCase.args, false);
        expect(calls.map(describeCall)).toEqual(expectedCalls(toolCase));
        for (const call of calls) expect(call.headers.authorization).toBe('Bearer test-token');
        if (toolCase.error) {
          expect(result.isError).toBe(true);
          expect(result.content[0].text).toMatch(toolCase.error);
        } else {
          expect(result.isError, result.content[0]?.text).toBeFalsy();
        }
      });

      it(`takes the same arguments through its input schema${label}`, async () => {
        const { calls } = await run(toolCase, name, toolCase.args, true);
        expect(calls.map(describeCall)).toEqual(expectedCalls(toolCase));
      });

      if (numbers.length > 0) {
        it(`takes its numbers as strings too, as models send them${label}`, async () => {
          let args = toolCase.args;
          for (const { path } of numbers) args = withValueAt(args, path, (n) => String(n));
          const { calls } = await run(toolCase, name, args, true);
          expect(calls.map(describeCall)).toEqual(expectedCalls(toolCase));
        });
      }

      if (decimals.length > 0) {
        it(`sends its decimals sent as text on as that text${label}`, async () => {
          // Each as text no other argument has: its digits, then a run of zeros as long as its place.
          let args = toolCase.args;
          const texts = new Map<string, unknown>();
          decimals.forEach(({ path }, i) => {
            args = withValueAt(args, path, (n) => {
              const text = `${String(n)}${String(n).includes('.') ? '' : '.'}${'0'.repeat(i + 1)}`;
              texts.set(text, n);
              return text;
            });
          });
          const { calls } = await run(toolCase, name, args, true);
          const seen = new Set<string>();
          // A query takes the number as text: the case lists it as String(n).
          const asSent = calls.map(describeCall).map((c) => ({
            ...c,
            query: mapStrings(c.query, (s) => (texts.has(s) ? (seen.add(s), String(texts.get(s))) : s)),
            body: mapStrings(c.body, (s) => (texts.has(s) ? (seen.add(s), texts.get(s)) : s)),
          }));
          // The same requests, with every one of those texts in its body as it was sent.
          expect(asSent).toEqual(expectedCalls(toolCase));
          expect([...seen].sort()).toEqual([...texts.keys()].sort());
        });
      }

      if (uuids.length > 0) {
        it(`refuses a path in place of each uuid, before any request${label}`, async () => {
          for (const { path } of uuids) {
            const { fetchImpl, calls } = makeFetchStub();
            await expect(callToolValidated(fetchImpl, name, withValueAt(toolCase.args, path, () => TRAVERSAL)), path.join('.')).rejects.toThrow();
            expect(calls).toHaveLength(0);
          }
        });

        it(`puts an id in a URL only as one encoded segment, even past its schema${label}`, async () => {
          for (const { path } of uuids) {
            // `../admin/…` can't climb out of the tool's route; `<uuid>/rules` can't add a segment.
            for (const value of [TRAVERSAL, SLASHED]) {
              const { calls } = await run(toolCase, name, withValueAt(toolCase.args, path, () => value), false);
              for (const call of calls) {
                const url = new URL(call.url);
                const at = `${path.join('.')} = ${value}: ${call.url}`;
                expect(url.origin, at).toBe('http://test.local');
                expect(url.pathname, at).toMatch(/^\/api\//);
                expect(url.pathname, at).not.toContain('/admin/');
                expect(url.pathname, at).not.toContain(SLASHED);
              }
            }
          }
        });
      }

      if (days.length > 0) {
        it(`refuses a date that isn't a calendar day, before any request${label}`, async () => {
          for (const path of days) {
            for (const notDay of NOT_DAYS) {
              const { fetchImpl, calls } = makeFetchStub();
              const args = withValueAt(toolCase.args, path, () => notDay);
              await expect(callToolValidated(fetchImpl, name, args), `${path.join('.')} = '${notDay}'`).rejects.toThrow();
              expect(calls).toHaveLength(0);
            }
          }
        });
      }

      if (toolCase.rejects) {
        it(`refuses ${toolCase.rejects.map((r) => JSON.stringify(r)).join(', ')}${label}`, async () => {
          for (const change of toolCase.rejects!) {
            const { fetchImpl, calls } = makeFetchStub();
            const args = Object.fromEntries(Object.entries({ ...toolCase.args, ...change }).filter(([, v]) => v !== undefined));
            await expect(callToolValidated(fetchImpl, name, args), JSON.stringify(change)).rejects.toThrow();
            expect(calls).toHaveLength(0);
          }
        });
      }
    }
  });
}
