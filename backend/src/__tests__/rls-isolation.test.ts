import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

/**
 * Row-level security isolation proof.
 *
 * Proves the baseline's row-level security (init.sql) actually isolates tenants:
 * ENABLE + FORCE ROW LEVEL SECURITY on every tenant-scoped table, a
 * `<t>_tenant_isolation` policy keyed on the `app.current_tenant_id` GUC (USING +
 * WITH CHECK), the tenant_id DEFAULT flipped to that GUC, and the merchant-rule uuid
 * helper hardened to SECURITY INVOKER.
 *
 * Two pools, by design:
 *   - The default CI test role (test_user) is the DB owner / SUPERUSER, so it
 *     BYPASSES RLS. It is used ONLY to provision + seed fixtures and to verify setup.
 *   - Isolation is proven through a SECOND pool connecting as the unprivileged
 *     `nuggets_app` role (created NOLOGIN / NOSUPERUSER / NOBYPASSRLS by the
 *     baseline, init.sql) — the role RLS actually applies to.
 *     The GUC is supplied per-tenant via `options: '-c app.current_tenant_id=<id>'`
 *     on dedicated pools (the same mechanism the other RLS-aware tests use), plus a
 *     no-GUC pool to prove deny-by-default.
 *
 * Like the other DB integration tests this needs a migrated Postgres. CI's
 * test-backend job provides one (DATABASE_URL + DB_HOST/DB_PORT/DB_NAME/DB_USER/
 * DB_PASSWORD, the baseline and the migrations loaded). With no DB configured (local dev, no
 * secrets) the whole suite is skipped rather than failing to connect.
 */

// nuggets_app is a cluster-wide role that other test runs and the app share, so this suite
// never changes it: migrate grants it LOGIN with APP_DB_PASSWORD (as CI's migrate step does;
// see CLAUDE.md), and the suite logs in with that password.
const APP_DB_PASSWORD = process.env.APP_DB_PASSWORD;

// Connection target for the superuser provisioning pool. Prefer an explicit URL,
// fall back to assembling one from the DB_* envs CI also sets.
const superuserConnString =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  (process.env.DB_HOST
    ? `postgresql://${process.env.DB_USER || 'postgres'}:${
        process.env.DB_PASSWORD || ''
      }@${process.env.DB_HOST}:${process.env.DB_PORT || '5432'}/${
        process.env.DB_NAME || 'nuggets_db'
      }`
    : undefined);

// Skip the whole suite when no database is configured (e.g. local dev without
// secrets). In CI both DATABASE_URL and DB_* are set, so it runs.
const describeRls = superuserConnString ? describe : describe.skip;

// Derive host/port/database for the nuggets_app pool. DB_* envs win; otherwise
// parse them out of the connection string.
function deriveConnParts(): { host: string; port: number; database: string } {
  if (process.env.DB_HOST) {
    return {
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'nuggets_db',
    };
  }
  // superuserConnString is defined here (describeRls would have skipped otherwise).
  const u = new URL(superuserConnString as string);
  return {
    host: u.hostname,
    port: u.port ? parseInt(u.port, 10) : 5432,
    database: u.pathname.replace(/^\//, '') || 'nuggets_db',
  };
}

describeRls('RLS tenant isolation (Phase 3 cut-over)', () => {
  // Superuser pool: provisioning + setup verification ONLY (it bypasses RLS).
  let su: Pool;
  // nuggets_app pools — RLS applies. One scoped to tenant B's GUC, one with no GUC.
  let appB: Pool;
  let appNoCtx: Pool;

  // Resolved fixture ids/uuids.
  let tenantA: number;
  let tenantB: number;
  let orgA: number; // org created to host tenant A (cleaned up)
  let orgB: number; // org created to host tenant B (cleaned up)

  let merchantA: number;
  let merchantB: number;

  let tagAId: number;
  let tagBId: number;

  let ruleAId: number;
  let ruleAUuid: string;
  let ruleBId: number;
  let ruleBUuid: string;

  // Distinguishable marker so the seeded rows are easy to find + clean up and can't
  // collide with anything else in the shared CI database.
  const marker = `rls-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

  beforeAll(async () => {
    su = new Pool({ connectionString: superuserConnString });

    const login = await su.query<{ rolcanlogin: boolean }>(
      "SELECT rolcanlogin FROM pg_roles WHERE rolname = 'nuggets_app'"
    );
    if (!login.rows[0]?.rolcanlogin || !APP_DB_PASSWORD) {
      throw new Error(
        'nuggets_app needs its login: run migrate with APP_DB_PASSWORD set, then run the tests ' +
          'with the same APP_DB_PASSWORD (see CLAUDE.md).'
      );
    }

    // --- Tenant A: a fresh organization + tenant. ----------------------------
    const orgARes = await su.query<{ id: number }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [`${marker}-orgA`]
    );
    orgA = orgARes.rows[0].id;
    const aRes = await su.query<{ id: number }>(
      'INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id',
      [orgA, `${marker}-tenantA`]
    );
    tenantA = aRes.rows[0].id;

    // --- Tenant B: a fresh organization + tenant. ----------------------------
    const orgRes = await su.query<{ id: number }>(
      'INSERT INTO organizations (name) VALUES ($1) RETURNING id',
      [`${marker}-org`]
    );
    orgB = orgRes.rows[0].id;
    const bRes = await su.query<{ id: number }>(
      'INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id',
      [orgB, `${marker}-tenant`]
    );
    tenantB = bRes.rows[0].id;
    expect(tenantB).not.toBe(tenantA);

    // --- One distinguishable tag per tenant (explicit tenant_id). ------------
    // tags requires name + tenant_id; is_active/is_report_root/color/icon default.
    const tagA = await su.query<{ id: number }>(
      'INSERT INTO tags (tenant_id, name, color) VALUES ($1, $2, $3) RETURNING id',
      [tenantA, `${marker}-tagA`, '#111111']
    );
    tagAId = tagA.rows[0].id;

    const tagB = await su.query<{ id: number }>(
      'INSERT INTO tags (tenant_id, name, color) VALUES ($1, $2, $3) RETURNING id',
      [tenantB, `${marker}-tagB`, '#222222']
    );
    tagBId = tagB.rows[0].id;

    // --- A merchant per tenant, then a merchant_matching_rule per tenant. ----
    // merchants requires name + tenant_id. merchant_matching_rules requires
    // method + matching_text + tenant_id; merchant_id is a (per-tenant) FK.
    const merchA = await su.query<{ id: number }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [tenantA, `${marker}-merchantA`]
    );
    merchantA = merchA.rows[0].id;
    const merchB = await su.query<{ id: number }>(
      'INSERT INTO merchants (tenant_id, name) VALUES ($1, $2) RETURNING id',
      [tenantB, `${marker}-merchantB`]
    );
    merchantB = merchB.rows[0].id;

    const ruleA = await su.query<{ id: number; uuid: string }>(
      `INSERT INTO merchant_matching_rules (tenant_id, merchant_id, method, matching_text)
       VALUES ($1, $2, 'contains', $3) RETURNING id, uuid`,
      [tenantA, merchantA, `${marker}-ruleA`]
    );
    ruleAId = ruleA.rows[0].id;
    ruleAUuid = ruleA.rows[0].uuid;

    const ruleB = await su.query<{ id: number; uuid: string }>(
      `INSERT INTO merchant_matching_rules (tenant_id, merchant_id, method, matching_text)
       VALUES ($1, $2, 'contains', $3) RETURNING id, uuid`,
      [tenantB, merchantB, `${marker}-ruleB`]
    );
    ruleBId = ruleB.rows[0].id;
    ruleBUuid = ruleB.rows[0].uuid;

    // Sanity: the superuser (BYPASSRLS) sees BOTH tenants' seeded rows. This both
    // verifies the fixtures landed and demonstrates that the isolation observed
    // below is RLS — not a missing row.
    const bypassTags = await su.query(
      'SELECT tenant_id FROM tags WHERE id = ANY($1) ORDER BY tenant_id',
      [[tagAId, tagBId]]
    );
    expect(bypassTags.rows.length).toBe(2);

    // --- Open the nuggets_app pools. ----------------------------------------
    // Guard the premise of the whole suite: the role must NOT bypass RLS,
    // otherwise these tests would pass vacuously.
    const roleRes = await su.query<{ rolbypassrls: boolean; rolsuper: boolean }>(
      'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
      ['nuggets_app']
    );
    expect(roleRes.rows[0]?.rolbypassrls).toBe(false);
    expect(roleRes.rows[0]?.rolsuper).toBe(false);

    const { host, port, database } = deriveConnParts();
    appB = new Pool({
      host,
      port,
      database,
      user: 'nuggets_app',
      password: APP_DB_PASSWORD,
      // Stamp tenant B's GUC on every connection this pool hands out.
      options: `-c app.current_tenant_id=${tenantB}`,
    });
    appNoCtx = new Pool({
      host,
      port,
      database,
      user: 'nuggets_app',
      password: APP_DB_PASSWORD,
      // Deliberately NO app.current_tenant_id → deny-by-default.
    });
  });

  afterAll(async () => {
    // Tear down nuggets_app pools first (they hold connections as that role).
    if (appB) await appB.end();
    if (appNoCtx) await appNoCtx.end();

    if (su) {
      // Best-effort cleanup of all seeded rows + both tenants (+ their orgs),
      // via the superuser pool (bypasses RLS so it can reach both tenants' rows).
      try {
        // By tenant rather than by seeded id, so rows a failing test leaked still go.
        const tenants = [tenantA, tenantB].filter((v) => v != null);
        await su.query('DELETE FROM merchant_matching_rules WHERE tenant_id = ANY($1)', [tenants]);
        await su.query('DELETE FROM merchants WHERE tenant_id = ANY($1)', [tenants]);
        await su.query('DELETE FROM tags WHERE tenant_id = ANY($1)', [tenants]);
        await su.query('DELETE FROM tenants WHERE id = ANY($1)', [tenants]);
        await su.query('DELETE FROM organizations WHERE id = ANY($1)', [
          [orgA, orgB].filter((v) => v != null),
        ]);
      } finally {
        await su.end();
      }
    }
  });

  it('SELECT is scoped to the GUC tenant: B sees only B, never A (tags + merchant_matching_rules)', async () => {
    const tags = await appB.query<{ id: number; tenant_id: number }>(
      'SELECT id, tenant_id FROM tags'
    );
    const tagTenants = new Set(tags.rows.map((r) => r.tenant_id));
    // Every visible row belongs to B; none belongs to A.
    expect(tagTenants.has(tenantA)).toBe(false);
    if (tagTenants.size > 0) expect([...tagTenants]).toEqual([tenantB]);
    const tagIds = tags.rows.map((r) => r.id);
    expect(tagIds).toContain(tagBId);
    expect(tagIds).not.toContain(tagAId);

    const rules = await appB.query<{ id: number; tenant_id: number }>(
      'SELECT id, tenant_id FROM merchant_matching_rules'
    );
    const ruleTenants = new Set(rules.rows.map((r) => r.tenant_id));
    expect(ruleTenants.has(tenantA)).toBe(false);
    if (ruleTenants.size > 0) expect([...ruleTenants]).toEqual([tenantB]);
    const ruleIds = rules.rows.map((r) => r.id);
    expect(ruleIds).toContain(ruleBId);
    expect(ruleIds).not.toContain(ruleAId);
  });

  it("UPDATE/DELETE of another tenant's row affect 0 rows; INSERT for another tenant is rejected (WITH CHECK)", async () => {
    // A's tag is invisible to B, so UPDATE matches nothing.
    const upd = await appB.query(
      'UPDATE tags SET name = $1 WHERE id = $2',
      [`${marker}-hijack`, tagAId]
    );
    expect(upd.rowCount).toBe(0);

    // Same for DELETE.
    const del = await appB.query('DELETE FROM tags WHERE id = $1', [tagAId]);
    expect(del.rowCount).toBe(0);

    // Inserting a row stamped for tenant A while in B's context violates the
    // policy's WITH CHECK and must throw.
    await expect(
      appB.query(
        'INSERT INTO tags (tenant_id, name) VALUES ($1, $2)',
        [tenantA, `${marker}-cross-insert`]
      )
    ).rejects.toThrow();

    // A's row is still intact + still A's (verified with the bypassing superuser).
    const still = await su.query<{ tenant_id: number; name: string }>(
      'SELECT tenant_id, name FROM tags WHERE id = $1',
      [tagAId]
    );
    expect(still.rows.length).toBe(1);
    expect(still.rows[0].tenant_id).toBe(tenantA);
    expect(still.rows[0].name).toBe(`${marker}-tagA`);

    // And no cross-tenant tag leaked into A under B's marker.
    const leaked = await su.query(
      'SELECT id FROM tags WHERE tenant_id = $1 AND name = $2',
      [tenantA, `${marker}-cross-insert`]
    );
    expect(leaked.rows.length).toBe(0);
  });

  it('get_merchant_rule_id_by_uuid is SECURITY INVOKER: resolves own tenant, NULL across tenants', async () => {
    // B's own rule uuid resolves to its id under B's context.
    const own = await appB.query<{ id: number | null }>(
      'SELECT get_merchant_rule_id_by_uuid($1) AS id',
      [ruleBUuid]
    );
    expect(own.rows[0].id).toBe(ruleBId);

    // A's rule uuid is NOT resolvable from B's context — the function now runs as
    // the caller (INVOKER), so RLS hides A's row and it returns NULL. Under the old
    // SECURITY DEFINER this would have leaked A's id.
    const cross = await appB.query<{ id: number | null }>(
      'SELECT get_merchant_rule_id_by_uuid($1) AS id',
      [ruleAUuid]
    );
    expect(cross.rows[0].id).toBeNull();
  });

  it('refuses tenant tables with no app.current_tenant_id, the same way on a fresh or a reused connection', async () => {
    const noTenant = /no tenant is set for this query/;
    await expect(appNoCtx.query('SELECT * FROM tags')).rejects.toThrow(noTenant);
    await expect(appNoCtx.query('SELECT * FROM merchant_matching_rules')).rejects.toThrow(noTenant);

    // After a tenant transaction the setting is '' rather than unset; that used to fail
    // differently ("invalid input syntax for type integer") from a fresh connection (0 rows).
    const client = await appNoCtx.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [String(tenantB)]);
      await client.query('SELECT 1 FROM tags LIMIT 1');
      await client.query('COMMIT');
      expect((await client.query(`SELECT current_setting('app.current_tenant_id', true) AS v`)).rows[0].v).toBe('');
      await expect(client.query('SELECT * FROM tags')).rejects.toThrow(noTenant);
      // An insert needs the tenant for its tenant_id default.
      await expect(client.query(`INSERT INTO tags (name) VALUES ('no-tenant-probe')`)).rejects.toThrow(noTenant);
      // Every stored image is a tenant's now, refused like any tenant table.
      await expect(client.query('SELECT count(*) FROM stored_images')).rejects.toThrow(noTenant);
    } finally {
      client.release();
    }
  });
});
