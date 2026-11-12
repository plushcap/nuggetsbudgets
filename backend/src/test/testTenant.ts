import { Pool, type PoolClient } from 'pg';
import type { RequestHandler } from 'express';
import { testTenantContext } from './tenantContext.js';
import { shareSchemaChangeLockInTransaction, withSchemaChangeLockShared } from './schemaLock.js';
import { initializeSecrets } from '../utils/docker-secrets.js';
import { servingRolePassword } from '../db/servingRole.js';

/**
 * A fresh organization + tenant (ledger) + member user for one integration test file.
 *
 * Test files run in parallel against one database. Files that share a tenant see each
 * other's rows, so any assertion over tenant-wide data (reports, totals, "rebuild is
 * idempotent") flakes depending on what else is running. Give every DB-backed file its
 * own tenant from here instead of the seeded tenant 1.
 *
 * `pool` is for seeding and inspecting fixtures only. It connects as the app's own role
 * (the same settings and secrets db.ts uses; CI runs it as the RLS-enforced nuggets_app)
 * with `app.current_tenant_id` set to this tenant on every connection, so fixture INSERTs
 * land in this tenant via the tenant_id column default, and reads and deletes are scoped
 * by RLS. `app.current_organization_id` is set to the tenant's organization, as withTenant
 * sets it, so the organization tables (its SimpleFin connection, price-sync settings and
 * runs) read and write that organization's rows. Hand the code under test the app's own pool (db.ts's default export), as
 * production does — never `pool`: its session-wide tenant setting would hide a query that
 * runs outside `tenantHandler`/`withTenant`.
 *
 * Refuses to run when the app's role bypasses RLS (a superuser or BYPASSRLS role): RLS is
 * what keeps each file inside its own tenant, so without it tenant-wide fixture queries
 * and endpoints would reach every tenant's rows.
 */
export interface TestTenant {
  tenantId: number;
  organizationId: number;
  userId: number;
  userEmail: string;
  pool: Pool;
  /** Stand-in for authenticateToken + the tenant middleware, signed in as this tenant's user. */
  context(opts?: { deploymentAdmin?: boolean }): RequestHandler;
  /** Delete everything in the tenant, then the tenant, organization and user, and close `pool`. */
  cleanup(): Promise<void>;
}

// A delete blocked by a reference: foreign_key_violation, or restrict_violation for ON DELETE RESTRICT.
const REFERENCED = new Set(['23503', '23001']);

function fixtureConnectionString(): string {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Integration tests need TEST_DATABASE_URL or DATABASE_URL (the schema-owner connection used for fixtures).'
    );
  }
  return url;
}

async function assertAppRoleUsesRls(owner: Pool, role: string): Promise<void> {
  const res = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
    [role]
  );
  const row = res.rows[0];
  if (!row || row.rolsuper || row.rolbypassrls) {
    throw new Error(
      `DB_USER "${role}" ${row ? 'bypasses RLS' : 'does not exist'}, so test files can't be kept inside their own ` +
        'tenant. Run DB-backed tests with DB_USER=nuggets_app and APP_DB_PASSWORD set, as CI does (see CLAUDE.md).'
    );
  }
}

let tenantTables: Promise<string[]> | undefined;

/** Every base table with a tenant_id column, except the tenant_users membership table. */
function listTenantTables(owner: Pool | PoolClient): Promise<string[]> {
  tenantTables ??= owner
    .query<{ table_name: string }>(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
          AND t.table_type = 'BASE TABLE' AND c.table_name <> 'tenant_users'`
    )
    .then((r) => r.rows.map((row) => row.table_name))
    .catch((err) => {
      tenantTables = undefined;
      throw err;
    });
  return tenantTables;
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Delete every row of `tenantId` from every tenant table, on `client`. Tables reference
 * each other, so delete in passes: a table blocked by a foreign key is retried after the
 * tables that reference it have been emptied. Leaves the tenant set on `client`.
 */
async function purgeTenant(client: PoolClient, tenantId: number): Promise<void> {
  const tables = await listTenantTables(client);
  // Tenant tables FORCE RLS, so a schema owner that isn't a superuser only sees the
  // current tenant's rows: set this tenant on the connection so it can delete them.
  await client.query(`SELECT set_config('app.current_tenant_id', $1, false)`, [String(tenantId)]);
  let remaining = tables;
  while (remaining.length > 0) {
    const blocked: string[] = [];
    for (const table of remaining) {
      try {
        await client.query(`DELETE FROM ${quoteIdent(table)} WHERE tenant_id = $1`, [tenantId]);
      } catch (err) {
        if (!REFERENCED.has((err as { code?: string }).code ?? '')) throw err;
        blocked.push(table);
      }
    }
    if (blocked.length === remaining.length) {
      throw new Error(`Could not purge test tenant ${tenantId}; still referenced: ${blocked.join(', ')}`);
    }
    remaining = blocked;
  }
}

export async function createTestTenant(label: string): Promise<TestTenant> {
  const connectionString = fixtureConnectionString();
  const secrets = initializeSecrets();
  const appRole = process.env.DB_USER || 'postgres';
  const owner = new Pool({ connectionString, max: 2 });
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  let tenantId: number;
  let organizationId: number;
  let userId: number;
  const userEmail = `${slug}-${stamp}@test.local`;
  try {
    await assertAppRoleUsesRls(owner, appRole);
    // One transaction, so a failure part-way leaves nothing behind.
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      // Not while a migration test changes the schema (test/schemaLock.ts).
      await shareSchemaChangeLockInTransaction(client);
      organizationId = (
        await client.query<{ id: number }>('INSERT INTO organizations (name) VALUES ($1) RETURNING id', [
          `${label} org ${stamp}`,
        ])
      ).rows[0].id;
      tenantId = (
        await client.query<{ id: number }>('INSERT INTO tenants (organization_id, name) VALUES ($1, $2) RETURNING id', [
          organizationId,
          `${label} ${stamp}`,
        ])
      ).rows[0].id;
      userId = (
        await client.query<{ id: number }>(
          `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id`,
          [userEmail, label]
        )
      ).rows[0].id;
      await client.query('INSERT INTO tenant_users (tenant_id, user_id) VALUES ($1, $2)', [tenantId, userId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    await owner.end();
    throw err;
  }

  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'nuggets_db',
    user: appRole,
    password: servingRolePassword(secrets),
    options: `-c app.current_tenant_id=${tenantId} -c app.current_organization_id=${organizationId}`,
  });

  return {
    tenantId,
    organizationId,
    userId,
    userEmail,
    pool,
    context: (contextOpts = {}) =>
      testTenantContext({ userId, tenantId, isAdmin: contextOpts.deploymentAdmin }),
    async cleanup() {
      try {
        await pool.end();
        // On one connection, which holds the schema-change lock shared throughout: deleting
        // the tenant and the user locks them and then the tables that refer to them, which a
        // migration test's DDL locks the other way round (test/schemaLock.ts).
        const client = await owner.connect();
        try {
          await withSchemaChangeLockShared(client, async () => {
            await purgeTenant(client, tenantId);
            await client.query('DELETE FROM tenant_users WHERE tenant_id = $1', [tenantId]);
            await client.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
            await client.query('DELETE FROM organizations WHERE id = $1', [organizationId]);
            await client.query('DELETE FROM users WHERE id = $1', [userId]);
          });
        } finally {
          // Discard the connection rather than return it to the pool with the tenant still set.
          client.release(true);
        }
      } finally {
        await owner.end();
      }
    },
  };
}
