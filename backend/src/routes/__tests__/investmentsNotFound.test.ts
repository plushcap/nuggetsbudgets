import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { randomUUID } from 'crypto';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * A security uuid that names nothing the ledger can see (unknown, or another ledger's,
 * which RLS hides) is a 404 on every /securities/:uuid route and in a request body.
 * The services threw a plain Error, which answered 500.
 */
describe('investments: an unknown security is a 404', () => {
  let app: Express;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let otherSecurity: string;
  let accountUuid: string;
  let securityUuid: string;

  beforeAll(async () => {
    tenant = await createTestTenant('Investments not found');
    otherTenant = await createTestTenant('Investments not found (other ledger)');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    const sec = await otherTenant.pool.query(
      `INSERT INTO securities (ticker, name, security_type) VALUES ($1, 'Other ledger fund', 'mutual_fund') RETURNING uuid`,
      [`OT${Date.now() % 100000}`]
    );
    otherSecurity = sec.rows[0].uuid;
    const acct = await tenant.pool.query(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`,
      [`Brokerage ${Date.now()}`]
    );
    accountUuid = acct.rows[0].uuid;
    const own = await tenant.pool.query(
      `INSERT INTO securities (ticker, name, security_type) VALUES ($1, 'Own fund', 'mutual_fund') RETURNING uuid`,
      [`OW${Date.now() % 100000}`]
    );
    securityUuid = own.rows[0].uuid;
    const buy = await request(app).post('/api/investments/events/buy').send({
      account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2026-01-02', shares: 10, price_per_share: 10,
    });
    expect(buy.status).toBe(201);
  });

  afterAll(async () => {
    await Promise.allSettled([tenant.cleanup(), otherTenant.cleanup()]);
  });

  const reads = ['', '/prices', '/composition', '/underlying-holdings', '/price-gaps'];

  it.each(reads)('GET /securities/:uuid%s answers 404 for an unknown security', async (path) => {
    const res = await request(app).get(`/api/investments/securities/${randomUUID()}${path}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/error: security not found: /);
    // One answer for an unknown security, whichever route reads it.
    expect(res.body).toMatchObject({ code: 'SECURITY_NOT_FOUND', error: 'Security not found' });
  });

  it.each([
    ['put', `/api/investments/securities/${randomUUID()}`],
    ['delete', `/api/investments/securities/${randomUUID()}`],
  ] as const)('%s /securities/:uuid answers the same 404 for an unknown security', async (verb, path) => {
    const res = await request(app)[verb](path).send({ name: 'Nobody' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SECURITY_NOT_FOUND', error: 'Security not found' });
  });

  it.each(reads)("GET /securities/:uuid%s answers 404 for another ledger's security", async (path) => {
    const res = await request(app).get(`/api/investments/securities/${otherSecurity}${path}`);
    expect(res.status).toBe(404);
  });

  it('answers 404 with a code when a buy names an unknown security', async () => {
    const res = await request(app).post('/api/investments/events/buy').send({
      account_uuid: accountUuid, security_uuid: randomUUID(), event_date: '2026-01-02', shares: 1, price_per_share: 10,
    });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: 'SECURITY_NOT_FOUND', error: 'Security not found' });
  });

  // These reached SQL as a uuid or a date and answered 500.
  it.each([
    '/holdings?account=not-a-uuid',
    '/events?security=123',
    '/reports/realized-gain-loss?start_date=2026-13-01',
    '/reports/wash-sales?end_date=yesterday',
    `/reports/sell-tax-impact?account=${'x'.repeat(36)}&security=${'y'.repeat(36)}&shares=1`,
  ])('answers 400 for a malformed id or day in the query: %s', async (path) => {
    const res = await request(app).get(`/api/investments${path}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // Years 1 to 9999 passed: 0001-01-01 reached SQL as the day before it, year 0 (a 500).
  // The query takes the days the bodies take (calendarDay): 1800 to 2999.
  it.each([
    '/reports/performance?start_date=0001-01-01',
    '/reports/realized-gain-loss?start_date=1799-12-31',
    '/reports/dividend-history?end_date=3000-01-01',
    '/events?end_date=9999-12-31',
    '/export/realized-gain-loss.csv?start_date=0100-01-01',
    `/reports/sell-tax-impact?account=ACCOUNT&security=SECURITY&shares=1&date=0001-01-01`,
  ])('answers 400 for a day outside 1800 to 2999 in the query: %s', async (path) => {
    const res = await request(app).get(`/api/investments${path.replace('ACCOUNT', accountUuid).replace('SECURITY', securityUuid)}`);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/must be a real YYYY-MM-DD date, from 1800 to 2999$/) });
  });

  it('takes the first and last days of that range', async () => {
    for (const path of ['/reports/performance?start_date=1800-01-01', '/reports/performance?start_date=2026-01-01&end_date=2999-12-31', '/events?start_date=1800-01-01']) {
      const res = await request(app).get(`/api/investments${path}`);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  // These still answered 500, or echoed garbage, after the fixes above.
  it.each([
    '/reports/value-series?limit=abc',
    '/reports/value-series?limit=1.5',
    '/securities/paginated?search=a%00b',
    '/events?event_type=%00',
    `/reports/sell-tax-impact?account=ACCOUNT&security=SECURITY&shares=1&method=bogus`,
    `/reports/lot-suggestions?account=ACCOUNT&security=SECURITY&objective=bogus`,
    `/reports/lot-suggestions?account=ACCOUNT&security=SECURITY&price=abc`,
    // An unknown category was read as expense_ratio and echoed back.
    '/reports/securities-needing-data?category=bogus',
    '/reports/securities-needing-data?category=underlying_holdings',
  ])('answers 400 for a query value that is not one: %s', async (path) => {
    const res = await request(app).get(`/api/investments${path.replace('ACCOUNT', accountUuid).replace('SECURITY', securityUuid)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('lists the securities needing each kind of data it knows, price by default', async () => {
    for (const [query, category] of [['', 'price'], ['?category=price', 'price'], ['?category=composition', 'composition'], ['?category=expense_ratio', 'expense_ratio']]) {
      const res = await request(app).get(`/api/investments/reports/securities-needing-data${query}`);
      expect(res.status, query).toBe(200);
      expect(res.body.category).toBe(category);
    }
  });

  it('still answers the same reports with good values', async () => {
    for (const path of [
      '/reports/value-series?limit=5',
      `/reports/sell-tax-impact?account=${accountUuid}&security=${securityUuid}&shares=1&method=fifo&price=12.5`,
      `/reports/lot-suggestions?account=${accountUuid}&security=${securityUuid}&objective=maximize_loss&price=12`,
    ]) {
      const res = await request(app).get(`/api/investments${path}`);
      expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    }
  });

  it('matches nothing, rather than failing, when a filter names a well-formed unknown account', async () => {
    const res = await request(app).get(`/api/investments/events?account=${randomUUID()}`);
    expect(res.status).toBe(200);
  });

  it('answers 400, not 404, when a tax report is missing what it is about', async () => {
    for (const path of ['/reports/sell-tax-impact', '/reports/lot-suggestions', `/reports/sell-tax-impact?account=${accountUuid}&security=${securityUuid}`]) {
      const res = await request(app).get(`/api/investments${path}`);
      expect(res.status, path).toBe(400);
    }
  });

  it('answers 400 with the reason when a sell names a lot that is not open, or more shares than held', async () => {
    const sell = { account_uuid: accountUuid, security_uuid: securityUuid, event_date: '2026-02-02', price_per_share: 12 };
    const unknownLot = await request(app).post('/api/investments/events/sell').send({
      ...sell, shares: 1, method: 'specific_id', specific_lots: [{ lot_uuid: randomUUID(), shares: 1 }],
    });
    expect(unknownLot.status).toBe(400);
    expect(unknownLot.body.code).toBe('INVALID_REQUEST');
    expect(unknownLot.body.error).toMatch(/^lot not open: /);

    const tooMany = await request(app).post('/api/investments/events/sell').send({ ...sell, shares: 100, method: 'fifo' });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.error).toMatch(/Insufficient shares/);
  });
});
