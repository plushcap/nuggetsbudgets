import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  answerProblem,
  merchantApplyRulesResponseSchema,
  merchantImageResponseSchema,
  merchantLiteListResponseSchema,
  merchantLitePageResponseSchema,
  merchantListResponseSchema,
  merchantMergeResponseSchema,
  merchantPageResponseSchema,
  merchantRemoveUnusedResponseSchema,
  merchantResponseSchema,
  merchantRuleListResponseSchema,
  merchantRulePreviewResponseSchema,
  merchantRuleResponseSchema,
  merchantSearchResponseSchema,
  merchantSpendingResponseSchema,
} from '@nuggets/shared';
import type { z } from 'zod';
import { createMerchantsRoutes } from '../merchants.js';
import { createMerchantSpendingRoutes } from '../merchantSpending.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The merchant routes' answers against their `@nuggets/shared` schemas: each
 * answer is exactly what its schema names, so a field a route adds fails here until the
 * schema has it, and the frontend's parse never drops one. And the merchant's auto-tag, which
 * the one-merchant answer left out: Edit Merchant seeded its picker from it, found
 * none, and saving cleared it; Add Merchant's was dropped.
 */
describe('Merchant answers', () => {
  let tenant: TestTenant;
  let app: Express;
  let tagId = 0;
  let accountId = 0;

  const one = async <T,>(text: string, values: unknown[] = []) => (await tenant.pool.query(text, values)).rows[0] as T;
  const fits = (schema: z.ZodType, body: unknown) => expect(answerProblem(schema, body)).toBeNull();
  // A 1x1 PNG.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  );

  beforeAll(async () => {
    tenant = await createTestTenant('Merchant answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/merchants', createMerchantsRoutes());
    app.use('/api/merchant-spending', createMerchantSpendingRoutes());
    tagId = (await one<{ id: number }>(`INSERT INTO tags (name) VALUES ('Groceries tag') RETURNING id`)).id;
    accountId = (
      await one<{ id: number }>(
        `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
      )
    ).id;
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('answers every merchant route as its schema says', async () => {
    const created = await request(app)
      .post('/api/merchants')
      .send({ name: 'Corner Market', merchant_website: 'corner.example', notes: 'grocer', transaction_auto_tag_id: tagId })
      .expect(201);
    fits(merchantResponseSchema, created.body);
    const uuid = created.body.uuid as string;
    const merchantId = created.body.id as number;
    await one(
      `INSERT INTO transactions (account_id, amount, description, import_payee, transaction_date, type, status, merchant_id)
       VALUES ($1, -12.34, 'CORNER MKT 1', 'CORNER MKT', app_today(), 'expense', 'cleared', $2),
              ($1, -5.00, 'CORNER MKT 2', NULL, app_today(), 'expense', 'cleared', NULL)`,
      [accountId, merchantId]
    );

    fits(merchantListResponseSchema, (await request(app).get('/api/merchants').expect(200)).body);
    fits(merchantLiteListResponseSchema, (await request(app).get('/api/merchants?fields=lite').expect(200)).body);
    fits(merchantPageResponseSchema, (await request(app).get('/api/merchants/paginated?search=corner').expect(200)).body);
    fits(merchantLitePageResponseSchema, (await request(app).get('/api/merchants/paginated?fields=lite').expect(200)).body);
    fits(merchantSearchResponseSchema, (await request(app).get('/api/merchants/search?q=corner').expect(200)).body);
    fits(merchantResponseSchema, (await request(app).get(`/api/merchants/${uuid}`).expect(200)).body);
    const updated = await request(app)
      .put(`/api/merchants/${uuid}`)
      .send({ name: 'Corner Market', notes: null, transaction_auto_tag_id: tagId })
      .expect(200);
    fits(merchantResponseSchema, updated.body);
    const image = await request(app).post(`/api/merchants/${uuid}/upload-image`).attach('merchant_image', PNG, 'logo.png').expect(200);
    fits(merchantImageResponseSchema, image.body);

    const rule = await request(app).post(`/api/merchants/${uuid}/rules`).send({ method: 'contains', matching_text: 'CORNER' }).expect(201);
    fits(merchantRuleResponseSchema, rule.body);
    fits(merchantRuleListResponseSchema, (await request(app).get(`/api/merchants/${uuid}/rules`).expect(200)).body);
    fits(
      merchantRuleResponseSchema,
      (await request(app).put(`/api/merchants/rules/${rule.body.uuid}`).send({ method: 'starts_with', matching_text: 'CORNER' }).expect(200)).body
    );
    const preview = await request(app).post(`/api/merchants/${uuid}/test-rules`).expect(200);
    // The one not given the merchant yet.
    expect(preview.body.matchingTransactions).toHaveLength(1);
    fits(merchantRulePreviewResponseSchema, preview.body);
    const applied = await request(app)
      .post(`/api/merchants/${uuid}/apply-rules`)
      .send({ transactionIds: preview.body.matchingTransactions.map((t: { id: number }) => t.id) })
      .expect(200);
    fits(merchantApplyRulesResponseSchema, applied.body);

    const spending = await request(app).get(`/api/merchant-spending/${uuid}`).expect(200);
    expect(spending.body.monthly).toHaveLength(1);
    fits(merchantSpendingResponseSchema, spending.body);

    const other = await request(app).post('/api/merchants').send({ name: 'Rule-less' }).expect(201);
    fits(merchantRulePreviewResponseSchema, (await request(app).post(`/api/merchants/${other.body.uuid}/test-rules`).expect(200)).body);
    fits(
      merchantMergeResponseSchema,
      (await request(app).post(`/api/merchants/${other.body.uuid}/merge`).send({ targetMerchantUuid: uuid }).expect(200)).body
    );
    await request(app).post('/api/merchants').send({ name: 'Unused' }).expect(201);
    const removed = await request(app).post('/api/merchants/admin/remove-unused').expect(200);
    expect(removed.body.removedCount).toBe(1);
    fits(merchantRemoveUnusedResponseSchema, removed.body);
  });

  it("answers a merchant's auto-tag, and keeps the one Add Merchant sends", async () => {
    const created = await request(app).post('/api/merchants').send({ name: 'Auto-tagged', transaction_auto_tag_id: tagId }).expect(201);
    expect(created.body.transaction_auto_tag_id).toBe(tagId);
    const read = await request(app).get(`/api/merchants/${created.body.uuid}`).expect(200);
    expect(read.body.transaction_auto_tag_id).toBe(tagId);
    const list = await request(app).get('/api/merchants').expect(200);
    expect(list.body.find((m: { uuid: string }) => m.uuid === created.body.uuid).transaction_auto_tag_id).toBe(tagId);

    // An image upload answers the whole merchant, its auto-tag too.
    const image = await request(app)
      .post(`/api/merchants/${created.body.uuid}/upload-image`)
      .attach('merchant_image', PNG, 'logo.png')
      .expect(200);
    expect(image.body.merchant).toMatchObject({ uuid: created.body.uuid, transaction_auto_tag_id: tagId });
  });

  it("refuses an auto-tag on create that isn't one of the ledger's tags", async () => {
    const res = await request(app).post('/api/merchants').send({ name: 'Bad tag', transaction_auto_tag_id: 2147483000 }).expect(400);
    expect(res.body).toMatchObject({ code: 'INVALID_REFERENCE', field: 'transaction_auto_tag_id' });
    expect(await one(`SELECT 1 AS found FROM merchants WHERE name = 'Bad tag'`)).toBeUndefined();
  });
});
