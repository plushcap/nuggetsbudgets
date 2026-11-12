import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool, type PoolClient } from 'pg';
import pool from '../../db.js';
import { createDataManagementRoutes } from '../data-management.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTagsRoutes } from '../tags.js';
import { createAnnotationsRoutes } from '../annotations.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { BackupService } from '../../services/BackupService.js';

/**
 * Delete Transactions against a tag or a note written on one of its transactions at the
 * same time. Taggings and annotations point at a transaction without a foreign key,
 * so writing one took no lock on it, and Delete's row locks didn't hold it up. One written
 * after Delete had checked its set against the preview was deleted with the
 * transaction unseen (maybe missing from the backup taken first), or, committed after it,
 * left pointing at nothing.
 *
 * A tag or a note now locks its transaction first (FOR KEY SHARE, as a foreign key check
 * does): the app before it writes (lockTransactionsForReference), the database as it inserts
 * one (trg_taggings_lock_transactions, trg_annotations_lock_transactions). So the two wait
 * for each other: written first, Delete sees it and deletes nothing (409 PREVIEW_OUTDATED);
 * Delete first, the write finds the transaction gone (404, or 23503 from the database).
 *
 * Each race is set up from other connections: a third holds a lock that stops one side
 * part-way (Delete as it deletes the transaction's receipt, after its check; a tagging as
 * it is checked against its tag), so the other meets it there.
 */
describe('delete-transactions against tags and notes written at the same time', () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let accountId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Delete transactions tags and notes');
    other = await createTestTenant('Delete transactions tags and notes, other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/data-management', createDataManagementRoutes({ backupService: new BackupService(pool) }));
    app.use('/api/transactions', createTransactionsRoutes());
    app.use('/api/tags', createTagsRoutes());
    app.use('/api/annotations', createAnnotationsRoutes());
    accountId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Tags and notes checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0].id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  type Row = { id: number; uuid: string };

  const add = async (date: string, merchantId: number | null = null): Promise<Row> =>
    (
      await tenant.pool.query<Row>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, merchant_id)
         VALUES ($1, -25, $2, 'expense', 'Tags and notes fixture', $3) RETURNING id, uuid`,
        [accountId, date, merchantId]
      )
    ).rows[0];
  const newTag = async (name: string): Promise<Row> =>
    (await tenant.pool.query<Row>('INSERT INTO tags (name) VALUES ($1) RETURNING id, uuid', [name])).rows[0];
  const tagOn = (tagId: number, transactionId: number) =>
    tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tagId, transactionId]);
  const noteOn = async (transactionId: number, body: string): Promise<Row> =>
    (
      await tenant.pool.query<Row>(
        `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', $1, 'question', $2) RETURNING id, uuid`,
        [transactionId, body]
      )
    ).rows[0];
  const receiptOn = async (transactionId: number) =>
    (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO attachments (name, original_filename, safe_filename, file_extension, file_name, transaction_id)
         VALUES ('Receipt', 'r.pdf', 'r.pdf', 'pdf', 'r.pdf', $1) RETURNING id`,
        [transactionId]
      )
    ).rows[0].id;

  const exists = async (id: number) => (await tenant.pool.query('SELECT 1 FROM transactions WHERE id = $1', [id])).rowCount === 1;
  /** The tags and notes that point at transaction `id` (none, once it is deleted). */
  const pointingAt = async (id: number) => {
    const tags = await tenant.pool.query(`SELECT 1 FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = $1`, [id]);
    const notes = await tenant.pool.query(`SELECT 1 FROM annotations WHERE subject_type = 'transaction' AND subject_id = $1`, [id]);
    return { tags: tags.rowCount, notes: notes.rowCount };
  };

  const monthRange = (month: string) => ({ dateFrom: `${month}-01`, dateTo: `${month}-28`, excludeBudgetPeriod: false });
  const preview = async (range: object) => {
    const res = await request(app).post('/api/data-management/preview-delete-transactions').send(range);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { count: number; selectionKey: string };
  };
  const startDelete = (range: object, previewed: { selectionKey: string }) =>
    request(app)
      .post('/api/data-management/delete-transactions')
      .send({ ...range, createBackup: false, selectionKey: previewed.selectionKey })
      .then((res) => res);

  /** Another connection, holding a transaction open until `release()`. */
  const holder = async (on: Pool = tenant.pool) => {
    const client: PoolClient = await on.connect();
    await client.query('BEGIN');
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let released = false;
    return {
      client,
      pid,
      commit: async () => {
        if (released) return;
        released = true;
        await client.query('COMMIT').catch(() => client.query('ROLLBACK'));
        client.release();
      },
      rollback: async () => {
        if (released) return;
        released = true;
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      },
    };
  };

  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map((r) => r.pid);
  /** The backend that waits for `pid`, once there is one. */
  const waiterOf = async (pid: number): Promise<number> => {
    let found: number | undefined;
    await waitUntil(async () => (found = (await waitersOf(pid))[0]) !== undefined);
    return found!;
  };
  /**
   * 'waited' once a backend waits for `pid` (`pending`'s, as it should), or 'went through'
   * once `pending` has settled without.
   */
  const waitedFor = async (pending: Promise<unknown>, pid: number): Promise<'waited' | 'went through'> => {
    let settled = false;
    let waiting = false;
    void pending.then(
      () => (settled = true),
      () => (settled = true)
    );
    await waitUntil(async () => settled || (waiting = (await waitersOf(pid)).length > 0));
    return waiting ? 'waited' : 'went through';
  };

  /**
   * Delete first: it has checked its set and is deleting the transaction (held at its
   * receipt), when `write` starts. Answers both outcomes; `write`'s error, if it threw.
   */
  const deleteFirst = async <C>(month: string, prepare: (x: Row) => Promise<C>, write: (x: Row, context: C) => Promise<unknown>) => {
    const x = await add(`${month}-10`);
    const receipt = await receiptOn(x.id);
    const context = await prepare(x);
    const range = monthRange(month);
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    const gate = await holder();
    let deleting: ReturnType<typeof startDelete> | undefined;
    let writing: Promise<unknown> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM attachments WHERE id = $1 FOR UPDATE', [receipt]);
      deleting = startDelete(range, previewed);
      const deletePid = await waiterOf(gate.pid);
      writing = write(x, context).catch((err: unknown) => err);
      // The write waits for Delete (its lock of the transaction); it went straight through.
      expect(await waitedFor(writing, deletePid)).toBe('waited');
    } finally {
      await gate.commit();
    }
    const [deleted, written] = await Promise.all([deleting!, writing!]);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(deleted.body.count).toBe(1);
    expect(await exists(x.id)).toBe(false);
    // Nothing points at the deleted transaction: no tag or note slipped in after it.
    expect(await pointingAt(x.id)).toEqual({ tags: 0, notes: 0 });
    return { x, context, written };
  };
  const answered = (written: unknown) => written as request.Response;

  it('a tag put on through /transactions/:uuid/tags waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-01',
      () => newTag('Tagged while deleting (transactions route)'),
      (x, tag) => request(app).post(`/api/transactions/${x.uuid}/tags/${tag.uuid}`).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it('a tag put on through /tags/transaction/:uuid waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-02',
      () => newTag('Tagged while deleting (tags route)'),
      (x, tag) => request(app).post(`/api/tags/transaction/${x.uuid}`).send({ tag_id: tag.id }).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it('a tag taken off waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-03',
      async (x) => {
        const tag = await newTag('Untagged while deleting');
        await tagOn(tag.id, x.id);
        return tag;
      },
      (x, tag) => request(app).delete(`/api/transactions/${x.uuid}/tags/${tag.uuid}`).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it('a new thread on it waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-04',
      async () => undefined,
      (x) =>
        request(app)
          .post('/api/annotations')
          .send({ subject_type: 'transaction', subject_uuid: x.uuid, kind: 'note', body: 'Noted while deleting' })
          .then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it('a reply to its thread waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-05',
      (x) => noteOn(x.id, 'Which card?'),
      (_x, note) =>
        request(app).post('/api/annotations').send({ parent_uuid: note.uuid, kind: 'answer', body: 'The blue one' }).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it('an edit of its note waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-06',
      (x) => noteOn(x.id, 'Before the edit'),
      (_x, note) => request(app).patch(`/api/annotations/${note.uuid}`).send({ body: 'Edited while deleting' }).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it('resolving its thread by hand waits for Delete, then answers 404', async () => {
    const { written } = await deleteFirst(
      '2021-07',
      (x) => noteOn(x.id, 'Resolve me'),
      (_x, note) => request(app).post('/api/annotations/manual-resolve').send({ uuid: note.uuid }).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(404);
  });

  it("re-applying a merchant's auto tag waits for Delete, and tags nothing deleted", async () => {
    const { written } = await deleteFirst(
      '2021-08',
      async (x) => {
        const tag = await newTag('Auto while deleting');
        const merchant = (
          await tenant.pool.query<Row>(`INSERT INTO merchants (name, transaction_auto_tag_id) VALUES ('Auto while deleting', $1) RETURNING id, uuid`, [tag.id])
        ).rows[0];
        await tenant.pool.query('UPDATE transactions SET merchant_id = $1 WHERE id = $2', [merchant.id, x.id]);
        return merchant;
      },
      (_x, merchant) => request(app).post(`/api/tags/auto-tag/merchant/${merchant.uuid}`).then((res) => res)
    );
    expect(answered(written).status, JSON.stringify(answered(written).body)).toBe(200);
  });

  it('a tagging any other writer inserts waits for Delete, then is refused (23503)', async () => {
    const { written } = await deleteFirst(
      '2021-09',
      () => newTag('Inserted while deleting'),
      (x, tag) => tagOn(tag.id, x.id)
    );
    expect(written).toMatchObject({ code: '23503' });
  });

  it('a note any other writer inserts waits for Delete, then is refused (23503)', async () => {
    const { written } = await deleteFirst(
      '2021-10',
      async () => undefined,
      (x) => noteOn(x.id, 'Inserted while deleting')
    );
    expect(written).toMatchObject({ code: '23503' });
  });

  /** Delete waits for `writer` (an open transaction that has written), which then commits. */
  const writeFirst = async (month: string, write: (x: Row, writer: PoolClient) => Promise<void>) => {
    const x = await add(`${month}-10`);
    const range = monthRange(month);
    const previewed = await preview(range);
    expect(previewed.count).toBe(1);

    const writer = await holder();
    let deleting: ReturnType<typeof startDelete> | undefined;
    try {
      await write(x, writer.client);
      deleting = startDelete(range, previewed);
      // Delete waits for the write's lock on the transaction; it went straight through.
      expect(await waitedFor(deleting, writer.pid)).toBe('waited');
    } finally {
      await writer.commit();
    }
    const deleted = await deleting!;
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.code).toBe('PREVIEW_OUTDATED');
    expect(await exists(x.id)).toBe(true);
    return x;
  };

  it('a tagging inserted first makes Delete wait, see it, and delete nothing', async () => {
    const tag = await newTag('Inserted before deleting');
    const x = await writeFirst('2021-11', (row, writer) =>
      writer.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'transaction', $2)`, [tag.id, row.id]).then(() => undefined)
    );
    expect(await pointingAt(x.id)).toEqual({ tags: 1, notes: 0 });
  });

  it('a note inserted first makes Delete wait, see it, and delete nothing', async () => {
    const x = await writeFirst('2021-12', (row, writer) =>
      writer
        .query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', $1, 'note', 'Before deleting')`, [row.id])
        .then(() => undefined)
    );
    expect(await pointingAt(x.id)).toEqual({ tags: 0, notes: 1 });
  });

  it('a tag put on through the route first makes Delete wait, see it, and delete nothing', async () => {
    const month = '2020-01';
    const x = await add(`${month}-10`);
    const tag = await newTag('Tagged before deleting');
    const range = monthRange(month);
    const previewed = await preview(range);

    // The tag row is held: the request stops as its tagging is checked against it (the
    // foreign key), once it has locked the transaction and written the tagging.
    const gate = await holder();
    let tagging: Promise<request.Response> | undefined;
    let deleting: ReturnType<typeof startDelete> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM tags WHERE id = $1 FOR UPDATE', [tag.id]);
      tagging = request(app).post(`/api/transactions/${x.uuid}/tags/${tag.uuid}`).then((res) => res);
      const taggingPid = await waiterOf(gate.pid);
      deleting = startDelete(range, previewed);
      expect(await waitedFor(deleting, taggingPid)).toBe('waited');
    } finally {
      await gate.commit();
    }
    const [tagged, deleted] = await Promise.all([tagging!, deleting!]);
    expect(tagged.status, JSON.stringify(tagged.body)).toBe(200);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.code).toBe('PREVIEW_OUTDATED');
    expect(await exists(x.id)).toBe(true);
    expect(await pointingAt(x.id)).toEqual({ tags: 1, notes: 0 });
  });

  /**
   * Re-applying a merchant's auto tag deletes its transactions' auto tags, then adds the
   * new one. It locks the transactions first: holding a deleted auto tag while it waited for
   * the transaction (the insert's lock), it would deadlock with Delete holding the
   * transaction and waiting for that tag (to delete it with the transaction).
   */
  it("re-applying a merchant's auto tag and Delete wait for each other, never deadlock", async () => {
    const month = '2020-02';
    const oldTag = await newTag('Old auto tag');
    const newAutoTag = await newTag('New auto tag');
    const merchant = (
      await tenant.pool.query<Row>(`INSERT INTO merchants (name, transaction_auto_tag_id) VALUES ('Re-tagged while deleting', $1) RETURNING id, uuid`, [
        oldTag.id,
      ])
    ).rows[0];
    const first = await add(`${month}-10`, merchant.id);
    const second = await add(`${month}-11`, merchant.id);
    const autoTags = async () =>
      (
        await tenant.pool.query<{ taggable_id: number; tag_id: number }>(
          `SELECT taggable_id, tag_id FROM taggings WHERE taggable_type = 'transaction' AND taggable_id = ANY($1::int[]) AND type = 'auto' ORDER BY taggable_id`,
          [[first.id, second.id]]
        )
      ).rows;
    expect(await autoTags()).toEqual([
      { taggable_id: first.id, tag_id: oldTag.id },
      { taggable_id: second.id, tag_id: oldTag.id },
    ]);
    const range = monthRange(month);
    const previewed = await preview(range);
    expect(previewed.count).toBe(2);
    await tenant.pool.query('UPDATE merchants SET transaction_auto_tag_id = $1 WHERE id = $2', [newAutoTag.id, merchant.id]);

    // A connection outside the app (the owner, its triggers off, so it locks nothing else)
    // has the first transaction's new auto tag written but not committed: the re-tagging
    // waits for it as it adds that tag, after it has deleted the old ones.
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    const gate = await holder(owner);
    let retagging: Promise<request.Response> | undefined;
    let deleting: ReturnType<typeof startDelete> | undefined;
    try {
      await gate.client.query(`SET LOCAL session_replication_role = replica`);
      await gate.client.query(
        `INSERT INTO taggings (tenant_id, tag_id, taggable_type, taggable_id, type) VALUES ($1, $2, 'transaction', $3, 'auto')`,
        [tenant.tenantId, newAutoTag.id, first.id]
      );
      retagging = request(app).post(`/api/tags/auto-tag/merchant/${merchant.uuid}`).then((res) => res);
      const retaggingPid = await waiterOf(gate.pid);
      deleting = startDelete(range, previewed);
      // Delete waits for the re-tagging's lock of the transactions (it went on, and waited
      // for the old auto tag the re-tagging had deleted).
      expect(await waitedFor(deleting, retaggingPid)).toBe('waited');
    } finally {
      await gate.rollback();
      await owner.end();
    }
    const [retagged, deleted] = await Promise.all([retagging!, deleting!]);

    // No deadlock: the re-tagging went first, and Delete found the auto tags changed.
    expect(retagged.status, JSON.stringify(retagged.body)).toBe(200);
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(409);
    expect(deleted.body.code).toBe('PREVIEW_OUTDATED');
    expect(await autoTags()).toEqual([
      { taggable_id: first.id, tag_id: newAutoTag.id },
      { taggable_id: second.id, tag_id: newAutoTag.id },
    ]);
  });

  it("refuses a tag or a note on a transaction that isn't there, or is another ledger's (23503)", async () => {
    const tag = await newTag('Pointing nowhere');
    const theirAccount = (
      await other.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Theirs', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    const theirs = (
      await other.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, -1, '2020-03-01', 'expense') RETURNING id`,
        [theirAccount]
      )
    ).rows[0].id;
    for (const id of [2147483000, theirs]) {
      await expect(tagOn(tag.id, id)).rejects.toMatchObject({ code: '23503' });
      await expect(noteOn(id, 'Nowhere')).rejects.toMatchObject({ code: '23503' });
    }
    // A budget item's tag isn't a transaction's: left as it was.
    const item = (await tenant.pool.query<{ id: number }>(`INSERT INTO budget_items (name, expense_type) VALUES ('Tagged item', 'Expense') RETURNING id`)).rows[0].id;
    await expect(tenant.pool.query(`INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'budget_item', $2)`, [tag.id, item])).resolves.toMatchObject({
      rowCount: 1,
    });
  });
});

/** Resolve once `check` answers true, polling; fail after 5 s. */
async function waitUntil(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
