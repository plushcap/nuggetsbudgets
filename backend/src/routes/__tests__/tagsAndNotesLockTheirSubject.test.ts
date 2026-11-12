import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { Pool, type PoolClient } from 'pg';
import { createTagsRoutes } from '../tags.js';
import { createAnnotationsRoutes } from '../annotations.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A tag or a note on something other than a transaction, written while that subject is
 * deleted. A tag or a note on a transaction already locked it as it was written; the
 * other subjects (an account's, a merchant's or a budget item's notes, a budget item's tags,
 * …) took no lock. Each is deleted with its subject (delete_polymorphic_references), but one
 * written while the delete ran, and committed after it, was left pointing at nothing.
 *
 * Now the database locks the subject as one is inserted (trg_taggings_lock_subjects,
 * trg_annotations_lock_subjects: FOR KEY SHARE, what a foreign key check takes) and the app
 * before it writes one (lockRowsForReference), so the two wait for each other, in either
 * order: the delete first, the write waits and is refused (23503, or a 404 from the app);
 * the write first, the delete waits and then deletes it with its subject. Either way
 * nothing is left pointing at a row that isn't there.
 *
 * Each race is set up from other connections, each holding its transaction open.
 */
describe('tags and notes on accounts, merchants and budget items against their deletion', () => {
  let app: Express;
  let tenant: TestTenant;
  let other: TestTenant;
  let tagId: number;
  let seq = 0;

  type Row = { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Tags and notes lock their subject');
    other = await createTestTenant('Tags and notes lock their subject, other ledger');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
    app.use('/api/annotations', createAnnotationsRoutes());
    tagId = (await tenant.pool.query<{ id: number }>(`INSERT INTO tags (name) VALUES ('Subject lock tag') RETURNING id`)).rows[0].id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
    await other?.cleanup();
  });

  /** A new subject of each kind, in `on`'s ledger. */
  const subjects = {
    account: {
      table: 'accounts',
      add: async (on: TestTenant = tenant): Promise<Row> =>
        (
          await on.pool.query<Row>(
            `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'checking', 'cash', 'Asset') RETURNING id, uuid`,
            [`Subject lock account ${++seq}`]
          )
        ).rows[0],
    },
    merchant: {
      table: 'merchants',
      add: async (on: TestTenant = tenant): Promise<Row> =>
        (await on.pool.query<Row>(`INSERT INTO merchants (name) VALUES ($1) RETURNING id, uuid`, [`Subject lock merchant ${++seq}`])).rows[0],
    },
    budget_item: {
      table: 'budget_items',
      add: async (on: TestTenant = tenant): Promise<Row> =>
        (
          await on.pool.query<Row>(`INSERT INTO budget_items (name, expense_type) VALUES ($1, 'Expense') RETURNING id, uuid`, [
            `Subject lock item ${++seq}`,
          ])
        ).rows[0],
    },
  } as const;
  type Kind = keyof typeof subjects;

  /** The writes that point at a subject: a note on each kind, and a budget item's tag. */
  const writes: Array<{ name: string; kind: Kind; sql: string; params: (id: number) => unknown[] }> = [
    ...(['account', 'merchant', 'budget_item'] as const).map((kind) => ({
      name: `a note on a ${kind}`,
      kind,
      sql: `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ($1, $2, 'note', 'Written meanwhile')`,
      params: (id: number) => [kind, id],
    })),
    {
      name: "a budget item's tag",
      kind: 'budget_item',
      sql: `INSERT INTO taggings (tag_id, taggable_type, taggable_id) VALUES ($1, 'budget_item', $2)`,
      params: (id: number) => [tagId, id],
    },
  ];

  /** The tags and notes that point at `kind` row `id` (none once it is deleted). */
  const pointingAt = async (kind: Kind, id: number) => {
    const tags = await tenant.pool.query(`SELECT 1 FROM taggings WHERE taggable_type = $1 AND taggable_id = $2`, [kind, id]);
    const notes = await tenant.pool.query(`SELECT 1 FROM annotations WHERE subject_type = $1 AND subject_id = $2`, [kind, id]);
    return { tags: tags.rowCount, notes: notes.rowCount };
  };
  const exists = async (kind: Kind, id: number) =>
    (await tenant.pool.query(`SELECT 1 FROM ${subjects[kind].table} WHERE id = $1`, [id])).rowCount === 1;

  /** Another connection, holding a transaction open until `commit()`. */
  const holder = async () => {
    const client: PoolClient = await tenant.pool.connect();
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
    };
  };
  const waitersOf = async (pid: number) =>
    (await tenant.pool.query<{ pid: number }>('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid])).rows.map(
      (r) => r.pid
    );
  /** 'waited' once a backend waits for `pid`, or 'went through' once `pending` settled without. */
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

  it.each(writes.map((w) => [w.name, w] as const))('%s written while its subject is deleted waits, then is refused (23503)', async (_name, write) => {
    const subject = await subjects[write.kind].add();
    const deleting = await holder();
    const writer = await holder();
    let written: Promise<unknown> | undefined;
    try {
      await deleting.client.query(`DELETE FROM ${subjects[write.kind].table} WHERE id = $1`, [subject.id]);
      written = writer.client.query(write.sql, write.params(subject.id)).catch((err: unknown) => err);
      // The write waits for the delete (its lock of the subject); it went straight through.
      expect(await waitedFor(written, deleting.pid)).toBe('waited');
    } finally {
      await deleting.commit();
    }
    expect(await written).toMatchObject({ code: '23503' });
    await writer.commit();
    expect(await exists(write.kind, subject.id)).toBe(false);
    expect(await pointingAt(write.kind, subject.id)).toEqual({ tags: 0, notes: 0 });
  });

  it.each(writes.map((w) => [w.name, w] as const))('%s written first makes the delete wait, which deletes it with its subject', async (_name, write) => {
    const subject = await subjects[write.kind].add();
    const writer = await holder();
    let deleting: Promise<unknown> | undefined;
    try {
      await writer.client.query(write.sql, write.params(subject.id));
      deleting = tenant.pool.query(`DELETE FROM ${subjects[write.kind].table} WHERE id = $1`, [subject.id]);
      // The delete waits for the write's lock of the subject; it went straight through.
      expect(await waitedFor(deleting, writer.pid)).toBe('waited');
    } finally {
      await writer.commit();
    }
    expect(await deleting).toMatchObject({ rowCount: 1 });
    expect(await exists(write.kind, subject.id)).toBe(false);
    expect(await pointingAt(write.kind, subject.id)).toEqual({ tags: 0, notes: 0 });
  });

  it("refuses a tag or a note on a subject that isn't there, or is another ledger's (23503)", async () => {
    for (const kind of ['account', 'merchant', 'budget_item'] as const) {
      const theirs = await subjects[kind].add(other);
      for (const id of [2147483000, theirs.id]) {
        for (const write of writes.filter((w) => w.kind === kind)) {
          await expect(tenant.pool.query(write.sql, write.params(id)), `${write.name} ${id}`).rejects.toMatchObject({ code: '23503' });
        }
      }
      // Their own subject takes them.
      expect((await other.pool.query(`SELECT 1 FROM annotations WHERE subject_type = $1 AND subject_id = $2`, [kind, theirs.id])).rowCount).toBe(0);
    }
    // And this ledger's own does: a note on each, and a tag on its budget item.
    for (const write of writes) {
      const mine = await subjects[write.kind].add();
      await expect(tenant.pool.query(write.sql, write.params(mine.id))).resolves.toMatchObject({ rowCount: 1 });
    }
    // The other subject types are checked the same way (a category's note, a tag's).
    await expect(
      tenant.pool.query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('tag', 2147483000, 'note', 'x')`)
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      tenant.pool.query(`INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('tag', $1, 'note', 'x')`, [tagId])
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  /** The app's writes, which lock the subject before they write: a 404 once it's gone. */
  const appWrites = [
    {
      name: 'POST /api/tags/budget-items/:uuid/tags',
      kind: 'budget_item' as const,
      prepare: async () => undefined,
      send: (item: Row) => request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: tagId }),
    },
    {
      name: 'PUT /api/tags/budget-items/:uuid/namespace/:rootUuid',
      kind: 'budget_item' as const,
      prepare: async () => {
        const root = (await tenant.pool.query<Row>(`INSERT INTO tags (name, is_report_root) VALUES ($1, true) RETURNING id, uuid`, [`Subject lock root ${++seq}`])).rows[0];
        const child = (await tenant.pool.query<Row>(`INSERT INTO tags (name, parent_id) VALUES ($1, $2) RETURNING id, uuid`, [`Subject lock child ${++seq}`, root.id])).rows[0];
        return { root, child };
      },
      send: (item: Row, ctx: unknown) => {
        const { root, child } = ctx as { root: Row; child: Row };
        return request(app).put(`/api/tags/budget-items/${item.uuid}/namespace/${root.uuid}`).send({ tag_uuid: child.uuid });
      },
    },
    {
      name: "POST /api/annotations (a reply to an account's thread)",
      kind: 'account' as const,
      prepare: async (subject: Row) =>
        (
          await tenant.pool.query<Row>(
            `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('account', $1, 'question', 'Which bank?') RETURNING id, uuid`,
            [subject.id]
          )
        ).rows[0],
      send: (_subject: Row, ctx: unknown) =>
        request(app).post('/api/annotations').send({ parent_uuid: (ctx as Row).uuid, kind: 'answer', body: 'The credit union' }),
    },
    {
      name: "PATCH /api/annotations/:uuid (a merchant's note)",
      kind: 'merchant' as const,
      prepare: async (subject: Row) =>
        (
          await tenant.pool.query<Row>(
            `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('merchant', $1, 'note', 'Before') RETURNING id, uuid`,
            [subject.id]
          )
        ).rows[0],
      send: (_subject: Row, ctx: unknown) => request(app).patch(`/api/annotations/${(ctx as Row).uuid}`).send({ body: 'Edited meanwhile' }),
    },
  ];

  it.each(appWrites.map((w) => [w.name, w] as const))('%s while its subject is deleted waits, then answers 404', async (_name, write) => {
    const subject = await subjects[write.kind].add();
    const context = await write.prepare(subject);
    const deleting = await holder();
    let answer: Promise<request.Response> | undefined;
    try {
      await deleting.client.query(`DELETE FROM ${subjects[write.kind].table} WHERE id = $1`, [subject.id]);
      answer = write.send(subject, context).then((res) => res);
      expect(await waitedFor(answer, deleting.pid)).toBe('waited');
    } finally {
      await deleting.commit();
    }
    const res = await answer!;
    expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await pointingAt(write.kind, subject.id)).toEqual({ tags: 0, notes: 0 });
  });

  // A legacy subject type check_known_or_unchanged kept has no table to lock: its note is
  // edited as before, not answered as gone.
  it('edits a note on a subject type it has no table for, as before', async () => {
    const owner = new Pool({ connectionString: process.env.TEST_DATABASE_URL || process.env.DATABASE_URL, max: 1 });
    try {
      const client = await owner.connect();
      let uuid: string;
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL session_replication_role = replica');
        uuid = (
          await client.query<{ uuid: string }>(
            `INSERT INTO annotations (tenant_id, subject_type, subject_id, kind, body) VALUES ($1, 'legacy_subject', 1, 'note', 'Old') RETURNING uuid`,
            [tenant.tenantId]
          )
        ).rows[0].uuid;
        await client.query('COMMIT');
      } finally {
        client.release();
      }
      const res = await request(app).patch(`/api/annotations/${uuid}`).send({ body: 'Edited' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.edited).toBe(true);
    } finally {
      await owner.end();
    }
  });

  it("a budget item's tag put on through the route first makes its delete wait, which then deletes the tag with it", async () => {
    const item = await subjects.budget_item.add();
    // The tag row is held: the request stops as its tagging is checked against it (the
    // foreign key), once it has locked the budget item and written the tagging.
    const gate = await holder();
    let tagging: Promise<request.Response> | undefined;
    let deleting: Promise<unknown> | undefined;
    try {
      await gate.client.query('SELECT 1 FROM tags WHERE id = $1 FOR UPDATE', [tagId]);
      tagging = request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: tagId }).then((res) => res);
      let taggingPid: number | undefined;
      await waitUntil(async () => (taggingPid = (await waitersOf(gate.pid))[0]) !== undefined);
      deleting = tenant.pool.query('DELETE FROM budget_items WHERE id = $1', [item.id]);
      expect(await waitedFor(deleting, taggingPid!)).toBe('waited');
    } finally {
      await gate.commit();
    }
    const tagged = await tagging!;
    expect(tagged.status, JSON.stringify(tagged.body)).toBe(201);
    expect(await deleting).toMatchObject({ rowCount: 1 });
    expect(await pointingAt('budget_item', item.id)).toEqual({ tags: 0, notes: 0 });
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
