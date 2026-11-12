import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createMerchantsRoutes } from '../merchants.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import { merchantsWithCountsQuery } from '../../services/merchants/MerchantService.js';

/**
 * The merchant lists choose their page from merchants alone, then count each page
 * merchant's transactions and rules. These check GET /merchants and
 * /merchants/paginated answer what the old query (every transaction and rule joined,
 * grouped, then paged) did, page by page and search by search; that paging walks every
 * merchant once, in name then id order; and that a page counts only its own merchants'
 * transactions (requires Postgres).
 */

/** The old list query, verbatim. Its ORDER BY was name alone. */
function legacySql(search: string, page?: { limit: number; offset: number }) {
  const params: unknown[] = [];
  let where = '';
  if (search) {
    params.push(`%${search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where = `WHERE (LOWER(m.name) LIKE $1 OR LOWER(m.merchant_website) LIKE $1 OR LOWER(m.notes) LIKE $1)`;
  }
  let paging = '';
  if (page) {
    params.push(page.limit, page.offset);
    paging = `LIMIT $${params.length - 1} OFFSET $${params.length}`;
  }
  return {
    text: `
      SELECT m.id, m.uuid, m.name, m.merchant_website, m.merchant_accountid, m.merchant_image, m.notes, m.instructions,
             m.transaction_auto_tag_id, m.created_at, m.updated_at,
             COUNT(DISTINCT t.id) as transaction_count, COUNT(DISTINCT mr.id) as rule_count
      FROM merchants m
      LEFT JOIN transactions t ON m.id = t.merchant_id
      LEFT JOIN merchant_matching_rules mr ON m.id = mr.merchant_id
      ${where}
      GROUP BY m.id, m.uuid, m.name, m.merchant_website, m.merchant_accountid, m.merchant_image, m.notes, m.instructions,
               m.transaction_auto_tag_id, m.created_at, m.updated_at
      ORDER BY m.name ASC
      ${paging}`,
    params,
  };
}

/** What res.json sends for a row. */
const asJson = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

describe('Merchant lists page first', () => {
  let tenant: TestTenant;
  let pool: Pool;
  let app: Express;

  async function legacy(search: string, page?: { limit: number; offset: number }) {
    const q = legacySql(search, page);
    const rows = (await pool.query(q.text, q.params)).rows;
    return rows.map((r) => ({ ...r, transaction_count: parseInt(r.transaction_count, 10), rule_count: parseInt(r.rule_count, 10) }));
  }

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant lists page first');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());

    const one = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0];
    const accountId = (
      await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`)
    ).id;

    // 37 merchants, inserted out of name order so id and name order differ; names that
    // share a prefix, mixed case, a % and an _ to search for, websites and notes.
    const merchantIds: number[] = [];
    for (let k = 0; k < 37; k++) {
      const n = (k * 17) % 37;
      const name = [`Corner Cafe ${n}`, `corner store ${n}`, `Green Grocer ${n}`, `Sale 50% ${n}`, `Under_score ${n}`][n % 5];
      const row = await one(
        `INSERT INTO merchants (name, merchant_website, notes) VALUES ($1, $2, $3) RETURNING id`,
        [name, n % 3 === 0 ? `https://shop${n}.example` : null, n % 4 === 0 ? `notes ${n} cafe` : null]
      );
      merchantIds.push(row.id);
    }
    // Transactions: none for some merchants, up to 11 for others, and some with none.
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let k = 0; k < 220; k++) {
      const merchant = k % 13 === 0 ? null : merchantIds[(k * 7) % 31];
      const base = values.length;
      values.push(accountId, merchant, -(1 + k), `2026-0${1 + (k % 9)}-15`);
      rows.push(`($${base + 1}, $${base + 2}, $${base + 3}, 'Purchase', $${base + 4}, 'expense')`);
    }
    await pool.query(
      `INSERT INTO transactions (account_id, merchant_id, amount, description, transaction_date, type) VALUES ${rows.join(', ')}`,
      values
    );
    // A split whose parent and children all carry a merchant: each row counts, as before.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const parent = (
        await client.query(
          `INSERT INTO transactions (account_id, merchant_id, amount, description, transaction_date, type, is_split_parent)
           VALUES ($1, $2, -30.00, 'Split', '2026-03-03', 'expense', true) RETURNING id`,
          [accountId, merchantIds[1]]
        )
      ).rows[0].id;
      await client.query(
        `INSERT INTO transactions (account_id, merchant_id, amount, description, transaction_date, type, parent_transaction_id)
         VALUES ($1, $2, -10.00, 'Split part', '2026-03-03', 'expense', $3), ($1, $2, -20.00, 'Split part', '2026-03-03', 'expense', $3)`,
        [accountId, merchantIds[1], parent]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // Rules: 0 to 3 per merchant.
    for (const [k, id] of merchantIds.entries()) {
      for (let r = 0; r < k % 4; r++) {
        await pool.query(`INSERT INTO merchant_matching_rules (merchant_id, method, matching_text) VALUES ($1, 'contains', $2)`, [id, `rule ${k}-${r}`]);
      }
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('GET /merchants answers what the old query did', async () => {
    const res = await request(app).get('/api/merchants').expect(200);
    const expected = await legacy('');
    expect(res.body).toEqual(asJson(expected));
    expect(expected.some((m) => m.transaction_count === 0) && expected.some((m) => m.transaction_count > 5)).toBe(true);
    expect(expected.some((m) => m.rule_count === 0) && expected.some((m) => m.rule_count === 3)).toBe(true);
  });

  it('GET /merchants/paginated answers what the old query did, page by page and search by search', async () => {
    for (const search of ['', 'corner', 'CAFE', 'shop', '50%', '_', 'under_', 'nothing matches']) {
      for (const limit of [1, 4, 10, 100]) {
        const all = await legacy(search);
        const pages = Math.max(1, Math.ceil(all.length / limit));
        for (let page = 1; page <= pages + 1; page++) {
          const res = await request(app).get('/api/merchants/paginated').query({ search, page, limit }).expect(200);
          const label = `search "${search}" limit ${limit} page ${page}`;
          expect(res.body.pagination, label).toEqual({ total: all.length, totalPages: Math.ceil(all.length / limit), page, limit });
          expect(res.body.merchants, label).toEqual(asJson(await legacy(search, { limit, offset: (page - 1) * limit })));
        }
      }
    }
  });

  it('pages walk every merchant once, by name then id, full or lite', async () => {
    const expected = (await pool.query(`SELECT uuid FROM merchants ORDER BY name, id`)).rows.map((r) => r.uuid);
    for (const fields of [undefined, 'lite']) {
      const seen: string[] = [];
      for (let page = 1; ; page++) {
        const res = await request(app).get('/api/merchants/paginated').query({ page, limit: 6, ...(fields ? { fields } : {}) }).expect(200);
        if (res.body.merchants.length === 0) break;
        seen.push(...res.body.merchants.map((m: { uuid: string }) => m.uuid));
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expected);
    }
    const lite = await request(app).get('/api/merchants').query({ fields: 'lite' }).expect(200);
    expect(lite.body.map((m: { uuid: string }) => m.uuid)).toEqual(expected);
  });

  it('bounds page and limit instead of failing on them', async () => {
    const total = (await legacy('')).length;
    for (const [query, page, limit] of [
      [{ page: -1 }, 1, 50],
      [{ page: 'abc', limit: 'abc' }, 1, 50],
      [{ limit: -5 }, 1, 50],
      [{ limit: 1e9 }, 1, 100],
      [{ page: '99999999999999999999', limit: 2 }, 100_000, 2],
      [{ page: '1.5', limit: '2.5' }, 1, 2],
    ] as const) {
      const res = await request(app).get('/api/merchants/paginated').query(query).expect(200);
      expect(res.body.pagination, JSON.stringify(query)).toEqual({ total, totalPages: Math.ceil(total / limit), page, limit });
    }
  });

  it('counts the transactions and rules of the page only', async () => {
    const plan = await withTenant(tenant.tenantId, async (trx) => {
      // As in transactionsListPagesFirst: on tables this small the planner may hash a whole
      // table; nested loops are what it picks at production volume, and counting every
      // merchant's transactions before LIMIT (what this guards against) still shows.
      await sql`SET LOCAL enable_hashjoin = off`.execute(trx);
      await sql`SET LOCAL enable_mergejoin = off`.execute(trx);
      const res = await sql<{ 'QUERY PLAN': unknown }>`EXPLAIN (ANALYZE, FORMAT JSON) ${merchantsWithCountsQuery({ page: { limit: 3, offset: 6 } })}`.execute(trx);
      return (res.rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0].Plan;
    });
    type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode) => {
      nodes.push(node);
      node.Plans?.forEach(walk);
    };
    walk(plan);
    const shape = JSON.stringify(nodes.map((n) => [n['Node Type'], n['Relation Name'] ?? '', n['Actual Rows'], n['Actual Loops']]));
    // Each counted table is looked up once per page merchant (3), never for all 37.
    for (const table of ['transactions', 'merchant_matching_rules']) {
      const scans = nodes.filter((n) => n['Relation Name'] === table);
      expect(scans.length, shape).toBeGreaterThan(0);
      for (const scan of scans) expect(scan['Actual Loops'], shape).toBeLessThanOrEqual(3);
    }
    expect(nodes.some((n) => /Aggregate/.test(n['Node Type']) && n['Actual Rows'] * n['Actual Loops'] > 3 * 2), shape).toBe(false);
  });
});
