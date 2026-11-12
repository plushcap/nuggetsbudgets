import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import path from 'path';
import { promises as fsp } from 'fs';
import {
  answerProblem,
  attachmentDeletedResponseSchema,
  attachmentListResponseSchema,
  attachmentUploadResponseSchema,
  categoryListResponseSchema,
  categoryResponseSchema,
  institutionDeletedResponseSchema,
  institutionListResponseSchema,
  institutionResponseSchema,
} from '@nuggets/shared';
import type { z } from 'zod';
import { createCategoriesRoutes } from '../categories.js';
import { createInstitutionsRoutes } from '../institutions.js';
import { createAttachmentRoutes } from '../attachments.js';
import { createTransactionsRoutes } from '../transactions.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The category, institution and attachment routes' answers against their `@nuggets/shared`
 * schemas: each is exactly what its schema names.
 */
describe('Category, institution and attachment answers', () => {
  let tenant: TestTenant;
  let app: Express;
  const fits = (schema: z.ZodType, body: unknown) => expect(answerProblem(schema, body)).toBeNull();
  const uploadDir = path.join(process.cwd(), 'uploads');
  const written: string[] = [];

  beforeAll(async () => {
    tenant = await createTestTenant('Reference answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/categories', createCategoriesRoutes());
    app.use('/api/institutions', createInstitutionsRoutes());
    app.use('/api/attachments', createAttachmentRoutes());
    app.use('/api/transactions', createTransactionsRoutes());
  });

  afterAll(async () => {
    await Promise.all(written.map((f) => fsp.unlink(path.join(uploadDir, f)).catch(() => undefined)));
    await tenant?.cleanup();
  });

  it('answers the category routes as their schemas say', async () => {
    const created = await request(app).post('/api/categories').send({ name: 'Food', icon: 'Utensils', notes: 'weekly' }).expect(201);
    fits(categoryResponseSchema, created.body);
    fits(categoryListResponseSchema, (await request(app).get('/api/categories').expect(200)).body);
    const updated = await request(app)
      .put(`/api/categories/${created.body.uuid}`)
      .send({ name: 'Food', icon: 'Utensils', description: null, priority: null, notes: null })
      .expect(200);
    expect(updated.body).toMatchObject({ notes: null, description: null, priority: 'Undefined' });
    fits(categoryResponseSchema, updated.body);
  });

  it('answers the institution routes as their schemas say', async () => {
    const created = await request(app).post('/api/institutions').send({ name: 'First Bank' }).expect(201);
    fits(institutionResponseSchema, created.body);
    await tenant.pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type, institution_id) VALUES ('At First Bank', 'checking', 'cash', 'Asset', $1)`,
      [created.body.id]
    );
    const list = await request(app).get('/api/institutions').expect(200);
    expect(list.body[0].account_count).toBe('1');
    fits(institutionListResponseSchema, list.body);
    fits(institutionResponseSchema, (await request(app).get(`/api/institutions/${created.body.uuid}`).expect(200)).body);
    fits(institutionResponseSchema, (await request(app).put(`/api/institutions/${created.body.uuid}`).send({ name: 'First Bank', notes: null }).expect(200)).body);
    const unused = await request(app).post('/api/institutions').send({ name: 'Closed Bank' }).expect(201);
    fits(institutionDeletedResponseSchema, (await request(app).delete(`/api/institutions/${unused.body.uuid}`).expect(200)).body);
  });

  it('answers the attachment routes as their schemas say', async () => {
    const account = (
      await tenant.pool.query(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Receipts', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).rows[0];
    const transaction = (
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type) VALUES ($1, -9.99, '2026-06-01', 'expense') RETURNING id, uuid`,
        [account.id]
      )
    ).rows[0];
    const uploaded = await request(app)
      .post('/api/attachments/upload')
      .field('transaction_id', String(transaction.id))
      .field('bill_date', '2026-06-01')
      .attach('attachments', Buffer.from('%PDF-1.4 fake'), 'receipt.pdf')
      .expect(201);
    written.push(...uploaded.body.attachments.map((a: { safe_filename: string }) => a.safe_filename));
    expect(uploaded.body.attachments[0].file_size).toBe(13);
    fits(attachmentUploadResponseSchema, uploaded.body);
    fits(attachmentListResponseSchema, (await request(app).get(`/api/transactions/${transaction.uuid}/attachments`).expect(200)).body);
    fits(attachmentDeletedResponseSchema, (await request(app).delete(`/api/attachments/${uploaded.body.attachments[0].uuid}`).expect(200)).body);
  });
});
