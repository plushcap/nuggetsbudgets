import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * What the baseline schema (init.sql) holds, and keeps holding as migrations follow it:
 * - no extension but plpgsql: pg_trgm and uuid-ossp were unused, and the baseline dropped them;
 * - its comments and function bodies cite no issue number, and its function bodies say
 *   "tenant", never "ledger" (CLAUDE.md);
 * - what migrations retired before it stays gone;
 * - the rules a test of the migration that made them used to pin: the instructions columns'
 *   comments name no AI vendor, a ledger's settings take only its keys, the budget event log
 *   only its event types and sources.
 * Read-only but for rows in this file's own ledger.
 */
const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
/** An issue number as the text cites one (a hash sign, then digits), not a colour such as #3B82F6. */
const ISSUE_NUMBER = '#[0-9]+([^0-9A-Za-z]|$)';

describe.skipIf(!url)('the baseline schema', () => {
  let owner: Pool;
  let tenant: TestTenant;

  beforeAll(async () => {
    owner = new Pool({ connectionString: url, max: 2 });
    tenant = await createTestTenant('baseline schema');
  });

  afterAll(async () => {
    await owner?.end();
    await tenant?.cleanup();
  });

  it('has no extension but plpgsql', async () => {
    const { rows } = await owner.query<{ extname: string }>('SELECT extname FROM pg_extension ORDER BY 1');
    expect(rows.map((r) => r.extname)).toEqual(['plpgsql']);
  });

  it('cites no issue number in a comment or a function body, and neither says ledger', async () => {
    const comments = await owner.query<{ object: string }>(
      `SELECT pg_describe_object(d.classoid, d.objoid, d.objsubid) AS object
         FROM pg_description d
        CROSS JOIN LATERAL pg_identify_object(d.classoid, d.objoid, d.objsubid) o
        WHERE o.schema = 'public' AND (d.description ~ $1 OR d.description ~* '\\mledger')
        ORDER BY 1`,
      [ISSUE_NUMBER]
    );
    expect(comments.rows.map((r) => r.object)).toEqual([]);
    const functions = await owner.query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND (p.prosrc ~ $1 OR p.prosrc ~* '\\mledger')
        ORDER BY 1`,
      [ISSUE_NUMBER]
    );
    expect(functions.rows.map((r) => r.fn)).toEqual([]);
    // The pattern finds what it looks for.
    const probe = await owner.query<{ cites: boolean; colour: boolean }>(
      `SELECT 'the rule (' || chr(35) || '123).' ~ $1 AS cites, 'DEFAULT ''#3B82F6''' ~ $1 AS colour`,
      [ISSUE_NUMBER]
    );
    expect(probe.rows[0]).toEqual({ cites: true, colour: false });
  });

  it('keeps what migrations retired before it gone', async () => {
    const { rows } = await owner.query<Record<string, boolean>>(
      `SELECT to_regclass('public.account_balance_cache') IS NULL AS balance_cache,
              to_regclass('public.goals_deprecated') IS NULL AS goals_deprecated,
              to_regclass('public.goal_progress_history') IS NULL AS goal_progress_history,
              to_regclass('public.notification_templates_registry') IS NULL AS templates_registry,
              to_regprocedure('public.get_system_config_typed(character varying)') IS NULL AS config_function,
              NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.transactions'::regclass AND attname = 'sequence_number' AND NOT attisdropped) AS sequence_number,
              NOT EXISTS (
                SELECT 1 FROM pg_index i JOIN pg_opclass oc ON oc.oid = ANY (i.indclass::oid[])
                 WHERE oc.opcname IN ('gin_trgm_ops', 'gist_trgm_ops')
              ) AS trigram_indexes`
    );
    expect(rows[0]).toEqual({
      balance_cache: true,
      goals_deprecated: true,
      goal_progress_history: true,
      templates_registry: true,
      config_function: true,
      sequence_number: true,
      trigram_indexes: true,
    });
  });

  it("names no AI vendor in the instructions columns' comments", async () => {
    const { rows } = await owner.query<{ table_name: string; comment: string | null }>(
      `SELECT c.relname AS table_name, col_description(c.oid, a.attnum) AS comment
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND a.attname = 'instructions'
        ORDER BY 1`
    );
    expect(rows.map((r) => r.table_name)).toEqual(['accounts', 'budget_items', 'merchants']);
    for (const { table_name, comment } of rows) {
      expect(comment, table_name).toMatch(/^Free-form instructions\/context for AI agents\. Distinct from user-facing /);
      expect(comment, table_name).not.toMatch(/claude|anthropic|openai|gpt/i);
    }
  });

  it("takes only a ledger setting's key in tenant_settings", async () => {
    await tenant.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('import_days_back', '30')`);
    await expect(
      tenant.pool.query(`INSERT INTO tenant_settings (setting_key, setting_value) VALUES ('notification_smtp_host', 'x')`)
    ).rejects.toMatchObject({ code: '23514', constraint: 'tenant_settings_setting_key_check' });
  });

  it('takes only its event types and sources in the budget event log', async () => {
    const item = (await tenant.pool.query<{ id: number }>(`INSERT INTO budget_items (name) VALUES ('baseline item') RETURNING id`)).rows[0]!.id;
    const period = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('baseline period', 'October', 2997, 10, '2997-10-01', '2997-10-31') RETURNING id`
      )
    ).rows[0]!.id;
    const periodItem = (
      await tenant.pool.query<{ id: number }>(
        'INSERT INTO budget_period_items (budget_period_id, budget_item_id) VALUES ($1, $2) RETURNING id',
        [period, item]
      )
    ).rows[0]!.id;
    const event = (eventType: string, source: string) =>
      tenant.pool.query(
        `INSERT INTO budget_period_transactions (budget_period_item_id, budget_item_id, transaction_type, type, amount, event_type, source_system)
         VALUES ($1, $2, 'add', 'budget_update', 1, $3, $4)`,
        [periodItem, item, eventType, source]
      );
    await event('budget_update', 'nuggets_app');
    await expect(event('bogus', 'nuggets_app')).rejects.toMatchObject({
      code: '23514',
      constraint: 'budget_period_transactions_event_type_check',
    });
    await expect(event('budget_update', 'bogus')).rejects.toMatchObject({
      code: '23514',
      constraint: 'budget_period_transactions_source_system_check',
    });
  });
});
