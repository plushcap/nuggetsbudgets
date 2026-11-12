import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { Pool } from 'pg';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

/**
 * Removing someone's deployment-admin role never leaves the deployment without one, even
 * when two removals run at once. The service counts the admins first, but two
 * removals could each count two and both go through; revoke_deployment_admin locks the
 * admins' rows and refuses to remove the only one, and the service answers that as the
 * count's 409.
 *
 * The count is of every admin of the deployment, and other files add theirs to the shared
 * database while this one runs, so this file copies deployment and deployment_users (and the
 * functions, pointing at the copies: test/schemaCopy.ts) into a schema of its own, with the
 * app's pool pointed at it by search_path, as setupAdminToken.test.ts does.
 */
const { SCHEMA } = vi.hoisted(() => ({ SCHEMA: `last_deployment_admin_${process.pid}_${Date.now()}` }));

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

describe('the last deployment admin stays', () => {
  let owner: Pool;
  // The users table in the copy holds ids only (and there are no foreign keys).
  const A = 101;
  const B = 102;
  const SUPPORT = 103;

  const admins = async () =>
    (await owner.query<{ user_id: number }>(`SELECT user_id FROM ${SCHEMA}.deployment_users WHERE role = 'admin' ORDER BY user_id`)).rows.map(
      (r) => r.user_id
    );
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'removed',
      (err: { status?: number; code?: string }) => `${err.status ?? ''} ${err.code ?? String(err)}`
    );

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 3 });
    const appRole = quoteIdent(process.env.DB_USER || 'postgres');
    await owner.query(`CREATE SCHEMA ${SCHEMA}`);
    for (const table of ['deployment', 'deployment_users']) {
      await owner.query(`CREATE TABLE ${SCHEMA}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await owner.query(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${appRole}`);
    await owner.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${appRole}`);
    // What the functions' owner has on the real table (the copies run as the caller).
    await owner.query(`GRANT INSERT, UPDATE, DELETE ON ${SCHEMA}.deployment_users TO ${appRole}`);
    await owner.query(`INSERT INTO ${SCHEMA}.deployment (name) VALUES ('Nuggets')`);
    // The accounts the grant locks first: their ids only.
    await owner.query(`CREATE TABLE ${SCHEMA}.users (id integer PRIMARY KEY)`);
    await owner.query(`GRANT SELECT, UPDATE ON ${SCHEMA}.users TO ${appRole}`);
    await owner.query(`INSERT INTO ${SCHEMA}.users (id) VALUES (${A}), (${B}), (${SUPPORT})`);
    await copyFunctionToSchema(owner, 'revoke_deployment_admin(integer)', SCHEMA, appRole);
    await copyFunctionToSchema(owner, 'grant_deployment_admin(integer, integer)', SCHEMA, appRole);
  });

  beforeEach(async () => {
    await owner.query(`TRUNCATE ${SCHEMA}.deployment_users`);
    await owner.query(
      `INSERT INTO ${SCHEMA}.deployment_users (user_id, deployment_id, role)
       SELECT u, (SELECT id FROM ${SCHEMA}.deployment), r FROM (VALUES (${A}, 'admin'), (${B}, 'admin'), (${SUPPORT}, 'support')) v(u, r)`
    );
  });

  afterAll(async () => {
    await appPool.end();
    await owner?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await owner?.end();
  });

  it('removes an admin while another remains, and refuses the only one', async () => {
    await setUserDeploymentAdmin(B, false, A);
    expect(await admins()).toEqual([A]);
    // The service's own count refuses first; the function refuses on its own too.
    expect(await outcome(setUserDeploymentAdmin(A, false, SUPPORT))).toBe('409 LAST_DEPLOYMENT_ADMIN');
    expect(await outcome(appPool.query('SELECT revoke_deployment_admin($1)', [A]))).toBe(' 23514');
    expect(await admins()).toEqual([A]);
    // A role that isn't admin goes, however few admins there are.
    await appPool.query('SELECT revoke_deployment_admin($1)', [SUPPORT]);
    expect((await owner.query(`SELECT 1 FROM ${SCHEMA}.deployment_users WHERE user_id = $1`, [SUPPORT])).rowCount).toBe(0);
    // And granting works as it did.
    await setUserDeploymentAdmin(B, true, A);
    expect(await admins()).toEqual([A, B]);
  });

  it('lets only one of two removals of the last two admins through', async () => {
    // Hold the admins' rows, so both removals pass the service's count (two admins) and
    // then wait in the function: the case the count alone let through.
    const holder = await owner.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${SCHEMA}.deployment_users WHERE role = 'admin' ORDER BY id FOR UPDATE`);
    const removals = [outcome(setUserDeploymentAdmin(A, false, B)), outcome(setUserDeploymentAdmin(B, false, A))];
    try {
      await vi.waitFor(
        async () => {
          const waiting = await owner.query(
            `SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event_type = 'Lock' AND query LIKE '%revoke_deployment_admin%'`,
            [SCHEMA]
          );
          expect(waiting.rowCount).toBe(2);
        },
        { timeout: 10_000, interval: 50 }
      );
    } finally {
      await holder.query('COMMIT');
      holder.release();
    }
    expect((await Promise.all(removals)).sort()).toEqual(['409 LAST_DEPLOYMENT_ADMIN', 'removed']);
    expect(await admins()).toHaveLength(1);
  });
});
