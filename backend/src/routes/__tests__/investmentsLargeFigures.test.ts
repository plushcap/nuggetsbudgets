import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { z } from 'zod';
import {
  answerProblem,
  concentrationResponseSchema,
  costOfOwnershipResponseSchema,
  holdingResponseSchema,
  lookThroughResponseSchema,
  lotSuggestionsResponseSchema,
  performanceResponseSchema,
  reconciliationResponseSchema,
  sellTaxImpactResponseSchema,
  taxLossHarvestResponseSchema,
  underlyingExposureResponseSchema,
} from '@nuggets/shared';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The largest figures stored data makes: 999,999,999,999 shares (NUMERIC(18,6)
 * holds no more whole shares) bought at $0.0001 and closed at $99,999,999.9999 (NUMERIC(12,4)'s
 * most) are worth $99,999,999,999,800,000,000.0001. Every report about them answered 200 with
 * a figure past what a double holds in cents, as a JSON number (1e+20, its cents lost) that
 * every amount schema refused. Each now carries it as exact decimal text, which its schema
 * reads; and a what-if figure past what the ledger can hold is refused, with a 400.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

const MARKET_VALUE = '99999999999800000000.00';
const BASIS = 100000000;
const GAIN = '99999999999700000000.00';

describeDb('Investments answers carry the largest stored figures exactly', () => {
  let app: Express;
  let tenant: TestTenant;
  let account: string;
  let security: string;

  const get = async (path: string, schema: z.ZodType) => {
    const res = await request(app).get(`/api/investments${path}`);
    expect(res.status, `${path}: ${res.text}`).toBe(200);
    expect(answerProblem(schema, res.body), path).toBeNull();
    return res.body;
  };

  beforeAll(async () => {
    tenant = await createTestTenant('Investments large figures');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    account = (await tenant.pool.query<{ uuid: string }>(
      `INSERT INTO accounts (name, account_type, account_group, type, import_balance, import_balance_date, import_account_rebalance)
       VALUES ('Big', 'investment', 'investments', 'Asset', 1.00, '2025-07-01T16:00:00Z', false) RETURNING uuid`
    )).rows[0]!.uuid;
    const created = await request(app).post('/api/investments/securities').send({ ticker: 'HUGE', name: 'Huge Co', security_type: 'stock' }).expect(201);
    security = created.body.uuid;
    await request(app).post('/api/investments/events/buy')
      .send({ account_uuid: account, security_uuid: security, event_date: '2024-01-02', shares: '999999999999', price_per_share: '0.0001', fees: '0' })
      .expect(201);
    await request(app).post('/api/investments/prices').send({ security_uuid: security, price_date: '2024-01-03', close: '99999999.9999' }).expect(201);
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('answers every report about them, exactly, in its schema', async () => {
    const [holding] = await get(`/holdings?account=${account}`, z.array(holdingResponseSchema));
    expect(holding).toMatchObject({ market_value: MARKET_VALUE, total_cost_basis: BASIS, unrealized_gain_loss: GAIN });
    // The frontend's parse reads it (responseAmount): a number, not a refusal.
    expect(z.array(holdingResponseSchema).parse([holding])[0]!.market_value).toBe(Number(MARKET_VALUE));

    const [reconciled] = (await get('/reports/reconciliation', reconciliationResponseSchema)).accounts;
    expect(reconciled).toMatchObject({ holdings_value: MARKET_VALUE, calculated_value: MARKET_VALUE, difference: '99999999999799999999.00' });
    expect((await get('/reports/concentration', concentrationResponseSchema)).rows[0].marketValue).toBe(MARKET_VALUE);
    expect((await get('/reports/cost-of-ownership', costOfOwnershipResponseSchema)).per_holding[0].average_holding_value).toBe(MARKET_VALUE);
    expect((await get('/reports/lookthrough', lookThroughResponseSchema)).totalValue).toBe(MARKET_VALUE);
    expect((await get('/reports/underlying-exposure', underlyingExposureResponseSchema)).total_value).toBe(MARKET_VALUE);
    const suggestions = await get(`/reports/lot-suggestions?account=${account}&security=${security}&date=2024-12-31`, lotSuggestionsResponseSchema);
    expect(suggestions.lots[0].unrealizedGain).toBe(GAIN);
    await get('/reports/tax-loss-harvest', taxLossHarvestResponseSchema);
    expect((await get(`/reports/performance?account=${account}&end_date=2024-12-31`, performanceResponseSchema)).current_value).toBe(MARKET_VALUE);
    const sale = await get(`/reports/sell-tax-impact?account=${account}&security=${security}&shares=999999999999&date=2024-12-31&st_rate=1`, sellTaxImpactResponseSchema);
    expect(sale.plan.totalProceeds).toBe(MARKET_VALUE);
    expect(sale.tax.estimatedShortTermTax).toBe(GAIN);
  });

  it('refuses a what-if figure the ledger could not hold, with a 400 saying so', async () => {
    const holding = `account=${account}&security=${security}`;
    for (const [query, message] of [
      [`/reports/sell-tax-impact?${holding}&shares=10&price=99999999999999999999`, 'price must be a price per share from 0 to 99,999,999.9999'],
      [`/reports/sell-tax-impact?${holding}&shares=10&price=-1`, 'price must be a price per share from 0 to 99,999,999.9999'],
      [`/reports/sell-tax-impact?${holding}&shares=1e13`, 'shares must be at most 999,999,999,999.999999, the most a lot can hold'],
      // 10^12 itself: 999,999,999,999.999999 rounds to it as a double, so the bound is "below 10^12".
      [`/reports/sell-tax-impact?${holding}&shares=1000000000000`, 'shares must be at most 999,999,999,999.999999, the most a lot can hold'],
      [`/reports/sell-tax-impact?${holding}&shares=1&st_rate=1.5`, 'st_rate must be a tax rate from 0 to 1, such as 0.24 for 24%'],
      [`/reports/sell-tax-impact?${holding}&shares=1&lt_rate=-0.1`, 'lt_rate must be a tax rate from 0 to 1, such as 0.24 for 24%'],
      [`/reports/lot-suggestions?${holding}&price=1e9`, 'price must be a price per share from 0 to 99,999,999.9999'],
    ] as const) {
      const res = await request(app).get(`/api/investments${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body, query).toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringContaining(message) });
    }
  });
});
