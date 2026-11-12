import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { createAnnotationsRoutes } from '../annotations.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The agent inbox's cursor. The agent polls GET /api/annotations/inbox and passes
 * back where it got to. With `since` alone (the last thread's last_activity_at), a page
 * that ended inside a run of threads sharing one timestamp skipped the rest of that run on
 * the next poll; and the answer's timestamps have milliseconds while the database keeps
 * microseconds, so the last thread came back again. The threads are now in
 * (last_activity_at to the millisecond, uuid) order, and the cursor is both: the answer's
 * next_since and next_since_uuid, passed back as since and since_uuid. Paged that way, every
 * thread comes once. `since` alone works as it did.
 */
describe('the agent inbox pages with a tiebreaker', () => {
  let app: Express;
  let tenant: TestTenant;
  let transactionId: number;

  beforeAll(async () => {
    tenant = await createTestTenant('Annotation inbox cursor');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/annotations', createAnnotationsRoutes());
    const account = (
      await tenant.pool.query<{ id: number }>(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Inbox', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0].id;
    transactionId = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -3, '2026-10-01', 'expense', 'Inbox fixture') RETURNING id`,
        [account]
      )
    ).rows[0].id;
  });

  beforeEach(async () => {
    await tenant.pool.query('DELETE FROM annotations');
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** A thread a human opened at `at` (a timestamptz literal). */
  const thread = async (at: string, extra: { learning_status?: string; author_kind?: string } = {}) =>
    (
      await tenant.pool.query<{ uuid: string }>(
        `INSERT INTO annotations (subject_type, subject_id, kind, body, author_kind, created_at, learning_status)
         VALUES ('transaction', $1, 'question', 'Which one?', $3, $2::timestamptz, $4) RETURNING uuid`,
        [transactionId, at, extra.author_kind ?? 'user', extra.learning_status ?? null]
      )
    ).rows[0].uuid;

  type Inbox = { since: string; inbox: Array<{ uuid: string; last_activity_at: string; inbox_reason: string }>; next_since: string; next_since_uuid: string | null };
  const poll = async (query: Record<string, string | number>): Promise<Inbox> =>
    (await request(app).get('/api/annotations/inbox').query(query).expect(200)).body;

  /** Every thread, a page of `limit` at a time, as an agent pages through them. */
  const pageThrough = async (limit: number) => {
    const seen: string[] = [];
    let cursor: Record<string, string> = {};
    for (let i = 0; i < 20; i++) {
      const page = await poll({ ...cursor, limit });
      seen.push(...page.inbox.map((t) => t.uuid));
      if (page.inbox.length < limit) return seen;
      cursor = { since: page.next_since, since_uuid: page.next_since_uuid! };
    }
    throw new Error('the inbox never ran out');
  };

  it('answers every thread once, paged through a run that shares a timestamp', async () => {
    // Five threads in one microsecond, three in one millisecond (different microseconds), and one later.
    const same = [];
    for (let i = 0; i < 5; i++) same.push(await thread('2026-10-02 10:00:00.123456+00'));
    const sameMs = [
      await thread('2026-10-02 10:00:01.500100+00'),
      await thread('2026-10-02 10:00:01.500200+00'),
      await thread('2026-10-02 10:00:01.500300+00'),
    ];
    const later = await thread('2026-10-02 11:00:00+00');
    const expected = [...[...same].sort(), ...[...sameMs].sort(), later];

    for (const limit of [1, 2, 3, 4, 50]) {
      expect(await pageThrough(limit), `limit ${limit}`).toEqual(expected);
    }
  });

  it("takes the answer's own last thread as the cursor too: its last_activity_at and uuid", async () => {
    const a = await thread('2026-10-03 09:00:00.000700+00');
    const b = await thread('2026-10-03 09:00:00.000700+00');
    const [first, second] = [a, b].sort();
    const page = await poll({ limit: 1 });
    expect(page.inbox.map((t) => t.uuid)).toEqual([first]);
    // The answer shows the millisecond; that and the uuid are the cursor.
    expect(page.inbox[0].last_activity_at).toBe('2026-10-03T09:00:00.000Z');
    expect([page.next_since, page.next_since_uuid]).toEqual(['2026-10-03T09:00:00.000Z', first]);
    const next = await poll({ since: page.inbox[0].last_activity_at, since_uuid: page.inbox[0].uuid.toUpperCase(), limit: 1 });
    expect(next.inbox.map((t) => t.uuid)).toEqual([second]);
    const after = await poll({ since: next.next_since, since_uuid: next.next_since_uuid!, limit: 1 });
    expect(after.inbox).toEqual([]);
    // Nothing new: the cursor stays where it was.
    expect([after.next_since, after.next_since_uuid]).toEqual([next.next_since, next.next_since_uuid]);
  });

  it('answers feedback whatever the cursor, without moving the cursor back', async () => {
    await thread('2026-10-04 08:00:00+00');
    const feedback = await thread('2026-10-01 08:00:00+00', { learning_status: 'pending' });
    const cursor = { since: '2026-10-04T08:00:00.000Z', since_uuid: 'ffffffff-ffff-7fff-bfff-ffffffffffff' };
    const page = await poll(cursor);
    expect(page.inbox.map((t) => [t.uuid, t.inbox_reason])).toEqual([[feedback, 'feedback']]);
    expect([page.next_since, page.next_since_uuid]).toEqual([cursor.since, cursor.since_uuid]);
  });

  it('keeps `since` alone working as before, and refuses a since_uuid that is not one', async () => {
    const old = await thread('2026-10-05 08:00:00+00');
    const recent = await thread('2026-10-05 09:00:00+00');
    expect((await poll({ since: '2026-10-05T08:30:00Z' })).inbox.map((t) => t.uuid)).toEqual([recent]);
    expect((await poll({})).inbox.map((t) => t.uuid)).toEqual([old, recent]);
    const res = await request(app).get('/api/annotations/inbox').query({ since: '2026-10-05T08:30:00Z', since_uuid: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CURSOR');
  });

  it('refuses a since that is not an ISO time, rather than move the cursor or fail', async () => {
    // 'today' Postgres reads and JavaScript doesn't: the cursor moved back to an old
    // feedback thread. 'not a time' and '2026-02-30T00:00:00Z' were a 500.
    // An offset past ±15:59 Postgres refuses; a time without a zone the two read differently.
    for (const since of ['today', 'not a time', '2026-02-30T00:00:00Z', '1', 'yesterday 10:00', '2026-10-05T08:30:00+16:00', '2026-10-05T08:30:00-18:00', '2026-10-05T08:30:00', '0049-06-15 12:00Z']) {
      const res = await request(app).get('/api/annotations/inbox').query({ since });
      expect(res.status, since).toBe(400);
      expect(res.body.code, since).toBe('INVALID_CURSOR');
    }
    for (const since of ['2026-10-05', '2026-10-05T08:30:00Z', '2026-10-05T08:30:00.123456+02:00', '2026-10-05 08:30:00+00', '2026-10-05T08:30:00-15:59', '2026-10-05T08:30:00+05:30']) {
      expect((await request(app).get('/api/annotations/inbox').query({ since })).status, since).toBe(200);
    }
  });

  it("leaves out a thread whose last word is the agent's", async () => {
    await thread('2026-10-06 08:00:00+00', { author_kind: 'agent' });
    expect((await poll({})).inbox).toEqual([]);
  });
});
