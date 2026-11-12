import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import {
  answerProblem,
  billDueDatesResponseSchema,
  billForecastResponseSchema,
  billMonthViewResponseSchema,
  billOccurrenceResponseSchema,
  billPaymentCandidatesResponseSchema,
} from '@nuggets/shared';
import type { z } from 'zod';
import { createBillRoutes } from '../bills.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * Every bills answer is exactly what its `@nuggets/shared` schema names, which
 * the frontend reads it with: a field a route adds, or one the schema names that the route
 * doesn't send, fails here. Real answers, from a ledger with a monthly bill paid this month
 * (once by a payment it matched, and again by one no due date took), a varying one, and a
 * candidate payment.
 */
describe('Bills answers match their shared schemas', () => {
  let tenant: TestTenant;
  let app: Express;
  let today: string;
  let rent: { id: number; uuid: string };
  let accountId: number;

  const one = async <T>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  const expectAnswer = (schema: z.ZodType, body: unknown) => expect(answerProblem(schema, body), JSON.stringify(body)).toBeNull();

  beforeAll(async () => {
    tenant = await createTestTenant('Bill answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/bills', createBillRoutes());

    today = (await one<{ today: string }>(`SELECT app_today()::text AS today`)).today;
    accountId = (await one<{ id: number }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Bills checking', 'checking', 'cash', 'Asset') RETURNING id`,
    )).id;
    const bill = (name: string, amount: string, varies: boolean) =>
      one<{ id: number; uuid: string }>(
        `INSERT INTO budget_items (name, expense_type, type, subtype, isbill, recurring_payment, recurring_payment_amount,
                                   recurring_payment_frequency, recurring_next_payment_date, recurring_amount_varies)
         VALUES ($1, 'Expense', 'Monthly', 'Fixed', true, true, $2, 1, date_trunc('month', app_today()::timestamp)::date + 1, $3)
         RETURNING id, uuid`,
        [name, amount, varies],
      );
    rent = await bill('Rent', '1200.10', false);
    await bill('Power', '80.25', true);
    // Rent paid on its due date this month, and again later in the month.
    for (const [day, amount] of [[1, '-1200.10'], [5, '-0.20']] as const) {
      await tenant.pool.query(
        `INSERT INTO transactions (account_id, amount, transaction_date, type, description, budget_item_id)
         VALUES ($1, $2, date_trunc('month', app_today()::timestamp)::date + $3::int, 'expense', 'Rent payment', $4)`,
        [accountId, amount, day, rent.id],
      );
    }
    // A payment that names no bill: a candidate to link.
    await tenant.pool.query(
      `INSERT INTO transactions (account_id, amount, transaction_date, type, description)
       VALUES ($1, '-12.34', app_today(), 'expense', 'Rent top-up')`,
      [accountId],
    );
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('answers the month, the forecast, the candidates, the due dates and each correction as their schemas say', async () => {
    const month = (await request(app).get('/api/bills').expect(200)).body;
    expectAnswer(billMonthViewResponseSchema, month);
    expect(month.occurrences.length).toBeGreaterThan(0);
    expect(month.occurrences.some((o: { payments: unknown[] }) => o.payments.length > 0)).toBe(true);

    expectAnswer(billForecastResponseSchema, (await request(app).get('/api/bills/forecast?months=3').expect(200)).body);

    const occurrence = month.occurrences.find((o: { bill: { uuid: string } }) => o.bill.uuid === rent.uuid);
    const candidates = (await request(app).get(`/api/bills/occurrences/${occurrence.uuid}/candidates?q=Rent`).expect(200)).body;
    expectAnswer(billPaymentCandidatesResponseSchema, candidates);
    expect(candidates.length).toBeGreaterThan(0);

    const candidate = candidates.find((c: { description: string }) => c.description === 'Rent top-up');
    const linked = (await request(app).post(`/api/bills/occurrences/${occurrence.uuid}/payments`).send({ transaction_uuid: candidate.transaction_uuid }).expect(200)).body;
    expectAnswer(billOccurrenceResponseSchema, linked);
    expect(linked.payments.map((p: { transaction_uuid: string }) => p.transaction_uuid)).toContain(candidate.transaction_uuid);

    const unlinked = (await request(app).delete(`/api/bills/occurrences/${occurrence.uuid}/payments/${candidate.transaction_uuid}`).expect(200)).body;
    expectAnswer(billOccurrenceResponseSchema, unlinked);

    const dueDates = (await request(app).get(`/api/bills/${rent.uuid}/due-dates`).expect(200)).body;
    expectAnswer(billDueDatesResponseSchema, dueDates);
    const next = dueDates.find((d: { due_date: string }) => d.due_date > today);
    const placed = (await request(app).post(`/api/bills/${rent.uuid}/payments`).send({ transaction_uuid: candidate.transaction_uuid, due_date: next.due_date }).expect(200)).body;
    expectAnswer(billOccurrenceResponseSchema, placed);

    const paidByHand = (await request(app).put(`/api/bills/occurrences/${placed.uuid}/resolution`)
      .send({ resolution: 'paid_manually', paid_date: today, paid_amount: '1200.10', note: 'Paid in cash' }).expect(200)).body;
    expectAnswer(billOccurrenceResponseSchema, paidByHand);
    expect(paidByHand).toMatchObject({ status: 'paid', resolution: 'paid_manually', paid: 1200.1, note: 'Paid in cash' });
    const skipped = (await request(app).put(`/api/bills/occurrences/${placed.uuid}/resolution`).send({ resolution: 'skipped' }).expect(200)).body;
    expectAnswer(billOccurrenceResponseSchema, skipped);
    expectAnswer(billOccurrenceResponseSchema, (await request(app).put(`/api/bills/occurrences/${placed.uuid}/resolution`).send({ resolution: null }).expect(200)).body);

    // The month again, with the payment no due date took among the unplaced.
    const after = (await request(app).get('/api/bills').expect(200)).body;
    expectAnswer(billMonthViewResponseSchema, after);
    expect(after.unplaced.length).toBeGreaterThan(0);
  });
});
