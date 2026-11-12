import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

/**
 * A deployment admin whose own role is removed while they grant or remove someone else's.
 * The admin routes check the caller's role once, as the request starts, so a grant
 * or a removal by an admin whose role had just been removed went through. Now the change
 * checks the acting admin's role again under the lock it takes: grant_deployment_admin
 * locks the granter's deployment row (and the user's) and decides on it as it stands, and
 * setUserDeploymentAdmin reads the remover's role after revoke_deployment_admin has locked
 * every admin's row, theirs among them. So a removal of the acting admin's role under way
 * is waited for, and then the change is refused (403 DEPLOYMENT_ADMIN_REQUIRED) with
 * nothing changed; and a change under way makes a removal of its admin's role wait for it.
 *
 * The admins are counted deployment-wide, and other files add theirs to the shared database
 * while this one runs, so this file copies deployment, deployment_users and the users' ids
 * (and the functions, pointing at the copies: test/schemaCopy.ts) into a schema of its own,
 * with the app's pool pointed at it by search_path, as deploymentLastAdmin.db.test.ts does.
 */
const { SCHEMA } = vi.hoisted(() => ({ SCHEMA: `deployment_admin_lock_${process.pid}_${Date.now()}` }));

vi.mock('../db.js', async () => {
  const pg = await import('pg');
  const { Kysely, PostgresDialect } = await import('kysely');
  const { initializeSecrets } = await import('../utils/docker-secrets.js');
  const { servingRolePassword } = await import('../db/servingRole.js');
  const pool = new pg.Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'nuggets_db',
    user: process.env.DB_USER || 'postgres',
    password: servingRolePassword(initializeSecrets()),
    options: `-c search_path=${SCHEMA}`,
    // So the test can find this file's connections waiting on a lock.
    application_name: SCHEMA,
    max: 6,
  });
  return {
    default: pool,
    db: new Kysely({ dialect: new PostgresDialect({ pool }) }),
    testConnection: async () => true,
  };
});

import appPool from '../db.js';
import { setUserDeploymentAdmin } from '../services/DeploymentAdminService.js';
import { copyFunctionToSchema } from '../test/schemaCopy.js';

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

describe("a deployment admin's change, against the removal of their own role", () => {
  let owner: Pool;
  const A = 201;
  const B = 202;
  const C = 203;
  /** Someone with no deployment role. */
  const T = 204;

  const admins = async () =>
    (await owner.query<{ user_id: number }>(`SELECT user_id FROM ${SCHEMA}.deployment_users WHERE role = 'admin' ORDER BY user_id`)).rows.map(
      (r) => r.user_id
    );
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'done',
      (err: { status?: number; code?: string }) => `${err.status ?? ''} ${err.code ?? String(err)}`
    );
  /** Resolves once `count` of this file's app connections wait on a lock. */
  const waiting = async (count: number) =>
    vi.waitFor(
      async () => {
        const { rows } = await owner.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock'`,
          [SCHEMA]
        );
        expect(rows[0].n).toBeGreaterThanOrEqual(count);
      },
      { timeout: 10_000, interval: 25 }
    );
  /** The owner's connection with a transaction open, until `end()`. */
  const holder = async () => {
    const client: PoolClient = await owner.connect();
    await client.query('BEGIN');
    let open = true;
    return {
      client,
      end: async (how: 'COMMIT' | 'ROLLBACK') => {
        if (!open) return;
        open = false;
        await client.query(how).catch(() => client.query('ROLLBACK'));
        client.release();
      },
    };
  };

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 3 });
    const appRole = quoteIdent(process.env.DB_USER || 'postgres');
    await owner.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const table of ['deployment', 'deployment_users']) {
      await owner.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await owner.query(`CREATE TABLE ${SCHEMA}.users (id integer PRIMARY KEY)`);
    await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${appRole}`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${appRole}`);
    // What the functions' owner has on the real tables (the copies run as the caller).
    await owner.query(`GRANT INSERT, UPDATE, DELETE ON ${SCHEMA}.deployment_users TO ${appRole}`);
    await owner.query(`GRANT UPDATE ON ${SCHEMA}.users TO ${appRole}`);
    await owner.query(`INSERT INTO ${SCHEMA}.deployment (name) VALUES ('Nuggets')`);
    await owner.query(`INSERT INTO ${SCHEMA}.users (id) VALUES (${A}), (${B}), (${C}), (${T})`);
    await copyFunctionToSchema(owner, 'revoke_deployment_admin(integer)', SCHEMA, appRole);
    await copyFunctionToSchema(owner, 'grant_deployment_admin(integer, integer)', SCHEMA, appRole);
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE ${SCHEMA}.deployment_users`);
    await owner.query(
      `INSERT INTO ${SCHEMA}.deployment_users (user_id, deployment_id, role)
       SELECT u, (SELECT id FROM ${SCHEMA}.deployment), 'admin' FROM unnest(ARRAY[${A}, ${B}, ${C}]) u`
    );
  });

  afterAll(async () => {
    await appPool.end();
    await owner?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await owner?.end();
  });

  /** B removing A's role, as revoke_deployment_admin does, held open until `end()`. */
  const removingA = async () => {
    const h = await holder();
    await h.client.query(`SELECT ${SCHEMA}.revoke_deployment_admin($1)`, [A]);
    return h;
  };

  it('refuses a grant or a removal by an admin whose role was removed since the request was authorized', async () => {
    await setUserDeploymentAdmin(A, false, B);
    expect(await outcome(setUserDeploymentAdmin(C, false, A))).toBe('403 DEPLOYMENT_ADMIN_REQUIRED');
    expect(await outcome(setUserDeploymentAdmin(T, true, A))).toBe('403 DEPLOYMENT_ADMIN_REQUIRED');
    expect(await admins()).toEqual([B, C]);
    // An admin still goes through.
    await setUserDeploymentAdmin(T, true, B);
    await setUserDeploymentAdmin(C, false, B);
    expect(await admins()).toEqual([B, T]);
  });

  it('a removal by an admin whose own removal is under way waits for it, then is refused', async () => {
    const h = await removingA();
    let removal: Promise<string> | undefined;
    try {
      removal = outcome(setUserDeploymentAdmin(C, false, A));
      await waiting(1);
    } finally {
      await h.end('COMMIT');
    }
    expect(await removal).toBe('403 DEPLOYMENT_ADMIN_REQUIRED');
    // Rolled back: C keeps the role A tried to remove.
    expect(await admins()).toEqual([B, C]);
  });

  it('a grant by an admin whose own removal is under way waits for it, then is refused', async () => {
    const h = await removingA();
    let grant: Promise<string> | undefined;
    try {
      grant = outcome(setUserDeploymentAdmin(T, true, A));
      await waiting(1);
    } finally {
      await h.end('COMMIT');
    }
    expect(await grant).toBe('403 DEPLOYMENT_ADMIN_REQUIRED');
    expect(await admins()).toEqual([B, C]);
  });

  it("a grant under way makes the removal of its admin's role wait for it; both then go through, in that order", async () => {
    // Another transaction is adding T's row: the grant, past its lock of A's row, waits for
    // it as it writes T's.
    const h = await holder();
    let grant: Promise<string> | undefined;
    let removal: Promise<string> | undefined;
    try {
      await h.client.query(`INSERT INTO ${SCHEMA}.deployment_users (user_id, deployment_id, role) SELECT $1, id, 'support' FROM ${SCHEMA}.deployment`, [T]);
      grant = outcome(setUserDeploymentAdmin(T, true, A));
      await waiting(1);
      // B removes A's role meanwhile: it waits for the grant, which holds A's row.
      removal = outcome(setUserDeploymentAdmin(A, false, B));
      await waiting(2);
    } finally {
      await h.end('ROLLBACK');
    }
    expect(await grant).toBe('done');
    expect(await removal).toBe('done');
    expect(await admins()).toEqual([B, C, T]);
  });

  it('lets only first-run setup grant the role without holding it: the first user, to themselves, while there is no admin', async () => {
    const grant = (user: number, by: number) => outcome(appPool.query('SELECT grant_deployment_admin($1, $2)', [user, by]));
    // Admins exist: someone who isn't one can't grant it, to themselves or anyone.
    expect(await grant(T, T)).toBe(' 42501');
    expect(await grant(C, T)).toBe(' 42501');
    await owner.query(`TRUNCATE ${SCHEMA}.deployment_users`);
    // None: only to themselves.
    expect(await grant(A, T)).toBe(' 42501');
    expect(await grant(T, T)).toBe('done');
    expect(await admins()).toEqual([T]);
  });
});
