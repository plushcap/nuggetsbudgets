import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import bcrypt from 'bcryptjs';
import { Pool, type PoolClient } from 'pg';
import { deleteUserByAdmin } from '../services/UserService.js';
import { setUserDeploymentAdmin } from '../services/DeploymentAdminService.js';

/**
 * Two deployment admins deleting each other at the same moment. Each
 * delete locked only the account it deleted, and the acting admin was checked once, when
 * the request began: both went through, and with no other admin the deployment was left
 * with none. Now a delete locks both accounts in id order and checks, under the lock, that
 * the acting admin is still one, so the second waits for the first and is refused (403
 * DEPLOYMENT_ADMIN_REQUIRED): the admin who acted first stays.
 *
 * The test holds the lower id's row so that both deletes have started before either can
 * finish. The old code locked only the target's row, so the delete of the higher id ran
 * through at once, and the other then deleted its own admin's account too.
 *
 * The same for a delete racing a removal of its admin's role: the delete decides on that
 * role under its deployment_users lock, which it takes with the target's rows.
 */

const RUN = `admins-delete-each-other-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

describe('deployment admins and accounts deleted meanwhile', () => {
  let owner: Pool;
  const created: number[] = [];

  const addAdmin = async (label: string) => {
    const { rows } = await owner.query<{ id: number; uuid: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, $2, 'Test', $3) RETURNING id, uuid`,
      [`${RUN}-${label}@test.local`, bcrypt.hashSync('a passphrase for this test', 4), label]
    );
    created.push(rows[0].id);
    await owner.query(`INSERT INTO deployment_users (deployment_id, user_id, role) SELECT id, $1, 'admin' FROM deployment LIMIT 1`, [rows[0].id]);
    return rows[0];
  };
  const exists = async (id: number) => (await owner.query('SELECT 1 FROM users WHERE id = $1', [id])).rowCount === 1;
  const outcome = (p: Promise<unknown>) =>
    p.then(
      () => 'deleted',
      (err: { status?: number; code?: string }) => `${err.status ?? ''} ${err.code ?? String(err)}`
    );
  /** Resolves once `count` of this test's statements wait on a row lock. */
  const waiting = async (count: number) => {
    for (let i = 0; i < 200; i++) {
      const { rows } = await owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE '%from "users"%for update%'`
      );
      if (rows[0].n >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${count} deletes waited`);
  };

  beforeAll(() => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 3 });
  });

  afterAll(async () => {
    if (created.length) await owner.query('DELETE FROM users WHERE id = ANY($1)', [created]);
    await owner.end();
  });

  it('lets only the first through, so one of them stays an admin', async () => {
    const x = await addAdmin('x');
    const y = await addAdmin('y');
    const [low] = [x, y].sort((a, b) => a.id - b.id);

    const hold: PoolClient = await owner.connect();
    let results: string[];
    try {
      await hold.query('BEGIN');
      await hold.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [low.id]);
      const xDeletesY = outcome(deleteUserByAdmin(y.uuid, x.id));
      const yDeletesX = outcome(deleteUserByAdmin(x.uuid, y.id));
      // Both have reached the account lock (the old code's delete of the higher id didn't
      // wait, and was done by now).
      await waiting(2);
      await hold.query('COMMIT');
      results = await Promise.all([xDeletesY, yDeletesX]);
    } finally {
      await hold.query('ROLLBACK').catch(() => undefined);
      hold.release();
    }

    expect([...results].sort()).toEqual(['403 DEPLOYMENT_ADMIN_REQUIRED', 'deleted']);
    const left = [(await exists(x.id)) && 'x', (await exists(y.id)) && 'y'].filter(Boolean);
    expect(left).toHaveLength(1);
  });

  // A deletes B while B removes A's admin role. The delete checked A's role with an
  // unlocked read, then locked only B's deployment_users rows: a removal that committed in
  // between still counted B as the admin who stays, and the delete then removed B, leaving
  // neither. Now the delete locks A's row with B's and reads A's role under the lock.
  it("refuses a delete whose admin lost the role while it ran, so the deployment keeps one", async () => {
    const a = await addAdmin('acting');
    const b = await addAdmin('deleted');
    // B is a plain member of an organization: the delete locks that membership (step 3 of
    // the lock order), which this test holds to pause the delete there, after its first
    // check of A and before its deployment_users lock.
    const org = (await owner.query<{ id: number }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`${RUN}-org`])).rows[0];
    try {
      await owner.query(`INSERT INTO organization_users (user_id, organization_id, is_admin) VALUES ($1, $2, false)`, [b.id, org.id]);
      const hold: PoolClient = await owner.connect();
      let result: string;
      try {
        await hold.query('BEGIN');
        await hold.query('SELECT id FROM organization_users WHERE user_id = $1 FOR UPDATE', [b.id]);
        const holdPid = (await hold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const aDeletesB = outcome(deleteUserByAdmin(b.uuid, a.id));
        // Waiting on this row: only the delete wants it.
        for (let i = 0; ; i++) {
          const { rows } = await owner.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))`,
            [holdPid]
          );
          if (rows[0].n >= 1) break;
          if (i > 200) throw new Error('the delete never waited on the membership');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        // B removes A's role while A's delete waits: B still counts as the admin who stays.
        await setUserDeploymentAdmin(a.id, false, b.id);
        await hold.query('COMMIT');
        result = await aDeletesB;
      } finally {
        await hold.query('ROLLBACK').catch(() => undefined);
        hold.release();
      }

      expect(result).toBe('403 DEPLOYMENT_ADMIN_REQUIRED');
      const admins = await owner.query<{ user_id: number }>(
        `SELECT user_id FROM deployment_users WHERE role = 'admin' AND user_id = ANY($1)`,
        [[a.id, b.id]]
      );
      expect(admins.rows.map((r) => r.user_id)).toEqual([b.id]);
    } finally {
      await owner.query('DELETE FROM organizations WHERE id = $1', [org.id]);
    }
  });

  // The grant re-checks its granter under a lock of their deployment row, which it
  // takes after their account's (FOR KEY SHARE, step 2 of the lock order), as a delete takes
  // the account then the deployment rows. Locking the deployment row first, the grant would
  // hold it while it waited for the account the delete held, and the delete wait for it.
  it('an admin granting the role while being deleted waits for the delete, then is refused, and nothing deadlocks', async () => {
    const granting = await addAdmin('granting-deleted');
    const deleting = await addAdmin('deleting-granter');
    const target = (
      await owner.query<{ id: number }>(
        `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', 'target') RETURNING id`,
        [`${RUN}-grant-target@test.local`]
      )
    ).rows[0];
    created.push(target.id);
    // A plain membership the delete locks after the account (step 3), held to pause it there.
    const org = (await owner.query<{ id: number }>(`INSERT INTO organizations (name) VALUES ($1) RETURNING id`, [`${RUN}-grant-org`])).rows[0];
    try {
      await owner.query(`INSERT INTO organization_users (user_id, organization_id, is_admin) VALUES ($1, $2, false)`, [granting.id, org.id]);
      const hold: PoolClient = await owner.connect();
      let results: string[];
      try {
        await hold.query('BEGIN');
        await hold.query('SELECT id FROM organization_users WHERE user_id = $1 FOR UPDATE', [granting.id]);
        const holdPid = (await hold.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        const waitersOf = async (pid: number) =>
          (await owner.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
        const deleted = outcome(deleteUserByAdmin(granting.uuid, deleting.id));
        let deletePid: number | undefined;
        for (let i = 0; (deletePid = (await waitersOf(holdPid))[0]) === undefined; i++) {
          if (i > 200) throw new Error('the delete never waited on the membership');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const granted = setUserDeploymentAdmin(target.id, true, granting.id).then(
          () => 'granted',
          (err: { status?: number; code?: string }) => `${err.status ?? ''} ${err.code ?? String(err)}`
        );
        // The grant waits for the delete, which holds the granter's account.
        for (let i = 0; (await waitersOf(deletePid)).length === 0; i++) {
          if (i > 200) throw new Error('the grant never waited on the delete');
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await hold.query('COMMIT');
        results = await Promise.all([deleted, granted]);
      } finally {
        await hold.query('ROLLBACK').catch(() => undefined);
        hold.release();
      }
      expect(results).toEqual(['deleted', '403 DEPLOYMENT_ADMIN_REQUIRED']);
      expect(await exists(granting.id)).toBe(false);
      expect((await owner.query('SELECT 1 FROM deployment_users WHERE user_id = $1', [target.id])).rowCount).toBe(0);
    } finally {
      await owner.query('DELETE FROM organizations WHERE id = $1', [org.id]);
    }
  });

  // The admin grant names the account by an id looked up before it: an account deleted in
  // between failed grant_deployment_admin's foreign key, which answered a 500.
  it('answers a grant to an account deleted meanwhile with a 404, and one by a deleted admin with a 403', async () => {
    const admin = await addAdmin('granter');
    const gone = await addAdmin('gone');
    await owner.query('DELETE FROM users WHERE id = $1', [gone.id]);
    await expect(outcome(setUserDeploymentAdmin(gone.id, true, admin.id))).resolves.toBe('404 USER_NOT_FOUND');

    const target = await addAdmin('target');
    await owner.query('DELETE FROM deployment_users WHERE user_id = $1', [target.id]);
    await owner.query('DELETE FROM users WHERE id = $1', [admin.id]);
    await expect(outcome(setUserDeploymentAdmin(target.id, true, admin.id))).resolves.toBe('403 DEPLOYMENT_ADMIN_REQUIRED');
  });
});
