import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createTransactionsRoutes } from '../transactions.js';
import { listFilters, listPage } from '../../services/transactions/index.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';

/**
 * The transactions list chooses its page before it joins or aggregates. These
 * check it answers what the old query did, row for row and page by page, on a ledger
 * with ties, splits, tags, assignees and names to search; that pages never repeat or
 * skip a row; and that only the page's rows are aggregated (requires Postgres).
 */

type Query = Record<string, string>;

/**
 * The list query as it was before it paged first, verbatim but for `t.id DESC` at the end of
 * the ORDER BY (its order among ties was arbitrary). Built with the same filters.
 */
function legacyListSql(query: Query, mode: 'list' | 'paginated', limit: number, offset: number) {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  if (mode === 'paginated' || query.include_children !== 'true') where.push('t.parent_transaction_id IS NULL');
  if (query.search) {
    const s = `%${query.search}%`;
    where.push(`(t.description ILIKE ${p(s)} OR a.name ILIKE ${p(s)} OR bi.name ILIKE ${p(s)} OR bi_from_bpi.name ILIKE ${p(s)} OR m.name ILIKE ${p(s)})`);
  }
  if (query.review_status && query.review_status !== 'all') where.push(`t.review_status = ${p(query.review_status)}`);
  if (query.date_from) where.push(`t.transaction_date >= ${p(query.date_from)}`);
  if (query.date_to) where.push(`t.transaction_date <= ${p(query.date_to)}`);
  if (query.type && query.type !== 'all') where.push(`t.type = ${p(query.type)}`);
  if (query.budget_period_id) where.push(`t.budget_period_id = ${p(parseInt(query.budget_period_id))}`);
  if (query.budget_item_id) where.push(`t.budget_item_id = ${p(parseInt(query.budget_item_id))}`);
  if (query.amount_min) where.push(`ABS(t.amount) >= ${p(parseFloat(query.amount_min))}`);
  if (query.amount_max) where.push(`ABS(t.amount) <= ${p(parseFloat(query.amount_max))}`);
  if (query.account_id) where.push(`t.account_id = ${p(parseInt(query.account_id))}`);
  if (query.account_uuid) where.push(`a.uuid = ${p(query.account_uuid)}`);
  if (mode === 'list') {
    if (query.merchant_uuid) where.push(`m.uuid = ${p(query.merchant_uuid)}`);
    if (query.budget_item_uuid) where.push(`bi.uuid = ${p(query.budget_item_uuid)}`);
    if (query.start_date) where.push(`t.transaction_date >= ${p(query.start_date)}`);
    if (query.end_date) where.push(`t.transaction_date <= ${p(query.end_date)}`);
  }
  if (query.assigned_to) where.push(`t.assigned_to = ${p(parseInt(query.assigned_to))}`);
  if (mode === 'paginated') {
    if (query.exclude_unassigned === 'true') where.push('t.assigned_to IS NOT NULL');
    if (query.assigned_to_or_unassigned) {
      where.push(`(t.assigned_to = ${p(parseInt(query.assigned_to_or_unassigned))} OR t.assigned_to IS NULL)`);
    }
  }
  const whereSql = where.map((w) => ` AND ${w}`).join('');
  const list = `
    SELECT t.id, t.uuid, t.description, t.amount, t.type, t.status, t.review_status, t.assigned_to,
      t.transaction_date::TEXT as transaction_date, t.budget_item_id, t.budget_period_id, t.budget_period_item_id,
      t.merchant_id, t.is_split_parent, t.parent_transaction_id, t.created_at, t.updated_at,
      a.name as account_name, a.uuid as account_uuid, a.type as account_class, bi.name as budget_item_name,
      bi.uuid as budget_item_uuid, bp.name as budget_period_name, bi_from_bpi.name as budget_period_item_name,
      m.name as merchant_name, u_assigned.first_name || ' ' || u_assigned.last_name as assigned_user,
      COALESCE(jsonb_agg(DISTINCT jsonb_build_object('id', tags.id, 'uuid', tags.uuid, 'name', tags.name,
        'color', tags.color, 'icon', tags.icon)) FILTER (WHERE tags.id IS NOT NULL), '[]'::jsonb) as tags
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
    LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
    LEFT JOIN budget_period_items bpi ON t.budget_period_item_id = bpi.id
    LEFT JOIN budget_items bi_from_bpi ON bpi.budget_item_id = bi_from_bpi.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    LEFT JOIN users u_assigned ON t.assigned_to = u_assigned.id
    LEFT JOIN taggings ON taggings.taggable_type = 'transaction' AND taggings.taggable_id = t.id
    LEFT JOIN tags ON tags.id = taggings.tag_id
    WHERE 1=1 ${whereSql}
    GROUP BY t.id, t.uuid, t.transaction_date, t.description, t.amount, t.type, t.status,
             t.review_status, t.account_id, t.budget_item_id, t.budget_period_id, t.budget_period_item_id,
             t.merchant_id, t.is_split_parent, t.assigned_to, t.notes, t.parent_transaction_id,
             t.created_at, t.updated_at, a.name, a.uuid, a.type, bi.name, bi.uuid, bp.name,
             bi_from_bpi.name, m.name, u_assigned.first_name, u_assigned.last_name
    ORDER BY t.transaction_date DESC, t.created_at DESC, t.id DESC
    LIMIT ${p(limit)} OFFSET ${p(offset)}`;
  const countParams = params.slice(0, params.length - 2);
  const count = `
    SELECT COUNT(*) as total
    FROM transactions t
    LEFT JOIN accounts a ON t.account_id = a.id
    LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
    LEFT JOIN budget_period_items bpi ON t.budget_period_item_id = bpi.id
    LEFT JOIN budget_items bi_from_bpi ON bpi.budget_item_id = bi_from_bpi.id
    LEFT JOIN merchants m ON t.merchant_id = m.id
    WHERE 1=1 ${whereSql}`;
  return { list, params, count, countParams };
}

/** The old /paginated formatter. */
function formatPaginated(row: Record<string, unknown>) {
  return {
    id: row.id, uuid: row.uuid, account_id: row.account_id, account_name: row.account_name,
    account_uuid: row.account_uuid, account_class: row.account_class, merchant_id: row.merchant_id,
    merchant_name: row.merchant_name, amount: parseFloat(row.amount as string), description: row.description,
    transaction_date: row.transaction_date, type: row.type, budget_period_id: row.budget_period_id,
    budget_period_name: row.budget_period_name, budget_item_id: row.budget_item_id,
    budget_item_name: row.budget_item_name, budget_item_uuid: row.budget_item_uuid,
    budget_period_item_name: row.budget_period_item_name, budget_period_item_id: row.budget_period_item_id,
    status: row.status, review_status: row.review_status, assigned_to: row.assigned_to,
    assigned_user: row.assigned_user, is_split_parent: row.is_split_parent,
    parent_transaction_id: row.parent_transaction_id, tags: row.tags, created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** What res.json sends for a row. */
const asJson = <T>(value: T): T => JSON.parse(JSON.stringify(value));

describe('Transactions list pages first', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  const ids: Record<string, number> = {};
  const uuids: Record<string, string> = {};

  beforeAll(async () => {
    tenant = await createTestTenant('Transactions list pages first');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/transactions', createTransactionsRoutes());

    const one = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0];
    for (const [key, name, type] of [
      ['checking', 'Joint Checking', 'Asset'],
      ['card', 'Rewards Card', 'Liability'],
      ['savings', 'Rainy Day', 'Asset'],
    ] as const) {
      const row = await one(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', $2) RETURNING id, uuid`,
        [name, type],
      );
      ids[key] = row.id;
      uuids[key] = row.uuid;
    }
    for (const [key, name] of [
      ['cafe', 'Corner Cafe'],
      ['percent', 'Sale 50% Off'],
      ['underscore', 'Under_score Books'],
      ['grocer', 'Green Grocer'],
    ] as const) {
      const row = await one('INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid', [name]);
      ids[key] = row.id;
      uuids[key] = row.uuid;
    }
    for (const [key, name] of [
      ['groceries', 'Groceries'],
      ['dining', 'Dining Out'],
      ['household', 'Household'],
    ] as const) {
      const row = await one(`INSERT INTO budget_items (name, status) VALUES ($1, 'paused') RETURNING id, uuid`, [name]);
      ids[key] = row.id;
      uuids[key] = row.uuid;
    }
    for (const [key, month] of [['sep', 9], ['oct', 10]] as const) {
      const start = `2026-${String(month).padStart(2, '0')}-01`;
      const row = await one(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ($1, $1, 2026, $2, $3::date, ($3::date + interval '1 month - 1 day')::date) RETURNING id`,
        [`List period ${month}`, month, start],
      );
      ids[key] = row.id;
      for (const item of ['groceries', 'dining', 'household']) {
        await pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [row.id, ids[item]]);
      }
    }
    const tagIds: number[] = [];
    for (const name of ['Trip', 'Kids', 'Work']) {
      tagIds.push((await one('INSERT INTO tags (name, color) VALUES ($1, $2) RETURNING id', [`${name}`, '#336699'])).id);
    }

    // 120 transactions in batches of 12 rows per INSERT, so each batch shares created_at,
    // and four rows a day, so most dates tie too.
    const accounts = [ids.checking, ids.card, ids.savings];
    const merchants = [ids.cafe, ids.percent, ids.underscore, ids.grocer, null];
    const items = [ids.groceries, ids.dining, ids.household, null];
    const descriptions = ['Coffee and a bun', 'Weekly shop', 'Paid 50% deposit', 'Book_club fee', 'Transfer'];
    for (let batch = 0; batch < 10; batch++) {
      const values: unknown[] = [];
      const rows: string[] = [];
      for (let k = 0; k < 12; k++) {
        const n = batch * 12 + k;
        const day = 1 + Math.floor(n / 4) % 30;
        const month = n % 2 === 0 ? 9 : 10;
        const income = n % 11 === 0;
        const base = values.length;
        values.push(
          accounts[income ? 0 : n % 3],
          merchants[n % 5],
          items[n % 4],
          items[n % 4] === null ? null : (month === 9 ? ids.sep : ids.oct),
          income ? 500 + n : -(5 + n * 1.25),
          descriptions[n % 5],
          `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          income ? 'income' : 'expense',
          n % 3 === 0 ? 'reviewed' : 'needs review',
          n % 4 === 0 ? tenant.userId : null,
        );
        rows.push(`(${Array.from({ length: 10 }, (_, i) => `$${base + i + 1}`).join(', ')})`);
      }
      await pool.query(
        `INSERT INTO transactions (account_id, merchant_id, budget_item_id, budget_period_id, amount, description,
                                   transaction_date, type, review_status, assigned_to)
         VALUES ${rows.join(', ')}`,
        values,
      );
    }
    // Splits: two parents with two children each
    const parents = (await pool.query(
      `SELECT id, account_id, transaction_date::text AS d, amount FROM transactions WHERE type = 'expense' ORDER BY id LIMIT 2`,
    )).rows;
    // The parent and its splits in one transaction, adding up to the cent: the database
    // checks a split transaction's splits at COMMIT.
    for (const parent of parents) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE transactions SET is_split_parent = true WHERE id = $1', [parent.id]);
        await client.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, description, parent_transaction_id, budget_item_id, budget_period_id)
           VALUES ($1, round($2::numeric / 2, 2), $3, 'expense', 'Split part', $4, $5, $6),
                  ($1, $2::numeric - round($2::numeric / 2, 2), $3, 'expense', 'Split part', $4, $7, $6)`,
          [parent.account_id, parent.amount, parent.d, parent.id, ids.groceries, parent.d.startsWith('2026-09') ? ids.sep : ids.oct, ids.dining],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }
    // Tags: none, one or two per transaction
    await pool.query(
      `INSERT INTO taggings (tag_id, taggable_type, taggable_id)
       SELECT tag.id, 'transaction', t.id
         FROM transactions t
         JOIN LATERAL unnest($1::int[]) WITH ORDINALITY AS tag(id, k) ON t.id % 3 >= tag.k AND tag.k <= 2`,
      [tagIds],
    );
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  async function legacy(query: Query, mode: 'list' | 'paginated', limit: number, offset: number) {
    const q = legacyListSql(query, mode, limit, offset);
    const rows = (await pool.query(q.list, q.params)).rows;
    const total = parseInt((await pool.query(q.count, q.countParams)).rows[0].total);
    return { rows, total };
  }

  const filterSets = (): Query[] => [
    {},
    { search: 'coffee' },
    { search: 'joint' },
    { search: 'grocer' },
    { search: 'dining' },
    { search: 'rewards' },
    { search: 'nothing matches this' },
    { review_status: 'needs review' },
    { review_status: 'all' },
    { review_status: 'needs review', assigned_to: String(tenant.userId) },
    { assigned_to_or_unassigned: String(tenant.userId) },
    { exclude_unassigned: 'true' },
    { date_from: '2026-09-10', date_to: '2026-10-20' },
    { type: 'income' },
    { type: 'all', amount_min: '10', amount_max: '60' },
    { account_uuid: uuids.card },
    { account_id: String(ids.savings), search: 'shop' },
    { budget_item_id: String(ids.dining) },
    { budget_period_id: String(ids.oct), review_status: 'reviewed' },
  ];

  // Every page of every filter set, each against the old query: dozens of requests, 4 s
  // alone on the 4-core machine, and past the default 10 s in a loaded full coverage run.
  // The work is fixed; only the machine's speed varies, so it gets a minute.
  it('GET /paginated answers what the old query did, page by page, with the same totals', { timeout: 60_000 }, async () => {
    for (const query of filterSets()) {
      const limit = 7;
      const { total } = await legacy(query, 'paginated', limit, 0);
      const pages = Math.max(1, Math.ceil(total / limit));
      for (let page = 1; page <= pages + 1; page++) {
        const res = await request(app)
          .get('/api/transactions/paginated')
          .query({ ...query, page, limit })
          .expect(200);
        const expected = await legacy(query, 'paginated', limit, (page - 1) * limit);
        expect(res.body.pagination, JSON.stringify(query)).toEqual({ total: expected.total, totalPages: Math.ceil(expected.total / limit), page, limit });
        expect(res.body.transactions, `${JSON.stringify(query)} page ${page}`).toEqual(asJson(expected.rows.map(formatPaginated)));
      }
    }
  });

  it('GET / answers what the old query did, children and uuid filters included', async () => {
    const extra: Query[] = [
      { include_children: 'true' },
      { include_children: 'true', budget_item_uuid: uuids.groceries },
      { merchant_uuid: uuids.cafe },
      { budget_item_uuid: uuids.household, start_date: '2026-09-05', end_date: '2026-10-25' },
    ];
    for (const query of [...filterSets(), ...extra]) {
      const res = await request(app).get('/api/transactions').query(query).expect(200);
      const expected = await legacy(query, 'list', 10000, 0);
      expect(res.body, JSON.stringify(query)).toEqual(asJson(expected.rows));
      expect(res.headers['x-result-truncated']).toBeUndefined();
    }
    const capped = await request(app).get('/api/transactions').query({ limit: 5 }).expect(200);
    expect(capped.body).toHaveLength(5);
    expect(capped.headers['x-result-truncated']).toBe('true');
  });

  it('pages never repeat or skip a row, though a whole batch shares its date and created_at', async () => {
    const seen: string[] = [];
    for (let page = 1; ; page++) {
      const res = await request(app).get('/api/transactions/paginated').query({ page, limit: 5 }).expect(200);
      if (res.body.transactions.length === 0) break;
      seen.push(...res.body.transactions.map((t: { uuid: string }) => t.uuid));
    }
    const all = (await pool.query(
      `SELECT uuid FROM transactions WHERE parent_transaction_id IS NULL ORDER BY transaction_date DESC, created_at DESC, id DESC`,
    )).rows.map((r) => r.uuid);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(all);
  });

  it("matches a search's % and _ as themselves", async () => {
    const percent = await request(app).get('/api/transactions/paginated').query({ search: '50%', limit: 200 }).expect(200);
    const expected = (await pool.query(
      `SELECT DISTINCT t.uuid FROM transactions t LEFT JOIN merchants m ON m.id = t.merchant_id
        WHERE t.parent_transaction_id IS NULL AND (strpos(lower(t.description), '50%') > 0 OR strpos(lower(m.name), '50%') > 0)`,
    )).rows.map((r) => r.uuid).sort();
    expect(percent.body.transactions.map((t: { uuid: string }) => t.uuid).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);

    // "_" was a wildcard: "a_d" matched "Card" and "Paid". Now it is only an underscore.
    expect((await legacy({ search: 'a_d' }, 'paginated', 200, 0)).total).toBeGreaterThan(0);
    const underscore = await request(app).get('/api/transactions/paginated').query({ search: 'a_d', limit: 200 }).expect(200);
    expect(underscore.body.pagination.total).toBe(0);
    const literal = await request(app).get('/api/transactions/paginated').query({ search: 'under_score', limit: 200 }).expect(200);
    expect(literal.body.pagination.total).toBeGreaterThan(0);
    for (const t of literal.body.transactions) expect(t.merchant_name).toBe('Under_score Books');
  });

  it('bounds paging parameters instead of failing on them', async () => {
    const zero = await request(app).get('/api/transactions/paginated').query({ page: 0, limit: -5 }).expect(200);
    expect(zero.body.pagination).toMatchObject({ page: 1, limit: 20 });
    const junk = await request(app).get('/api/transactions/paginated').query({ page: 'abc', limit: 'abc' }).expect(200);
    expect(junk.body.pagination).toMatchObject({ page: 1, limit: 20 });
    const huge = await request(app).get('/api/transactions/paginated').query({ limit: 1000000 }).expect(200);
    expect(huge.body.pagination.limit).toBe(200);
    expect(huge.body.transactions.length).toBeLessThanOrEqual(200);
  });

  it('joins and aggregates the rows of the page only', async () => {
    const { plan, tagCount } = await withTenant(tenant.tenantId, async (trx) => {
      const filters = [sql` AND t.parent_transaction_id IS NULL`, ...listFilters({})];
      // On tables this small the planner sometimes hashes a whole (tiny) table instead
      // of looping over the page, depending on statistics other test files change as
      // they run, so the counts below varied. Nested loops are what it picks at
      // production volume, and aggregating the whole history before LIMIT (what this
      // guards against) still shows under them.
      await sql`SET LOCAL enable_hashjoin = off`.execute(trx);
      await sql`SET LOCAL enable_mergejoin = off`.execute(trx);
      const res = await sql<{ 'QUERY PLAN': unknown }>`EXPLAIN (ANALYZE, FORMAT JSON) ${listPage(filters, 5, 10)}`.execute(trx);
      const tags = await sql<{ n: number }>`SELECT count(*)::int AS n FROM tags`.execute(trx);
      return { plan: (res.rows[0]['QUERY PLAN'] as { Plan: PlanNode }[])[0].Plan, tagCount: tags.rows[0].n };
    });
    type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Actual Rows': number; 'Actual Loops': number; Plans?: PlanNode[] };
    const nodes: PlanNode[] = [];
    const walk = (node: PlanNode) => {
      nodes.push(node);
      node.Plans?.forEach(walk);
    };
    walk(plan);
    // The plan's nodes, for the failure message: what each read, and how often.
    const shape = JSON.stringify(nodes.map((n) => [n['Node Type'], n['Relation Name'] ?? '', n['Actual Rows'], n['Actual Loops']]));
    // Fifteen rows are read for page 3 of 5; nothing joined or aggregated sees more than the five it keeps.
    const taggingScans = nodes.filter((n) => n['Relation Name'] === 'taggings');
    expect(taggingScans.length, shape).toBeGreaterThan(0);
    // Once per page row, or once per page row and tag when the planner loops over the tiny
    // tags table outside it; tags looked up for the whole history would be 120 or more.
    for (const scan of taggingScans) {
      expect(scan['Actual Loops'], shape).toBeLessThanOrEqual(5 * Math.max(1, tagCount));
    }
    for (const n of nodes.filter((n) => /Join|Nested Loop|Aggregate/.test(n['Node Type']))) {
      expect(n['Actual Rows'] * n['Actual Loops'], `${n['Node Type']}: ${shape}`).toBeLessThanOrEqual(15);
    }
    expect(nodes.some((n) => n['Node Type'] === 'Sort' && n['Actual Rows'] > 15), shape).toBe(false);
  });
});
