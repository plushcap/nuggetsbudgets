import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PoolClient } from 'pg';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

/**
 * A tagging or an annotation moved to another subject (an
 * UPDATE of taggable_type / taggable_id, subject_type / subject_id) locks its new subject
 * and is refused when that isn't there, as one inserted is. Only the insert
 * was covered: a row moved onto a subject being deleted, or onto one that doesn't exist or
 * is another ledger's, was left pointing at nothing. No app path moves one; these run the
 * UPDATEs as the app role, under RLS, as any other writer would.
 */
describe('a tag or a note moved to another subject', () => {
  let tenant: TestTenant;
  let other: TestTenant;
  let account: number;
  let transaction: number;
  let item: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Subject lock on update');
    other = await createTestTenant('Subject lock on update, other ledger');
    const one = async (pool: TestTenant['pool'], text: string, params: unknown[] = []) => (await pool.query<{ id: number }>(text, params)).rows[0]!.id;
    account = await one(tenant.pool, `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Lock checking', 'checking', 'cash', 'Asset') RETURNING id`);
    transaction = await one(tenant.pool, `INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, -1, '2022-10-01', 'expense') RETURNING id`, [account]);
    item = await one(tenant.pool, `INSERT INTO budget_items (name, expense_type) VALUES ('Lock item', 'Expense') RETURNING id`);
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  const note = async () =>
    (await tenant.pool.query<{ id: number }>(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('account', $1, 'note', 'Moved') RETURNING id`, [account])).rows[0]!.id;
  let tags = 0;
  /** A tagging of the transaction, with a tag of its own. */
  const tagging = async () => {
    const tag = (await tenant.pool.query<{ id: number }>('INSERT INTO tags (name) VALUES ($1) RETURNING id', [`Lock tag ${++tags}`])).rows[0]!.id;
    return (await tenant.pool.query<{ id: number }>(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2) RETURNING id`, [tag, transaction])).rows[0]!.id;
  };
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (err: { code?: string }) => err.code ?? 'no code'
    );
  const newAccount = async (name: string) =>
    (await tenant.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'savings', 'cash', 'Asset') RETURNING id`, [name])).rows[0]!.id;

  it('is refused when the new subject is not there, or is another ledger\'s', async () => {
    const n = await note();
    const t = await tagging();
    const missing = 2147483000;
    const theirs = (
      await other.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Their account', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0]!.id;

    expect(await refusal(tenant.pool.query('UPDATE annotations SET subject_id = $1 WHERE id = $2', [missing, n]))).toBe('23503');
    expect(await refusal(tenant.pool.query(`UPDATE annotations SET subject_type = 'merchant' WHERE id = $1`, [n]))).toBe('23503');
    expect(await refusal(tenant.pool.query('UPDATE annotations SET subject_id = $1 WHERE id = $2', [theirs, n]))).toBe('23503');
    expect(await refusal(tenant.pool.query('UPDATE taggings SET taggable_id = $1 WHERE id = $2', [missing, t]))).toBe('23503');
    expect(await refusal(tenant.pool.query(`UPDATE taggings SET taggable_type = 'budget_item', taggable_id = $1 WHERE id = $2`, [missing, t]))).toBe('23503');

    // Onto a subject that is there, it goes through; and a change of anything else isn't checked.
    expect(await refusal(tenant.pool.query(`UPDATE taggings SET taggable_type = 'budget_item', taggable_id = $1 WHERE id = $2`, [item, t]))).toBeNull();
    expect(await refusal(tenant.pool.query(`UPDATE annotations SET subject_type = 'transaction', subject_id = $1 WHERE id = $2`, [transaction, n]))).toBeNull();
    expect(await refusal(tenant.pool.query(`UPDATE annotations SET body = 'Edited', status = 'resolved' WHERE id = $1`, [n]))).toBeNull();
  });

  it('waits for a delete of the new subject under way, then is refused, leaving nothing orphaned', async () => {
    const n = await note();
    const doomed = await newAccount('Lock doomed');
    const deleter: PoolClient = await tenant.pool.connect();
    try {
      await deleter.query('BEGIN');
      const pid = (await deleter.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await deleter.query('DELETE FROM accounts WHERE id = $1', [doomed]);
      const moving = refusal(tenant.pool.query('UPDATE annotations SET subject_id = $1 WHERE id = $2', [doomed, n]));
      const deadline = Date.now() + 5_000;
      while ((await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount === 0) {
        if (Date.now() > deadline) throw new Error('the update never waited for the delete');
        await new Promise((r) => setTimeout(r, 20));
      }
      await deleter.query('COMMIT');
      expect(await moving).toBe('23503');
    } finally {
      await deleter.query('ROLLBACK').catch(() => undefined);
      deleter.release();
    }
    expect((await tenant.pool.query<{ subject_id: number }>('SELECT subject_id FROM annotations WHERE id = $1', [n])).rows[0]!.subject_id).toBe(account);
  });

  it('moved first, makes a delete of the new subject wait, which then deletes it with its subject', async () => {
    const t = await tagging();
    const n = await note();
    const target = await newAccount('Lock target');
    const targetItem = (await tenant.pool.query<{ id: number }>(`INSERT INTO budget_items (name, expense_type) VALUES ('Lock target item', 'Expense') RETURNING id`)).rows[0]!.id;
    const mover: PoolClient = await tenant.pool.connect();
    let deleting: Promise<unknown> | undefined;
    try {
      await mover.query('BEGIN');
      const pid = (await mover.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
      await mover.query('UPDATE annotations SET subject_id = $1 WHERE id = $2', [target, n]);
      await mover.query(`UPDATE taggings SET taggable_type = 'budget_item', taggable_id = $1 WHERE id = $2`, [targetItem, t]);
      deleting = Promise.all([
        tenant.pool.query('DELETE FROM accounts WHERE id = $1', [target]),
        tenant.pool.query('DELETE FROM budget_items WHERE id = $1', [targetItem]),
      ]);
      const deadline = Date.now() + 5_000;
      while ((await tenant.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rowCount! < 2) {
        if (Date.now() > deadline) throw new Error('the deletes never waited for the moves');
        await new Promise((r) => setTimeout(r, 20));
      }
      await mover.query('COMMIT');
    } finally {
      await mover.query('ROLLBACK').catch(() => undefined);
      mover.release();
    }
    await deleting;
    expect((await tenant.pool.query('SELECT 1 FROM annotations WHERE id = $1', [n])).rowCount).toBe(0);
    expect((await tenant.pool.query('SELECT 1 FROM taggings WHERE id = $1', [t])).rowCount).toBe(0);
  });
});
