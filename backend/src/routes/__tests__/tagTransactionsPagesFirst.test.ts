import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool } from 'pg';
import { sql } from 'kysely';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import { tagTransactionsPage } from '../../services/tags/TagReportService.js';

/**
 * GET /api/tags/:uuid/transactions chooses its page of transactions, each once, before
 * it joins names or aggregates tags. These check it answers what the old query
 * (a SELECT DISTINCT over the taggings and the joins, then LIMIT/OFFSET) did, page by
 * page, with many transactions on one day, transactions carrying several of the tag's
 * tags, splits and date ranges; that pages never repeat or skip a row; and that only the
 * page's rows are joined (requires Postgres).
 */

/** The old list and count, verbatim. */
function legacySql(tagIds: number[], range: { start?: string; end?: string }, limit: number, offset: number) {
  const params: unknown[] = [tagIds];
  let dates = '';
  if (range.start) {
    params.push(range.start);
    dates += ` AND t.transaction_date >= $${params.length}::date`;
  }
  if (range.end) {
    params.push(range.end);
    dates += ` AND t.transaction_date <= $${params.length}::date`;
  }
  const countParams = [...params];
  params.push(limit, offset);
  return {
    list: `
      SELECT DISTINCT
        t.id, t.uuid, t.description, t.amount, t.type, t.status,
        t.review_status, t.assigned_to, t.merchant_id,
        t.budget_item_id, t.budget_period_id, t.budget_period_item_id,
        t.transaction_date,
        t.notes, t.is_split_parent, t.parent_transaction_id, t.created_at, t.updated_at,
        a.name as account_name, a.uuid as account_uuid,
        m.name as merchant_name, m.uuid as merchant_uuid,
        bi.name as budget_item_name, bi.uuid as budget_item_uuid,
        bp.name as budget_period_name,
        u_assigned.first_name || ' ' || u_assigned.last_name as assigned_user,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', tags.id, 'uuid', tags.uuid, 'name', tags.name, 'color', tags.color, 'icon', tags.icon))
            FROM taggings tags_join INNER JOIN tags ON tags.id = tags_join.tag_id
            WHERE tags_join.taggable_type = 'transaction' AND tags_join.taggable_id = t.id), '[]'::jsonb) as tags
      FROM transactions t
      INNER JOIN taggings tg ON tg.taggable_id = t.id AND tg.taggable_type = 'transaction'
      LEFT JOIN accounts a ON t.account_id = a.id
      LEFT JOIN merchants m ON t.merchant_id = m.id
      LEFT JOIN budget_items bi ON t.budget_item_id = bi.id
      LEFT JOIN budget_period bp ON t.budget_period_id = bp.id
      LEFT JOIN users u_assigned ON t.assigned_to = u_assigned.id
      WHERE tg.tag_id = ANY($1)
        AND t.status != 'deleted'
        AND t.is_split_parent = false
        ${dates}
      ORDER BY t.transaction_date DESC, t.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
    count: `
      SELECT COUNT(DISTINCT t.id) as total
      FROM transactions t
      INNER JOIN taggings tg ON tg.taggable_id = t.id AND tg.taggable_type = 'transaction'
      WHERE tg.tag_id = ANY($1)
        AND t.status != 'deleted'
        AND t.is_split_parent = false
        ${dates}`,
    countParams,
  };
}

type Row = { tags: { id: number }[] } & Record<string, unknown>;
/** What res.json sends for a row, its tags in id order (jsonb_agg has no ORDER BY, before or after). */
const asJson = (rows: Row[]) =>
  (JSON.parse(JSON.stringify(rows)) as Row[]).map((row) => ({ ...row, tags: [...row.tags].sort((x, y) => x.id - y.id) }));

describe('Tag transactions page first', () => {
  let app: Express;
  let pool: Pool;
  let tenant: TestTenant;
  const tags: Record<string, { id: number; uuid: string }> = {};

  beforeAll(async () => {
    tenant = await createTestTenant('Tag transactions page first');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());

    const one = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows[0];
    const accounts = [
      (await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Joint Checking', 'checking', 'cash', 'Asset') RETURNING id`)).id,
      (await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Rewards Card', 'credit_card', 'credit_cards', 'Liability') RETURNING id`)).id,
    ];
    const merchants = [(await one(`INSERT INTO merchants (name) VALUES ('Corner Cafe') RETURNING id`)).id, null];
    const item = (await one(`INSERT INTO budget_items (name, status) VALUES ('Dining', 'paused') RETURNING id`)).id;
    const period = (
      await one(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('Oct 2026', 'Oct 2026', 2026, 10, '2026-10-01', '2026-10-31') RETURNING id`
      )
    ).id;
    await pool.query('INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2)', [period, item]);

    // Trip > Food > Snacks, and Work outside it.
    for (const [key, name, parent] of [
      ['trip', 'Trip', null],
      ['food', 'Food', 'trip'],
      ['snacks', 'Snacks', 'food'],
      ['work', 'Work', null],
    ] as const) {
      tags[key] = await one('INSERT INTO tags (name, parent_id) VALUES ($1, $2) RETURNING id, uuid', [name, parent ? tags[parent].id : null]);
    }

    // 90 transactions over 6 days of October, 15 a day, one INSERT (one created_at).
    const values: unknown[] = [];
    const rows: string[] = [];
    for (let n = 0; n < 90; n++) {
      const base = values.length;
      values.push(
        accounts[n % 2],
        merchants[n % 2],
        n % 3 === 0 ? item : null,
        n % 3 === 0 ? period : null,
        -(1 + n * 0.37).toFixed(2),
        `Purchase ${n}`,
        `2026-10-${String(10 + (n % 6)).padStart(2, '0')}`,
        n % 4 === 0 ? tenant.userId : null
      );
      rows.push(`(${Array.from({ length: 8 }, (_, i) => `$${base + i + 1}`).join(', ')}, 'expense')`);
    }
    const ids: number[] = (
      await pool.query(
        `INSERT INTO transactions (account_id, merchant_id, budget_item_id, budget_period_id, amount, description, transaction_date, assigned_to, type)
         VALUES ${rows.join(', ')} RETURNING id`,
        values
      )
    ).rows.map((r) => r.id);
    // A split: the parent is left out, its children count.
    const client = await pool.connect();
    let children: number[];
    try {
      await client.query('BEGIN');
      await client.query('UPDATE transactions SET is_split_parent = true WHERE id = $1', [ids[0]]);
      children = (
        await client.query(
          `INSERT INTO transactions (account_id, amount, transaction_date, type, description, parent_transaction_id)
           SELECT account_id, -0.50, transaction_date, 'expense', 'Split part', id FROM transactions WHERE id = $1
           UNION ALL
           SELECT account_id, amount + 0.50, transaction_date, 'expense', 'Split part', id FROM transactions WHERE id = $1
           RETURNING id`,
          [ids[0]]
        )
      ).rows.map((r) => r.id);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    // Tags: most carry one of Trip's tree, many two or three of them (one row each in the
    // old join), some Work as well, some nothing. The split parent and both children too.
    const tagging = async (tag: string, id: number) =>
      pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tags[tag].id, id]);
    for (const [n, id] of ids.entries()) {
      if (n % 7 === 6) continue;
      await tagging(['trip', 'food', 'snacks'][n % 3], id);
      if (n % 2 === 0) await tagging(['trip', 'food', 'snacks'][(n + 1) % 3], id);
      if (n % 5 === 0) await tagging(['trip', 'food', 'snacks'][(n + 2) % 3], id);
      if (n % 4 === 1) await tagging('work', id);
    }
    for (const id of children) {
      await tagging('snacks', id);
      await tagging('trip', id);
    }
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  async function tagIdsOf(key: string): Promise<number[]> {
    return (await pool.query('SELECT tag_id FROM get_child_tag_ids($1)', [tags[key].id])).rows.map((r) => r.tag_id);
  }

  async function legacy(key: string, range: { start?: string; end?: string }, limit: number, offset: number) {
    const q = legacySql(await tagIdsOf(key), range, limit, offset);
    return {
      rows: (await pool.query(q.list, q.params)).rows as Row[],
      total: parseInt((await pool.query(q.count, q.countParams)).rows[0].total, 10),
    };
  }

  it('answers what the old query did, page by page, with the same totals', async () => {
    for (const key of ['trip', 'food', 'snacks', 'work']) {
      const ranges: { start?: string; end?: string }[] = [{}, { start: '2026-10-11', end: '2026-10-13' }, { start: '2026-10-15' }, { end: '2026-10-09' }];
      for (const range of ranges) {
        for (const limit of [1, 7, 500]) {
          const { total } = await legacy(key, range, limit, 0);
          // Every page, and one past the end; a page of one only at the start and the end.
          const pages = Math.max(1, Math.ceil(total / limit));
          const offsets = Array.from({ length: pages + 1 }, (_, page) => page * limit)
            .filter((offset) => limit > 1 || offset < 3 || offset >= total - 2);
          for (const offset of offsets) {
            const dates = { ...(range.start ? { start_date: range.start } : {}), ...(range.end ? { end_date: range.end } : {}) };
            const res = await request(app).get(`/api/tags/${tags[key].uuid}/transactions`).query({ limit, offset, ...dates }).expect(200);
            const expected = await legacy(key, range, limit, offset);
            const label = `${key} ${JSON.stringify(range)} limit ${limit} offset ${offset}`;
            expect(res.body.total, label).toBe(expected.total);
            expect(asJson(res.body.transactions), label).toEqual(asJson(expected.rows));
          }
        }
      }
    }
    // The tree's transactions: 90 less the untagged and the split parent, plus its two children.
    expect((await legacy('trip', {}, 500, 0)).total).toBeGreaterThan(70);
  }, 120_000);

  it('pages never repeat or skip a transaction, though fifteen share each day and several tags each', async () => {
    const seen: string[] = [];
    for (let offset = 0; ; offset += 4) {
      const res = await request(app).get(`/api/tags/${tags.trip.uuid}/transactions`).query({ limit: 4, offset }).expect(200);
      if (res.body.transactions.length === 0) break;
      seen.push(...res.body.transactions.map((t: { uuid: string }) => t.uuid));
    }
    const expected = (
      await pool.query(
        `SELECT t.uuid FROM transactions t
          WHERE NOT t.is_split_parent
            AND EXISTS (SELECT 1 FROM taggings g WHERE g.taggable_type = 'transaction' AND g.taggable_id = t.id AND g.tag_id = ANY($1))
          ORDER BY t.transaction_date DESC, t.id DESC`,
        [await tagIdsOf('trip')]
      )
    ).rows.map((r) => r.uuid);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected);
  });

  it('joins and aggregates the rows of the page only', async () => {
    const tagIds = await tagIdsOf('trip');
    const plan = await withTenant(tenant.tenantId, async (trx) => {
      // As in transactionsListPagesFirst: on tables this small the planner may hash a whole
      // table; joining every row before LIMIT (what this guards against) still shows under
      // nested loops.
      await sql`SET LOCAL enable_hashjoin = off`.execute(trx);
      await sql`SET LOCAL enable_mergejoin = off`.execute(trx);
      const res = await sql<{ 'QUERY PLAN': unknown }>`EXPLAIN (ANALYZE, FORMAT JSON) ${tagTransactionsPage(tagIds, {}, { limit: 5, offset: 10 })}`.execute(trx);
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
    // The names are looked up once per page row (5), not for every tagged transaction;
    // the tags once per page row and tag it carries (at most four here).
    for (const table of ['accounts', 'merchants', 'budget_items', 'budget_period', 'users', 'tags']) {
      for (const scan of nodes.filter((n) => n['Relation Name'] === table)) {
        expect(scan['Actual Loops'], `${table}: ${shape}`).toBeLessThanOrEqual(table === 'tags' ? 5 * 4 : 5);
      }
    }
    // The tags are aggregated once per page row.
    for (const n of nodes.filter((n) => n['Node Type'] === 'Aggregate')) {
      expect(n['Actual Loops'], shape).toBeLessThanOrEqual(5);
    }
  });
});
