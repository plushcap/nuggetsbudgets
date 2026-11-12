import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { createTransactionsRoutes } from '../transactions.js';
import { createTransferRoutes } from '../transfer.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import {
  answerProblem,
  attachmentListResponseSchema,
  budgetPeriodTransferResponseSchema,
  transactionBulkCreateResponseSchema,
  transactionCreatedResponseSchema,
  transactionDeletedResponseSchema,
  transactionTagDoneResponseSchema,
  transferResponseSchema,
  transactionBulkEditResponseSchema,
  transactionDetailResponseSchema,
  transactionPageResponseSchema,
  transactionResponseSchema,
  transactionWithSplitsResponseSchema,
} from '@nuggets/shared';
import { z } from 'zod';

/**
 * Every transaction and transfer route's whole answer, pinned: status,
 * body, the truncation header, and what the ledger holds after each request. Written
 * before the routes' logic moved to services/transactions/, so the move is checked
 * against what the routes answered before it, not just against the fields the other
 * suites assert.
 *
 * The answers carry ids, uuids and instants that differ from run to run. Each id or
 * uuid is replaced with a placeholder numbered in the order it first appears, per table
 * for ids (`<merchant:2>`, `<uuid:7>`), and each instant with `<instant>`. So the same
 * answer reads the same every run, and a row that points at another shows it pointing
 * at the same placeholder.
 *
 * Two lists come in no promised order, which can change with the plan Postgres picks
 * (a merge join reverses an unordered jsonb_agg): a transaction's `tags`, and the rows
 * a bulk edit returns (UPDATE … RETURNING). Those are compared in a fixed order, tags
 * by name and the bulk edit's rows by uuid; every other list is pinned as answered.
 */
describe('Transaction routes: whole answers', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  type Ref = { id: number; uuid: string };
  let checking: Ref;
  let savings: Ref;
  let groceries: Ref;
  let dining: Ref;
  let june: Ref;
  let july: Ref;
  let merchant: Ref;
  let trip: Ref;
  let kids: Ref;

  const uuids = new Map<string, string>();
  /** Placeholders for ids, per table: ids of two tables can be the same number. */
  const ids = new Map<string, Map<number, string>>();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const INSTANT_KEY = /(_at|^date_uploaded|^synced_transactiondate)$/;
  /** The table a column's id names. `id` names a row of the list it is in. */
  const ID_TABLE: Record<string, string> = {
    account_id: 'account',
    transfer_source_account_id: 'account',
    merchant_id: 'merchant',
    budget_item_id: 'budget_item',
    budget_period_id: 'period',
    budget_period_item_id: 'period_item',
    assigned_to: 'user',
    tenant_id: 'tenant',
    parent_transaction_id: 'transaction',
    transfer_transaction_id: 'transaction',
  };
  const idTable = (key: string, container: string) =>
    key === 'id' ? (container === 'tags' ? 'tag' : 'transaction') : ID_TABLE[key] ?? (key.endsWith('_id') ? key : null);
  const idPlaceholder = (table: string, id: number) => {
    const forTable = ids.get(table) ?? ids.set(table, new Map()).get(table)!;
    if (!forTable.has(id)) forTable.set(id, `<${table}:${forTable.size + 1}>`);
    return forTable.get(id);
  };

  const normalize = (value: unknown, key = '', container = ''): unknown => {
    if (Array.isArray(value)) {
      const items = key === 'tags' ? [...value].sort((a, b) => String(a?.name).localeCompare(String(b?.name))) : value;
      return items.map((v) => normalize(v, key, key));
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, k, key || container)]));
    }
    if (typeof value === 'string' && UUID.test(value)) {
      if (!uuids.has(value)) uuids.set(value, `<uuid:${uuids.size + 1}>`);
      return uuids.get(value);
    }
    const table = typeof value === 'number' ? idTable(key, container) : null;
    if (table) return idPlaceholder(table, value as number);
    if (INSTANT_KEY.test(key) && value != null) return '<instant>';
    return value;
  };

  const one = async <T = Ref>(text: string, params: unknown[] = []) => (await pool.query(text, params)).rows[0] as T;
  const counts = async () =>
    one<Record<string, number>>(
      `SELECT (SELECT COUNT(*)::int FROM transactions) AS transactions,
              (SELECT COUNT(*)::int FROM taggings) AS taggings,
              (SELECT COUNT(*)::int FROM merchants) AS merchants`,
    );
  const tenantState = async () =>
    normalize(
      (
        await pool.query(
          `SELECT id, uuid, account_id, amount, type, description, notes, merchant_id,
                  transaction_date::text AS transaction_date, budget_item_id, budget_period_id,
                  budget_period_item_id, is_split_parent, parent_transaction_id, transfer_transaction_id,
                  transfer_source_account_id, status, review_status, assigned_to, external_transaction_id,
                  external_link,
                  ARRAY(SELECT tg.name FROM taggings x JOIN tags tg ON tg.id = x.tag_id
                         WHERE x.taggable_type = 'transaction' AND x.taggable_id = t.id ORDER BY tg.name) AS tags
             FROM transactions t ORDER BY id`,
        )
      ).rows,
    );

  type Method = 'get' | 'post' | 'put' | 'delete';
  /** Answer and pin it under `label`; returns the raw body for the next step. */
  /** The rows of an answer whose order isn't promised, by uuid. */
  const byUuid = (rows: { uuid: string }[]) => [...rows].sort((a, b) => a.uuid.localeCompare(b.uuid));
  /**
   * The shared response schema of each answer the frontend parses, by step:
   * the answer must be exactly what it names, so a field a route adds fails here until
   * the schema has it, and the frontend's parse never drops it.
   */
  const transactionList = z.array(transactionResponseSchema);
  const ANSWERS: Record<string, z.ZodType> = {
    'get one': transactionWithSplitsResponseSchema,
    'get one: split': transactionWithSplitsResponseSchema,
    'edit: text, link, amount and envelope': transactionDetailResponseSchema,
    'edit: type to income re-signs': transactionDetailResponseSchema,
    'edit: one transfer side amount': transactionDetailResponseSchema,
    // The split answer is GET /:uuid's: its splits with their names and tags.
    'split: by uuids, with tags': transactionWithSplitsResponseSchema,
    'split: again': transactionWithSplitsResponseSchema,
    unsplit: transactionDetailResponseSchema,
    'list: all': transactionList,
    'list: with children': transactionList,
    'list: date window and type': transactionList,
    'page: first': transactionPageResponseSchema,
    'page: second': transactionPageResponseSchema,
    'page: filters': transactionPageResponseSchema,
    'bulk edit: review and assign': transactionBulkEditResponseSchema,
    // The other answers.
    'create: expense by uuids, tags by uuid and id': transactionCreatedResponseSchema,
    'create: income by numeric ids as strings': transactionCreatedResponseSchema,
    'create: payment keeps its sign': transactionCreatedResponseSchema,
    attachments: attachmentListResponseSchema,
    'tag: add': transactionTagDoneResponseSchema,
    untag: transactionTagDoneResponseSchema,
    'bulk create: dry run': transactionBulkCreateResponseSchema,
    'bulk create': transactionBulkCreateResponseSchema,
    'bulk create: again': transactionBulkCreateResponseSchema,
    'transfer: payment by uuids': transferResponseSchema,
    'transfer: by ids': transferResponseSchema,
    'period move: to July': budgetPeriodTransferResponseSchema,
    'period move: with a note': budgetPeriodTransferResponseSchema,
    'delete: a transfer side': transactionDeletedResponseSchema,
    'delete: the income': transactionDeletedResponseSchema,
  };
  const step = async (label: string, method: Method, path: string, body?: unknown, unordered?: 'transactions') => {
    const req = request(app)[method](path);
    const res = body === undefined ? await req : await req.send(body as object);
    if (ANSWERS[label]) {
      expect(res.status, label).toBeLessThan(400);
      expect.soft(answerProblem(ANSWERS[label], res.body), label).toBeNull();
    }
    if (unordered && Array.isArray(res.body?.[unordered])) res.body[unordered] = byUuid(res.body[unordered]);
    expect({
      status: res.status,
      truncated: res.headers['x-result-truncated'] ?? null,
      body: normalize(res.body),
      after: await counts(),
    }).toMatchSnapshot(label);
    return res.body;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction answers');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/transfer', createTransferRoutes());

    checking = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Answers checking', 'checking', 'cash', 'Asset') RETURNING id, uuid`,
    );
    savings = await one(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Answers savings', 'savings', 'cash', 'Asset') RETURNING id, uuid`,
    );
    groceries = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Groceries', 'Expense') RETURNING id, uuid`);
    dining = await one(`INSERT INTO budget_items (name, expense_type) VALUES ('Dining', 'Expense') RETURNING id, uuid`);
    june = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ('June 2026', 'June', 2026, 6, '2026-06-01', '2026-06-30') RETURNING id, uuid`,
    );
    july = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ('July 2026', 'July', 2026, 7, '2026-07-01', '2026-07-31') RETURNING id, uuid`,
    );
    await pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2), ($1, $3)', [
      june.id,
      groceries.id,
      dining.id,
    ]);
    merchant = await one(`INSERT INTO merchants (name) VALUES ('Corner Market') RETURNING id, uuid`);
    trip = await one(`INSERT INTO tags (name, color) VALUES ('Trip', '#123456') RETURNING id, uuid`);
    kids = await one(`INSERT INTO tags (name) VALUES ('Kids') RETURNING id, uuid`);
    // The fixtures' placeholders come first, in this order, whatever the answers name first.
    for (const [table, r] of [
      ['account', checking], ['account', savings], ['budget_item', groceries], ['budget_item', dining],
      ['period', june], ['period', july], ['merchant', merchant], ['tag', trip], ['tag', kids],
    ] as const) {
      idPlaceholder(table, r.id);
      normalize(r.uuid);
    }
    idPlaceholder('user', tenant.userId);
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  const NOWHERE = '0190a000-0000-7000-8000-000000000000';

  it('answers every route as before', async () => {
    // ---- create
    const created = await step('create: expense by uuids, tags by uuid and id', 'post', '/api/transactions', {
      account_uuid: checking.uuid,
      merchant_uuid: merchant.uuid,
      amount: 42.5,
      description: 'Weekly shop',
      transaction_date: '2026-06-12',
      type: 'expense',
      budget_item_uuid: groceries.uuid,
      budget_period_uuid: june.uuid,
      tag_uuids: [trip.uuid],
      tag_ids: [kids.id, String(kids.id)],
      external_transaction_id: 'stmt-1',
    });
    const expenseUuid = created.transaction.uuid as string;
    // A tag id that isn't one is refused by the body's schema, nothing saved (it
    // was dropped, the transaction saved without it).
    await step('create: a tag id that is not one', 'post', '/api/transactions', {
      account_uuid: checking.uuid,
      amount: 1,
      transaction_date: '2026-06-12',
      type: 'expense',
      tag_ids: [kids.id, 'x'],
    });
    const income = await step('create: income by numeric ids as strings', 'post', '/api/transactions', {
      account_uuid: checking.uuid,
      merchant_id: String(merchant.id),
      amount: '-1000.00',
      transaction_date: '2026-06-01',
      type: 'income',
      budget_item_id: String(dining.id),
      budget_period_id: String(june.id),
      status: 'pending',
      review_status: 'reviewed',
      external_transaction_id: '  ',
    });
    const incomeUuid = income.transaction.uuid as string;
    await step('create: payment keeps its sign', 'post', '/api/transactions', {
      account_uuid: savings.uuid, amount: -5, transaction_date: '2026-06-20', type: 'payment', description: '',
    });
    await step('create: unknown account', 'post', '/api/transactions', {
      account_uuid: NOWHERE, amount: 1, transaction_date: '2026-06-01', type: 'expense',
    });
    await step('create: unknown merchant uuid', 'post', '/api/transactions', {
      account_uuid: checking.uuid, merchant_uuid: NOWHERE, amount: 1, transaction_date: '2026-06-01', type: 'expense',
    });
    await step('create: unknown budget item uuid', 'post', '/api/transactions', {
      account_uuid: checking.uuid, budget_item_uuid: NOWHERE, amount: 1, transaction_date: '2026-06-01', type: 'expense',
    });
    await step('create: unknown period uuid', 'post', '/api/transactions', {
      account_uuid: checking.uuid, budget_period_uuid: NOWHERE, amount: 1, transaction_date: '2026-06-01', type: 'expense',
    });
    await step('create: budget item id of no row', 'post', '/api/transactions', {
      account_uuid: checking.uuid, budget_item_id: 2147483000, amount: 1, transaction_date: '2026-06-01', type: 'expense',
    });
    await step('create: three decimals', 'post', '/api/transactions', {
      account_uuid: checking.uuid, amount: 1.005, transaction_date: '2026-06-01', type: 'expense',
    });
    await step('create: unknown type', 'post', '/api/transactions', {
      account_uuid: checking.uuid, amount: 1, transaction_date: '2026-06-01', type: 'gift',
    });
    await step('create: missing fields', 'post', '/api/transactions', { amount: 0 });

    // ---- read
    await step('get one', 'get', `/api/transactions/${expenseUuid}`);
    await step('get one: none', 'get', `/api/transactions/${NOWHERE}`);
    await step('get one: not a uuid', 'get', '/api/transactions/not-a-uuid');
    await step('attachments', 'get', `/api/transactions/${expenseUuid}/attachments`);
    await step('attachments: none', 'get', `/api/transactions/${NOWHERE}/attachments`);

    // ---- tags
    await step('tag: add', 'post', `/api/transactions/${incomeUuid}/tags/${trip.uuid}`);
    await step('tag: add again', 'post', `/api/transactions/${incomeUuid}/tags/${trip.uuid}`);
    await step('tag: unknown transaction', 'post', `/api/transactions/${NOWHERE}/tags/${trip.uuid}`);
    await step('tag: unknown tag', 'post', `/api/transactions/${incomeUuid}/tags/${NOWHERE}`);
    await step('untag', 'delete', `/api/transactions/${incomeUuid}/tags/${trip.uuid}`);
    await step('untag: unknown transaction', 'delete', `/api/transactions/${NOWHERE}/tags/${trip.uuid}`);
    await step('untag: unknown tag', 'delete', `/api/transactions/${incomeUuid}/tags/${NOWHERE}`);

    // ---- bulk edit
    await step('bulk edit: no uuids', 'put', '/api/transactions/bulk', { updates: { review_status: 'reviewed' } });
    await step('bulk edit: no updates', 'put', '/api/transactions/bulk', { transactionUuids: [expenseUuid] });
    await step('bulk edit: no transaction found', 'put', '/api/transactions/bulk', {
      transactionUuids: [NOWHERE], updates: { review_status: 'reviewed' },
    });
    await step('bulk edit: no allowed field', 'put', '/api/transactions/bulk', {
      transactionUuids: [expenseUuid], updates: { amount: 1 },
    });
    await step('bulk edit: bad status', 'put', '/api/transactions/bulk', {
      transactionUuids: [expenseUuid], updates: { status: 'lost' },
    });
    await step('bulk edit: budget item of no row', 'put', '/api/transactions/bulk', {
      transactionUuids: [expenseUuid], updates: { budget_item_id: 2147483000 },
    });
    await step('bulk edit: assignee outside the ledger', 'put', '/api/transactions/bulk', {
      transactionUuids: [expenseUuid], updates: { assigned_to: 2147483000 },
    });
    await step('bulk edit: review and assign', 'put', '/api/transactions/bulk', {
      transactionUuids: [expenseUuid, incomeUuid, NOWHERE],
      updates: { review_status: 'flagged', assigned_to: tenant.userId, budget_period_item_id: '', notes: 'ignored' },
    }, 'transactions');

    // ---- edit
    await step('edit: none', 'put', `/api/transactions/${NOWHERE}`, { description: 'x' });
    await step('edit: nothing allowed', 'put', `/api/transactions/${expenseUuid}`, { amount_cents: 1 });
    await step('edit: bad link', 'put', `/api/transactions/${expenseUuid}`, { external_link: 'javascript:alert(1)' });
    // A link others open is checked as a website is: a user name in it reads as another site.
    await step('edit: link with a user name', 'put', `/api/transactions/${expenseUuid}`, { external_link: 'https://bank.example@evil.example/r' });
    await step('edit: bad status', 'put', `/api/transactions/${expenseUuid}`, { review_status: 'later' });
    await step('edit: bad type', 'put', `/api/transactions/${expenseUuid}`, { type: 'gift' });
    await step('edit: three decimals', 'put', `/api/transactions/${expenseUuid}`, { amount: '3.333' });
    await step('edit: merchant of no row', 'put', `/api/transactions/${expenseUuid}`, { merchant_id: 2147483000 });
    await step('edit: assignee outside the ledger', 'put', `/api/transactions/${expenseUuid}`, { assigned_to: 2147483000 });
    await step('edit: text, link, amount and envelope', 'put', `/api/transactions/${expenseUuid}`, {
      description: '',
      notes: 'note',
      external_link: 'https://example.com/r/1',
      amount: 40,
      budget_item_id: dining.id,
      budget_period_id: june.id,
      assigned_to: '',
      unknown_field: 'dropped',
    });
    await step('edit: type to income re-signs', 'put', `/api/transactions/${expenseUuid}`, { type: 'income' });
    await step('edit: back to expense', 'put', `/api/transactions/${expenseUuid}`, { type: 'expense', amount: 40 });

    // ---- lists
    await step('list: all', 'get', '/api/transactions');
    await step('list: capped at 1', 'get', '/api/transactions?limit=1');
    await step('list: search and account', 'get', `/api/transactions?search=shop&account_uuid=${checking.uuid}`);
    await step('list: merchant and budget item uuid', 'get', `/api/transactions?merchant_uuid=${merchant.uuid}&budget_item_uuid=${dining.uuid}`);
    await step('list: date window and type', 'get', '/api/transactions?start_date=2026-06-02&end_date=2026-06-30&type=expense');
    // Not uuids, so they name nothing and nothing matches (this answered 500).
    await step('list: bad uuid filters', 'get', '/api/transactions?merchant_uuid=nope&budget_item_uuid=nope');
    await step('list: bad account uuid', 'get', '/api/transactions?account_uuid=nope');
    // A filter that isn't a number or a date is refused, not cast (these answered 500).
    await step('list: filters that are not numbers or dates', 'get',
      '/api/transactions?merchant_id=x&start_date=2026-02-30&end_date=soon&amount_min=lots');
    await step('page: first', 'get', '/api/transactions/paginated?page=1&limit=2');
    await step('page: second', 'get', '/api/transactions/paginated?page=2&limit=2');
    await step('page: filters', 'get', `/api/transactions/paginated?review_status=flagged&amount_min=10&amount_max=100&merchant_id=${merchant.id}`);
    await step('page: assigned', 'get', `/api/transactions/paginated?exclude_unassigned=true`);
    await step('page: assigned to or none', 'get', `/api/transactions/paginated?assigned_to_or_unassigned=${tenant.userId}&limit=500`);
    await step('page: bad account uuid', 'get', '/api/transactions/paginated?account_uuid=nope');
    await step('page: filters that are not numbers or dates', 'get',
      '/api/transactions/paginated?budget_period_id=abc&date_from=abc&date_to=2026-06-01T00:00:00Z&budget_item_id=1.5' +
        '&account_id=99999999999&assigned_to=-1&assigned_to_or_unassigned=me&amount_max=x');
    await step('page: an id sent twice', 'get', '/api/transactions/paginated?budget_period_id=1&budget_period_id=2');

    // ---- splits
    await step('split: too few', 'post', `/api/transactions/${expenseUuid}/split`, { splits: [{ amount: -40 }] });
    await step('split: not a number', 'post', `/api/transactions/${expenseUuid}/split`, { splits: [{ amount: '-20' }, { amount: -20 }] });
    await step('split: three decimals', 'post', `/api/transactions/${expenseUuid}/split`, { splits: [{ amount: -20.005 }, { amount: -19.995 }] });
    await step('split: none', 'post', `/api/transactions/${NOWHERE}/split`, { splits: [{ amount: -20 }, { amount: -20 }] });
    // A split that isn't one has no amount (this was a TypeError, a 500).
    await step('split: a split that is null', 'post', `/api/transactions/${expenseUuid}/split`, { splits: [null, { amount: -40 }] });
    await step('split: does not add up', 'post', `/api/transactions/${expenseUuid}/split`, { splits: [{ amount: -20 }, { amount: -10 }] });
    await step('split: budget item of no row', 'post', `/api/transactions/${expenseUuid}/split`, {
      splits: [{ amount: -20, budget_item_id: 2147483000 }, { amount: -20 }],
    });
    // A tag id that isn't a list, beside tag uuids: refused, not a TypeError.
    await step('split: tag ids not a list', 'post', `/api/transactions/${expenseUuid}/split`, {
      splits: [{ amount: -20, tag_ids: kids.id, tag_uuids: [trip.uuid] }, { amount: -20 }],
    });
    // A tag that names nothing is refused, as a split's other references are (it
    // was dropped, the split saved without it).
    await step('split: a tag of no row', 'post', `/api/transactions/${expenseUuid}/split`, {
      splits: [{ amount: -25, tag_uuids: [trip.uuid, NOWHERE] }, { amount: -15, tag_ids: [kids.id, 2147483000] }],
    });
    await step('split: by uuids, with tags', 'post', `/api/transactions/${expenseUuid}/split`, {
      splits: [
        { amount: -25, budget_item_uuid: groceries.uuid, budget_period_uuid: june.uuid, tag_uuids: [trip.uuid], description: 'Food' },
        { amount: -15, budget_item_id: dining.id, budget_period_id: june.id, tag_ids: [kids.id] },
      ],
    });
    // A budget item uuid of no row is refused, the splits left as they are (it was
    // dropped, the split saved without its item).
    await step('split: a budget item uuid of no row', 'post', `/api/transactions/${expenseUuid}/split`, {
      splits: [{ amount: -10 }, { amount: -10 }, { amount: -20, budget_item_uuid: NOWHERE }],
    });
    await step('split: again', 'post', `/api/transactions/${expenseUuid}/split`, {
      splits: [{ amount: -10 }, { amount: -10 }, { amount: -20 }],
    });
    const splitParent = await step('get one: split', 'get', `/api/transactions/${expenseUuid}`);
    const childUuid = splitParent.split_children[0].uuid as string;
    await step('edit: split parent budget item', 'put', `/api/transactions/${expenseUuid}`, { budget_item_id: groceries.id });
    await step('edit: split parent amount', 'put', `/api/transactions/${expenseUuid}`, { amount: 50 });
    await step('edit: one split amount', 'put', `/api/transactions/${childUuid}`, { amount: -5 });
    await step('edit: one split budget item', 'put', `/api/transactions/${childUuid}`, { budget_item_id: groceries.id });
    await step('delete: one split', 'delete', `/api/transactions/${childUuid}`);
    await step('list: with children', 'get', `/api/transactions?include_children=true&account_uuid=${checking.uuid}`);
    await step('unsplit', 'delete', `/api/transactions/${expenseUuid}/unsplit`);
    await step('unsplit: not split', 'delete', `/api/transactions/${expenseUuid}/unsplit`);

    // ---- bulk create
    const bulkRows = [
      { account_uuid: checking.uuid, amount: 12.34, transaction_date: '2026-06-05', type: 'expense', external_transaction_id: 'b-1',
        merchant_uuid: merchant.uuid, budget_item_uuid: groceries.uuid, budget_period_uuid: june.uuid },
      { account_uuid: checking.uuid, amount: 1, transaction_date: '2026-06-05', type: 'expense', external_transaction_id: 'b-1' },
      { account_uuid: checking.uuid, amount: 1, transaction_date: '2026-06-05', type: 'expense', external_transaction_id: 'stmt-1' },
      { account_uuid: NOWHERE, amount: 1, transaction_date: '2026-06-05', type: 'income', merchant_uuid: NOWHERE },
      { account_uuid: checking.uuid, amount: 1.001, transaction_date: '2026-06-05', type: 'income' },
      { account_uuid: savings.uuid, amount: -7, transaction_date: '2026-06-06', type: 'income', description: 'Refund' },
    ];
    await step('bulk create: dry run', 'post', '/api/transactions/bulk', { transactions: bulkRows, dry_run: true });
    await step('bulk create', 'post', '/api/transactions/bulk', { transactions: bulkRows });
    await step('bulk create: again', 'post', '/api/transactions/bulk', { transactions: bulkRows.slice(0, 1) });
    await step('bulk create: invalid', 'post', '/api/transactions/bulk', { transactions: [] });

    // ---- transfers
    await step('transfer: payment by uuids', 'post', '/api/transfer', {
      source_account_uuid: checking.uuid, destination_account_uuid: savings.uuid, amount: 100,
      transaction_date: '2026-06-15', type: 'payment', description: '  Card  ', budget_period_uuid: june.uuid,
    });
    const transfer = await step('transfer: by ids', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: savings.id, amount: '20.50',
      transaction_date: '2026-06-16', type: 'transfer', budget_period_id: june.id,
    });
    await step('transfer: same account', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: checking.id, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
    });
    await step('transfer: no accounts', 'post', '/api/transfer', { amount: 1, transaction_date: '2026-06-16', type: 'transfer' });
    await step('transfer: unknown source', 'post', '/api/transfer', {
      source_account_uuid: NOWHERE, destination_account_uuid: savings.uuid, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
    });
    await step('transfer: unknown destination', 'post', '/api/transfer', {
      source_account_uuid: checking.uuid, destination_account_uuid: NOWHERE, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
    });
    await step('transfer: destination id of no row', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: 2147483000, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
    });
    // Ids of no row are refused before anything is written, not by the foreign key.
    await step('transfer: source id of no row', 'post', '/api/transfer', {
      source_account_id: 2147483000, destination_account_id: savings.id, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
    });
    await step('transfer: period id of no row', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: savings.id, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
      budget_period_id: 2147483000,
    });
    await step('transfer: unknown period', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: savings.id, amount: 1, transaction_date: '2026-06-16', type: 'transfer',
      budget_period_uuid: NOWHERE,
    });
    await step('transfer: three decimals', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: savings.id, amount: 1.234, transaction_date: '2026-06-16', type: 'transfer',
    });
    await step('transfer: bad type', 'post', '/api/transfer', {
      source_account_id: checking.id, destination_account_id: savings.id, amount: 1, transaction_date: '2026-06-16', type: 'expense',
    });
    const source = transfer.source_transaction_uuid as string;
    await step('edit: one transfer side amount', 'put', `/api/transactions/${source}`, { amount: 30 });
    await step('edit: transfer side to expense', 'put', `/api/transactions/${source}`, { type: 'expense' });
    await step('edit: transfer sides to payment', 'put', `/api/transactions/${source}`, { type: 'payment' });
    // 12.345 was rounded to 12.35 and moved; amounts are whole cents.
    await step('period move: more than 2 decimals', 'post', '/api/transfer/period', {
      account_uuid: checking.uuid, source_period_uuid: june.uuid, amount: '12.345',
    });
    await step('period move: to July', 'post', '/api/transfer/period', {
      account_uuid: checking.uuid, source_period_uuid: june.uuid, amount: '12.35',
    });
    await step('period move: with a note', 'post', '/api/transfer/period', {
      account_uuid: savings.uuid, source_period_uuid: june.uuid, amount: -3, description: ' Leftover ',
    });
    await step('period move: unknown account', 'post', '/api/transfer/period', {
      account_uuid: NOWHERE, source_period_uuid: june.uuid, amount: 1,
    });
    await step('period move: unknown period', 'post', '/api/transfer/period', {
      account_uuid: checking.uuid, source_period_uuid: NOWHERE, amount: 1,
    });
    await step('period move: no next period', 'post', '/api/transfer/period', {
      account_uuid: checking.uuid, source_period_uuid: july.uuid, amount: 1,
    });
    await step('period move: zero', 'post', '/api/transfer/period', {
      account_uuid: checking.uuid, source_period_uuid: june.uuid, amount: 0,
    });

    // ---- delete
    await step('delete: none', 'delete', `/api/transactions/${NOWHERE}`);
    await step('delete: a transfer side', 'delete', `/api/transactions/${source}`);
    await step('delete: the income', 'delete', `/api/transactions/${incomeUuid}`);

    expect(await tenantState()).toMatchSnapshot('ledger at the end');
  });
});
