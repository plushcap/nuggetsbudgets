import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createBudgetRoutes } from '../budgets.js';
import { createBudgetPeriodRoutes } from '../budget-periods.js';
import { createGoalRoutes } from '../goals.js';
import { rejectMalformedIds } from '../../middleware/routeParams.js';
import { requestScope } from '../../middleware/requestScope.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import {
  answerProblem,
  budgetAmountUpdatedResponseSchema,
  budgetEventHistoryResponseSchema,
  budgetItemActivityResponseSchema,
  budgetItemAssignedTransactionsResponseSchema,
  budgetItemMatchingRuleListResponseSchema,
  budgetItemMatchingRuleResponseSchema,
  budgetItemResponseSchema,
  budgetItemTransferResponseSchema,
  budgetPeriodCreatedResponseSchema,
  budgetPeriodDeletedResponseSchema,
  budgetPeriodItemsResponseSchema,
  budgetPeriodListResponseSchema,
  budgetPeriodManagedCreatedResponseSchema,
  budgetPeriodManagementResponseSchema,
  budgetPeriodSummaryListResponseSchema,
  envelopeTransfersResponseSchema,
  goalAccountBalanceHistoryResponseSchema,
  goalBalanceHistoryResponseSchema,
  goalListResponseSchema,
  goalOneResponseSchema,
  goalProgressHistoryResponseSchema,
  messageResponseSchema,
} from '@nuggets/shared';
import { z } from 'zod';

/**
 * Every budget, budget-period and goal route's whole answer, pinned:
 * status and body, and the ledger's budget figures after each write. Written before the
 * routes' database work moved to services (BudgetService, services/budgetPeriods/,
 * services/budgetItems/BudgetItemMatchingRules.ts, GoalService), so the move is checked
 * against what the routes answered before it; a change of answer the move makes on
 * purpose shows in the snapshot's diff, in the commit that makes it.
 *
 * The answers carry ids, uuids, instants and days counted from today, which differ from
 * run to run. Each id is replaced with a placeholder numbered in the order it first
 * appears, per table (`<budget_item:2>`), each uuid likewise (`<uuid:7>`), each instant
 * with `<instant>`, the request id with `<request>`, today with `<today>` and another day
 * worked out from today with `<from-today>`. The fixtures' own days (up to May 2024, and
 * the two targets in 2027) stay as they are. The app's requestScope is mounted, so a
 * refusal reads as the app answers it, with the code it fills in.
 */
describe('Budget, budget-period and goal routes: whole answers', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  let today: string;
  type Ref = { id: number; uuid: string };
  let checking: Ref;
  let envelopeAccount: Ref;
  let savings: Ref;
  let hidden: Ref;
  let merchant: Ref;
  let category: Ref;

  const uuids = new Map<string, string>();
  const ids = new Map<string, Map<number, string>>();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  const INSTANT_KEY = /(_at|^timestamp)$/;
  /** The fixtures' days: every other day in an answer is worked out from today (today is after 2026-11). */
  const isFixtureDay = (day: string) => day <= '2024-05-31' || day === '2027-06-30' || day === '2027-01-31';
  /** The table of the rows a list or object holds, when it isn't the step's. */
  const CONTAINER_TABLE: Record<string, string> = {
    associated_accounts: 'account',
    associated_budget_items: 'budget_item',
    envelope_account: 'account',
  };
  /** The table a key's number names; `id` names a row of the table the step says. */
  const ID_TABLE: Record<string, string> = {
    account_id: 'account',
    budget_item_id: 'budget_item',
    budgetItemId: 'budget_item',
    merchant_id: 'merchant',
    category_id: 'category',
    budget_period_id: 'period',
    period_id: 'period',
    budget_period_item_id: 'period_item',
    from_id: 'period_item',
    to_id: 'period_item',
    eventId: 'event',
    event_id: 'event',
    user_id: 'user',
    created_by: 'user',
    updated_by: 'user',
    tenant_id: 'tenant',
    transaction_auto_tag_id: 'tag',
  };
  const idPlaceholder = (table: string, id: number) => {
    const forTable = ids.get(table) ?? ids.set(table, new Map()).get(table)!;
    if (!forTable.has(id)) forTable.set(id, `<${table}:${forTable.size + 1}>`);
    return forTable.get(id);
  };

  const normalize = (value: unknown, idTable: string, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => normalize(v, idTable, key));
    if (value && typeof value === 'object') {
      const table = CONTAINER_TABLE[key] ?? idTable;
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, table, k)]));
    }
    if (key === 'requestId' && typeof value === 'string') return '<request>';
    if (typeof value === 'string' && UUID.test(value)) {
      if (!uuids.has(value)) uuids.set(value, `<uuid:${uuids.size + 1}>`);
      return uuids.get(value);
    }
    if (typeof value === 'number' && Number.isInteger(value)) {
      const table = key === 'id' ? idTable : ID_TABLE[key];
      if (table) return idPlaceholder(table, value);
    }
    if (INSTANT_KEY.test(key) && value != null) return '<instant>';
    if (typeof value === 'string' && DAY.test(value) && !isFixtureDay(value)) {
      return value === today ? '<today>' : '<from-today>';
    }
    return value;
  };

  const one = async <T = Ref>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as T;
  /** The ledger's budget figures: what a write to the budget changes. */
  const budgetState = async () =>
    (
      await pool.query(
        `SELECT (SELECT COUNT(*)::int FROM budget_period) AS periods,
                (SELECT COUNT(*)::int FROM budget_period_items) AS period_items,
                (SELECT COUNT(*)::int FROM budget_period_transactions) AS events,
                (SELECT COALESCE(SUM(CASE WHEN transaction_type IN ('add', 'move_in') THEN amount ELSE -amount END), 0)::text
                   FROM budget_period_transactions) AS events_net,
                (SELECT COUNT(*)::int FROM transactions WHERE budget_period_id IS NOT NULL) AS transactions_in_periods,
                (SELECT COUNT(*)::int FROM budget_item_matching_rules) AS rules,
                (SELECT COUNT(*)::int FROM budget_items) AS items,
                (SELECT COUNT(*)::int FROM budget_item_accounts WHERE valid_to IS NULL) AS goal_accounts,
                (SELECT COUNT(*)::int FROM goal_budget_items WHERE valid_to IS NULL) AS goal_envelopes`,
      )
    ).rows[0];

  type Method = 'get' | 'post' | 'put' | 'delete';
  /**
   * The shared response schema of each answer the frontend parses, by
   * step: the answer must be exactly what it names, so a field a route adds fails here
   * until the schema has it, and the frontend's parse never drops it.
   */
  const ANSWERS: Record<string, z.ZodType> = {
    'items: create a monthly item': budgetItemResponseSchema,
    'items: create an envelope': budgetItemResponseSchema,
    'items: create income': budgetItemResponseSchema,
    'items: list': z.array(budgetItemResponseSchema),
    'items: update': budgetItemResponseSchema,
    'periods: list': budgetPeriodListResponseSchema,
    'period items: April': budgetPeriodItemsResponseSchema,
    'period items: April, one item': budgetPeriodItemsResponseSchema,
    'periods: April summary': budgetPeriodSummaryListResponseSchema,
    'goals: create': goalOneResponseSchema,
    'goals: list': goalListResponseSchema,
    'goals: one': goalOneResponseSchema,
    'goals: update': goalOneResponseSchema,
    'goals: list after archiving': goalListResponseSchema,
    // Every other answer the frontend reads.
    'periods: create March': budgetPeriodCreatedResponseSchema,
    'periods: managed create of April': budgetPeriodManagedCreatedResponseSchema,
    'periods: managed create of May without taking its transactions': budgetPeriodManagedCreatedResponseSchema,
    'periods: management': budgetPeriodManagementResponseSchema,
    'budget: set an amount': budgetAmountUpdatedResponseSchema,
    'budget: set another': budgetAmountUpdatedResponseSchema,
    'transfer: move money': budgetItemTransferResponseSchema,
    'transfer: default description': budgetItemTransferResponseSchema,
    'activity: budget events of an item': budgetItemActivityResponseSchema,
    'activity: transactions of an item': budgetItemAssignedTransactionsResponseSchema,
    'events: one item': budgetEventHistoryResponseSchema,
    'events: one period, limited': budgetEventHistoryResponseSchema,
    'envelope transfers: April': envelopeTransfersResponseSchema,
    'rules: create by ids': budgetItemMatchingRuleResponseSchema,
    'rules: create by uuids': budgetItemMatchingRuleResponseSchema,
    'rules: list': budgetItemMatchingRuleListResponseSchema,
    'rules: list by item uuid': budgetItemMatchingRuleListResponseSchema,
    'rules: list by item id': budgetItemMatchingRuleListResponseSchema,
    'rules: update': budgetItemMatchingRuleResponseSchema,
    'goals: link an account': messageResponseSchema,
    'goals: link a hidden account': messageResponseSchema,
    'goals: link an envelope': messageResponseSchema,
    'goals: unlink an account': messageResponseSchema,
    'goals: unlink an envelope': messageResponseSchema,
    'goals: progress history': goalProgressHistoryResponseSchema,
    'goals: progress history over a range': goalProgressHistoryResponseSchema,
    'goals: balance history': goalBalanceHistoryResponseSchema,
    'goals: balance history by account': goalAccountBalanceHistoryResponseSchema,
    'periods: delete May': budgetPeriodDeletedResponseSchema,
    'periods: delete April': budgetPeriodDeletedResponseSchema,
  };
  /** Send, pin the answer under `label` (ids named `id` are rows of `idTable`), and return the raw body. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const step = async (label: string, idTable: string, method: Method, path: string, body?: unknown): Promise<any> => {
    const req = request(app)[method](path);
    const res = body === undefined ? await req : await req.send(body as object);
    if (ANSWERS[label]) {
      expect(res.status, label).toBeLessThan(400);
      expect.soft(answerProblem(ANSWERS[label], res.body), label).toBeNull();
    }
    expect.soft({
      status: res.status,
      body: normalize(res.body, idTable),
      after: method === 'get' ? undefined : await budgetState(),
    }).toMatchSnapshot(label);
    return res.body;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Budget answers');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(requestScope);
    app.use(tenant.context());
    app.use('/api/budgets', rejectMalformedIds(createBudgetRoutes()));
    app.use('/api/budget-periods', rejectMalformedIds(createBudgetPeriodRoutes()));
    app.use('/api/goals', rejectMalformedIds(createGoalRoutes()));

    today = (await one<{ today: string }>(`SELECT app_today()::text AS today`)).today;
    const account = (name: string, extra = '') =>
      one(`INSERT INTO accounts (name, account_type, account_group, type${extra ? `, ${extra}` : ''})
           VALUES ($1, 'checking', 'cash', 'Asset'${extra ? ', true' : ''}) RETURNING id, uuid`, [name]);
    checking = await account('Answers checking');
    savings = await account('Answers savings');
    hidden = await account('Answers hidden', 'hide_account');
    category = await one(`INSERT INTO categories (name) VALUES ('Household') RETURNING id, uuid`);
    merchant = await one(`INSERT INTO merchants (name) VALUES ('Corner Market') RETURNING id, uuid`);
    for (const [table, r] of [
      ['account', checking], ['account', savings], ['account', hidden], ['category', category], ['merchant', merchant],
    ] as const) {
      idPlaceholder(table, r.id);
      normalize(r.uuid, table);
    }
    idPlaceholder('user', tenant.userId);
    idPlaceholder('tenant', tenant.tenantId);

    // March and April 2024's transactions, before their periods exist (the create routes take
    // them in: POST /api/budgets/periods March's, POST /api/budget-periods April's).
    await pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, 1000.00, '2024-04-01', 'income', 'Pay'), ($1, -50.10, '2024-04-05', 'expense', 'Shop'),
              ($1, -20.20, '2024-04-10', 'expense', 'Shop again'), ($2, 300.00, '2024-03-15', 'income', 'Interest'),
              ($3, 5000.00, '2024-03-15', 'income', 'Hidden money')`,
      [checking.id, savings.id, hidden.id],
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const NOWHERE = '0190a000-0000-7000-8000-000000000000';

  /** Both sides of a transfer of `amount` from checking to the envelope account, in `periodId`. */
  const envelopeTransfer = async (amount: string, date: string, periodId: number) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insert = `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_period_id, transfer_source_account_id)
                      VALUES ($1, $2, $3, 'transfer', 'To the envelopes', $4, $5) RETURNING id`;
      const from = (await client.query(insert, [checking.id, `-${amount}`, date, periodId, null])).rows[0].id;
      const to = (await client.query(insert, [envelopeAccount.id, amount, date, periodId, checking.id])).rows[0].id;
      await client.query('UPDATE transactions SET transfer_transaction_id = $1 WHERE id = $2', [to, from]);
      await client.query('UPDATE transactions SET transfer_transaction_id = $1 WHERE id = $2', [from, to]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };

  it('answers every budget route as before', async () => {
    // ---- budget items
    const groceries = await step('items: create a monthly item', 'budget_item', 'post', '/api/budgets/items', {
      name: 'Groceries', expense_type: 'Expense', type: 'Monthly', subtype: 'Flexible', priority: 'Essential',
      default_budget_amount: 400, category_id: category.id, color: '#123456', icon: 'Cart',
    });
    const carFund = await step('items: create an envelope', 'budget_item', 'post', '/api/budgets/items', {
      name: 'Car fund', expense_type: 'Expense', type: 'Envelope', rollover: true, default_budget_amount: 50,
    });
    const pay = await step('items: create income', 'budget_item', 'post', '/api/budgets/items', {
      name: 'Pay', expense_type: 'Income', type: 'Monthly', subtype: 'Paycheck',
    });
    await step('items: list', 'budget_item', 'get', '/api/budgets/items');
    await step('items: update', 'budget_item', 'put', `/api/budgets/items/${groceries.uuid}`, {
      description: 'Food', recurring_next_payment_date: '', rollover_target_date: '2027-01-31',
    });

    // ---- budget periods
    const march = await step('periods: create March', 'period', 'post', '/api/budgets/periods', { year: 2024, month: 3 });
    await step('periods: create March again', 'period', 'post', '/api/budgets/periods', { year: 2024, month: 3 });
    await step('periods: create without a month', 'period', 'post', '/api/budgets/periods', { year: 2024 });
    await step('periods: managed create of April', 'period', 'post', '/api/budget-periods', { year: 2024, month: 4 });
    await step('periods: managed create of April again', 'period', 'post', '/api/budget-periods', { year: 2024, month: 4 });
    await step('periods: managed create of month 13', 'period', 'post', '/api/budget-periods', { year: 2024, month: 13 });
    await step('periods: managed create without a year', 'period', 'post', '/api/budget-periods', { month: 5 });
    await step('periods: managed create of May without taking its transactions', 'period', 'post', '/api/budget-periods', {
      year: 2024, month: 5, associate_transactions: false,
    });
    const periods = await step('periods: list', 'period', 'get', '/api/budgets/periods');
    const april = periods.find((p: { month_number: number }) => p.month_number === 4);
    const may = periods.find((p: { month_number: number }) => p.month_number === 5);
    await step('periods: management', 'period', 'get', '/api/budget-periods/management');

    // ---- the period's items and budgets
    const aprilItems = await step('period items: April', 'period_item', 'get', `/api/budgets/periods/${april.uuid}/items`);
    await step('period items: April, one item', 'period_item', 'get', `/api/budgets/periods/${april.uuid}/items?budget_item_uuid=${carFund.uuid}`);
    await step('period items: a period that is not there', 'period_item', 'get', `/api/budgets/periods/${NOWHERE}/items`);
    const itemOf = (rows: Array<{ budget_item_id: number; id: number; uuid: string }>, budgetItemId: number) =>
      rows.find((r) => r.budget_item_id === budgetItemId)!;
    const aprilCar = itemOf(aprilItems.data, carFund.id);
    const aprilGroceries = itemOf(aprilItems.data, groceries.id);
    const aprilPay = itemOf(aprilItems.data, pay.id);
    await step('budget: set an amount', 'period_item', 'put', `/api/budgets/period-items/${aprilCar.uuid}/budget`, {
      amount: 120.5, description: 'Saving up',
    });
    await step('budget: set another', 'period_item', 'put', `/api/budgets/period-items/${aprilGroceries.uuid}/budget`, { amount: 400 });
    await step('budget: an amount that is text', 'period_item', 'put', `/api/budgets/period-items/${aprilGroceries.uuid}/budget`, { amount: 'twelve' });
    await step('budget: three decimals', 'period_item', 'put', `/api/budgets/period-items/${aprilGroceries.uuid}/budget`, { amount: 1.005 });
    await step('budget: a period item that is not there', 'period_item', 'put', `/api/budgets/period-items/${NOWHERE}/budget`, { amount: 1 });
    await step('periods: April summary', 'period', 'get', `/api/budgets/periods/${april.uuid}/summary`);
    await step('periods: summary of a period that is not there', 'period', 'get', `/api/budgets/periods/${NOWHERE}/summary`);

    // ---- transfers between items, in the period
    await step('transfer: move money', 'period_item', 'post', `/api/budget-periods/${april.uuid}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilGroceries.id, amount: 20.25, description: 'Top up',
    });
    await step('transfer: default description', 'period_item', 'post', `/api/budget-periods/${april.uuid}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilPay.id, amount: '1.10',
    });
    await step('transfer: without a source', 'period_item', 'post', `/api/budget-periods/${april.uuid}/transfer`, {
      toBudgetPeriodItemId: aprilGroceries.id, amount: 1,
    });
    await step('transfer: zero', 'period_item', 'post', `/api/budget-periods/${april.uuid}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilGroceries.id, amount: 0,
    });
    await step('transfer: to itself', 'period_item', 'post', `/api/budget-periods/${april.uuid}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilCar.id, amount: 1,
    });
    await step('transfer: more than it has', 'period_item', 'post', `/api/budget-periods/${april.uuid}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilGroceries.id, amount: 5000,
    });
    await step('transfer: into another period', 'period_item', 'post', `/api/budget-periods/${may.uuid}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilGroceries.id, amount: 1,
    });
    await step('transfer: a period that is not there', 'period_item', 'post', `/api/budget-periods/${NOWHERE}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilGroceries.id, amount: 1,
    });
    // A period is named by its uuid: the numeric path names nothing.
    await step('transfer: by the period id', 'period_item', 'post', `/api/budget-periods/${april.id}/transfer`, {
      fromBudgetPeriodItemId: aprilCar.id, toBudgetPeriodItemId: aprilGroceries.id, amount: 1,
    });
    await step('activity: budget events of an item', 'event', 'get', `/api/budget-periods/items/${aprilCar.uuid}/budget-activity`);
    await step('activity: transactions of an item', 'transaction', 'get', `/api/budget-periods/items/${aprilGroceries.uuid}/transactions`);
    await step('activity: a period item that is not there', 'event', 'get', `/api/budget-periods/items/${NOWHERE}/budget-activity`);
    await step('activity: by the period item id', 'event', 'get', `/api/budget-periods/items/${aprilCar.id}/budget-activity`);
    await step('activity: transactions by the period item id', 'transaction', 'get', `/api/budget-periods/items/${aprilGroceries.id}/transactions`);

    // ---- budget events
    await step('events: one item', 'event', 'get', `/api/budgets/events?budget_item_uuid=${carFund.uuid}`);
    await step('events: one period, limited', 'event', 'get', `/api/budgets/events?period_uuid=${april.uuid}&limit=2`);
    await step('events: an item that is not there', 'event', 'get', `/api/budgets/events?budget_item_uuid=${NOWHERE}`);
    await step('events: a period that is not there', 'event', 'get', `/api/budgets/events?period_uuid=${NOWHERE}`);

    // ---- envelope transfers
    await step('envelope transfers: no envelope account', 'account', 'get', `/api/budgets/periods/${april.uuid}/envelope-transfers`);
    envelopeAccount = await one(
      `INSERT INTO accounts (name, account_type, account_group, type, is_envelope_account)
       VALUES ('Answers envelopes', 'savings', 'cash', 'Asset', true) RETURNING id, uuid`,
    );
    await envelopeTransfer('0.10', '2024-04-02', april.id);
    await envelopeTransfer('0.20', '2024-04-03', april.id);
    await step('envelope transfers: April', 'account', 'get', `/api/budgets/periods/${april.uuid}/envelope-transfers`);
    await step('envelope transfers: a period that is not there', 'account', 'get', `/api/budgets/periods/${NOWHERE}/envelope-transfers`);

    // ---- matching rules
    const rule = await step('rules: create by ids', 'rule', 'post', '/api/budgets/item-matching-rules', {
      budget_item_id: groceries.id, method: 'contains', matching_text: '  corner  ', amount_min: 5, amount_max: 500, priority: 10, notes: ' weekly ',
    });
    await step('rules: create by uuids', 'rule', 'post', '/api/budgets/item-matching-rules', {
      budget_item_uuid: pay.uuid, merchant_uuid: merchant.uuid, method: 'merchant_exact',
    });
    await step('rules: create without a method', 'rule', 'post', '/api/budgets/item-matching-rules', { budget_item_id: groceries.id });
    await step('rules: create with an unknown method', 'rule', 'post', '/api/budgets/item-matching-rules', {
      budget_item_id: groceries.id, method: 'sounds_like', matching_text: 'x',
    });
    await step('rules: create a text rule without text', 'rule', 'post', '/api/budgets/item-matching-rules', {
      budget_item_id: groceries.id, method: 'contains', matching_text: '   ',
    });
    await step('rules: create a merchant rule without a merchant', 'rule', 'post', '/api/budgets/item-matching-rules', {
      budget_item_id: groceries.id, method: 'merchant_exact',
    });
    await step('rules: list', 'rule', 'get', '/api/budgets/item-matching-rules');
    await step('rules: list by item uuid', 'rule', 'get', `/api/budgets/item-matching-rules?budget_item_uuid=${pay.uuid}`);
    await step('rules: list by item id', 'rule', 'get', `/api/budgets/item-matching-rules?budget_item_id=${groceries.id}`);
    await step('rules: update', 'rule', 'put', `/api/budgets/item-matching-rules/${rule.uuid}`, {
      budget_item_uuid: carFund.uuid, method: 'starts_with', matching_text: 'CORNER', is_active: false,
    });
    await step('rules: update one that is not there', 'rule', 'put', `/api/budgets/item-matching-rules/${NOWHERE}`, {
      budget_item_id: groceries.id, method: 'contains', matching_text: 'x',
    });
    await step('rules: update without a method', 'rule', 'put', `/api/budgets/item-matching-rules/${rule.uuid}`, { budget_item_id: groceries.id });
    await step('rules: delete', 'rule', 'delete', `/api/budgets/item-matching-rules/${rule.uuid}`);
    await step('rules: delete one that is not there', 'rule', 'delete', `/api/budgets/item-matching-rules/${rule.uuid}`);

    // ---- goals
    const goal = await step('goals: create', 'goal', 'post', '/api/goals', {
      name: 'House', description: 'A deposit', target_amount: '10000.00', target_date: '2027-06-30', estimated_monthly_contribution: 250,
    });
    await step('goals: create without a target', 'goal', 'post', '/api/goals', { name: 'Nothing', target_date: '2027-06-30' });
    const goalUuid = goal.goal.uuid;
    await step('goals: link an account', 'goal', 'post', `/api/goals/${goalUuid}/accounts`, { account_id: savings.id });
    await step('goals: link a hidden account', 'goal', 'post', `/api/goals/${goalUuid}/accounts`, { account_id: hidden.id });
    await step('goals: link an account that is not there', 'goal', 'post', `/api/goals/${goalUuid}/accounts`, { account_id: 2147483647 });
    await step('goals: link without an account', 'goal', 'post', `/api/goals/${goalUuid}/accounts`, {});
    await step('goals: link an envelope', 'goal', 'post', `/api/goals/${goalUuid}/budget-items`, { budget_item_id: carFund.id });
    await step('goals: link an item that is not an envelope', 'goal', 'post', `/api/goals/${goalUuid}/budget-items`, { budget_item_id: groceries.id });
    await step('goals: link to a goal that is not there', 'goal', 'post', `/api/goals/${NOWHERE}/budget-items`, { budget_item_id: carFund.id });
    await step('goals: list', 'goal', 'get', '/api/goals');
    await step('goals: one', 'goal', 'get', `/api/goals/${goalUuid}`);
    await step('goals: one that is not there', 'goal', 'get', `/api/goals/${NOWHERE}`);
    await step('goals: update', 'goal', 'put', `/api/goals/${goalUuid}`, { name: 'Bigger house', target_amount: 12000 });
    await step('goals: update one that is not there', 'goal', 'put', `/api/goals/${NOWHERE}`, { name: 'x' });
    await step('goals: progress history', 'goal', 'get', `/api/goals/${goalUuid}/progress-history`);
    await step('goals: progress history over a range', 'goal', 'get', `/api/goals/${goalUuid}/progress-history?start_date=2024-01-01&end_date=2024-04-30`);
    await step('goals: progress history from a day that is not one', 'goal', 'get', `/api/goals/${goalUuid}/progress-history?start_date=2024-02-30`);
    await step('goals: progress history backwards', 'goal', 'get', `/api/goals/${goalUuid}/progress-history?start_date=2024-04-01&end_date=2024-01-01`);
    await step('goals: balance history', 'goal', 'get', `/api/goals/${goalUuid}/balance-history?limit=2&period=year`);
    await step('goals: balance history by account', 'goal', 'get', `/api/goals/${goalUuid}/account-balance-history?limit=1&period=week`);
    await step('goals: balance history of a goal that is not there', 'goal', 'get', `/api/goals/${NOWHERE}/balance-history`);
    // An account or envelope is named by its uuid: the numeric path names nothing.
    await step('goals: unlink an account by its id', 'goal', 'delete', `/api/goals/${goalUuid}/accounts/${hidden.id}`);
    await step('goals: unlink an envelope by its id', 'goal', 'delete', `/api/goals/${goalUuid}/budget-items/${carFund.id}`);
    await step('goals: unlink an account', 'goal', 'delete', `/api/goals/${goalUuid}/accounts/${hidden.uuid}`);
    await step('goals: unlink an envelope', 'goal', 'delete', `/api/goals/${goalUuid}/budget-items/${carFund.uuid}`);
    await step('goals: delete an image it does not have', 'goal', 'delete', `/api/goals/${goalUuid}/image`);
    await step('goals: archive', 'goal', 'delete', `/api/goals/${goalUuid}`);
    await step('goals: archive one that is not there', 'goal', 'delete', `/api/goals/${NOWHERE}`);
    await step('goals: list after archiving', 'goal', 'get', '/api/goals');

    // ---- deleting a period
    await step('periods: delete May', 'period', 'delete', `/api/budget-periods/${may.uuid}`);
    await step('periods: delete one that is not there', 'period', 'delete', `/api/budget-periods/${NOWHERE}`);
    await step('periods: delete April', 'period', 'delete', `/api/budget-periods/${april.uuid}`);
    void march;
  });
});
