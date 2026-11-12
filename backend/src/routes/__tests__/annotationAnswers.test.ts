import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  annotationCountsResponseSchema,
  annotationCreatedResponseSchema,
  annotationInboxResponseSchema,
  annotationManualResolveResponseSchema,
  annotationThreadsResponseSchema,
  annotationTimelineResponseSchema,
  annotationUpdatedResponseSchema,
  answerProblem,
} from '@nuggets/shared';
import type { z } from 'zod';
import { createAnnotationsRoutes } from '../annotations.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The annotation routes' answers against their `@nuggets/shared` schemas: each
 * is exactly what its schema names. annotationResponseSchema was a loose object (any field
 * passed), which no answer was checked against.
 */
describe('Annotation answers', () => {
  let tenant: TestTenant;
  let app: Express;
  const fits = (schema: z.ZodType, body: unknown) => expect(answerProblem(schema, body)).toBeNull();

  beforeAll(async () => {
    tenant = await createTestTenant('Annotation answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/annotations', createAnnotationsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('answers every annotation route as its schema says', async () => {
    const account = (
      await tenant.pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`)
    ).rows[0];
    const transaction = (
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, description, type) VALUES ($1, -9.99, '2026-10-01', 'Coffee', 'expense') RETURNING uuid`,
        [account.id]
      )
    ).rows[0];

    const root = await request(app)
      .post('/api/annotations')
      .send({
        subject_type: 'transaction', subject_uuid: transaction.uuid, kind: 'question', body: 'Coffee or groceries?',
        notify: true, severity: 'question', author_kind: 'agent', agent_name: 'categorizer', meta: { confidence: 0.4 },
      })
      .expect(201);
    fits(annotationCreatedResponseSchema, root.body);
    const reply = await request(app).post('/api/annotations').send({ parent_uuid: root.body.uuid, kind: 'answer', body: 'Coffee' }).expect(201);
    fits(annotationCreatedResponseSchema, reply.body);

    const timeline = await request(app).get(`/api/annotations?subject_type=transaction&subject_uuid=${transaction.uuid}`).expect(200);
    expect(timeline.body.annotations).toHaveLength(2);
    fits(annotationTimelineResponseSchema, timeline.body);
    const threads = await request(app).get('/api/annotations/threads?status=all').expect(200);
    expect(threads.body.threads[0].reply_count).toBe('1');
    fits(annotationThreadsResponseSchema, threads.body);
    fits(annotationCountsResponseSchema, (await request(app).get('/api/annotations/counts').expect(200)).body);
    const inbox = await request(app).get('/api/annotations/inbox').expect(200);
    expect(inbox.body.inbox).toHaveLength(1);
    fits(annotationInboxResponseSchema, inbox.body);
    fits(
      annotationUpdatedResponseSchema,
      (await request(app).patch(`/api/annotations/${root.body.uuid}`).send({ pinned: true, feedback: 'incorrect', feedback_reason: 'Groceries' }).expect(200)).body
    );
    fits(annotationInboxResponseSchema, (await request(app).get('/api/annotations/inbox').expect(200)).body);
    fits(annotationManualResolveResponseSchema, (await request(app).post('/api/annotations/manual-resolve').send({ scope: 'all' }).expect(200)).body);
  });
});
