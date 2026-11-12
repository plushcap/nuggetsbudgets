import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { Pool } from 'pg';
import { MigrationRefusal, MigrationService } from '../services/MigrationService.js';
import { assertSchemaMigrated } from '../db/schemaReady.js';
import { BASELINE, V2_4_0_CUTOVER_PATH } from '../db/baseline.js';
import { V2_4_0_MIGRATIONS } from '../db/v240Migrations.js';
import { fingerprintText, schemaDefinitions, schemaFingerprint } from '../db/schemaFingerprint.js';
import { getDirname } from '../utils/esm-compat.js';
import { loadV240Install, migrationRows, schemaSnapshot } from '../test/schemaSnapshot.js';
import { migrationFailedLine } from '../scripts/migrate.js';
import { ApplicationLifecycleService } from '../services/ApplicationLifecycleService.js';
import type { ImportService } from '../services/ImportService.js';
import type { BackupService } from '../services/BackupService.js';

/**
 * The migration runner after the squash, on databases of its own that this file creates and
 * drops (a migration's test, so it runs alone, after the other files):
 * - a v2.4.0 install (src/test/fixtures/v2.4.0-install.sql) is cut over: its 161 rows become
 *   the baseline's one, and its schema a fresh install's, whatever text its comments and
 *   function bodies had;
 * - a history it can't upgrade (an older release's, one with a migration it doesn't know, an
 *   edited v2.4.0 migration) is refused, and so is a cutover file that isn't the baseline's;
 *   each changes nothing, and a cutover that fails part-way is rolled back whole;
 * - a database at the baseline, or an empty one, applies the migrations newer than it.
 * backend/scripts/check-migrations.sh upgrade makes the same comparison with pg_dump (CI).
 *
 * Runs as the owner (DATABASE_URL), which needs CREATEDB. Nothing here touches the shared
 * test database.
 */

const ownerUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = ownerUrl ? describe : describe.skip;

const BACKEND = path.join(getDirname(import.meta.url), '../..');
const MIGRATIONS_DIR = path.join(BACKEND, 'migrations');
const BASELINE_SQL = path.join(BACKEND, 'init.sql');
const BASELINE_ROW = { version: BASELINE.version, name: BASELINE.name, checksum: BASELINE.checksum };

function urlFor(database: string): string {
  const url = new URL(ownerUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

describeDb('the cutover from v2.4.0, and the runner at the baseline', () => {
  const created: string[] = [];
  const pools: Pool[] = [];
  let admin: Pool;
  let scratch: string;
  let fresh: Record<string, string[]>;
  /** A fresh install's schema_migrations: the baseline's row, and the migrations in backend/migrations. */
  let freshRows: Awaited<ReturnType<typeof migrationRows>>;
  /** A migrations directory with no migration: a runner over it stops at the baseline, where the cutover compares. */
  let noMigrations: string;
  /** A fresh install's schema with no newer migration: the baseline's. */
  let freshAtBaseline: Record<string, string[]>;

  /** A new empty database (dropped in afterAll) and a pool on it. */
  async function emptyDatabase(): Promise<{ pool: Pool; url: string }> {
    const name = `nuggets_cutover_test_${randomBytes(6).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    const pool = new Pool({ connectionString: urlFor(name), max: 4 });
    pools.push(pool);
    return { pool, url: urlFor(name) };
  }
  /** A new database holding a v2.4.0 install. */
  async function v240Database(): Promise<Pool> {
    const { pool, url } = await emptyDatabase();
    await loadV240Install(url);
    return pool;
  }
  const runner = (pool: Pool, options: { migrationsDir?: string; cutoverPath?: string } = {}) =>
    new MigrationService(pool, { migrationsDir: MIGRATIONS_DIR, baselinePath: BASELINE_SQL, ...options });
  const extensions = async (pool: Pool) => (await pool.query('SELECT extname FROM pg_extension ORDER BY 1')).rows.map((r) => r.extname);

  beforeAll(async () => {
    admin = new Pool({ connectionString: ownerUrl, max: 2 });
    scratch = mkdtempSync(path.join(tmpdir(), 'nuggets-cutover-'));
    // A fresh install: the runner loads init.sql into an empty database.
    const { pool } = await emptyDatabase();
    await runner(pool).migrate();
    freshRows = await migrationRows(pool);
    expect(freshRows[0]).toEqual(BASELINE_ROW);
    fresh = await schemaSnapshot(pool);
    noMigrations = mkdtempSync(path.join(scratch, 'none-'));
    const { pool: atBaseline } = await emptyDatabase();
    await runner(atBaseline, { migrationsDir: noMigrations }).migrate();
    freshAtBaseline = await schemaSnapshot(atBaseline);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
    for (const name of created) {
      for (let i = 0; i < 50; i++) {
        const { rows } = await admin.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name]);
        if (rows[0].n === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    }
    await admin?.end();
    rmSync(scratch, { recursive: true, force: true });
  }, 120_000);

  it("cuts a v2.4.0 install over: its 161 rows become the baseline's, its schema a fresh install's", async () => {
    const pool = await v240Database();
    expect((await migrationRows(pool)).map(({ version, checksum }) => ({ version, checksum }))).toEqual(
      V2_4_0_MIGRATIONS.map(({ version, checksum }) => ({ version, checksum }))
    );
    expect(await extensions(pool)).toEqual(['pg_trgm', 'plpgsql', 'uuid-ossp']);
    const before = await runner(pool).getStatus();
    expect(before).toMatchObject({ initialized: true, history: 'v2.4.0', applied: [] });
    expect(before.pending.map((m) => m.version)).toEqual(freshRows.map((r) => r.version));
    // The server's check: the schema is there, the baseline is pending (logged, not refused).
    await expect(assertSchemaMigrated(pool, MIGRATIONS_DIR)).resolves.toEqual({ pending: freshRows.map((r) => r.version) });
    const settings = (await pool.query('SELECT count(*)::int AS n FROM system_settings')).rows[0].n;

    const service = runner(pool);
    await service.migrate();

    expect(await migrationRows(pool)).toEqual(freshRows);
    expect(await schemaSnapshot(pool)).toEqual(fresh);
    expect(await extensions(pool)).toEqual(['plpgsql']);
    // Compared with a fresh baseline's fingerprint, nothing differs.
    expect(service.cutoverDrift).toEqual({ missing: [], extra: [], changed: [] });
    expect((await pool.query('SELECT count(*)::int AS n FROM system_settings')).rows[0].n).toBe(settings);
    const after = await runner(pool).getStatus();
    expect(after).toMatchObject({ history: 'baseline', pending: [] });
    expect(after.applied.map((m) => m.version)).toEqual(freshRows.map((r) => r.version));
    expect(after.refusal).toBeUndefined();

    // Nothing to do the second time, and the baseline has no DOWN part to roll back.
    await runner(pool).migrate();
    expect(await migrationRows(pool)).toEqual(freshRows);
    await expect(runner(pool).rollback(freshRows.length)).rejects.toThrow(/20261113000000 \(v3\.0\.0 baseline\) has no DOWN section\. Nothing was rolled back/);
  }, 60_000);

  it("has the committed fingerprint, a fresh baseline's, where the cutover compares: before any newer migration", async () => {
    const pool = await v240Database();
    const service = runner(pool, { migrationsDir: noMigrations });
    await service.migrate();
    expect(await migrationRows(pool)).toEqual([BASELINE_ROW]);
    expect(service.cutoverDrift).toEqual({ missing: [], extra: [], changed: [] });
    // vitest -u writes it again.
    await expect(fingerprintText(await schemaFingerprint(pool))).toMatchFileSnapshot('../../upgrade/baseline-fingerprint.txt');
    // Every definition whole, as text: a function's, an index's, a policy's run past 63 characters.
    const definitions = await schemaDefinitions(pool);
    const fn = (await pool.query(`SELECT pg_get_functiondef('public.calculate_tag_level()'::regprocedure) AS def`)).rows[0].def;
    expect(definitions.get('function public.calculate_tag_level()')).toBe(fn);
    expect(fn.length).toBeGreaterThan(1000);
    const long = [...definitions].filter(([, def]) => def.length > 63).map(([key]) => key.split(' ')[0]);
    expect(new Set(long)).toEqual(new Set(['column', 'constraint', 'index', 'trigger', 'policy', 'view', 'function', 'privileges']));
  }, 60_000);

  it('leaves nothing of the old text: any comments and function bodies come out as the baseline has them', async () => {
    const pool = await v240Database();
    // Every comment reworded, comments where the baseline has none (a column, an index, a
    // trigger, a constraint, a policy), and every function body with a line it doesn't have.
    await pool.query(`DO $$
      DECLARE d record; f record;
      BEGIN
        FOR d IN SELECT c.objoid, c.classoid, c.objsubid FROM pg_description c
                   CROSS JOIN LATERAL pg_identify_object(c.classoid, c.objoid, c.objsubid) o WHERE o.schema = 'public' LOOP
          UPDATE pg_description SET description = 'stale wording (' || chr(35) || '1) of the ledger'
           WHERE objoid = d.objoid AND classoid = d.classoid AND objsubid = d.objsubid;
        END LOOP;
        FOR f IN SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
                   AND p.prolang IN (SELECT oid FROM pg_language WHERE lanname IN ('plpgsql', 'sql')) LOOP
          EXECUTE regexp_replace(pg_get_functiondef(f.oid), 'AS \\$function\\$', format(E'AS $function$\\n-- stale (%s1): a ledger''s\\n', chr(35)));
        END LOOP;
      END $$`);
    // trim_space has a SQL-standard body (RETURN …), no text to add a line to: another one.
    await pool.query(
      'CREATE OR REPLACE FUNCTION public.trim_space(value text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT RETURN btrim(value)'
    );
    await pool.query(`COMMENT ON COLUMN public.tags.name IS 'a comment the baseline has not'`);
    await pool.query(`COMMENT ON INDEX public.uq_merchants_tenant_lower_name IS 'nor this'`);
    await pool.query(`COMMENT ON TRIGGER trigger_check_transaction_type_for_account ON public.transactions IS 'nor this'`);
    await pool.query(`COMMENT ON CONSTRAINT budget_period_tenant_month_key ON public.budget_period IS 'nor this'`);
    await pool.query(`COMMENT ON POLICY tags_tenant_isolation ON public.tags IS 'nor this'`);
    const changed = await schemaSnapshot(pool);
    expect(changed.comments).not.toEqual(fresh.comments);
    expect(changed.functions).not.toEqual(fresh.functions);
    // Not one function as the baseline has it.
    expect(changed.functions.filter((def) => fresh.functions.includes(def))).toEqual([]);

    await runner(pool).migrate();

    expect(await schemaSnapshot(pool)).toEqual(fresh);
    expect(await migrationRows(pool)).toEqual(freshRows);
  }, 60_000);

  describe('a history it cannot upgrade, refused unchanged', () => {
    let pool: Pool;
    let schema: Record<string, string[]>;
    let rows: Awaited<ReturnType<typeof migrationRows>>;

    beforeAll(async () => {
      pool = await v240Database();
      schema = await schemaSnapshot(pool);
      rows = await migrationRows(pool);
    }, 60_000);

    /**
     * migrate refuses with `message`, the schema and the rows are as they were, and `status`
     * and the server's start without migrations say the same refusal.
     */
    async function refused(message: RegExp, expectedRows = rows, options: { cutoverPath?: string } = {}) {
      const service = runner(pool, options);
      const error = await service.migrate().then(() => null, (err: unknown) => err);
      expect(error).toBeInstanceOf(MigrationRefusal);
      expect((error as Error).message).toMatch(message);
      expect(migrationFailedLine(error)).toBe(`Migration refused (nothing was changed): ${(error as Error).message}`);
      expect(await migrationRows(pool)).toEqual(expectedRows);
      expect(await schemaSnapshot(pool)).toEqual(schema);
      if (!options.cutoverPath) {
        expect((await service.status()).refusal).toBe((error as Error).message);
        expect((await assertSchemaMigrated(pool, MIGRATIONS_DIR)).refusal).toBe((error as Error).message);
      }
      return service;
    }

    it("refuses an older release's history (some of v2.4.0's migrations), naming how many and the newest", async () => {
      const newest = V2_4_0_MIGRATIONS.slice(-3).map((m) => m.version);
      await pool.query('DELETE FROM schema_migrations WHERE version = ANY($1)', [newest]);
      try {
        const kept = rows.filter((r) => !newest.includes(r.version));
        const service = await refused(/from a release before v2\.4\.0/, kept);
        await expect(service.migrate()).rejects.toThrow(`has 158 migration(s), the newest ${kept.at(-1)!.version} (${kept.at(-1)!.name})`);
        await expect(service.migrate()).rejects.toThrow(/Upgrade to v2\.4\.0 first .*then to this release\. Nothing was changed\./);
        expect(service.failedMigration).toBeNull();
        expect(await service.getStatus()).toMatchObject({ history: 'older', refusal: expect.stringMatching(/before v2\.4\.0/) });
      } finally {
        for (const r of rows.filter((row) => newest.includes(row.version))) {
          await pool.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [r.version, r.name, r.checksum]);
        }
      }
    });

    it('refuses a history with a migration neither v2.4.0 nor this release has, naming it, and says to take it off', async () => {
      // One newer than v2.4.0's, and one older: v2.4.0 refuses either too, so "upgrade to
      // v2.4.0" would not help.
      for (const version of ['20261112300000', '20250101000000']) {
        await pool.query(`INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'my own', $2)`, [version, 'a'.repeat(64)]);
        try {
          const withExtra = [...rows, { version, name: 'my own', checksum: 'a'.repeat(64) }].sort((a, b) => a.version.localeCompare(b.version));
          const service = await refused(
            new RegExp(`has 162 migration\\(s\\), and 1 of them neither v2\\.4\\.0 nor this release has: ${version} \\(my own\\)\\.`),
            withExtra
          );
          await expect(service.migrate()).rejects.toThrow(/roll them back with the build that has their files .* or restore a backup made before they were applied/);
          expect((await service.getStatus()).refusal).not.toMatch(/Upgrade to v2\.4\.0 first/);
          expect((await service.getStatus()).history).toBe('unknown');
        } finally {
          await pool.query('DELETE FROM schema_migrations WHERE version = $1', [version]);
        }
      }
    });

    it('refuses an edited v2.4.0 migration (a checksum that is not v2.4.0s), as before the squash', async () => {
      const edited = V2_4_0_MIGRATIONS[100]!;
      await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [edited.version, 'b'.repeat(64)]);
      try {
        const withEdit = rows.map((r) => (r.version === edited.version ? { ...r, checksum: 'b'.repeat(64) } : r));
        await refused(new RegExp(`Migration ${edited.version} \\(${edited.name}\\) has been modified!`), withEdit);
      } finally {
        await pool.query('UPDATE schema_migrations SET checksum = $2 WHERE version = $1', [edited.version, edited.checksum]);
      }
    });

    it('refuses to roll back before the cutover', async () => {
      await expect(runner(pool).rollback(1)).rejects.toThrow(/still has v2\.4\.0's 161 migrations: run migrate, which cuts it over to the baseline \(20261113000000\), first/);
      expect(await migrationRows(pool)).toEqual(rows);
    });

    it("refuses a cutover file that isn't the one the baseline's checksum names", async () => {
      const edited = path.join(scratch, 'from-v2.4.0.sql');
      writeFileSync(edited, `${readFileSync(V2_4_0_CUTOVER_PATH, 'utf8')}\nCOMMENT ON TABLE public.tags IS 'edited';\n`);
      await refused(/from-v2\.4\.0\.sql has been modified: its checksum is [0-9a-f]{64}, the baseline's [0-9a-f]{64}\./, rows, { cutoverPath: edited });
    });

    it('rolls a cutover that fails part-way back whole', async () => {
      // A column the cutover comments on, renamed: its COMMENT ON COLUMN fails, after the
      // extensions are dropped and the comments cleared.
      await pool.query('ALTER TABLE public.wash_sale_records RENAME COLUMN loss_shares TO loss_shares_renamed');
      try {
        const renamed = await schemaSnapshot(pool);
        const service = runner(pool);
        await expect(service.migrate()).rejects.toMatchObject({ code: '42703' });
        expect(service.failedMigration).toMatchObject({ version: BASELINE.version, filename: 'upgrade/from-v2.4.0.sql' });
        expect(await migrationRows(pool)).toEqual(rows);
        expect(await schemaSnapshot(pool)).toEqual(renamed);
        expect(await extensions(pool)).toEqual(['pg_trgm', 'plpgsql', 'uuid-ossp']);
      } finally {
        await pool.query('ALTER TABLE public.wash_sale_records RENAME COLUMN loss_shares_renamed TO loss_shares');
      }
      // As it was, it cuts over.
      expect(await schemaSnapshot(pool)).toEqual(schema);
      await runner(pool).migrate();
      expect(await migrationRows(pool)).toEqual(freshRows);
      expect(await schemaSnapshot(pool)).toEqual(fresh);
    }, 60_000);
  });

  it("refuses the baseline's row with a row older than it, and status says so too", async () => {
    const { pool } = await emptyDatabase();
    await runner(pool).migrate();
    const stray = V2_4_0_MIGRATIONS.at(-1)!;
    await pool.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [stray.version, stray.name, stray.checksum]);
    const service = runner(pool);
    const status = await service.getStatus();
    expect(status.history).toBe('mixed');
    expect(status.applied[0]).toMatchObject({ version: BASELINE.version });
    expect(status.refusal).toContain(`and 1 migration(s) older than it: ${stray.version} (${stray.name})`);
    await expect(service.migrate()).rejects.toThrow(status.refusal!);
    expect((await assertSchemaMigrated(pool, MIGRATIONS_DIR)).refusal).toBe(status.refusal);
    // /api/ready's query counts the stray row as pending (not ready), as it counts a missing baseline.
    const lifecycle = new ApplicationLifecycleService(pool, {} as ImportService, {} as BackupService, { migrationsDir: MIGRATIONS_DIR });
    const pending = (lifecycle as unknown as { pendingMigrationCount: () => Promise<number> }).pendingMigrationCount();
    await expect(pending).resolves.toBe(1);
    await pool.query('DELETE FROM schema_migrations WHERE version = $1', [stray.version]);
    await expect((lifecycle as unknown as { pendingMigrationCount: () => Promise<number> }).pendingMigrationCount()).resolves.toBe(0);
  }, 60_000);

  it('refuses a database with no history but objects in public, before loading anything, and status says the same', async () => {
    const cases: [string, (pool: Pool) => Promise<unknown>, RegExp][] = [
      // A Nuggets database whose schema_migrations was dropped, or emptied.
      ['schema_migrations dropped', async (pool) => { await runner(pool).migrate(); await pool.query('DROP TABLE schema_migrations'); }, /object\(s\), function public\.\w+\(/],
      ['schema_migrations emptied', async (pool) => { await runner(pool).migrate(); await pool.query('DELETE FROM schema_migrations'); }, /object\(s\), function public\.account_balances_as_of\(.* and \d+ more\./],
      ['a leftover table', (pool) => pool.query('CREATE TABLE public.someone_elses (id int)'), /1 object\(s\), table public\.someone_elses\./],
      ['a leftover view', (pool) => pool.query('CREATE VIEW public.a_view AS SELECT 1 AS one'), /1 object\(s\), view public\.a_view\./],
      // One the baseline would make, which the load would fail on.
      ['a leftover function', (pool) => pool.query(`CREATE FUNCTION public.app_today() RETURNS date LANGUAGE sql AS $$SELECT date '2026-01-01'$$`), /1 object\(s\), function public\.app_today\(\)\./],
    ];
    for (const [what, make, named] of cases) {
      const { pool } = await emptyDatabase();
      await make(pool);
      const before = await schemaSnapshot(pool);
      const service = runner(pool);
      const error = await service.migrate().then(() => null, (err: unknown) => err);
      expect(error, what).toBeInstanceOf(MigrationRefusal);
      expect((error as Error).message, what).toMatch(/^Database "nuggets_cutover_test_[0-9a-f]+" has no Nuggets migration history/);
      expect((error as Error).message, what).toMatch(named);
      expect(migrationFailedLine(error), what).toBe(`Migration refused (nothing was changed): ${(error as Error).message}`);
      expect(await schemaSnapshot(pool), what).toEqual(before);
      expect((await service.status()).refusal, what).toBe((error as Error).message);
    }
  }, 120_000);

  it('says what differs from a fresh baseline after a cutover, and cuts over all the same', async () => {
    const pool = await v240Database();
    // A v2.4.0 database whose schema went its own way.
    await pool.query(`ALTER TABLE public.tags ALTER COLUMN color SET DEFAULT '#000000'`);
    await pool.query('DROP INDEX public.idx_transactions_assigned_to');
    await pool.query('CREATE INDEX drift_probe_idx ON public.tags (name)');
    // Row security that lets any tenant's row in, and two money triggers that never fire.
    await pool.query('ALTER POLICY tags_tenant_isolation ON public.tags WITH CHECK (true)');
    await pool.query('ALTER TABLE public.transactions DISABLE TRIGGER trigger_transactions_splits_and_transfers_insert');
    await pool.query(`DO $$
      DECLARE def text;
      BEGIN
        SELECT pg_get_triggerdef(oid) INTO def FROM pg_trigger WHERE tgname = 'trigger_transactions_splits_and_transfers_delete';
        EXECUTE 'DROP TRIGGER trigger_transactions_splits_and_transfers_delete ON public.transactions';
        EXECUTE regexp_replace(def, 'WHEN \\(.*\\) EXECUTE', 'WHEN (false) EXECUTE');
      END $$`);
    await pool.query('ALTER TABLE public.tags NO FORCE ROW LEVEL SECURITY');
    // A view, a CHECK past its 63rd character, an index on another column under its name, a
    // unique index made plain, a column's type, an enum the baseline lacks.
    await pool.query(`CREATE OR REPLACE VIEW public.tags_with_hierarchy AS
      SELECT t.id, t.uuid, t.name, t.color, t.icon, t.description, t.parent_id, t.level, t.sort_order, t.is_active,
        t.is_report_root, t.report_flow_measure, t.created_at, t.updated_at,
        public.get_tag_hierarchy_path(t.id) AS hierarchy_path, p.name AS parent_name, p.uuid AS parent_uuid,
        (SELECT count(*) AS count FROM public.tags WHERE tags.parent_id = t.id) AS child_count,
        (SELECT count(*) AS count FROM public.taggings WHERE taggings.tag_id = t.id AND taggings.taggable_type::text = 'transaction'::text) AS transaction_count,
        (SELECT 0::bigint) AS budget_item_count,
        t.last_used_at
      FROM public.tags t LEFT JOIN public.tags p ON t.parent_id = p.id`);
    await pool.query(`ALTER TABLE public.securities DROP CONSTRAINT securities_security_type_check,
      ADD CONSTRAINT securities_security_type_check CHECK (security_type IN ('stock', 'etf', 'mutual_fund', 'bond', 'money_market', 'crypto'))`);
    await pool.query('DROP INDEX public.idx_merchants_transaction_auto_tag_id');
    await pool.query('CREATE INDEX idx_merchants_transaction_auto_tag_id ON public.merchants USING btree (name)');
    await pool.query('DROP INDEX public.uq_merchants_tenant_lower_name');
    await pool.query('CREATE INDEX uq_merchants_tenant_lower_name ON public.merchants USING btree (tenant_id, lower((name)::text))');
    await pool.query('ALTER TABLE public.annotations ALTER COLUMN body TYPE varchar(5000)');
    await pool.query(`CREATE TYPE public.drift_kind AS ENUM ('a', 'b')`);
    // The serving role's privileges: more on a table it may only read, less on one it uses.
    await pool.query('GRANT INSERT, UPDATE, DELETE ON public.deployment_users TO nuggets_app');
    await pool.query('REVOKE SELECT ON public.budget_items FROM nuggets_app');
    // Not drift: a varchar CHECK as a migration spells it (the baseline's is spelled as a dump
    // reloads it).
    await pool.query(`ALTER TABLE public.budget_period_transactions DROP CONSTRAINT budget_period_transactions_event_type_check,
      ADD CONSTRAINT budget_period_transactions_event_type_check CHECK (event_type IN ('budget_update', 'user_transfer', 'starting_balance'))`);
    expect(
      (await pool.query(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'budget_period_transactions_event_type_check'`)).rows[0].def
    ).toContain('::text[]');
    const service = runner(pool);
    await service.migrate();
    expect(await migrationRows(pool)).toEqual(freshRows);
    expect(service.cutoverDrift).toEqual({
      missing: ['index public.idx_transactions_assigned_to'],
      extra: ['index public.drift_probe_idx', 'type public.drift_kind'],
      changed: [
        'column public.annotations.body',
        'column public.tags.color',
        'constraint public.securities.securities_security_type_check',
        'index public.idx_merchants_transaction_auto_tag_id',
        'index public.uq_merchants_tenant_lower_name',
        'policy public.tags.tags_tenant_isolation',
        'privileges relation public.budget_items',
        'privileges relation public.deployment_users',
        'relation public.tags',
        'trigger public.transactions.trigger_transactions_splits_and_transfers_delete',
        'trigger public.transactions.trigger_transactions_splits_and_transfers_insert',
        'view public.tags_with_hierarchy',
      ],
    });
    // A database at the baseline already isn't compared again.
    const again = runner(pool);
    await again.migrate();
    expect(again.cutoverDrift).toBeNull();
  }, 60_000);

  it("gives up reading the fingerprint within seconds when a table's lock is held", async () => {
    const { pool } = await emptyDatabase();
    await runner(pool, { migrationsDir: noMigrations }).migrate();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE public.tags IN ACCESS EXCLUSIVE MODE');
      const started = Date.now();
      await expect(schemaFingerprint(pool)).rejects.toMatchObject({ code: expect.stringMatching(/^(55P03|57014)$/) });
      expect(Date.now() - started).toBeLessThan(12_000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  }, 60_000);

  describe('migrations newer than the baseline', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(path.join(scratch, 'm-'));
      writeFileSync(
        path.join(dir, '20261201000000_probe.sql'),
        'CREATE TABLE public.baseline_probe (id int);\n\n-- === DOWN ===\nDROP TABLE public.baseline_probe;\n'
      );
    });
    const probe = async (pool: Pool) => (await pool.query(`SELECT to_regclass('public.baseline_probe') IS NOT NULL AS present`)).rows[0].present;

    it('an empty database loads the baseline, then applies them; they roll back, the baseline does not', async () => {
      const { pool } = await emptyDatabase();
      const service = runner(pool, { migrationsDir: dir });
      expect(await service.getStatus()).toMatchObject({
        initialized: false,
        history: 'empty',
        applied: [],
        pending: [{ version: BASELINE.version, name: BASELINE.name }, { version: '20261201000000', name: 'probe' }],
      });

      await service.migrate();
      expect((await migrationRows(pool)).map((r) => r.version)).toEqual([BASELINE.version, '20261201000000']);
      expect(await probe(pool)).toBe(true);
      expect(await service.getStatus()).toMatchObject({
        history: 'baseline',
        applied: [{ version: BASELINE.version }, { version: '20261201000000' }],
        pending: [],
      });
      await expect(assertSchemaMigrated(pool, dir)).resolves.toEqual({ pending: [] });

      await service.rollback(1);
      expect(await probe(pool)).toBe(false);
      expect(await service.getStatus()).toMatchObject({ applied: [{ version: BASELINE.version }], pending: [{ version: '20261201000000' }] });
      await expect(service.rollback(1)).rejects.toThrow(/has no DOWN section/);
      await service.migrate();
      expect(await probe(pool)).toBe(true);
    }, 60_000);

    it('an empty database without a baseline to load is refused, not migrated from nothing', async () => {
      const { pool } = await emptyDatabase();
      await expect(new MigrationService(pool, { migrationsDir: dir }).migrate()).rejects.toThrow(
        /is empty, and this runner has no baseline schema to load into it/
      );
      expect((await pool.query(`SELECT count(*)::int AS n FROM pg_class WHERE relnamespace = 'public'::regnamespace`)).rows[0].n).toBe(0);
    });

    it('a v2.4.0 install is cut over and then applies them, in one run', async () => {
      const pool = await v240Database();
      await runner(pool, { migrationsDir: dir }).migrate();
      expect((await migrationRows(pool)).map((r) => r.version)).toEqual([BASELINE.version, '20261201000000']);
      expect(await probe(pool)).toBe(true);
      await pool.query('DROP TABLE public.baseline_probe');
      await pool.query(`DELETE FROM schema_migrations WHERE version = '20261201000000'`);
      expect(await schemaSnapshot(pool)).toEqual(freshAtBaseline);
    }, 60_000);
  });
});
