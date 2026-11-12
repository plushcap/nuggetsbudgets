import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { Pool, type PoolClient } from 'pg';
import { deleteUserByAdmin, updateUserByAdmin } from '../services/UserService.js';
import { png } from '../test/imageFixtures.js';

/**
 * A deployment admin's edit of an account (PUT /api/admin/users/:uuid, updateUserByAdmin)
 * by an admin whose role is removed while it runs. The route checks the role as the
 * request begins; the edit then waits for the account's row lock (another edit of it, a
 * sign-in). It didn't look at the role again, so an admin removed meanwhile still changed
 * the account, locking it included, where granting and removing the role re-check the
 * actor under their lock. It is now re-checked under the lock and refused 403
 * DEPLOYMENT_ADMIN_REQUIRED, nothing changed: the profile picture included, which was
 * written before the edit's transaction and stayed whatever the edit then did.
 */
describe("a deployment admin's edit by an admin removed while it waits", () => {
  let owner: Pool;
  const ids: number[] = [];

  const addUser = async (label: string) => {
    const { rows } = await owner.query<{ id: number; uuid: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Before', $2) RETURNING id, uuid`,
      [`admin-recheck-${label}-${process.pid}-${Date.now()}@test.local`, label]
    );
    ids.push(rows[0]!.id);
    return rows[0]!;
  };
  const makeAdmin = (userId: number) =>
    owner.query(`INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`, [userId]);

  beforeAll(() => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 4 });
  });

  afterAll(async () => {
    if (ids.length) await owner?.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    await owner?.end();
  });

  /** Start `edit` while another connection holds the account's row; remove `adminId`'s role, then let the edit go on. */
  const editWhileRemoved = async <T>(userId: number, adminId: number, edit: () => Promise<T>) => {
    const holder: PoolClient = await owner.connect();
    let editing: Promise<{ value: T } | { error: unknown }> | undefined;
    try {
      await holder.query('BEGIN');
      const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await holder.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
      editing = edit().then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      const deadline = Date.now() + 10_000;
      while ((await owner.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount === 0) {
        if (Date.now() > deadline) throw new Error('the edit never waited for the account');
        await new Promise((r) => setTimeout(r, 20));
      }
      await owner.query('DELETE FROM deployment_users WHERE user_id = $1', [adminId]);
    } finally {
      await holder.query('COMMIT').catch(() => undefined);
      holder.release();
    }
    return editing!;
  };

  const account = async (id: number) =>
    (await owner.query('SELECT first_name, is_locked, profile_image FROM users WHERE id = $1', [id])).rows[0] as {
      first_name: string;
      is_locked: boolean;
      profile_image: string | null;
    };
  const pictureOf = async (id: number) => (await owner.query<{ uuid: string }>('SELECT uuid FROM user_profile_images WHERE user_id = $1', [id])).rows[0]?.uuid ?? null;

  it('is refused 403, changing nothing, not even the picture', async () => {
    const user = await addUser('target');
    const admin = await addUser('removed-admin');
    const other = await addUser('other-admin');
    await makeAdmin(admin.id);
    await makeAdmin(other.id);

    const outcome = await editWhileRemoved(user.id, admin.id, () =>
      updateUserByAdmin(user.uuid, { first_name: 'After', is_locked: true }, { mimeType: 'image/png', data: png() }, admin.id)
    );

    expect('error' in outcome, JSON.stringify(outcome)).toBe(true);
    expect((outcome as { error: unknown }).error).toMatchObject({ status: 403, code: 'DEPLOYMENT_ADMIN_REQUIRED' });
    expect(await account(user.id)).toEqual({ first_name: 'Before', is_locked: false, profile_image: null });
    expect(await pictureOf(user.id)).toBeNull();
  });

  it('keeps the picture an account had when the edit removing it is refused', async () => {
    const user = await addUser('pictured');
    const admin = await addUser('removed-admin-2');
    const other = await addUser('other-admin-2');
    await makeAdmin(admin.id);
    await makeAdmin(other.id);
    const set = await updateUserByAdmin(user.uuid, {}, { mimeType: 'image/png', data: png() }, other.id);
    const picture = await pictureOf(user.id);
    expect(picture).not.toBeNull();
    expect(set?.profile_image).toContain(picture);

    const outcome = await editWhileRemoved(user.id, admin.id, () => updateUserByAdmin(user.uuid, { remove_profile_image: 'true' }, undefined, admin.id));

    expect((outcome as { error?: unknown }).error).toMatchObject({ status: 403, code: 'DEPLOYMENT_ADMIN_REQUIRED' });
    expect(await pictureOf(user.id)).toBe(picture);
    expect((await account(user.id)).profile_image).toBe(set?.profile_image);
  });

  // The edit share-locks the admin's deployment_users row after the account it edits, as
  // the lock order has it; a delete of that admin takes their account, then that row
  // (lock_deployment_users_of): the delete waits for the edit there, holding nothing the
  // edit needs, and both go through.
  it('waits in turn with a delete of the editing admin, never deadlocking', async () => {
    const user = await addUser('pictured-target');
    const admin = await addUser('deleted-admin');
    const other = await addUser('deleting-admin');
    await makeAdmin(admin.id);
    await makeAdmin(other.id);
    await updateUserByAdmin(user.uuid, {}, { mimeType: 'image/png', data: png() }, other.id);

    // The edit stops at the picture it replaces, holding the account and the admin's role.
    const gate: PoolClient = await owner.connect();
    let editing: Promise<unknown> | undefined;
    let deleting: Promise<unknown> | undefined;
    const waitersOf = async (pid: number) =>
      (await owner.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
    const until = async (check: () => Promise<boolean>) => {
      const deadline = Date.now() + 10_000;
      while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      await gate.query('BEGIN');
      const gatePid = (await gate.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await gate.query('SELECT 1 FROM user_profile_images WHERE user_id = $1 FOR UPDATE', [user.id]);
      editing = updateUserByAdmin(user.uuid, { first_name: 'Repictured' }, { mimeType: 'image/png', data: png() }, admin.id).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      let editPid: number | undefined;
      await until(async () => (editPid = (await waitersOf(gatePid))[0]) !== undefined);
      deleting = deleteUserByAdmin(admin.uuid, other.id).then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await until(async () => (await waitersOf(editPid!)).length > 0);
    } finally {
      await gate.query('COMMIT').catch(() => undefined);
      gate.release();
    }
    const [edited, deleted] = (await Promise.all([editing!, deleting!])) as Array<{ value?: unknown; error?: unknown }>;
    expect(edited, JSON.stringify(edited)).toHaveProperty('value');
    expect(deleted, JSON.stringify(deleted)).toHaveProperty('value');
    expect((await account(user.id)).first_name).toBe('Repictured');
    expect((await owner.query('SELECT 1 FROM users WHERE id = $1', [admin.id])).rowCount).toBe(0);
  });

  it("still goes through for an admin who keeps the role, picture and all", async () => {
    const user = await addUser('edited');
    const admin = await addUser('staying-admin');
    await makeAdmin(admin.id);
    const edited = await updateUserByAdmin(user.uuid, { first_name: 'After' }, { mimeType: 'image/png', data: png() }, admin.id);
    const picture = await pictureOf(user.id);
    expect(picture).not.toBeNull();
    expect(edited).toMatchObject({ id: user.id, first_name: 'After' });
    expect(edited?.profile_image).toContain(picture);
  });
});
