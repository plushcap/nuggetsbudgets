import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import { sql } from 'kysely';
import { db } from '../db.js';
import { createBudgetRoutes } from '../routes/budgets.js';
import { createTestTenant, type TestTenant } from '../test/testTenant.js';

// A `date` column is a calendar day. node-postgres used to hand it over as
// a JS Date at the process's local midnight, which came out as the day before
// (`…T05:00:00.000Z` in New York, `…-30T10:00:00.000Z` in Kiritimati) once it
// was serialized. Run each check in zones on both sides of UTC.
const zones = ['America/New_York', 'Pacific/Kiritimati', 'UTC'];

describe('calendar dates leave the database as YYYY-MM-DD', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it.each(zones)('a date column reads as its own day under TZ=%s', async (zone) => {
    process.env.TZ = zone;
    const { rows } = await sql<{ day: unknown; days: unknown; at: unknown }>`
      SELECT '2026-12-31'::date AS day,
             ARRAY['2026-01-01'::date, NULL] AS days,
             '2026-12-31T23:30:00Z'::timestamptz AS at
    `.execute(db);

    expect(rows[0].day).toBe('2026-12-31');
    expect(rows[0].days).toEqual(['2026-01-01', null]);
    // Instants stay Dates.
    expect(rows[0].at).toBeInstanceOf(Date);
    expect((rows[0].at as Date).toISOString()).toBe('2026-12-31T23:30:00.000Z');
  });

  describe('through a route', () => {
    let app: Express;
    let tenant: TestTenant;

    beforeAll(async () => {
      tenant = await createTestTenant('Calendar dates');
      await tenant.pool.query(
        `INSERT INTO budget_period (name, month, year, month_number, start_date, end_date)
         VALUES ('December 2026', 'December', 2026, 12, '2026-12-01', '2026-12-31')`
      );
      app = express();
      app.use(express.json());
      app.use(tenant.context());
      app.use('/api/budgets', createBudgetRoutes());
    });

    afterAll(async () => {
      await tenant.cleanup();
    });

    it.each(zones)('GET /api/budgets/periods answers start_date and end_date as days under TZ=%s', async (zone) => {
      process.env.TZ = zone;
      const res = await request(app).get('/api/budgets/periods').expect(200);
      const period = res.body.find((p: { name: string }) => p.name === 'December 2026');
      expect(period.start_date).toBe('2026-12-01');
      expect(period.end_date).toBe('2026-12-31');
    });
  });
});
