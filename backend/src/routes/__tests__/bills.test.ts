import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { createBillRoutes } from '../bills.js';
import { testTenantContext } from '../../test/tenantContext.js';
import { globalDb } from '../../db/withTenant.js';

/**
 * The bills API's wiring, in a tenant of its own: it answers with a month's
 * view and a forecast, and refuses bad input before touching anything. The
 * service's behaviour is covered in BillService.db.test.ts.
 */
describe('Bills API', () => {
  const stamp = Date.now();
  let tenantId: number;
  let organizationId: number;
  let userId: number;
  let app: Express;

  beforeAll(async () => {
    organizationId = (await globalDb.insertInto('organizations').values({ name: `Bills API org ${stamp}` }).returning('id').executeTakeFirstOrThrow()).id;
    tenantId = (await globalDb.insertInto('tenants').values({ name: `Bills API ${stamp}`, organization_id: organizationId }).returning('id').executeTakeFirstOrThrow()).id;
    userId = (await globalDb.insertInto('users').values({ email: `bills-api-${stamp}@test.local`, password_hash: 'x' }).returning('id').executeTakeFirstOrThrow()).id;
    app = express();
    app.use(express.json());
    app.use('/api/bills', testTenantContext({ userId, tenantId }), createBillRoutes());
  });

  afterAll(async () => {
    await globalDb.deleteFrom('tenants').where('id', '=', tenantId).execute();
    await globalDb.deleteFrom('organizations').where('id', '=', organizationId).execute();
    await globalDb.deleteFrom('users').where('id', '=', userId).execute();
  });

  it('shows a month, this one by default', async () => {
    const res = await request(app).get('/api/bills').expect(200);
    expect(res.body).toMatchObject({ month: res.body.today.slice(0, 7), totals: { expected: 0, paid: 0, remaining: 0 }, occurrences: [], unplaced: [] });
    expect((await request(app).get('/api/bills?month=2027-02').expect(200)).body.month).toBe('2027-02');
  });

  it('refuses a month that isn’t YYYY-MM', async () => {
    const res = await request(app).get('/api/bills?month=2027-13').expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Give a month as YYYY-MM.', details: [{ field: 'month' }] });
  });

  // The view reads the month after it, and 9999-12's was "+010000-01",
  // which Postgres refused (a 500); so was year 0000.
  it('refuses a month outside 1800 to 2999 before reading it', async () => {
    for (const month of ['9999-12', '0000-01', '1799-12', '3000-01']) {
      const res = await request(app).get(`/api/bills?month=${month}`);
      expect(res.status, month).toBe(400);
      expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Give a month as YYYY-MM, from 1800 to 2999.' });
    }
    expect((await request(app).get('/api/bills?month=2999-12').expect(200)).body.month).toBe('2999-12');
    expect((await request(app).get('/api/bills?month=1800-01').expect(200)).body.month).toBe('1800-01');
  });

  it('refuses a due date or paid date that isn’t a real day, before looking anything up', async () => {
    const missing = '00000000-0000-7000-8000-000000000000';
    for (const day of ['2026-02-30', '0000-01-01', '9999-12-31']) {
      await request(app).post(`/api/bills/${missing}/payments`).send({ transaction_uuid: missing, due_date: day }).expect(400);
      await request(app)
        .put(`/api/bills/occurrences/${missing}/resolution`)
        .send({ resolution: 'paid_manually', paid_date: day, paid_amount: 10 })
        .expect(400);
    }
  });

  // The query strings are checked by shared schemas before anything reads them.
  it('reads its query strings with their schemas: a list where one value goes is a 400, an empty one is not given', async () => {
    const missing = '0190a000-0000-7000-8000-000000000000';
    const twice = await request(app).get(`/api/bills/occurrences/${missing}/candidates?q=rent&q=power`).expect(400);
    expect(twice.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'q' }] });
    const months = await request(app).get('/api/bills?month=2027-01&month=2027-02').expect(400);
    expect(months.body).toMatchObject({ code: 'VALIDATION_ERROR', details: [{ field: 'month' }] });
    const empty = await request(app).get('/api/bills?month=').expect(200);
    expect(empty.body.month).toBe(empty.body.today.slice(0, 7));
    expect((await request(app).get('/api/bills/forecast?months=abc').expect(200)).body).toHaveLength(12);
    expect((await request(app).get('/api/bills/forecast?months=99').expect(200)).body).toHaveLength(24);
  });

  it('forecasts 12 months unless asked for fewer', async () => {
    expect((await request(app).get('/api/bills/forecast').expect(200)).body).toHaveLength(12);
    expect((await request(app).get('/api/bills/forecast?months=3').expect(200)).body).toHaveLength(3);
  });

  it('says what’s missing when marking paid by hand', async () => {
    const res = await request(app)
      .put('/api/bills/occurrences/00000000-0000-7000-8000-000000000000/resolution')
      .send({ resolution: 'paid_manually' })
      .expect(400);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['paid_date', 'paid_amount']);
  });

  it('answers 404 for a due date or bill that isn’t there, and 400 for a bad transaction id', async () => {
    const missing = '00000000-0000-7000-8000-000000000000';
    await request(app).put(`/api/bills/occurrences/${missing}/resolution`).send({ resolution: 'skipped' }).expect(404);
    await request(app).post(`/api/bills/occurrences/${missing}/payments`).send({ transaction_uuid: missing }).expect(404);
    await request(app).post(`/api/bills/occurrences/${missing}/payments`).send({ transaction_uuid: 'nope' }).expect(400);
    const res = await request(app).get(`/api/bills/${missing}/due-dates`).expect(404);
    expect(res.body.error).toBe('That bill wasn’t found, or has no due date and frequency set.');
  });
});
