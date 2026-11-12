import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import {
  findRlsBypass,
  assertServingRoleEnforcesRls,
  assertMayAddTenant,
  countTenants,
  RlsBypassRoleError,
} from '../db/servingRole.js';
import { sql, type KyselyPlugin, type Transaction } from 'kysely';
import type { DB } from '../db/schema.generated.js';
import { globalDb } from '../db/withTenant.js';
import { createTenant } from '../services/TenantAdminService.js';
import { bootstrapFirstAdmin } from '../services/DeploymentAdminService.js';

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('serving role check', () => {
  let owner: Pool;
  let client: PoolClient;
  let ownerRole: string;
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const probe = (name: string) => `serving_role_probe_${name}_${suffix}`;
  const role = {
    bypass: probe('bypass'),
    memberOfBypass: probe('member_of_bypass'),
    superMember: probe('super_member'),
    nested: probe('nested'),
    setOnly: probe('set_only'),
    tableOwner: probe('table_owner'),
    ownerMember: probe('owner_member'),
    serverProgram: probe('server_program'),
    replication: probe('replication'),
    memberOfReplication: probe('member_of_replication'),
  };
  const table = probe('table');

  // Run fn on the probe connection as if `name` had logged in (a superuser can switch the
  // session to any role).
  async function asLogin<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await client.query(`SET SESSION AUTHORIZATION "${name}"`);
    try {
      return await fn();
    } finally {
      await client.query('RESET SESSION AUTHORIZATION');
    }
  }
  const problemsOf = (name: string) => asLogin(name, () => findRlsBypass(client));
  const who = (name: string) => `role ${name}`;

  beforeAll(async () => {
    owner = new Pool({ connectionString, max: 2 });
    client = await owner.connect();
    ownerRole = (await client.query<{ role: string }>('SELECT current_user AS role')).rows[0].role;
    // Every probe role and table lives in this transaction, which is rolled back at the
    // end, so even a killed run leaves nothing behind. Its one snapshot keeps the tenant
    // counts below steady while other test files add and remove tenants.
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const ddl = [
      `CREATE ROLE "${role.bypass}" NOLOGIN BYPASSRLS`,
      `CREATE ROLE "${role.memberOfBypass}" NOLOGIN IN ROLE "${role.bypass}"`,
      `CREATE ROLE "${role.superMember}" NOLOGIN`,
      `GRANT "${ownerRole}" TO "${role.superMember}"`,
      `CREATE ROLE "${role.nested}" NOLOGIN IN ROLE "${role.superMember}"`,
      `CREATE ROLE "${role.setOnly}" NOLOGIN`,
      `GRANT "${ownerRole}" TO "${role.setOnly}" WITH INHERIT FALSE, SET TRUE`,
      `CREATE ROLE "${role.tableOwner}" NOLOGIN`,
      `CREATE TABLE public."${table}" (id int)`,
      `ALTER TABLE public."${table}" OWNER TO "${role.tableOwner}"`,
      `CREATE ROLE "${role.ownerMember}" NOLOGIN IN ROLE "${role.tableOwner}"`,
      `CREATE ROLE "${role.serverProgram}" NOLOGIN IN ROLE pg_execute_server_program`,
      `CREATE ROLE "${role.replication}" NOLOGIN REPLICATION`,
      `CREATE ROLE "${role.memberOfReplication}" NOLOGIN IN ROLE "${role.replication}"`,
    ];
    for (const statement of ddl) await client.query(statement);
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await client?.query('ROLLBACK');
    } finally {
      client?.release();
      await owner.end();
    }
  });

  it("passes the app's own serving role", async () => {
    // db.ts's pool, as the app serves (CI: DB_USER=nuggets_app).
    const { default: pool } = await import('../db.js');
    expect(await findRlsBypass(pool)).toEqual([]);
    await expect(assertServingRoleEnforcesRls(pool, {})).resolves.toBeUndefined();
  });

  it('refuses a superuser, naming MIGRATION_DB_USER as part of the fix', async () => {
    expect(await findRlsBypass(owner)).toEqual([expect.stringMatching(/^role .+ is a superuser$/)]);
    const refusal = assertServingRoleEnforcesRls(owner, {});
    await expect(refusal).rejects.toBeInstanceOf(RlsBypassRoleError);
    await expect(refusal).rejects.toThrow(/Refusing to start.*MIGRATION_DB_USER.*ALLOW_RLS_BYPASS_ROLE=true/s);
    await expect(assertServingRoleEnforcesRls(owner, { ALLOW_RLS_BYPASS_ROLE: '1' })).rejects.toThrow(/Refusing/);
  });

  it('lets ALLOW_RLS_BYPASS_ROLE=true start with one tenant, but not with two', async () => {
    const optOut = { ALLOW_RLS_BYPASS_ROLE: 'true' };
    await expect(assertServingRoleEnforcesRls(owner, optOut, { countTenants: async () => 1 })).resolves.toBeUndefined();
    await expect(assertServingRoleEnforcesRls(owner, optOut, { countTenants: async () => 2 })).rejects.toThrow(
      /only works with one tenant, and this deployment has 2/
    );
    await expect(
      assertServingRoleEnforcesRls(owner, optOut, {
        countTenants: async () => {
          throw new Error('permission denied for table tenants');
        },
      })
    ).rejects.toThrow(/counting them failed: permission denied/);
  });

  it('counts every tenant row, which the opt-out checks against', async () => {
    // Inside the probe transaction, so no other test file sees it, and in a savepoint rolled
    // back at once, which also releases the lock the insert takes on tenants.
    const before = await countTenants(client);
    expect(before).toBeGreaterThanOrEqual(1);
    await client.query('SAVEPOINT count_tenants');
    try {
      const org = await client.query<{ id: number }>(`INSERT INTO organizations (name) VALUES ('${probe('org')}') RETURNING id`);
      await client.query(`INSERT INTO tenants (organization_id, name, status) VALUES ($1, $2, 'deleted')`, [
        org.rows[0].id,
        probe('tenant'),
      ]);
      expect(await countTenants(client)).toBe(before + 1);
      await expect(assertServingRoleEnforcesRls(client, { ALLOW_RLS_BYPASS_ROLE: 'true' })).rejects.toThrow(
        new RegExp(`only works with one tenant, and this deployment has ${before + 1}`)
      );
    } finally {
      await client.query('ROLLBACK TO SAVEPOINT count_tenants');
    }
  });

  const limit = { status: 409, code: 'TENANT_LIMIT_RLS_BYPASS' };
  // Run fn in a transaction that is always rolled back.
  class Rollback extends Error {}
  const rolledBack = (fn: (trx: Transaction<DB>) => Promise<void>) =>
    globalDb
      .transaction()
      .execute(async (trx) => {
        await fn(trx);
        throw new Rollback();
      })
      .catch((err) => {
        if (!(err instanceof Rollback)) throw err;
      });
  const tenantsLocks = async (trx: Transaction<DB>) =>
    (
      await sql<{ mode: string }>`SELECT mode FROM pg_locks
        WHERE pid = pg_backend_pid() AND relation = 'public.tenants'::regclass`.execute(trx)
    ).rows.map((r) => r.mode);
  // trx, recording the statements run through it: raw SQL as written, the rest by kind.
  const recording = (trx: Transaction<DB>) => {
    const ran: string[] = [];
    const recorder: KyselyPlugin = {
      transformQuery: ({ node }) => {
        ran.push(node.kind === 'RawNode' ? node.sqlFragments.join('?') : node.kind);
        return node;
      },
      transformResult: async ({ result }) => result,
    };
    return { trx: trx.withPlugin(recorder), ran };
  };
  const expectRefused = () =>
    rolledBack(async (trx) => {
      await expect(assertMayAddTenant(trx)).rejects.toMatchObject(limit);
    });

  it('refuses to add a tenant while the opt-out is in effect', async () => {
    const { default: pool } = await import('../db.js');
    await assertServingRoleEnforcesRls(owner, { ALLOW_RLS_BYPASS_ROLE: 'true' }, { countTenants: async () => 1 });
    try {
      await rolledBack(async (trx) => {
        const recorded = recording(trx);
        await expect(assertMayAddTenant(recorded.trx)).rejects.toMatchObject(limit);
        // Locked before counting and held until the transaction ends, so concurrent callers
        // count one at a time, each seeing what the one before inserted.
        expect(recorded.ran).toEqual(['LOCK TABLE public.tenants IN SHARE ROW EXCLUSIVE MODE', 'SelectQueryNode']);
        expect(await tenantsLocks(trx)).toContain('ShareRowExclusiveLock');
      });
      // An org that can't exist: if the guard were gone this fails on the foreign key, adding nothing.
      await expect(createTenant(-1, probe('blocked'), 1)).rejects.toMatchObject(limit);
      // First-run setup: an organization ahead of all others with no tenant yet, so the
      // bootstrap goes on to create one.
      await rolledBack(async (trx) => {
        await trx.insertInto('organizations').values({ id: -1, name: probe('first_org') }).execute();
        const admin = await trx
          .insertInto('users')
          .values({ email: `${probe('admin')}@test.local`, password_hash: 'x', first_name: 'Probe', last_name: 'Admin' })
          .returning('id')
          .executeTakeFirstOrThrow();
        // Its first step grants the user deployment admin to themselves, which the database
        // allows only while the deployment has no admin (on a test database that
        // has some, it was refused there, 403, before the tenant was tried). Where it has one,
        // that admin grants it first, in this rolled-back transaction, so the self-grant passes
        // and the case reaches the tenant either way.
        const existing = await trx
          .selectFrom('deployment_users')
          .select('user_id')
          .where('role', '=', 'admin')
          .orderBy('id')
          .limit(1)
          .executeTakeFirst();
        if (existing) await sql`SELECT grant_deployment_admin(${admin.id}, ${existing.user_id})`.execute(trx);
        await expect(bootstrapFirstAdmin(trx, admin.id)).rejects.toMatchObject(limit);
      });
      // Neither added a tenant (other test files add and remove theirs meanwhile, so count only these).
      const added = await owner.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM tenants WHERE name = $1 OR organization_id = -1',
        [probe('blocked')]
      );
      expect(added.rows[0].n).toBe(0);
    } finally {
      // Back to normal: the app's own role passes the check, which clears the opt-out.
      await assertServingRoleEnforcesRls(pool, {});
    }
    await rolledBack(async (trx) => {
      await expect(assertMayAddTenant(trx)).resolves.toBeUndefined();
      expect(await tenantsLocks(trx)).toEqual([]);
    });
  });

  it('keeps refusing while the check runs again, as after a restore, and after it refuses', async () => {
    const { default: pool } = await import('../db.js');
    const optOut = { ALLOW_RLS_BYPASS_ROLE: 'true' };
    await assertServingRoleEnforcesRls(owner, optOut, { countTenants: async () => 1 });
    try {
      // Try to add one while the check looks up the role, and again while it counts.
      const checked: string[] = [];
      const ownerTryingMeanwhile = {
        query: async (...args: Parameters<Pool['query']>) => {
          if (checked.length === 0) {
            await expectRefused();
            checked.push('role');
          }
          return owner.query(...args);
        },
      } as unknown as Pool;
      await assertServingRoleEnforcesRls(ownerTryingMeanwhile, optOut, {
        countTenants: async () => {
          await expectRefused();
          checked.push('count');
          return 1;
        },
      });
      expect(checked).toEqual(['role', 'count']);
      await expect(assertServingRoleEnforcesRls(owner, optOut, { countTenants: async () => 2 })).rejects.toThrow(
        RlsBypassRoleError
      );
      // The server is shutting down now, and must not add one on the way.
      await expectRefused();
    } finally {
      await assertServingRoleEnforcesRls(pool, {});
    }
  });

  it('flags BYPASSRLS, directly and through membership', async () => {
    expect(await problemsOf(role.bypass)).toEqual([`${who(role.bypass)} is BYPASSRLS`]);
    expect(await problemsOf(role.memberOfBypass)).toEqual([
      `${who(role.memberOfBypass)} can act as role ${role.bypass}, which is BYPASSRLS`,
    ]);
  });

  it('flags a role that can act as a superuser, directly, nested, or by SET ROLE only', async () => {
    for (const name of [role.superMember, role.nested, role.setOnly]) {
      expect(await problemsOf(name)).toContain(`${who(name)} can act as role ${ownerRole}, which is a superuser`);
    }
  });

  it('flags a role that owns a public table, directly or through membership', async () => {
    for (const name of [role.tableOwner, role.ownerMember]) {
      expect(await problemsOf(name)).toEqual([expect.stringMatching(new RegExp(`owns 1 table\\(s\\).*${table}`))]);
    }
  });

  it('flags server program access and REPLICATION, directly and through membership', async () => {
    expect(await problemsOf(role.serverProgram)).toEqual([
      expect.stringMatching(/can act as role pg_execute_server_program, which is a predefined role/),
    ]);
    expect(await problemsOf(role.replication)).toEqual([expect.stringMatching(/has REPLICATION/)]);
    expect(await problemsOf(role.memberOfReplication)).toEqual([
      `${who(role.memberOfReplication)} can act as role ${role.replication}, which is REPLICATION`,
    ]);
  });

  it('also checks the login role when a role default switched the session to another', async () => {
    // As with ALTER ROLE <login> SET role = <role>: RESET ROLE gets the login back.
    await client.query(`SET ROLE "${role.tableOwner}"`);
    try {
      const problems = await findRlsBypass(client);
      expect(problems).toContain(`login role ${ownerRole} is a superuser`);
      expect(problems).toEqual(expect.arrayContaining([expect.stringMatching(new RegExp(`^role ${role.tableOwner} owns 1 table`))]));
    } finally {
      await client.query('RESET ROLE');
    }
  });
});
