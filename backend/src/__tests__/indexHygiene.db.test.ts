import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withSchemaChangeLockShared } from '../test/schemaLock.js';

/**
 * No index in public repeats another one on its table: every index is
 * written on every insert and update of its table, so a copy costs every import for
 * nothing. Migrations before v3.0.0 dropped the ones there were;
 * this keeps a new migration from adding another.
 *
 *  - a duplicate: same access method, key columns, operator classes, collations,
 *    expressions and predicate, in the same order or all reversed (a btree is scanned
 *    either way), including a plain index on a unique key's columns;
 *  - a plain btree prefix: a non-unique btree, backing no constraint and with no INCLUDE
 *    columns, whose columns lead a longer btree on the table with the same predicate (or
 *    none), in the same order or all reversed. An index whose predicate differs from its
 *    partner's is not one: it serves queries the partner can't.
 *
 * Nor is there a trigram index (gin_trgm_ops, gist_trgm_ops) on a table under row-level
 * security: Postgres runs a condition as an index condition below the tenant policy
 * only if its operator is leakproof, and LIKE, ILIKE, the regex operators and pg_trgm's
 * similarity ones aren't, so no request query can use one; it only costs every write. The
 * baseline has none, and no pg_trgm either: a migration that brings it back for an index
 * on such a table fails here.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const INDEXES_SQL = `
  SELECT c.relname AS index_name, t.relname AS table_name, am.amname AS method,
         i.indisunique AS is_unique, i.indnkeyatts AS key_count,
         EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid AND k.conrelid = i.indrelid) AS backs_constraint,
         string_to_array(i.indkey::text, ' ') AS keys,
         string_to_array(i.indclass::text, ' ') AS classes,
         string_to_array(i.indcollation::text, ' ') AS collations,
         string_to_array(i.indoption::text, ' ') AS options,
         pg_get_expr(i.indexprs, i.indrelid) AS expressions,
         pg_get_expr(i.indpred, i.indrelid) AS predicate
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_am am ON am.oid = c.relam
   WHERE n.nspname = 'public'`;

/** Indexes in public, on a table with row-level security, with a key column in a trigram operator class. */
const TRIGRAM_INDEXES_SQL = `
  SELECT DISTINCT c.relname AS index_name, t.relname AS table_name, oc.opcname AS opclass
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    CROSS JOIN LATERAL unnest(i.indclass::oid[]) AS k(opclass_oid)
    JOIN pg_opclass oc ON oc.oid = k.opclass_oid
   WHERE n.nspname = 'public'
     AND t.relrowsecurity
     AND oc.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
   ORDER BY 2, 1`;

interface IndexRow {
  index_name: string;
  table_name: string;
  method: string;
  is_unique: boolean;
  key_count: number;
  backs_constraint: boolean;
  keys: string[];
  classes: string[];
  collations: string[];
  options: string[];
  expressions: string | null;
  predicate: string | null;
}

/** indoption with each column's direction and nulls order flipped: the index scanned backward. */
const reversed = (options: string[]) => options.map((o) => String(Number(o) ^ 3));
const same = (a: string[], b: string[]) => a.length === b.length && a.every((v, k) => v === b[k]);

/** `a`'s key columns lead `b`'s, in the same order or all reversed (a btree scans either way). */
function leads(a: IndexRow, b: IndexRow): boolean {
  const n = a.key_count;
  const head = (row: IndexRow, field: 'keys' | 'classes' | 'collations' | 'options') => row[field].slice(0, n);
  if (!same(head(a, 'keys'), head(b, 'keys')) || !same(head(a, 'classes'), head(b, 'classes'))) return false;
  if (!same(head(a, 'collations'), head(b, 'collations'))) return false;
  const options = head(b, 'options');
  return same(head(a, 'options'), options) || (a.method === 'btree' && same(reversed(head(a, 'options')), options));
}

describeDb('Index hygiene', () => {
  let pool: Pool;
  let indexes: IndexRow[];

  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 1 });
    const client = await pool.connect();
    try {
      // Not while a migration test's rolled-back DDL holds its tables.
      indexes = await withSchemaChangeLockShared(client, async () => (await client.query<IndexRow>(INDEXES_SQL)).rows);
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('reads the catalog', () => {
    expect(indexes.length).toBeGreaterThan(100);
    expect(indexes.some((ix) => ix.index_name === 'transactions_tenant_id_id_key' && ix.backs_constraint)).toBe(true);
  });

  it('has no index that duplicates another on its table', () => {
    const duplicates: string[] = [];
    for (const [k, a] of indexes.entries()) {
      for (const b of indexes.slice(k + 1)) {
        if (a.table_name !== b.table_name || a.method !== b.method || a.key_count !== b.key_count) continue;
        if (!same(a.keys, b.keys) || a.expressions !== b.expressions || a.predicate !== b.predicate) continue;
        if (leads(a, b)) duplicates.push(`${a.table_name}: ${a.index_name} = ${b.index_name}`);
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('has no plain btree whose columns lead another btree with the same predicate', () => {
    const prefixes: string[] = [];
    for (const a of indexes) {
      if (a.method !== 'btree' || a.is_unique || a.backs_constraint || a.expressions !== null) continue;
      // A covering index (INCLUDE columns) can answer from the index alone; not a copy.
      if (a.keys.length > a.key_count) continue;
      for (const b of indexes) {
        if (b === a || b.table_name !== a.table_name || b.method !== 'btree' || b.expressions !== null) continue;
        if (b.key_count <= a.key_count || b.predicate !== a.predicate) continue;
        if (leads(a, b)) prefixes.push(`${a.table_name}: ${a.index_name} leads ${b.index_name}`);
      }
    }
    expect(prefixes).toEqual([]);
  });

  it('has no trigram index on a table under row-level security, where no request query can use one', async () => {
    const client = await pool.connect();
    try {
      const { rows } = await withSchemaChangeLockShared(client, () =>
        client.query<{ index_name: string; table_name: string; opclass: string }>(TRIGRAM_INDEXES_SQL)
      );
      expect(rows.map((r) => `${r.table_name}: ${r.index_name} (${r.opclass})`)).toEqual([]);
      // Without pg_trgm (the baseline doesn't install it) there is no trigram opclass to use.
      const trigram = await client.query<{ installed: boolean; opclasses: number }>(
        `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed,
                (SELECT count(*)::int FROM pg_opclass WHERE opcname IN ('gin_trgm_ops', 'gist_trgm_ops')) AS opclasses`
      );
      expect(trigram.rows[0]).toEqual({ installed: false, opclasses: 0 });
    } finally {
      client.release();
    }
  });
});
