import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

/**
 * Hold an edit between its commit and its answer: once the real account change has
 * committed (applyUserAccountFlags, or applyUserAccountFlagsAnd with what it read back
 * under the lock), the armed edit waits for `release` before its caller goes on, as a busy
 * event loop or pool might hold it.
 */
const gate = vi.hoisted(() => ({
  armed: null as null | { committed: () => void; release: Promise<void> },
}));

vi.mock('../services/userFlagsService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/userFlagsService.js')>();
  const held =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const result = await fn(...args);
      const armed = gate.armed;
      if (armed) {
        gate.armed = null;
        armed.committed();
        await armed.release;
      }
      return result;
    };
  const mocked: Record<string, unknown> = { ...actual, applyUserAccountFlags: held(actual.applyUserAccountFlags) };
  if ('applyUserAccountFlagsAnd' in actual) mocked.applyUserAccountFlagsAnd = held(actual.applyUserAccountFlagsAnd);
  return mocked;
});

import { Pool } from 'pg';
import { updateUserByAdmin } from '../services/UserService.js';

/**
 * Two deployment admins editing one account at once: each edit runs under the
 * user's row lock, so the later write wins whole, but the edit read its answer after its
 * transaction committed. The other admin's edit, waiting for the lock, could commit in
 * between, and the first admin was answered with the second's write. The answer is now
 * read in the same transaction, under the lock: each admin's answer is their own edit.
 */
describe("a deployment admin's edit answers with its own write", () => {
  let owner: Pool;
  const ids: number[] = [];

  const addUser = async (label: string) => {
    const { rows } = await owner.query<{ id: number; uuid: string }>(
      `INSERT INTO users (email, password_hash, first_name, last_name) VALUES ($1, 'x', 'Test', $2) RETURNING id, uuid`,
      [`admin-edit-answer-${label}-${process.pid}-${Date.now()}@test.local`, label]
    );
    ids.push(rows[0].id);
    return rows[0];
  };

  beforeAll(() => {
    owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 2 });
  });

  afterAll(async () => {
    if (ids.length) await owner?.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    await owner?.end();
  });

  it("answers the first admin's edit with their write, though the second committed before it answered", async () => {
    const user = await addUser('edited');
    const adminA = await addUser('admin-a');
    const adminB = await addUser('admin-b');
    // Deployment admins: the edit checks the acting admin's role under its lock.
    for (const admin of [adminA, adminB]) {
      await owner.query(`INSERT INTO deployment_users (user_id, deployment_id, role) SELECT $1, id, 'admin' FROM deployment ORDER BY id LIMIT 1`, [admin.id]);
    }

    let committed!: () => void;
    let release!: () => void;
    const aCommitted = new Promise<void>((resolve) => (committed = resolve));
    gate.armed = { committed, release: new Promise<void>((resolve) => (release = resolve)) };

    const first = updateUserByAdmin(user.uuid, { first_name: 'Alpha' }, undefined, adminA.id);
    try {
      await aCommitted;
      // A's edit has committed and not answered yet: B's goes through whole meanwhile.
      const second = await updateUserByAdmin(user.uuid, { first_name: 'Bravo' }, undefined, adminB.id);
      expect(second).toMatchObject({ id: user.id, first_name: 'Bravo' });
    } finally {
      release();
    }
    expect(await first).toMatchObject({ id: user.id, uuid: user.uuid, first_name: 'Alpha' });
    // The later write is the one kept.
    expect((await owner.query('SELECT first_name FROM users WHERE id = $1', [user.id])).rows[0].first_name).toBe('Bravo');
  });
});
