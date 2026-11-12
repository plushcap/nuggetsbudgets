import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import pg from 'pg';
import http from 'http';
import { createApp } from '../../app.js';
import { mountRoutes } from '../../routes.js';
import { sessionService } from '../../middleware/auth.js';
import { SESSION_COOKIE_NAME } from '../../utils/session-cookie-config.js';
import type { ApplicationLifecycleService } from '../../services/ApplicationLifecycleService.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { contentDisposition } from '../../utils/uploadSafety.js';

/**
 * The CSV exports (/api/export/*) through the real app, against the real schema.
 *
 * Ledger A gets one of each thing an export shows; ledger B, in another organization,
 * gets its own copies with a different marker. Each export is downloaded as A's signed-in
 * user and checked for: 200, its exact header row, a seeded row's values (money exact as
 * NUMERIC text, calendar dates as YYYY-MM-DD, instants as ISO-8601 UTC, user text guarded
 * against spreadsheet formulas), and rows from ledger A only.
 *
 * Also covers the two /api/import balance routes, which read a table that never existed
 * and were removed: they must be gone, not answer 500.
 *
 * And that an export streams: a ledger with more rows than one batch is read a
 * batch at a time and written as it goes, whole and in order, with no transaction open while
 * it writes.
 */

const TRANSACTION_HEADERS = [
  'uuid', 'transaction_date', 'description', 'merchant_name', 'amount', 'type', 'account_name',
  'budget_period_name', 'budget_item_name', 'assigned_to', 'tags', 'status', 'review_status', 'notes',
  'pending', 'import_description', 'import_posted_date', 'import_transacted_at', 'import_provider',
  'import_transaction_id', 'import_imported_at', 'created_at', 'updated_at',
];
const ACCOUNT_TRANSACTION_HEADERS = [
  'uuid', 'transaction_date', 'description', 'merchant_name', 'amount', 'running_balance', 'type',
  'budget_period_name', 'budget_item_name', 'assigned_to', 'tags', 'status', 'review_status', 'notes',
  'pending', 'import_description', 'import_posted_date', 'import_transacted_at', 'import_provider',
  'import_transaction_id', 'import_imported_at', 'created_at', 'updated_at',
];
const BUDGET_ITEM_HEADERS = [
  'uuid', 'name', 'expense_type', 'priority', 'type', 'subtype', 'description', 'category_name',
  'merchant_name', 'rollover', 'rollover_target_amount', 'rollover_target_date', 'rollover_starting_balance',
  'rollover_starting_balance_date', 'default_budget_amount', 'isbill', 'recurring_payment',
  'recurring_payment_amount', 'recurring_payment_frequency', 'recurring_last_payment_date',
  'recurring_next_payment_date', 'recurring_amount_varies', 'goal_target_amount', 'goal_target_date',
  'icon', 'color', 'status', 'tags', 'created_at', 'updated_at',
];
const ACCOUNT_HEADERS = [
  'uuid', 'name', 'account_type', 'account_group', 'type', 'subtype', 'institution_name',
  'account_number', 'routing_number', 'balance', 'import_balance', 'import_available_balance',
  'import_balance_date', 'exclude_account_balance', 'hide_account', 'hide_transactions', 'close_account',
  'is_envelope_account', 'require_zero_balance', 'custom_sort', 'notes', 'created_at', 'updated_at',
];
const MERCHANT_HEADERS = [
  'id', 'uuid', 'name', 'merchant_website', 'merchant_accountid', 'merchant_image', 'notes', 'instructions',
  'auto_tag_name', 'transaction_count', 'total_transaction_amount', 'first_transaction_date',
  'last_transaction_date', 'rule_count', 'matching_rules', 'created_at', 'updated_at',
];

// An instant as the exports write it: ISO-8601 in UTC, like the JSON API.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Parse RFC-4180 CSV (quoted cells may hold commas, quotes and newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  // An export with no rows is just the header line and its newline.
  if (!(row.length === 1 && row[0] === '')) rows.push(row);
  return rows;
}

/** The header row and the data rows keyed by header, checking every row is as wide as the header. */
function readCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const [headers, ...data] = parseCsv(text);
  for (const r of data) expect(r.length, `row ${JSON.stringify(r)}`).toBe(headers.length);
  return { headers, rows: data.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))) };
}

/** A batch of an export's rows: read by their ids, in the order the export took them (ExportService). */
const isBatch = (text: string) => text.includes('WITH ORDINALITY AS k(');

/** What {@link watchQueries} has seen so far. */
interface QueryWatch {
  maxRows: number;
  statements: string[];
}

/**
 * Run `fn`, watching every query the app sends Postgres: the most rows any one of them
 * returned, and the SQL of each. `intercept` may hold a statement back until a promise
 * settles, and fail it if that promise rejects.
 */
async function watchQueries<T>(
  fn: (watch: QueryWatch) => Promise<T>,
  intercept: (text: string) => Promise<void> | undefined = () => undefined
): Promise<{ result: T } & QueryWatch> {
  const query = pg.Client.prototype.query as (...args: unknown[]) => unknown;
  const watch: QueryWatch = { maxRows: 0, statements: [] };
  const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const text = (typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string } | undefined)?.text ?? '')).trim();
    watch.statements.push(text);
    const held = intercept(text);
    const out = held ? held.then(() => query.apply(this, args)) : query.apply(this, args);
    if (out instanceof Promise) {
      out.then((r: { rows?: unknown[] }) => (watch.maxRows = Math.max(watch.maxRows, r?.rows?.length ?? 0)), () => {});
    }
    return out;
  } as never);
  try {
    return { result: await fn(watch), ...watch };
  } finally {
    spy.mockRestore();
  }
}

const lifecycleStub = new Proxy(
  {},
  { get: (_target, prop) => (prop === 'then' ? undefined : async () => undefined) }
) as unknown as ApplicationLifecycleService;

type Ref = { id: number; uuid: string };

describe('CSV exports', () => {
  let app: express.Application;
  let a: TestTenant;
  let b: TestTenant;
  const tokens = {} as Record<'a' | 'b', string>;
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const markA = `export-a-${stamp}`;
  const markB = `export-b-${stamp}`;
  const seedA = {} as Record<
    'institution' | 'account' | 'category' | 'merchant' | 'tag' | 'period' | 'budgetItem'
      | 't0' | 't1' | 't2' | 't3' | 'c1' | 'c2',
    Ref
  >;
  const seedB = {} as Record<'account' | 'merchant' | 'budgetItem' | 'transaction', Ref>;

  const get = (who: 'a' | 'b', url: string) =>
    request(app).get(url).set('Cookie', `${SESSION_COOKIE_NAME}=${tokens[who]}`);

  /** Download an export as A: 200, CSV, the given header row exactly. */
  async function download(url: string, headers: string[], who: 'a' | 'b' = 'a') {
    const res = await get(who, url);
    expect(res.status, res.text).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    // Named with contentDisposition(), not a header built by hand.
    const disposition = String(res.headers['content-disposition']);
    const name = /^attachment; filename="([^"]+\.csv)"; /.exec(disposition)?.[1];
    expect(name, disposition).toBeDefined();
    expect(disposition).toBe(contentDisposition('attachment', name!));
    const csv = readCsv(res.text);
    expect(csv.headers).toEqual(headers);
    return { ...csv, text: res.text };
  }

  /** The rows of ledger B, and its marker, must not appear in A's export. */
  function expectNothingOfB(text: string) {
    expect(text).not.toContain(markB);
    for (const ref of Object.values(seedB)) expect(text).not.toContain(ref.uuid);
    expect(text).not.toContain('777.77');
  }

  /** The uuids an export lists are exactly the ledger's own rows of that table. */
  async function expectOwnRows(tenant: TestTenant, table: string, rows: Record<string, string>[]) {
    const own = await tenant.pool.query<{ uuid: string }>(`SELECT uuid FROM ${table}`);
    expect(rows.map((r) => r.uuid).sort()).toEqual(own.rows.map((r) => r.uuid).sort());
  }

  beforeAll(async () => {
    app = createApp();
    mountRoutes(app, { lifecycleService: lifecycleStub });

    a = await createTestTenant('Export A');
    b = await createTestTenant('Export B');
    for (const [key, tenant] of [['a', a], ['b', b]] as const) {
      const { token, sessionId } = await sessionService.createSession({ userId: tenant.userId });
      await tenant.pool.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [tenant.tenantId, sessionId]);
      tokens[key] = token;
    }

    // Ledger A, through its own RLS-scoped pool.
    // The split below and its splits go in one transaction: they must add up when it
    // commits. Everything else goes straight to the pool.
    let db: Pick<pg.Pool, 'query'> = a.pool;
    const one = async (sql: string, params: unknown[] = []): Promise<Ref> =>
      (await db.query<Ref>(`${sql} RETURNING id, uuid`, params)).rows[0];
    seedA.institution = await one('INSERT INTO account_institutions (name) VALUES ($1)', [`${markA} Bank`]);
    seedA.account = await one(
      `INSERT INTO accounts (name, account_type, account_group, type, subtype, institution_id, account_number,
                             routing_number, notes, import_balance, import_available_balance, import_balance_date,
                             custom_sort, is_envelope_account)
       VALUES ($1, 'checking', 'cash', 'Asset', 'Checking', $2, '000123', '123456789',
               '=HYPERLINK("http://evil.example")', 1500.10, 1400.05, '2025-03-31T12:00:00Z', 7, true)`,
      [`${markA} Checking`, seedA.institution.id]
    );
    seedA.category = await one('INSERT INTO categories (name) VALUES ($1)', [`${markA} Category`]);
    seedA.merchant = await one('INSERT INTO merchants (name, merchant_website) VALUES ($1, $2)', [
      `${markA} Cafe`,
      'https://cafe.example',
    ]);
    // Two rules, so a join that multiplies the merchant's transactions by its rules shows up in the total.
    await a.pool.query(
      `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'CAFE'), ($1, 'exact', 'CAFE 123')`,
      [seedA.merchant.id]
    );
    seedA.tag = await one('INSERT INTO tags (name) VALUES ($1)', [`${markA} tag`]);
    const year = 4000 + Math.floor(Math.random() * 100000);
    seedA.period = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
       VALUES ($1, 'March', $2, 3, make_date($2, 3, 1), make_date($2, 3, 31))`,
      [`${markA} Period`, year]
    );
    seedA.budgetItem = await one(
      `INSERT INTO budget_items (name, description, category_id, merchant_id, isbill, default_budget_amount, rollover,
                                 rollover_target_date, goal_target_amount, goal_target_date, recurring_payment,
                                 recurring_payment_amount, recurring_payment_frequency, recurring_next_payment_date)
       VALUES ($1, '+cmd', $2, $3, true, 123.45, true, '2026-12-31', 5000.55, '2027-06-30', true, 99.99, 1, '2025-04-01')`,
      [`${markA} Groceries`, seedA.category.id, seedA.merchant.id]
    );
    await a.pool.query('INSERT INTO budget_period_items (budget_item_id, budget_period_id) VALUES ($1, $2)', [
      seedA.budgetItem.id,
      seedA.period.id,
    ]);

    const txn = (values: Record<string, unknown>) => {
      const cols = Object.keys(values);
      return one(
        `INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(values)
      );
    };
    const account_id = seedA.account.id;
    // Amounts whose float sums aren't exact (0.1 + 0.2), and a split whose children must not count twice.
    seedA.t0 = await txn({ account_id, transaction_date: '2025-03-01', type: 'starting balance', amount: '1000.10', description: 'Opening' });
    seedA.t1 = await txn({
      account_id,
      transaction_date: '2025-03-10',
      type: 'expense',
      amount: '-0.20',
      description: 'Coffee, "large"',
      merchant_id: seedA.merchant.id,
      budget_item_id: seedA.budgetItem.id,
      budget_period_id: seedA.period.id,
      assigned_to: a.userId,
      notes: '=1+2',
      status: 'cleared',
      import_description: '@coffee',
      import_provider: 'simplefin',
      import_transaction_id: 'TXN-1',
      import_posted_date: '2025-03-11T08:30:00Z',
    });
    seedA.t2 = await txn({ account_id, transaction_date: '2025-03-20', type: 'income', amount: '0.10', description: 'Refund' });
    const client = await a.pool.connect();
    try {
      await client.query('BEGIN');
      db = client;
      seedA.t3 = await txn({
        account_id,
        transaction_date: '2025-03-25',
        type: 'expense',
        amount: '-50.00',
        description: 'Split purchase',
        merchant_id: seedA.merchant.id,
        is_split_parent: true,
      });
      for (const [key, amount] of [['c1', '-30.00'], ['c2', '-20.00']] as const) {
        seedA[key] = await txn({
          account_id,
          parent_transaction_id: seedA.t3.id,
          transaction_date: '2025-03-25',
          type: 'expense',
          amount,
          description: 'Split purchase',
          merchant_id: seedA.merchant.id,
          budget_item_id: seedA.budgetItem.id,
          budget_period_id: seedA.period.id,
        });
      }
      await client.query('COMMIT');
    } finally {
      db = a.pool;
      client.release();
    }
    await a.pool.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2), ($1, 'budget_item', $3)`,
      [seedA.tag.id, seedA.t1.id, seedA.budgetItem.id]
    );

    // Ledger B: one of each, with its own marker.
    const oneB = async (sql: string, params: unknown[] = []): Promise<Ref> =>
      (await b.pool.query<Ref>(`${sql} RETURNING id, uuid`, params)).rows[0];
    const bInstitution = await oneB('INSERT INTO account_institutions (name) VALUES ($1)', [`${markB} Bank`]);
    seedB.account = await oneB(
      `INSERT INTO accounts (name, account_type, account_group, type, institution_id) VALUES ($1, 'checking', 'cash', 'Asset', $2)`,
      [`${markB} Account`, bInstitution.id]
    );
    seedB.merchant = await oneB('INSERT INTO merchants (name) VALUES ($1)', [`${markB} Shop`]);
    seedB.budgetItem = await oneB('INSERT INTO budget_items (name, isbill) VALUES ($1, true)', [`${markB} Item`]);
    seedB.transaction = await oneB(
      `INSERT INTO transactions (account_id, transaction_date, type, amount, description, merchant_id, budget_item_id)
       VALUES ($1, '2025-03-12', 'expense', -777.77, $2, $3, $4)`,
      [seedB.account.id, `${markB} purchase`, seedB.merchant.id, seedB.budgetItem.id]
    );
  }, 60_000);

  afterAll(async () => {
    await a?.cleanup();
    await b?.cleanup();
  });

  describe('GET /api/export/transactions', () => {
    it("exports the ledger's transactions with exact amounts and readable references", async () => {
      const { rows, text } = await download('/api/export/transactions', TRANSACTION_HEADERS);
      expectNothingOfB(text);
      await expectOwnRows(a, 'transactions', rows);

      const t1 = rows.find((r) => r.uuid === seedA.t1.uuid)!;
      expect(t1).toMatchObject({
        transaction_date: '2025-03-10',
        description: 'Coffee, "large"',
        merchant_name: `${markA} Cafe`,
        amount: '-0.20',
        type: 'expense',
        account_name: `${markA} Checking`,
        budget_period_name: `${markA} Period`,
        budget_item_name: `${markA} Groceries`,
        assigned_to: 'Test Export A',
        tags: `${markA} tag`,
        status: 'cleared',
        notes: "'=1+2",
        pending: 'false',
        import_description: "'@coffee",
        import_posted_date: '2025-03-11T08:30:00.000Z',
        import_provider: 'simplefin',
        import_transaction_id: 'TXN-1',
      });
      expect(t1.created_at).toMatch(ISO_INSTANT);
      expect(t1.updated_at).toMatch(ISO_INSTANT);
      expect(rows.find((r) => r.uuid === seedA.t0.uuid)!.amount).toBe('1000.10');
      // Newest first.
      expect(rows.map((r) => r.transaction_date)).toEqual([...rows.map((r) => r.transaction_date)].sort().reverse());
    });

    it('filters by date range, inclusive', async () => {
      const { rows } = await download('/api/export/transactions?start_date=2025-03-10&end_date=2025-03-20', TRANSACTION_HEADERS);
      expect(rows.map((r) => r.uuid).sort()).toEqual([seedA.t1.uuid, seedA.t2.uuid].sort());
    });

    it('refuses a date that is not YYYY-MM-DD', async () => {
      await get('a', '/api/export/transactions?start_date=not-a-date').expect(400);
      await get('a', '/api/export/transactions?end_date=2025-02-30').expect(400);
    });
  });

  describe('GET /api/export/account-transactions/:accountUuid', () => {
    const url = () => `/api/export/account-transactions/${seedA.account.uuid}`;

    it('exports the account with an exact running balance that leaves split children out', async () => {
      const { rows, text } = await download(url(), ACCOUNT_TRANSACTION_HEADERS);
      expectNothingOfB(text);
      await expectOwnRows(a, 'transactions', rows); // A has one account
      const balance = Object.fromEntries(rows.map((r) => [r.uuid, r.running_balance]));
      expect(balance[seedA.t3.uuid]).toBe('950.00');
      expect(balance[seedA.t2.uuid]).toBe('1000.00');
      expect(balance[seedA.t1.uuid]).toBe('999.90');
      expect(balance[seedA.t0.uuid]).toBe('1000.10');
      expect(rows.find((r) => r.uuid === seedA.t1.uuid)).toMatchObject({
        amount: '-0.20',
        merchant_name: `${markA} Cafe`,
        budget_item_name: `${markA} Groceries`,
        tags: `${markA} tag`,
        notes: "'=1+2",
      });
    });

    it('keeps the whole-account running balance in a date-ranged export', async () => {
      const { rows } = await download(`${url()}?start_date=2025-03-15&end_date=2025-03-20`, ACCOUNT_TRANSACTION_HEADERS);
      expect(rows.map((r) => [r.uuid, r.running_balance])).toEqual([[seedA.t2.uuid, '1000.00']]);
    });

    it("answers 404 for another ledger's account or an id that isn't a uuid, 400 for a bad date", async () => {
      await get('a', `/api/export/account-transactions/${seedB.account.uuid}`).expect(404);
      await get('a', '/api/export/account-transactions/not-a-uuid').expect(404);
      await get('a', `${url()}?start_date=2025-13-01`).expect(400);
    });
  });

  describe('GET /api/export/budget-items', () => {
    it("exports the ledger's budget items", async () => {
      const { rows, text } = await download('/api/export/budget-items', BUDGET_ITEM_HEADERS);
      expectNothingOfB(text);
      await expectOwnRows(a, 'budget_items', rows);
      const item = rows.find((r) => r.uuid === seedA.budgetItem.uuid)!;
      expect(item).toMatchObject({
        name: `${markA} Groceries`,
        description: "'+cmd",
        category_name: `${markA} Category`,
        merchant_name: `${markA} Cafe`,
        rollover: 'true',
        rollover_target_date: '2026-12-31',
        default_budget_amount: '123.45',
        isbill: 'true',
        recurring_payment: 'true',
        recurring_payment_amount: '99.99',
        recurring_payment_frequency: '1',
        recurring_next_payment_date: '2025-04-01',
        recurring_last_payment_date: '',
        goal_target_amount: '5000.55',
        goal_target_date: '2027-06-30',
        status: 'active',
        tags: `${markA} tag`,
      });
      expect(item.created_at).toMatch(ISO_INSTANT);
    });
  });

  describe('GET /api/export/accounts', () => {
    it("exports the ledger's accounts with their ledger and bank balances", async () => {
      const { rows, text } = await download('/api/export/accounts', ACCOUNT_HEADERS);
      expectNothingOfB(text);
      await expectOwnRows(a, 'accounts', rows);
      const account = rows.find((r) => r.uuid === seedA.account.uuid)!;
      expect(account).toMatchObject({
        name: `${markA} Checking`,
        account_type: 'checking',
        account_group: 'cash',
        type: 'Asset',
        subtype: 'Checking',
        institution_name: `${markA} Bank`,
        account_number: '000123',
        routing_number: '123456789',
        // 1000.10 - 0.20 + 0.10 - 50.00: the split parent counts, its children don't.
        balance: '950.00',
        import_balance: '1500.10',
        import_available_balance: '1400.05',
        import_balance_date: '2025-03-31T12:00:00.000Z',
        exclude_account_balance: 'false',
        hide_account: 'false',
        close_account: 'false',
        is_envelope_account: 'true',
        custom_sort: '7',
        notes: `'=HYPERLINK("http://evil.example")`,
      });
      expect(account.created_at).toMatch(ISO_INSTANT);
    });

    it("shows ledger B only its own accounts", async () => {
      const { rows, text } = await download('/api/export/accounts', ACCOUNT_HEADERS, 'b');
      expect(text).not.toContain(markA);
      expect(rows.map((r) => r.uuid)).toEqual([seedB.account.uuid]);
      expect(rows[0]).toMatchObject({ institution_name: `${markB} Bank`, balance: '-777.77' });
    });
  });

  describe('GET /api/export/merchants', () => {
    it("exports the ledger's merchants with totals counted once per transaction", async () => {
      const { rows, text } = await download('/api/export/merchants', MERCHANT_HEADERS);
      expectNothingOfB(text);
      await expectOwnRows(a, 'merchants', rows);
      const merchant = rows.find((r) => r.uuid === seedA.merchant.uuid)!;
      expect(merchant).toMatchObject({
        name: `${markA} Cafe`,
        merchant_website: 'https://cafe.example',
        // t1 and the split parent t3; the split's children and the two rules don't multiply it.
        transaction_count: '2',
        total_transaction_amount: '-50.20',
        first_transaction_date: '2025-03-10',
        last_transaction_date: '2025-03-25',
        rule_count: '2',
        matching_rules: 'contains:CAFE | exact:CAFE 123',
      });
      expect(merchant.created_at).toMatch(ISO_INSTANT);
    });
  });

  describe('a ledger with more rows than one batch', () => {
    const ROWS = 2345; // two whole batches of 1000 and part of a third
    let c: TestTenant;
    let cToken: string;
    let order: string[];

    beforeAll(async () => {
      c = await createTestTenant('Export streaming');
      const { token, sessionId } = await sessionService.createSession({ userId: c.userId });
      await c.pool.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [c.tenantId, sessionId]);
      cToken = token;
      const account = await c.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Streamed', 'checking', 'cash', 'Asset') RETURNING id`
      );
      // Expenses and income on 400 days, so many rows share a day and the id breaks the tie.
      await c.pool.query(
        `INSERT INTO transactions (account_id, transaction_date, type, amount, description)
         SELECT $1, DATE '2024-01-01' + (g % 400),
                CASE WHEN g % 3 = 0 THEN 'income' ELSE 'expense' END,
                CASE WHEN g % 3 = 0 THEN g / 100.0 ELSE -g / 100.0 END,
                'Row ' || g
           FROM generate_series(1, $2::int) AS g`,
        [account.rows[0].id, ROWS]
      );
      order = (
        await c.pool.query<{ uuid: string }>('SELECT uuid FROM transactions ORDER BY transaction_date DESC, created_at DESC, id DESC')
      ).rows.map((r) => r.uuid);
    }, 60_000);

    afterAll(async () => {
      await c?.cleanup();
    });

    const exportAll = () =>
      request(app).get('/api/export/transactions').set('Cookie', `${SESSION_COOKIE_NAME}=${cToken}`);

    it('streams every row once, in order, never reading more than a batch at a time', async () => {
      const { result: res, maxRows, statements } = await watchQueries(() => exportAll());
      expect(res.status, res.text).toBe(200);
      // Written as it goes: chunked, so no length known up front.
      expect(res.headers['transfer-encoding']).toBe('chunked');
      expect(res.headers['content-length']).toBeUndefined();
      const { headers, rows } = readCsv(res.text);
      expect(headers).toEqual(TRANSACTION_HEADERS);
      expect(rows.map((r) => r.uuid)).toEqual(order);
      expect(rows.find((r) => r.description === 'Row 2344')!.amount).toBe('-23.44');
      expect(rows.find((r) => r.description === 'Row 2343')!.amount).toBe('23.43');
      // The old export read all 2345 rows in one query.
      expect(maxRows).toBeLessThanOrEqual(1000);
      expect(statements.filter(isBatch)).toHaveLength(3);
    });

    // It streamed inside the request's transaction, so a slow client held the
    // transaction, and its pool connection, idle while it took each batch.
    it('writes to the client only between its transactions', async () => {
      const outer = express();
      let watching: QueryWatch | null = null;
      outer.use((_req, res, next) => {
        const write = res.write.bind(res) as (...args: unknown[]) => boolean;
        (res as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => {
          watching?.statements.push('-- written to the client');
          return write(...args);
        };
        next();
      });
      outer.use(app);
      const { result: res, statements } = await watchQueries((watch) => {
        watching = watch;
        return request(outer).get('/api/export/transactions').set('Cookie', `${SESSION_COOKIE_NAME}=${cToken}`);
      });
      expect(res.status, res.text).toBe(200);
      expect(readCsv(res.text).rows.map((r) => r.uuid)).toEqual(order);
      // Between each BEGIN and its COMMIT, nothing was written to the client.
      let open = false;
      const writtenInside: string[] = [];
      for (const text of statements) {
        if (/^begin\b/i.test(text)) open = true;
        else if (/^(commit|rollback)\b/i.test(text)) open = false;
        else if (text === '-- written to the client' && open) writtenInside.push(text);
      }
      expect(statements).toContain('-- written to the client');
      expect(writtenInside).toEqual([]);
    });

    it('cuts the connection, rather than ending a short file, when a later batch fails', async () => {
      let fetches = 0;
      const { result } = await watchQueries(
        () => exportAll().then((res) => ({ res }), (err: Error) => ({ err })),
        (text) => (isBatch(text) && ++fetches === 2 ? Promise.reject(new Error('injected failure')) : undefined)
      );
      expect('err' in result, 'the client got a whole response').toBe(true);
    });

    // A client that left while the next batch was read used to leave the export waiting
    // for a 'drain' that never came, holding its transaction and pool connection open. Now
    // the batch's own transaction ends, and no further batch is read.
    it('ends its transaction when the client leaves while a batch is read', async () => {
      const server = http.createServer(app);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      try {
        const { port } = server.address() as { port: number };
        let fetches = 0;
        // Settles once the server has seen the client's socket close.
        const gone = new Promise<void>((resolve) =>
          server.once('connection', (socket) => socket.once('close', () => setImmediate(resolve))));
        let client: http.ClientRequest | undefined;
        await watchQueries(
          async (watch) => {
            client = http.get({ port, path: '/api/export/transactions', headers: { Cookie: `${SESSION_COOKIE_NAME}=${cToken}` } });
            client.on('error', () => {});
            client.on('response', (res) => res.resume());
            // The second batch's transaction ends once the client has gone...
            await vi.waitFor(
              () => {
                expect(fetches).toBe(2);
                expect(watch.statements.slice(-1)).toEqual(['commit']);
              },
              { timeout: 5000, interval: 50 }
            );
            // ...and no third batch is read.
            await new Promise((resolve) => setTimeout(resolve, 100));
          },
          (text) => {
            if (!isBatch(text) || ++fetches !== 2) return undefined;
            client?.destroy();
            return gone;
          }
        );
        expect(fetches).toBe(2);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });

  // Read a batch at a time in transactions of their own, an account export's
  // balances (worked out first) and amounts (read with each batch) came from different
  // moments, so an edit or a delete during the download left rows whose balance didn't follow
  // from their amount. Each balance is now worked out from the amounts the file holds.
  describe('an account export while the account changes', () => {
    const ROWS = 1500; // a whole batch, and half another
    let d: TestTenant;
    let dToken: string;
    let accountUuid: string;
    let order: Ref[];

    beforeAll(async () => {
      d = await createTestTenant('Export balances under edits');
      const { token, sessionId } = await sessionService.createSession({ userId: d.userId });
      await d.pool.query('UPDATE sessions SET active_tenant_id = $1 WHERE id = $2', [d.tenantId, sessionId]);
      dToken = token;
      const account = await d.pool.query<Ref>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Edited meanwhile', 'checking', 'cash', 'Asset') RETURNING id, uuid`
      );
      accountUuid = account.rows[0].uuid;
      await d.pool.query(
        `INSERT INTO transactions (account_id, transaction_date, type, amount, description)
         SELECT $1, DATE '2024-01-01' + (g % 300), 'expense', -g / 100.0, 'Row ' || g FROM generate_series(1, $2::int) AS g`,
        [account.rows[0].id, ROWS]
      );
      order = (
        await d.pool.query<Ref>('SELECT id, uuid FROM transactions ORDER BY transaction_date DESC, created_at DESC, id DESC')
      ).rows;
    }, 60_000);

    afterAll(async () => {
      await d?.cleanup();
    });

    const cents = (amount: string) => Math.round(Number(amount) * 100);

    it("keeps each row's balance following from its amount and the next row's, a row edited or deleted meanwhile included", async () => {
      // Of the first batch (already written when the second is read), and of the second.
      const [editedFirst, deletedFirst, editedSecond, deletedSecond] = [order[100], order[200], order[1100], order[1200]];
      let batches = 0;
      const { result: res } = await watchQueries(
        () => request(app).get(`/api/export/account-transactions/${accountUuid}`).set('Cookie', `${SESSION_COOKIE_NAME}=${dToken}`),
        (text) => {
          if (!isBatch(text) || ++batches !== 2) return undefined;
          // Between the two batches, another request edits two rows and deletes two.
          return (async () => {
            await d.pool.query('UPDATE transactions SET amount = amount - 1000 WHERE id = ANY($1)', [[editedFirst.id, editedSecond.id]]);
            await d.pool.query('DELETE FROM transactions WHERE id = ANY($1)', [[deletedFirst.id, deletedSecond.id]]);
          })();
        }
      );
      expect(res.status, res.text).toBe(200);
      const { rows } = readCsv(res.text);
      // Written before the delete, it is in the file; read after it, it isn't.
      expect(rows.map((r) => r.uuid)).toEqual(order.filter((r) => r !== deletedSecond).map((r) => r.uuid));
      // Read after the edit, the row shows its new amount.
      const edited = rows.find((r) => r.uuid === editedSecond.uuid)!;
      expect(edited.amount).toBe((-Number(edited.description.replace('Row ', '')) / 100 - 1000).toFixed(2));
      const breaks = rows.slice(0, -1).flatMap((row, i) =>
        cents(row.running_balance) === cents(rows[i + 1].running_balance) + cents(row.amount) ? [] : [row.description]
      );
      expect(breaks).toEqual([]);
      expect(batches).toBe(2);
    });
  });

  describe('removed /api/import balance routes', () => {
    it.each(['/api/import/balance-history', '/api/import/balance-discrepancies'])('%s is gone', async (url) => {
      await get('a', url).expect(404);
    });
  });
});
