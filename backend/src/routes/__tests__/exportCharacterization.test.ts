import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import type { PoolClient } from 'pg';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * Every CSV export's whole download, pinned byte for byte: status, Content-Type,
 * Content-Disposition and body, through the real app, and its refusals. Written before the
 * exports' queries moved to services/export/, so the move is checked against the bytes the
 * routes wrote before it.
 *
 * The fixture is the same every run; what differs is replaced: each uuid with a placeholder
 * numbered in the order it first appears, each merchant id likewise, the instants the
 * database stamps (created_at, updated_at) with <instant>, today's day in a file name with
 * <today>, and a request id with <requestId>.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

describeDb('CSV exports: whole downloads', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let session: string;
  let today: string;
  const seed = {} as Record<'account' | 'savings' | 'merchant' | 'quiet', Ref>;

  const uuids = new Map<string, string>();
  const merchantIds = new Map<string, string>();
  /** The instants the fixture writes itself; every other one is the database's now(). */
  const FIXED_INSTANTS = new Set(['2025-03-31T12:00:00.000Z', '2025-03-11T08:30:00.000Z', '2025-03-10T17:45:12.000Z']);
  const normalizeText = (text: string) =>
    text
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => {
        if (!uuids.has(u)) uuids.set(u, `<uuid:${uuids.size + 1}>`);
        return uuids.get(u)!;
      })
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, (instant) => (FIXED_INSTANTS.has(instant) ? instant : '<instant>'))
      .split(today)
      .join('<today>');

  const download = async (path: string, merchants = false) => {
    const res = await h.call(session, 'get', `/api/export${path}`);
    let body = res.headers['content-type']?.startsWith('text/csv') ? normalizeText(res.text) : res.body;
    if (merchants && typeof body === 'string') {
      body = body.replace(/^\d+(?=,<uuid)/gm, (id) => {
        if (!merchantIds.has(id)) merchantIds.set(id, `<merchant:${merchantIds.size + 1}>`);
        return merchantIds.get(id)!;
      });
    }
    if (body && typeof body === 'object' && 'requestId' in body) body = { ...body, requestId: '<requestId>' };
    return {
      status: res.status,
      contentType: res.headers['content-type'] ?? null,
      disposition: res.headers['content-disposition'] ? normalizeText(String(res.headers['content-disposition'])) : null,
      body,
    };
  };

  beforeAll(async () => {
    h = await startRouteHarness('Export characterization');
    tenant = await createTestTenant('Export characterization');
    session = await h.signIn(tenant.userId, tenant.tenantId);
    today = (await tenant.pool.query<{ today: string }>('SELECT app_today()::text AS today')).rows[0]!.today;
    await h.owner.query(`UPDATE users SET first_name = 'Pat', last_name = 'Doe' WHERE id = $1`, [tenant.userId]);

    let db: Pick<PoolClient, 'query'> = tenant.pool;
    const one = async (text: string, params: unknown[] = []): Promise<Ref> => (await db.query<Ref>(`${text} RETURNING id, uuid`, params)).rows[0]!;
    const institution = await one(`INSERT INTO account_institutions (name) VALUES ('First Bank')`);
    seed.account = await one(
      `INSERT INTO accounts (name, account_type, account_group, type, subtype, institution_id, account_number, routing_number,
                             notes, import_balance, import_available_balance, import_balance_date, custom_sort)
       VALUES ('Joint Checking #1', 'checking', 'cash', 'Asset', 'Checking', $1, '000123', '123456789',
               '=SUM(A1)', 1500.10, 1400.05, '2025-03-31T12:00:00Z', 2)`,
      [institution.id]
    );
    seed.savings = await one(`INSERT INTO accounts (name, account_type, account_group, type, hide_account, close_account) VALUES ('Old Savings', 'savings', 'cash', 'Asset', true, true)`);
    const category = await one(`INSERT INTO categories (name) VALUES ('Food')`);
    seed.merchant = await one(`INSERT INTO merchants (name, merchant_website, notes, instructions) VALUES ('Corner Cafe', 'https://cafe.example', 'Line one\nline "two"', '-cmd')`);
    seed.quiet = await one(`INSERT INTO merchants (name) VALUES ('Quiet Shop')`);
    await tenant.pool.query(
      `INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', 'CAFE'), ($1, 'exact', 'CAFE 123')`,
      [seed.merchant.id]
    );
    const tag = await one(`INSERT INTO tags (name) VALUES ('Weekend')`);
    const tag2 = await one(`INSERT INTO tags (name) VALUES ('Coffee')`);
    await tenant.pool.query(`UPDATE merchants SET transaction_auto_tag_id = $1 WHERE id = $2`, [tag2.id, seed.merchant.id]);
    const period = await one(
      `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date) VALUES ('March 2025', 'March', 2025, 3, '2025-03-01', '2025-03-31')`
    );
    const item = await one(
      `INSERT INTO budget_items (name, description, category_id, merchant_id, isbill, default_budget_amount, rollover, rollover_target_date,
                                 goal_target_amount, goal_target_date, recurring_payment, recurring_payment_amount, recurring_payment_frequency,
                                 recurring_next_payment_date, icon, color)
       VALUES ('Groceries', '+cmd', $1, $2, true, 123.45, true, '2026-12-31', 5000.55, '2027-06-30', true, 99.99, 1, '2025-04-01', 'cart', '#336699')`,
      [category.id, seed.merchant.id]
    );
    await one(`INSERT INTO budget_items (name, expense_type, status) VALUES ('Salary', 'Income', 'archived')`);
    const periodItem = await one(`INSERT INTO budget_period_items (budget_item_id, budget_period_id) VALUES ($1, $2)`, [item.id, period.id]);

    const txn = (values: Record<string, unknown>) => {
      const cols = Object.keys(values);
      return one(`INSERT INTO transactions (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values));
    };
    const account_id = seed.account.id;
    await txn({ account_id, transaction_date: '2025-03-01', type: 'starting balance', amount: '1000.10', description: 'Opening' });
    const coffee = await txn({
      account_id, transaction_date: '2025-03-10', type: 'expense', amount: '-0.20', description: 'Coffee, "large"', merchant_id: seed.merchant.id,
      budget_item_id: item.id, budget_period_id: period.id, assigned_to: tenant.userId, notes: '=1+2', status: 'cleared',
      review_status: 'reviewed', import_description: '@coffee', import_provider: 'simplefin', import_transaction_id: 'TXN-1',
      import_posted_date: '2025-03-11T08:30:00Z', import_transacted_at: '2025-03-10T17:45:12Z', import_pending: true,
    });
    await txn({ account_id, transaction_date: '2025-03-20', type: 'income', amount: '0.10', description: 'Refund' });
    await txn({ account_id, transaction_date: '2025-03-20', type: 'expense', amount: '-12.00', description: 'Same day', budget_period_item_id: periodItem.id });
    await txn({ account_id: seed.savings.id, transaction_date: '2025-02-14', type: 'income', amount: '250.00', description: 'Gift' });
    const client = await tenant.pool.connect();
    try {
      await client.query('BEGIN');
      db = client;
      const parent = await txn({ account_id, transaction_date: '2025-03-25', type: 'expense', amount: '-50.00', description: 'Split purchase', merchant_id: seed.merchant.id, is_split_parent: true });
      for (const amount of ['-30.00', '-20.00']) {
        await txn({ account_id, parent_transaction_id: parent.id, transaction_date: '2025-03-25', type: 'expense', amount, description: 'Split purchase', merchant_id: seed.merchant.id, budget_item_id: item.id });
      }
      await client.query('COMMIT');
    } finally {
      db = tenant.pool;
      client.release();
    }
    await tenant.pool.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $3), ($2, 'transaction', $3), ($1, 'budget_item', $4)
       ON CONFLICT DO NOTHING`,
      [tag.id, tag2.id, coffee.id, item.id]
    );
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([tenant?.cleanup(), h?.close()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it('downloads every transaction, and a date range of them', async () => {
    expect.soft(await download('/transactions')).toMatchSnapshot('all');
    expect.soft(await download('/transactions?start_date=2025-03-10&end_date=2025-03-20')).toMatchSnapshot('range');
    expect.soft(await download('/transactions?start_date=2025-03-21')).toMatchSnapshot('from');
    expect.soft(await download('/transactions?end_date=2025-02-01')).toMatchSnapshot('none');
    expect.soft(await download('/transactions?start_date=03/01/2025')).toMatchSnapshot('bad date');
  });

  // The range went through the backend's own date check, which took years 1 to 9999.
  it('refuses a day no ledger holds, or a range given twice, naming the field', async () => {
    for (const query of ['start_date=0001-01-01', 'end_date=9999-12-31', 'start_date=1799-12-31', 'end_date=2025-02-29', 'start_date=2025-03-01&start_date=2025-03-02']) {
      for (const path of ['/transactions', `/account-transactions/${seed.account.uuid}`]) {
        const res = await h.call(session, 'get', `/api/export${path}?${query}`);
        expect(res.status, `${path}?${query}`).toBe(400);
        expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: query.slice(0, query.indexOf('=')) }] });
      }
    }
    const edges = await h.call(session, 'get', '/api/export/transactions?start_date=1800-01-01&end_date=2999-12-31');
    expect(edges.status).toBe(200);
  });

  it("downloads one account's transactions with their running balance", async () => {
    expect.soft(await download(`/account-transactions/${seed.account.uuid}`)).toMatchSnapshot('all');
    expect.soft(await download(`/account-transactions/${seed.account.uuid}?start_date=2025-03-20&end_date=2025-03-31`)).toMatchSnapshot('range');
    expect.soft(await download(`/account-transactions/${seed.savings.uuid}`)).toMatchSnapshot('closed account');
    expect.soft(await download('/account-transactions/01900000-0000-7000-8000-000000000001')).toMatchSnapshot('unknown account');
    expect.soft(await download('/account-transactions/not-a-uuid')).toMatchSnapshot('malformed account');
    expect.soft(await download(`/account-transactions/${seed.account.uuid}?end_date=2025-13-01`)).toMatchSnapshot('bad date');
  });

  it('downloads the budget items, the accounts and the merchants', async () => {
    expect.soft(await download('/budget-items')).toMatchSnapshot('budget items');
    expect.soft(await download('/accounts')).toMatchSnapshot('accounts');
    expect.soft(await download('/merchants', true)).toMatchSnapshot('merchants');
  });
});
