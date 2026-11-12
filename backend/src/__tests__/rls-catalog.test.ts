import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { SERVING_ROLE_DEFINER_FUNCTIONS } from '../db/servingRoleGrants.js';

/**
 * Tenant isolation rests entirely on Postgres RLS, so pin the schema-wide facts it
 * depends on. `rls-isolation.test.ts` proves the policies behave for a couple of tables;
 * this proves every tenant table is covered, so a new tenant table without a policy — or a
 * looser extra policy, a view, rule or SECURITY DEFINER function that sidesteps one (but
 * the tracked ones below) — fails CI. A foreign key is checked outside RLS, so it also requires every foreign key
 * between tenant tables to include tenant_id, which keeps a reference inside its ledger
 * (tenantReferences.db.test.ts shows the database refusing one that isn't).
 *
 * Also asserts that the app's serving role is one RLS applies to. CI runs every
 * integration test that way (DB_USER=nuggets_app); against a superuser or BYPASSRLS role
 * RLS is silently off.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

// Tables that carry tenant_id but are looked up before a tenant is chosen, so they are
// isolated in application code instead (membership and token checks).
const CONTROL_PLANE_TABLES = ['personal_access_tokens', 'tenant_users'];

// The one row filter a tenant table's permissive policies may use (pg_policies' rendering).
// Permissive policies are OR'ed together, so any extra or looser one — `USING (true)`,
// `tenant_id = … OR …` — opens the table to every tenant.
const TENANT_PREDICATE = '(tenant_id = current_tenant_id())';

// Policies known to deviate from TENANT_PREDICATE. Each is a tracked bug; when it's fixed
// the policy no longer matches its entry here and this test fails until the entry goes.
// (stored_images was one until profile pictures moved to user_profile_images.)
const KNOWN_POLICY_EXCEPTIONS: Record<string, string> = {};

// Views that are known to run with their owner's rights and so bypass RLS. Each entry is
// a tracked bug; remove it when the view is fixed (this list must match exactly).
const KNOWN_RLS_BYPASSING_VIEWS: string[] = [];

// SECURITY DEFINER functions run as their owner, outside RLS. These are the only ones, each
// reviewed: they let the serving role change or lock deployment_users, which it may
// only read, by user id, and touch no tenant table. Each pins its search_path and names its
// tables with their schema, and only the serving role may run it. This list must match
// exactly, and db/servingRoleGrants.ts must list them too (a restore re-applies grants from it).
const TRACKED_SECURITY_DEFINER_FUNCTIONS = [
  'public.grant_deployment_admin(integer,integer)',
  'public.lock_deployment_admin(integer)',
  'public.lock_deployment_users_of(integer,integer)',
  'public.revoke_deployment_admin(integer)',
];

const TENANT_TABLES_SQL = `
  SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     AND c.relname <> ALL($1)`;

describeDb('RLS catalog coverage', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('runs the app as a role that RLS applies to', async () => {
    const role = process.env.DB_USER || 'postgres';
    const res = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      [role]
    );
    expect(res.rows, `DB_USER role "${role}" does not exist`).toHaveLength(1);
    expect(
      res.rows[0],
      `DB_USER "${role}" bypasses RLS, so these tests can't prove tenant isolation. ` +
        'Run them with DB_USER=nuggets_app and APP_DB_PASSWORD set, as CI does.'
    ).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it('forces RLS with a tenant policy on every table that has tenant_id', async () => {
    const res = await pool.query<{ table: string }>(
      `WITH t AS (${TENANT_TABLES_SQL})
       SELECT t.relname AS table
         FROM t JOIN pg_class c ON c.oid = t.oid
        WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
                SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = t.relname AND p.permissive = 'PERMISSIVE'))
        ORDER BY 1`,
      [CONTROL_PLANE_TABLES]
    );
    expect(res.rows.map((r) => r.table)).toEqual([]);
  });

  it("stamps every tenant table's rows with the current tenant, which fails when none is set", async () => {
    // current_tenant_id() raises with no tenant, so an insert outside a tenant fails
    // loudly instead of writing a NULL or failing on a cast, or making a row no
    // tenant owns.
    const res = await pool.query<{ table: string; default: string | null; not_null: boolean }>(
      `WITH t AS (${TENANT_TABLES_SQL})
       SELECT t.relname AS table, pg_get_expr(d.adbin, d.adrelid) AS default, a.attnotnull AS not_null
         FROM t
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'tenant_id'
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM 'current_tenant_id()' OR NOT a.attnotnull
        ORDER BY 1`,
      [CONTROL_PLANE_TABLES]
    );
    expect(res.rows).toEqual([]);
  });

  it('keeps every foreign key between tenant tables inside one tenant', async () => {
    // The database checks a foreign key outside RLS, so a key on (id) alone lets a row of
    // one ledger point at another ledger's row. Each must be (tenant_id, col)
    // REFERENCES parent (tenant_id, id); tenants' own reference to its balance-adjustment
    // merchant is (id, col) REFERENCES merchants (tenant_id, id).
    const res = await pool.query<{ fk: string }>(
      `WITH tenant_tables AS (
         SELECT c.oid FROM pg_class c
          WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
            AND EXISTS (SELECT 1 FROM pg_attribute a
                         WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
       )
       SELECT c.conrelid::regclass || '.' || c.conname || ': ' || pg_get_constraintdef(c.oid) AS fk
         FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.connamespace = 'public'::regnamespace
          AND c.confrelid IN (SELECT oid FROM tenant_tables)
          AND (c.conrelid IN (SELECT oid FROM tenant_tables) OR c.conrelid = 'public.tenants'::regclass)
          AND NOT (
            cardinality(c.conkey) = 2
            AND (SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = c.confkey[1]) = 'tenant_id'
            AND (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1])
                = CASE WHEN c.conrelid = 'public.tenants'::regclass THEN 'id' ELSE 'tenant_id' END
          )
        ORDER BY 1`
    );
    expect(res.rows.map((r) => r.fk)).toEqual([]);
    // And there are such keys to check: the query above isn't vacuously empty.
    const composite = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND cardinality(conkey) = 2
          AND (SELECT attname FROM pg_attribute WHERE attrelid = confrelid AND attnum = confkey[1]) = 'tenant_id'`
    );
    expect(composite.rows[0].n).toBeGreaterThan(70);
  });

  it('lets every permissive policy on a tenant table match only the current tenant', async () => {
    const res = await pool.query<{
      table: string;
      policy: string;
      roles: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `WITH t AS (${TENANT_TABLES_SQL})
       SELECT p.tablename AS table, p.policyname AS policy, p.roles::text AS roles, p.cmd, p.qual, p.with_check
         FROM pg_policies p JOIN t ON t.relname = p.tablename
        WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
        ORDER BY 1, 2`,
      [CONTROL_PLANE_TABLES]
    );
    expect(res.rows.length).toBeGreaterThan(0);
    const wrong = res.rows
      .filter((p) => {
        const expected = KNOWN_POLICY_EXCEPTIONS[p.table] ?? TENANT_PREDICATE;
        return p.roles !== '{public}' || p.cmd !== 'ALL' || p.qual !== expected || p.with_check !== expected;
      })
      .map((p) => `${p.table}.${p.policy}: ${p.cmd} to ${p.roles} USING ${p.qual} WITH CHECK ${p.with_check}`);
    expect(wrong).toEqual([]);
  });

  it('has no SECURITY DEFINER functions but the tracked ones, which would run queries outside RLS', async () => {
    const res = await pool.query<{ fn: string }>(
      `SELECT n.nspname || '.' || p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS fn
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosecdef
        ORDER BY 1`
    );
    expect(res.rows.map((r) => r.fn.replace(/, /g, ','))).toEqual(TRACKED_SECURITY_DEFINER_FUNCTIONS);
    expect([...SERVING_ROLE_DEFINER_FUNCTIONS].map((fn) => `public.${fn}`)).toEqual(TRACKED_SECURITY_DEFINER_FUNCTIONS);
  });

  it('lets only the serving role run them, with a pinned search_path, and touches no tenant table in them', async () => {
    const role = process.env.DB_USER || 'nuggets_app';
    const res = await pool.query<{
      fn: string;
      config: string[] | null;
      owner_is_app: boolean;
      runners: string[];
      body: string;
    }>(
      `SELECT p.proname || '(' || oidvectortypes(p.proargtypes) || ')' AS fn, p.proconfig AS config,
              pg_has_role($1, p.proowner, 'MEMBER') AS owner_is_app,
              ARRAY(SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END
                      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                     WHERE a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
                     ORDER BY 1) AS runners,
              p.prosrc AS body
         FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        ORDER BY 1`,
      [role]
    );
    expect(res.rows.length).toBe(TRACKED_SECURITY_DEFINER_FUNCTIONS.length);
    const tenantTables = (await pool.query<{ relname: string }>(TENANT_TABLES_SQL, [[]])).rows.map((r) => r.relname);
    for (const f of res.rows) {
      expect({ fn: f.fn, config: f.config, ownerIsApp: f.owner_is_app, runners: f.runners }).toEqual({
        fn: f.fn,
        config: ['search_path=pg_catalog, public'],
        ownerIsApp: false,
        runners: [role],
      });
      // pg_temp is searched first for a table named without its schema, and the serving role
      // can create temporary tables: every table in the body is public.<name>.
      const tables = [...f.body.matchAll(/\b(?:FROM|JOIN|INSERT\s+INTO|UPDATE)\s+(?!SET\b)([a-z_.]+)/gi)].map((m) => m[1]);
      expect(tables.length, f.fn).toBeGreaterThan(0);
      expect(tables.filter((t) => !t.startsWith('public.')), f.fn).toEqual([]);
      expect(tables.filter((t) => tenantTables.includes(t.slice('public.'.length))), f.fn).toEqual([]);
    }
  });

  it("has no rules on tables, whose actions run with the owner's rights and so outside RLS", async () => {
    // pg_rules leaves out the _RETURN rules that implement views (checked below).
    const res = await pool.query<{ rule: string }>(
      `SELECT schemaname || '.' || tablename || '.' || rulename AS rule
         FROM pg_rules
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY 1`
    );
    expect(res.rows.map((r) => r.rule)).toEqual([]);
  });

  it('applies RLS inside every view (security_invoker)', async () => {
    const res = await pool.query<{ view: string }>(
      `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS view
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND c.relkind IN ('v', 'm')
          AND NOT COALESCE('security_invoker=true' = ANY(c.reloptions)
                        OR 'security_invoker=on' = ANY(c.reloptions), false)
        ORDER BY 1`
    );
    expect(res.rows.map((r) => r.view)).toEqual(KNOWN_RLS_BYPASSING_VIEWS);
  });
});

// ---------------------------------------------------------------------------------------
// Organization tables: an organization's own data (its SimpleFin connection, its price-sync
// settings and runs) has RLS one level up from a ledger's, keyed on app.current_organization_id.
// The same facts, pinned for every public table with
// organization_id, so a new one without the policy fails CI.

// Tables with organization_id that are read before any organization is chosen, so they are
// isolated in application code instead: the membership tables (sign-in, accepting an
// invitation) and tenants, the ledger registry (resolving a request's ledger, and withTenant
// itself, which reads a ledger's organization there). This list must match exactly.
const ORGANIZATION_CONTROL_PLANE_TABLES = ['organization_invitations', 'organization_users', 'tenants'];

const ORGANIZATION_PREDICATE = '(organization_id = current_organization_id())';

// Foreign keys from outside the organization tables into one. A ledger table's reference
// can't carry organization_id, so each is guarded by the trigger named here, which checks
// the row it names is the ledger's organization's (and runs under the policy).
const TRACKED_REFERENCES_INTO_ORGANIZATION_TABLES: Record<string, string> = {
  'accounts.accounts_simplefin_connection_id_fkey': 'trigger_check_account_simplefin_connection',
};

const ORGANIZATION_TABLES_SQL = `
  SELECT c.oid, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid AND a.attname = 'organization_id' AND NOT a.attisdropped)
     AND c.relname <> ALL($1)`;

describeDb('RLS catalog coverage: organization tables', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('covers the organization tables, and leaves out only the listed control-plane ones', async () => {
    const all = await pool.query<{ relname: string; rls: boolean }>(
      `SELECT t.relname, c.relrowsecurity AS rls FROM (${ORGANIZATION_TABLES_SQL}) t JOIN pg_class c ON c.oid = t.oid ORDER BY 1`,
      [[]]
    );
    const controlPlane = all.rows.filter((r) => ORGANIZATION_CONTROL_PLANE_TABLES.includes(r.relname));
    // Each listed table exists and has no RLS: an entry that went stale fails here.
    expect(controlPlane).toEqual(ORGANIZATION_CONTROL_PLANE_TABLES.map((relname) => ({ relname, rls: false })));
    expect(all.rows.map((r) => r.relname).filter((t) => !ORGANIZATION_CONTROL_PLANE_TABLES.includes(t))).toEqual([
      'organization_price_sync_runs',
      'organization_price_sync_settings',
      'organization_simplefin_connections',
    ]);
  });

  it('forces RLS with an organization policy on every table that has organization_id', async () => {
    const res = await pool.query<{ table: string }>(
      `WITH t AS (${ORGANIZATION_TABLES_SQL})
       SELECT t.relname AS table
         FROM t JOIN pg_class c ON c.oid = t.oid
        WHERE NOT (c.relrowsecurity AND c.relforcerowsecurity AND EXISTS (
                SELECT 1 FROM pg_policies p
                 WHERE p.schemaname = 'public' AND p.tablename = t.relname AND p.permissive = 'PERMISSIVE'))
        ORDER BY 1`,
      [ORGANIZATION_CONTROL_PLANE_TABLES]
    );
    expect(res.rows.map((r) => r.table)).toEqual([]);
  });

  it("stamps every organization table's rows with the current organization, which fails when none is set", async () => {
    const res = await pool.query<{ table: string; default: string | null; not_null: boolean }>(
      `WITH t AS (${ORGANIZATION_TABLES_SQL})
       SELECT t.relname AS table, pg_get_expr(d.adbin, d.adrelid) AS default, a.attnotnull AS not_null
         FROM t
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attname = 'organization_id'
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE pg_get_expr(d.adbin, d.adrelid) IS DISTINCT FROM 'current_organization_id()' OR NOT a.attnotnull
        ORDER BY 1`,
      [ORGANIZATION_CONTROL_PLANE_TABLES]
    );
    expect(res.rows).toEqual([]);
  });

  it('lets every permissive policy on an organization table match only the current organization', async () => {
    const res = await pool.query<{
      table: string;
      policy: string;
      roles: string;
      cmd: string;
      qual: string | null;
      with_check: string | null;
    }>(
      `WITH t AS (${ORGANIZATION_TABLES_SQL})
       SELECT p.tablename AS table, p.policyname AS policy, p.roles::text AS roles, p.cmd, p.qual, p.with_check
         FROM pg_policies p JOIN t ON t.relname = p.tablename
        WHERE p.schemaname = 'public' AND p.permissive = 'PERMISSIVE'
        ORDER BY 1, 2`,
      [ORGANIZATION_CONTROL_PLANE_TABLES]
    );
    expect(res.rows.length).toBeGreaterThan(0);
    const wrong = res.rows
      .filter(
        (p) =>
          p.roles !== '{public}' || p.cmd !== 'ALL' || p.qual !== ORGANIZATION_PREDICATE || p.with_check !== ORGANIZATION_PREDICATE
      )
      .map((p) => `${p.table}.${p.policy}: ${p.cmd} to ${p.roles} USING ${p.qual} WITH CHECK ${p.with_check}`);
    expect(wrong).toEqual([]);
  });

  it("defines current_organization_id() as current_tenant_id() is defined, and it raises when no organization is set", async () => {
    const res = await pool.query<{ fn: string; props: Record<string, unknown> }>(
      `SELECT p.proname AS fn,
              jsonb_build_object('language', l.lanname, 'volatility', p.provolatile, 'parallel', p.proparallel,
                                 'leakproof', p.proleakproof, 'securityDefiner', p.prosecdef, 'strict', p.proisstrict,
                                 'returns', format_type(p.prorettype, NULL), 'args', p.pronargs,
                                 'config', p.proconfig, 'acl', p.proacl::text) AS props
         FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('current_tenant_id', 'current_organization_id', 'tenant_context_missing', 'organization_context_missing')`
    );
    const props = Object.fromEntries(res.rows.map((r) => [r.fn, r.props]));
    expect(props.current_organization_id).toBeDefined();
    expect(props.current_organization_id).toEqual(props.current_tenant_id);
    expect(props.organization_context_missing).toEqual(props.tenant_context_missing);

    // Unset, and empty (what a pooled connection that ran an organization transaction reads).
    const client = await pool.connect();
    try {
      for (const value of [null, '']) {
        await client.query('BEGIN');
        try {
          if (value !== null) await client.query(`SELECT set_config('app.current_organization_id', $1, true)`, [value]);
          await expect(client.query('SELECT current_organization_id()')).rejects.toThrow(
            'no organization is set for this query (app.current_organization_id)'
          );
        } finally {
          await client.query('ROLLBACK');
        }
      }
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.current_organization_id', '42', true)`);
        expect((await client.query('SELECT current_organization_id() AS id')).rows[0].id).toBe(42);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  it('gives every organization table its uuid: NOT NULL DEFAULT uuidv7(), unique as <table>_uuid_key', async () => {
    const res = await pool.query<{ table: string }>(
      `WITH t AS (${ORGANIZATION_TABLES_SQL})
       SELECT t.relname AS table
         FROM t
        WHERE NOT EXISTS (
                SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                 WHERE a.attrelid = t.oid AND a.attname = 'uuid' AND a.attnotnull
                   AND pg_get_expr(d.adbin, d.adrelid) = 'uuidv7()')
           OR NOT EXISTS (
                SELECT 1 FROM pg_constraint k
                 WHERE k.conrelid = t.oid AND k.contype = 'u' AND k.conname = t.relname || '_uuid_key'
                   AND k.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'uuid')])
        ORDER BY 1`,
      [ORGANIZATION_CONTROL_PLANE_TABLES]
    );
    expect(res.rows.map((r) => r.table)).toEqual([]);
  });

  it('keeps every foreign key between organization tables inside one organization, and tracks those from other tables', async () => {
    // A foreign key is checked outside RLS, as for the ledger tables: one between two
    // organization tables must be (organization_id, col) REFERENCES parent (organization_id, id).
    const res = await pool.query<{ fk: string; from_org_table: boolean; composite: boolean; guard: string | null }>(
      `WITH org_tables AS (${ORGANIZATION_TABLES_SQL})
       SELECT c.conrelid::regclass::text || '.' || c.conname AS fk,
              c.conrelid IN (SELECT oid FROM org_tables) AS from_org_table,
              (cardinality(c.conkey) = 2
               AND (SELECT attname FROM pg_attribute WHERE attrelid = c.confrelid AND attnum = c.confkey[1]) = 'organization_id'
               AND (SELECT attname FROM pg_attribute WHERE attrelid = c.conrelid AND attnum = c.conkey[1]) = 'organization_id')
                AS composite,
              (SELECT tg.tgname FROM pg_trigger tg
                WHERE tg.tgrelid = c.conrelid AND NOT tg.tgisinternal
                  AND tg.tgattr::int2[] @> ARRAY(SELECT unnest(c.conkey))::int2[]
                ORDER BY 1 LIMIT 1) AS guard
         FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
          AND c.confrelid IN (SELECT oid FROM org_tables)
        ORDER BY 1`,
      [ORGANIZATION_CONTROL_PLANE_TABLES]
    );
    expect(res.rows.filter((r) => r.from_org_table && !r.composite).map((r) => r.fk)).toEqual([]);
    expect(Object.fromEntries(res.rows.filter((r) => !r.from_org_table).map((r) => [r.fk, r.guard]))).toEqual(
      TRACKED_REFERENCES_INTO_ORGANIZATION_TABLES
    );
  });
});
