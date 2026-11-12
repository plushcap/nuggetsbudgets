import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

// The MCP list_transactions tool filters /transactions/paginated by merchant_uuid,
// merchant_id and budget_item_uuid. The route ignored them, so those filters
// answered every transaction (requires Postgres test DB).
describe('Transaction list filters by merchant and budget item', () => {
  const stamp = Date.now();
  let app: Express;
  let tenant: TestTenant;
  const ids: Record<string, { id: number; uuid: string }> = {};

  beforeAll(async () => {
    tenant = await createTestTenant('Transaction list filters');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());
    const pool = tenant.pool;
    const one = async (q: string, params: unknown[]) => (await pool.query(q, params)).rows[0];
    ids.account = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`, [`Filters ${stamp}`]);
    ids.cafe = await one('INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid', [`Cafe ${stamp}`]);
    ids.grocer = await one('INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid', [`Grocer ${stamp}`]);
    ids.dining = await one(`INSERT INTO budget_items (name, expense_type, type) VALUES ($1, 'Expense', 'Monthly') RETURNING id, uuid`, [`Dining ${stamp}`]);
    for (const [description, merchant, item] of [['coffee', 'cafe', 'dining'], ['lunch', 'cafe', null], ['milk', 'grocer', null]] as const) {
      await pool.query(
        `INSERT INTO transactions (description, amount, type, transaction_date, account_id, merchant_id, budget_item_id)
         VALUES ($1, -5.00, 'expense', '2026-10-01', $2, $3, $4)`,
        [description, ids.account.id, ids[merchant].id, item ? ids[item].id : null],
      );
    }
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  const descriptions = async (query: Record<string, string | number>) => {
    const res = await request(app).get('/api/transactions/paginated').query(query).expect(200);
    return (res.body.transactions as Array<{ description: string }>).map((t) => t.description).sort();
  };

  it('filters by merchant uuid or id, and by budget item uuid', async () => {
    expect(await descriptions({ merchant_uuid: ids.cafe.uuid })).toEqual(['coffee', 'lunch']);
    expect(await descriptions({ merchant_id: ids.grocer.id })).toEqual(['milk']);
    expect(await descriptions({ budget_item_uuid: ids.dining.uuid })).toEqual(['coffee']);
    expect(await descriptions({ merchant_uuid: ids.cafe.uuid, budget_item_uuid: ids.dining.uuid })).toEqual(['coffee']);
  });

  it('matches nothing for an unknown or malformed uuid', async () => {
    expect(await descriptions({ merchant_uuid: '00000000-0000-0000-0000-000000000000' })).toEqual([]);
    expect(await descriptions({ budget_item_uuid: 'not-a-uuid' })).toEqual([]);
  });

  // A search or a uuid sent twice is a list, which the list read as one text ('a,b') or
  // compared as an array. Each filter is sent once; a page or limit that
  // isn't one still reads as the default, as pageParams read it.
  it('refuses a filter sent twice, and reads a page or limit that is not one as the default', async () => {
    for (const path of ['/api/transactions/paginated', '/api/transactions']) {
      for (const query of ['search=a&search=b', `merchant_uuid=${ids.cafe.uuid}&merchant_uuid=${ids.grocer.uuid}`, 'review_status=reviewed&review_status=flagged']) {
        const res = await request(app).get(`${path}?${query}`);
        expect({ path, query, status: res.status, code: res.body.code }).toEqual({ path, query, status: 400, code: 'VALIDATION_ERROR' });
      }
    }
    const page = await request(app).get('/api/transactions/paginated?page=abc&limit=-3').expect(200);
    expect(page.body.pagination).toMatchObject({ page: 1, limit: 20 });
    const capped = await request(app).get('/api/transactions/paginated?limit=5000').expect(200);
    expect(capped.body.pagination.limit).toBe(200);
  });
});
