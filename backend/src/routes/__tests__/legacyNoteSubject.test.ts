import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { createAnnotationsRoutes } from '../annotations.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { insertLegacyRow } from '../../test/legacyRows.js';

/**
 * A note whose subject type notes aren't written on any more: a legacy value from
 * before check_known_or_unchanged, which keeps a row's value but refuses a new row of it.
 * Resolving every open thread wrote an answer on each, and the database refused the one on
 * that thread (23514): the whole resolve answered 500, and so did any reply to it. The
 * resolve now resolves that thread without an answer, and a reply to it is refused with a
 * reason (409 SUBJECT_TYPE_RETIRED).
 */
describe('a note on a subject type notes are no longer written on', () => {
  let app: Express;
  let tenant: TestTenant;
  let transaction: { id: number; uuid: string };

  beforeAll(async () => {
    tenant = await createTestTenant('Legacy note subject');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/annotations', createAnnotationsRoutes());
    const account = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Legacy notes checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0]!.id;
    transaction = (
      await tenant.pool.query<{ id: number; uuid: string }>(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description) VALUES ($1, -4, '2022-09-01', 'expense', 'Noted') RETURNING id, uuid`,
        [account]
      )
    ).rows[0]!;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  /** An open thread on a legacy subject type, written past the triggers as an old row was. */
  const legacyThread = () =>
    insertLegacyRow<{ id: number; uuid: string }>(
      `INSERT INTO annotations (tenant_id, subject_type, subject_id, kind, body, status) VALUES ($1, 'goal', 7, 'question', 'Old question', 'open') RETURNING id, uuid`,
      [tenant.tenantId]
    );
  const repliesTo = async (id: number) => (await tenant.pool.query('SELECT 1 FROM annotations WHERE parent_id = $1', [id])).rowCount;
  const statusOf = async (id: number) => (await tenant.pool.query<{ status: string }>('SELECT status FROM annotations WHERE id = $1', [id])).rows[0]!.status;

  it('resolving every open thread resolves it without an answer, and answers the others', async () => {
    const legacy = await legacyThread();
    const current = (
      await tenant.pool.query<{ id: number }>(
        `INSERT INTO annotations (subject_type, subject_id, kind, body) VALUES ('transaction', $1, 'question', 'Which store?') RETURNING id`,
        [transaction.id]
      )
    ).rows[0]!;

    const res = await request(app).post('/api/annotations/manual-resolve').send({ scope: 'all' });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.resolved).toBe(2);
    expect([await statusOf(legacy.id), await statusOf(current.id)]).toEqual(['answered', 'answered']);
    expect(await repliesTo(legacy.id)).toBe(0);
    expect(await repliesTo(current.id)).toBe(1);
  });

  it('resolving it alone resolves it', async () => {
    const legacy = await legacyThread();
    const res = await request(app).post('/api/annotations/manual-resolve').send({ uuid: legacy.uuid });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.resolved).toBe(1);
    expect(await statusOf(legacy.id)).toBe('answered');
  });

  it('a reply to it is refused with a reason, saving nothing', async () => {
    const legacy = await legacyThread();
    const res = await request(app).post('/api/annotations').send({ parent_uuid: legacy.uuid, kind: 'answer', body: 'An answer' });
    expect({ status: res.status, body: res.body }).toMatchObject({
      status: 409,
      body: { code: 'SUBJECT_TYPE_RETIRED', error: expect.stringMatching(/can't take a reply/) },
    });
    expect(await repliesTo(legacy.id)).toBe(0);
    expect(await statusOf(legacy.id)).toBe('open');
    // It can still be dismissed.
    const dismissed = await request(app).patch(`/api/annotations/${legacy.uuid}`).send({ status: 'dismissed' });
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
  });
});
