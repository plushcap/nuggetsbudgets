import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness } from './routeHarness.js';

/**
 * /api/annotations through the real app under RLS: threads on a
 * transaction, replies and the status they move, the counts, thread list and agent
 * inbox, edits (agent reasoning is append-only), feedback and manual resolution. Ledger
 * B has its own transaction with an open thread, which A's calls must neither show,
 * count, answer, change nor resolve.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('Annotation routes', () => {
  let h: RouteHarness;
  let a: TestTenant;
  let b: TestTenant;
  let session: string;
  let txnA: string;
  let txnA2: string;
  let txnB: string;
  let threadB: string;

  const transaction = async (t: TestTenant, description: string) => {
    const account = (
      await t.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    return (
      await t.pool.query<{ uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, description, type) VALUES ($1, -9.99, '2026-10-01', $2, 'expense') RETURNING uuid`,
        [account, description]
      )
    ).rows[0].uuid;
  };
  const status = async (t: TestTenant, uuid: string) =>
    (await t.pool.query<{ status: string }>('SELECT status FROM annotations WHERE uuid = $1', [uuid])).rows[0]?.status;

  /** An agent's question on txnA, with notify (the categorizer's), through the route. */
  const askQuestion = async () => {
    const q = await h.call(session, 'post', '/api/annotations', {
      subject_type: 'transaction', subject_uuid: txnA, kind: 'question', body: 'Is this coffee or groceries?',
      notify: true, severity: 'question', author_kind: 'agent', agent_name: 'categorizer',
    });
    expect(q.status, q.text).toBe(201);
    return q;
  };
  /** An agent's reasoning on txnA2, through the route. */
  const giveReasoning = async () => {
    const r = await h.call(session, 'post', '/api/annotations', {
      subject_type: 'transaction', subject_uuid: txnA2, kind: 'reasoning', body: 'Hardware store, so Home.', author_kind: 'agent',
    });
    expect(r.status, r.text).toBe(201);
    return r;
  };

  beforeAll(async () => {
    h = await startRouteHarness('Annotations');
    a = await createTestTenant('Annotations A');
    b = await createTestTenant('Annotations B');
    session = await h.signIn(a.userId, a.tenantId);
    txnA = await transaction(a, 'Coffee');
    txnA2 = await transaction(a, 'Hardware');
    txnB = await transaction(b, 'Their coffee');
    const subjectB = (await b.pool.query<{ id: number }>('SELECT id FROM transactions WHERE uuid = $1', [txnB])).rows[0].id;
    threadB = (
      await b.pool.query<{ uuid: string }>(
        `INSERT INTO annotations (subject_type, subject_id, author_kind, kind, body, status, notify)
         VALUES ('transaction', $1, 'agent', 'question', 'Their question', 'open', true) RETURNING uuid`,
        [subjectB]
      )
    ).rows[0].uuid;
  }, 60_000);

  // The counts, the thread list and the inbox are the ledger's: each test starts with no
  // threads in A and makes its own, so any one passes alone (`-t`, `.only`) or in another
  // order. B's thread stays.
  beforeEach(async () => {
    await a.pool.query('DELETE FROM annotations');
  });

  afterAll(async () => {
    const settled = await Promise.allSettled([h?.close(), a?.cleanup(), b?.cleanup()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it("starts threads on this ledger's transactions only", async () => {
    const q = await askQuestion();
    expect(q.body).toMatchObject({ subject_type: 'transaction', kind: 'question', status: 'open', subject_uuid: txnA });
    const r = await giveReasoning();
    expect(r.body).toMatchObject({ subject_type: 'transaction', kind: 'reasoning', subject_uuid: txnA2 });

    const foreign = await h.call(session, 'post', '/api/annotations', { subject_type: 'transaction', subject_uuid: txnB, kind: 'note', body: 'x' });
    expect(foreign.status).toBe(404);
    const unsupported = await h.call(session, 'post', '/api/annotations', { subject_type: 'merchant', subject_uuid: txnA, kind: 'note', body: 'x' });
    expect(unsupported.status).toBe(400);
    const replyToTheirs = await h.call(session, 'post', '/api/annotations', { parent_uuid: threadB, kind: 'answer', body: 'mine' });
    expect(replyToTheirs.status).toBe(404);

    const theirs = await b.pool.query('SELECT count(*)::int AS n FROM annotations');
    expect(theirs.rows[0].n).toBe(1);
  });

  it("counts and lists this ledger's open threads", async () => {
    const question = (await askQuestion()).body.uuid;
    await giveReasoning();

    const counts = await h.call(session, 'get', '/api/annotations/counts');
    expect(counts.status).toBe(200);
    expect(counts.body).toEqual({ open: 2, notify: 1 });

    const threads = await h.call(session, 'get', '/api/annotations/threads?notify=true');
    expect(threads.status).toBe(200);
    expect(threads.body.threads.map((t: { uuid: string }) => t.uuid)).toEqual([question]);
    expect(threads.body.threads[0]).toMatchObject({ subject_uuid: txnA, subject_label: 'Coffee', agent_name: 'categorizer' });
  });

  it("answers a thread: the reply inherits its subject, moves it to 'answered' and reaches the agent's inbox", async () => {
    const question = (await askQuestion()).body.uuid;
    await giveReasoning();

    const reply = await h.call(session, 'post', '/api/annotations', { parent_uuid: question, kind: 'answer', body: 'Groceries.', notify: true });
    expect(reply.status, reply.text).toBe(201);
    expect(reply.body.subject_type).toBe('transaction');
    expect(await status(a, question)).toBe('answered');
    // Thread-level fields stay on the root.
    const row = (await a.pool.query('SELECT notify, status, parent_id IS NOT NULL AS is_reply FROM annotations WHERE uuid = $1', [reply.body.uuid])).rows[0];
    expect(row).toEqual({ notify: false, status: 'open', is_reply: true });

    const timeline = await h.call(session, 'get', `/api/annotations?subject_type=transaction&subject_uuid=${txnA}`);
    expect(timeline.status).toBe(200);
    expect(timeline.body.annotations.map((x: { uuid: string; parent_uuid: string | null }) => [x.uuid, x.parent_uuid])).toEqual([
      [question, null],
      [reply.body.uuid, question],
    ]);
    expect((await h.call(session, 'get', `/api/annotations?subject_type=transaction&subject_uuid=${txnB}`)).status).toBe(404);

    const inbox = await h.call(session, 'get', '/api/annotations/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.inbox.map((x: { uuid: string; inbox_reason: string; last_body: string }) => [x.uuid, x.inbox_reason, x.last_body])).toEqual([
      [question, 'reply', 'Groceries.'],
    ]);
    // The reasoning is still open; the question isn't, and nothing asks to notify.
    const counts = await h.call(session, 'get', '/api/annotations/counts');
    expect(counts.body).toEqual({ open: 1, notify: 0 });
  });

  it("keeps an agent's reasoning append-only, and queues a decision marked incorrect for the agent", async () => {
    const reasoning = (await giveReasoning()).body.uuid;

    const edit = await h.call(session, 'patch', `/api/annotations/${reasoning}`, { body: 'Rewritten' });
    expect(edit.status).toBe(400);
    expect((await a.pool.query('SELECT body FROM annotations WHERE uuid = $1', [reasoning])).rows[0].body).toBe('Hardware store, so Home.');

    const feedback = await h.call(session, 'patch', `/api/annotations/${reasoning}`, { feedback: 'incorrect', feedback_reason: 'It was a gift' });
    expect(feedback.status, feedback.text).toBe(200);
    expect(feedback.body.feedback).toBe('incorrect');
    const inbox = await h.call(session, 'get', '/api/annotations/inbox');
    const entry = inbox.body.inbox.find((x: { uuid: string }) => x.uuid === reasoning);
    expect(entry).toMatchObject({ inbox_reason: 'feedback', learning_status: 'pending', feedback_reason: 'It was a gift' });

    const resolved = await h.call(session, 'patch', `/api/annotations/${reasoning}`, { status: 'resolved' });
    expect(resolved.status).toBe(200);
    const row = (await a.pool.query('SELECT status, resolved_by_user_id FROM annotations WHERE uuid = $1', [reasoning])).rows[0];
    expect(row).toEqual({ status: 'resolved', resolved_by_user_id: a.userId });

    expect((await h.call(session, 'patch', `/api/annotations/${threadB}`, { status: 'dismissed' })).status).toBe(404);
    expect(await status(b, threadB)).toBe('open');
  });

  it("resolves open threads by hand with an answer each, never another ledger's", async () => {
    const third = await h.call(session, 'post', '/api/annotations', { subject_type: 'transaction', subject_uuid: txnA2, kind: 'flag', body: 'Duplicate?' });
    expect(third.status).toBe(201);

    expect((await h.call(session, 'post', '/api/annotations/manual-resolve', { uuid: threadB })).status).toBe(404);
    const all = await h.call(session, 'post', '/api/annotations/manual-resolve', { scope: 'all' });
    expect(all.status, all.text).toBe(200);
    expect(all.body.resolved).toBe(1);
    expect(await status(a, third.body.uuid)).toBe('answered');
    const answers = await a.pool.query(
      `SELECT kind, author_user_id FROM annotations WHERE parent_id = (SELECT id FROM annotations WHERE uuid = $1)`,
      [third.body.uuid]
    );
    expect(answers.rows).toEqual([{ kind: 'answer', author_user_id: a.userId }]);

    // B's thread is untouched and still counted in B.
    expect(await status(b, threadB)).toBe('open');
    expect((await b.pool.query('SELECT count(*)::int AS n FROM annotations')).rows[0].n).toBe(1);
    // Running it again finds nothing open.
    expect((await h.call(session, 'post', '/api/annotations/manual-resolve', { scope: 'all' })).body.resolved).toBe(0);
  });
});
