import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { Pool, type PoolClient } from 'pg';
import appPool from '../db.js';

/**
 * The serving role may only read schema_migrations and deployment_users, and may only set
 * the deployment row's setup token: none has RLS, so a statement
 * with a missing predicate could otherwise make anyone a deployment admin, remove them all
 * (deleting the deployment row cascades) or rewrite the migration history. It changes and
 * locks deployment_users through four SECURITY DEFINER functions that take ids only
 * (grant_deployment_admin and the others, in the baseline). Runs as the app's own role,
 * on the real tables, for users this file makes; deploymentLastAdmin.db.test.ts covers the
 * last-admin refusal, which counts every admin of the deployment.
 */

const RUN = `serving-grants-${process.pid}-${Date.now()}`;
const FORGED_VERSION = '29991231235959';

describe('the serving role writes deployment_users and schema_migrations only through the functions', () => {
  let owner: Pool;
  const userIds: number[] = [];

  async function addUser(label: string): Promise<number> {
    const { rows } = await owner.query<{ id: number }>(
      `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id`,
      [`${RUN}-${label}@test.local`, label]
    );
    userIds.push(rows[0].id);
    return rows[0].id;
  }
  /**
   * Make `userId` an admin as the owner, as setup would: grant_deployment_admin takes the
   * role only from an admin, and the deployment may have none while this runs.
   */
  const seedAdmin = (userId: number) =>
    owner.query(`INSERT INTO deployment_users (deployment_id, user_id, role, created_by) SELECT id, $1, 'admin', $1 FROM deployment ORDER BY id LIMIT 1`, [
      userId,
    ]);
  const deploymentRows = async (userId: number) =>
    (await owner.query<{ role: string; created_by: number | null }>('SELECT role, created_by FROM deployment_users WHERE user_id = $1', [userId]))
      .rows;
  /** Whether another session can lock `userId`'s deployment_users row as `mode` without waiting. */
  const lockable = async (userId: number, mode: 'FOR KEY SHARE' | 'FOR UPDATE'): Promise<boolean> => {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT 1 FROM deployment_users WHERE user_id = $1 ${mode} NOWAIT`, [userId]);
      return true;
    } catch (err) {
      if ((err as { code?: string }).code === '55P03') return false;
      throw err;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  const asApp = async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await appPool.connect();
    try {
      await client.query('BEGIN');
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  };

  beforeAll(async () => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 3 });
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.query('DELETE FROM schema_migrations WHERE version = $1', [FORGED_VERSION]);
      await owner.query('DELETE FROM deployment_users WHERE user_id = ANY($1) OR created_by = ANY($1)', [userIds]);
      await owner.query('DELETE FROM users WHERE id = ANY($1)', [userIds]);
    } finally {
      await owner.end();
    }
  });

  it('refuses it any direct write or row lock on either table (42501), and still lets it read them', async () => {
    const user = await addUser('direct');
    // Each aimed at rows only this file has (none, mostly): the privilege is checked before
    // any row is, and should one ever run, it must not change the shared database's own.
    const refusals = [
      ["INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1", [user]],
      ["UPDATE deployment_users SET role = 'admin' WHERE user_id = $1", [user]],
      ['DELETE FROM deployment_users WHERE user_id = $1', [user]],
      ['SELECT id FROM deployment_users WHERE user_id = $1 FOR UPDATE', [user]],
      ['SELECT id FROM deployment_users WHERE user_id = $1 FOR KEY SHARE', [user]],
      ["INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, 'forged', repeat('0', 64))", [FORGED_VERSION]],
      ["UPDATE schema_migrations SET checksum = repeat('0', 64) WHERE version = $1", [FORGED_VERSION]],
      ['DELETE FROM schema_migrations WHERE version = $1', [FORGED_VERSION]],
      ['SELECT version FROM schema_migrations WHERE version = $1 FOR UPDATE', [FORGED_VERSION]],
      // Deleting the deployment row cascades to every deployment_users row; another row with
      // a lower id would be the one the functions use.
      ['DELETE FROM deployment', []],
      ["INSERT INTO deployment (id, name) VALUES (0, 'forged')", []],
      ["UPDATE deployment SET name = 'forged'", []],
      ['UPDATE deployment SET id = 0', []],
    ] as const;
    // Each in a transaction rolled back, so that should one ever run, it changes nothing.
    const outcome = (statement: string, params: readonly unknown[]) =>
      asApp((app) => app.query(statement, [...params])).then(
        () => 'ran',
        (err: { code?: string }) => err.code
      );
    for (const [statement, params] of refusals) {
      expect({ statement, outcome: await outcome(statement, params) }).toEqual({ statement, outcome: '42501' });
    }
    // What the app does write there: the setup token (SetupTokenService).
    expect(await outcome('UPDATE deployment SET setup_token_hash = setup_token_hash', [])).toBe('ran');
    expect((await owner.query('SELECT count(*)::int AS n FROM deployment')).rows).toEqual([{ n: 1 }]);
    expect(await deploymentRows(user)).toEqual([]);
    expect((await owner.query('SELECT 1 FROM schema_migrations WHERE version = $1', [FORGED_VERSION])).rowCount).toBe(0);

    // What the serving process reads: /api/ready and the backup manifest, the admin checks.
    const latest = await appPool.query<{ version: string }>('SELECT max(version) AS version FROM schema_migrations');
    expect(latest.rows[0].version).toMatch(/^\d{14}$/);
    expect((await appPool.query('SELECT role FROM deployment_users WHERE user_id = $1', [user])).rows).toEqual([]);
  });

  it('grants and removes the role for the user named, recording who granted it', async () => {
    const granter = await addUser('granter');
    const target = await addUser('target');
    const nobody = await addUser('nobody');

    await seedAdmin(granter);
    await appPool.query('SELECT grant_deployment_admin($1, $2)', [target, granter]);
    expect(await deploymentRows(target)).toEqual([{ role: 'admin', created_by: granter }]);
    // Again, by someone else: still one row, which keeps who added it.
    await appPool.query('SELECT grant_deployment_admin($1, $2)', [target, target]);
    expect(await deploymentRows(target)).toEqual([{ role: 'admin', created_by: granter }]);

    // granter is an admin too, so removing target leaves the deployment one.
    await appPool.query('SELECT revoke_deployment_admin($1)', [target]);
    expect(await deploymentRows(target)).toEqual([]);
    expect(await deploymentRows(granter)).toEqual([{ role: 'admin', created_by: granter }]);
    // Removing a role nobody has changes nothing.
    await appPool.query('SELECT revoke_deployment_admin($1)', [nobody]);
    expect(await deploymentRows(nobody)).toEqual([]);
  });

  it('locks the rows a user delete changes, the deleting admin\'s, and an inviting admin\'s row, until the transaction ends', async () => {
    const leaving = await addUser('leaving');
    const madeByLeaving = await addUser('made-by-leaving');
    const deleter = await addUser('deleter');
    const bystander = await addUser('bystander');
    await seedAdmin(leaving);
    await appPool.query('SELECT grant_deployment_admin($1, $2)', [madeByLeaving, leaving]);
    await seedAdmin(deleter);
    await seedAdmin(bystander);

    await asApp(async (app) => {
      const locked = await app.query<{ admin: boolean }>('SELECT lock_deployment_users_of($1, $2) AS admin', [leaving, deleter]);
      // The deleting admin still is one.
      expect(locked.rows).toEqual([{ admin: true }]);
      // Their row, the one whose created_by the delete clears, and the deleting admin's:
      // locked FOR UPDATE.
      expect(await lockable(leaving, 'FOR KEY SHARE')).toBe(false);
      expect(await lockable(madeByLeaving, 'FOR KEY SHARE')).toBe(false);
      expect(await lockable(deleter, 'FOR KEY SHARE')).toBe(false);
      expect(await lockable(bystander, 'FOR UPDATE')).toBe(true);
    });
    expect(await lockable(leaving, 'FOR UPDATE')).toBe(true);
    expect(await lockable(deleter, 'FOR UPDATE')).toBe(true);
    // A deleting user who isn't an admin (another role, or none) is told so.
    const support = await addUser('support');
    await owner.query(`INSERT INTO deployment_users (deployment_id, user_id, role) SELECT id, $1, 'support' FROM deployment ORDER BY id LIMIT 1`, [support]);
    for (const actor of [support, await addUser('no-role')]) {
      const locked = await asApp((app) => app.query<{ admin: boolean }>('SELECT lock_deployment_users_of($1, $2) AS admin', [leaving, actor]));
      expect(locked.rows).toEqual([{ admin: false }]);
    }

    await asApp(async (app) => {
      const held = await app.query<{ held: boolean }>('SELECT lock_deployment_admin($1) AS held', [bystander]);
      expect(held.rows).toEqual([{ held: true }]);
      // Shared: a removal (FOR UPDATE, then DELETE) waits; the lock order's other share locks don't.
      expect(await lockable(bystander, 'FOR UPDATE')).toBe(false);
      expect(await lockable(bystander, 'FOR KEY SHARE')).toBe(true);
      const none = await app.query<{ held: boolean }>('SELECT lock_deployment_admin($1) AS held', [await addUser('not-an-admin')]);
      expect(none.rows).toEqual([{ held: false }]);
    });
    expect(await lockable(bystander, 'FOR UPDATE')).toBe(true);
  });
});
