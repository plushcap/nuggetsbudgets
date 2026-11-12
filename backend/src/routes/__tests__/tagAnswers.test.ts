import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  answerProblem,
  autoTagResponseSchema,
  budgetItemTaggingResponseSchema,
  budgetItemTagsResponseSchema,
  reportRootListResponseSchema,
  tagBreakdownResponseSchema,
  tagDoneResponseSchema,
  tagListResponseSchema,
  tagNamespaceSetResponseSchema,
  tagReportRootSetResponseSchema,
  tagRowResponseSchema,
  tagSummaryResponseSchema,
  tagTimeSeriesResponseSchema,
  tagTransactionsResponseSchema,
  tagWithHierarchyResponseSchema,
  transactionTaggingResponseSchema,
  transactionTagsResponseSchema,
} from '@nuggets/shared';
import type { z } from 'zod';
import { createTagsRoutes } from '../tags.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The tag routes' answers against their `@nuggets/shared` schemas: each is
 * exactly what its schema names. A tag's transactions are rows of the shared transaction list
 * (`transactionResponseSchema`), which the tag page's table shows; they lacked the merchant id,
 * the period item and the instants.
 */
describe('Tag answers', () => {
  let tenant: TestTenant;
  let app: Express;
  const one = async <T,>(text: string, values: unknown[] = []) => (await tenant.pool.query(text, values)).rows[0] as T;
  const fits = (schema: z.ZodType, body: unknown) => expect(answerProblem(schema, body)).toBeNull();

  beforeAll(async () => {
    tenant = await createTestTenant('Tag answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/tags', createTagsRoutes());
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('answers every tag route as its schema says', async () => {
    const root = await request(app).post('/api/tags').send({ name: 'Household', color: '#123456' }).expect(201);
    fits(tagRowResponseSchema, root.body);
    const child = await request(app).post('/api/tags').send({ name: 'Utilities', parent_id: root.body.id, description: 'bills' }).expect(201);
    fits(tagRowResponseSchema, child.body);
    fits(tagRowResponseSchema, (await request(app).put(`/api/tags/${child.body.uuid}`).send({ name: 'Utilities', sort_order: 2 }).expect(200)).body);
    fits(tagReportRootSetResponseSchema, (await request(app).put(`/api/tags/${root.body.uuid}/report-root`).send({ is_report_root: true }).expect(200)).body);

    const account = await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Checking', 'checking', 'cash', 'Asset') RETURNING id`
    );
    const merchant = await one<{ id: number; uuid: string }>(`INSERT INTO merchants (name) VALUES ('Power Co') RETURNING id, uuid`);
    const transaction = await one<{ id: number; uuid: string }>(
      `INSERT INTO transactions (account_id, amount, description, transaction_date, type, status, merchant_id)
       VALUES ($1, -40.25, 'Power', '2026-06-03', 'expense', 'cleared', $2) RETURNING id, uuid`,
      [account.id, merchant.id]
    );
    const item = await one<{ id: number; uuid: string }>(
      `INSERT INTO budget_items (name, expense_type, merchant_id) VALUES ('Power', 'Expense', $1) RETURNING id, uuid`,
      [merchant.id]
    );

    fits(transactionTaggingResponseSchema, (await request(app).post(`/api/tags/transaction/${transaction.uuid}`).send({ tag_id: child.body.id }).expect(201)).body);
    fits(transactionTagsResponseSchema, (await request(app).get(`/api/tags/transaction/${transaction.uuid}`).expect(200)).body);
    fits(tagListResponseSchema, (await request(app).get('/api/tags').expect(200)).body);
    fits(tagWithHierarchyResponseSchema, (await request(app).get(`/api/tags/${child.body.uuid}`).expect(200)).body);
    fits(reportRootListResponseSchema, (await request(app).get('/api/tags/report-roots').expect(200)).body);

    const summary = await request(app).get(`/api/tags/${root.body.uuid}/summary`).expect(200);
    expect(summary.body.transaction_count).toBe('1');
    fits(tagSummaryResponseSchema, summary.body);
    const page = await request(app).get(`/api/tags/${root.body.uuid}/transactions`).expect(200);
    expect(page.body.transactions).toHaveLength(1);
    expect(page.body.transactions[0]).toMatchObject({ merchant_id: merchant.id, merchant_uuid: merchant.uuid, budget_period_item_id: null });
    fits(tagTransactionsResponseSchema, page.body);
    const series = await request(app).get(`/api/tags/${root.body.uuid}/timeseries?start_date=2026-06-01&end_date=2026-06-30&bucket=week`).expect(200);
    expect(series.body.series).toHaveLength(1);
    fits(tagTimeSeriesResponseSchema, series.body);
    const breakdown = await request(app).get(`/api/tags/${root.body.uuid}/breakdown`).expect(200);
    expect(breakdown.body.breakdown).toHaveLength(1);
    fits(tagBreakdownResponseSchema, breakdown.body);

    fits(budgetItemTaggingResponseSchema, (await request(app).post(`/api/tags/budget-items/${item.uuid}/tags`).send({ tag_id: child.body.id }).expect(201)).body);
    fits(budgetItemTagsResponseSchema, (await request(app).get(`/api/tags/budget-items/${item.uuid}/tags`).expect(200)).body);
    fits(
      tagNamespaceSetResponseSchema,
      (await request(app).put(`/api/tags/budget-items/${item.uuid}/namespace/${root.body.uuid}`).send({ tag_uuid: child.body.uuid }).expect(200)).body
    );
    fits(
      tagNamespaceSetResponseSchema,
      (await request(app).put(`/api/tags/budget-items/${item.uuid}/namespace/${root.body.uuid}`).send({ tag_uuid: null }).expect(200)).body
    );
    fits(autoTagResponseSchema, (await request(app).post(`/api/tags/auto-tag/budget-item/${item.uuid}`).expect(200)).body);
    fits(autoTagResponseSchema, (await request(app).post(`/api/tags/auto-tag/merchant/${merchant.uuid}`).expect(200)).body);
    fits(tagDoneResponseSchema, (await request(app).delete(`/api/tags/transaction/${transaction.uuid}/tag/${child.body.id}`).expect(200)).body);
    fits(tagDoneResponseSchema, (await request(app).delete(`/api/tags/${child.body.uuid}`).expect(200)).body);
  });
});
