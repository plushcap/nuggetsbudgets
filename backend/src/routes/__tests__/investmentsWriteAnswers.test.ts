import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import request from 'supertest';
import express, { type Express } from 'express';
import { z } from 'zod';
import {
  answerProblem,
  buyResponseSchema,
  compositionUpsertResponseSchema,
  costBasisMethodResponseSchema,
  dividendResponseSchema,
  feeResponseSchema,
  fundCompositionResponseSchema,
  mergerCashResponseSchema,
  mergerStockResponseSchema,
  returnOfCapitalResponseSchema,
  sellResponseSchema,
  splitResponseSchema,
  spinoffResponseSchema,
  underlyingHoldingsResponseSchema,
} from '@nuggets/shared';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';

/**
 * The answers to the investments writes the app sends, and the fund reads beside them, each
 * exactly its @nuggets/shared schema: the frontend parses each one, so a
 * field a route adds or drops fails here first. Each write is checked as it records and as its
 * dry run answers (the same route, `dry_run: true`, writing nothing).
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

describeDb('Investments write answers match their shared schemas', () => {
  let app: Express;
  let tenant: TestTenant;
  let account: string;
  let n = 0;

  /** POST, expecting `status`, and the answer exactly `schema`. */
  const post = async (path: string, body: object, schema: z.ZodType, status: number) => {
    const res = await request(app).post(`/api/investments${path}`).send(body);
    expect(res.status, `${path}: ${res.text}`).toBe(status);
    expect(answerProblem(schema, res.body), path).toBeNull();
    return res.body;
  };
  const security = async (values: object = {}) => {
    n += 1;
    const res = await request(app).post('/api/investments/securities').send({ ticker: `WA${n}`, name: `Write answer ${n}`, security_type: 'stock', ...values });
    expect(res.status, res.text).toBe(201);
    return res.body.uuid as string;
  };
  const buy = (sec: string, day: string, extra: object = {}) =>
    post('/events/buy', { account_uuid: account, security_uuid: sec, event_date: day, shares: '10', price_per_share: '20', fees: '1.00', ...extra }, buyResponseSchema, 'dry_run' in extra ? 200 : 201);

  beforeAll(async () => {
    tenant = await createTestTenant('Investments write answers');
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    account = (await tenant.pool.query<{ uuid: string }>(
      `INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Write answers', 'investment', 'investments', 'Asset') RETURNING uuid`
    )).rows[0]!.uuid;
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('answers a buy, a sale, a dividend and a fee, recorded and as dry runs', async () => {
    const sec = await security();
    await buy(sec, '2025-01-02', { dry_run: true });
    await buy(sec, '2025-01-02');
    // A loss sale, then a buy within 30 days: the buy's answer carries the wash sale it makes.
    const sell = { account_uuid: account, security_uuid: sec, event_date: '2025-02-03', shares: '4', price_per_share: '15', method: 'fifo' };
    await post('/events/sell', { ...sell, dry_run: true }, sellResponseSchema, 200);
    await post('/events/sell', sell, sellResponseSchema, 201);
    const washed = await buy(sec, '2025-02-10');
    expect(washed.wash_sale.flagged).toBe(1);

    const dividend = { account_uuid: account, security_uuid: sec, event_date: '2025-03-03', total_amount: '6.00' };
    await post('/events/dividend', { ...dividend, dry_run: true }, dividendResponseSchema, 200);
    await post('/events/dividend', dividend, dividendResponseSchema, 201);
    const reinvest = { ...dividend, event_date: '2025-04-01', reinvest: true, price_per_share: '20' };
    await post('/events/dividend', { ...reinvest, dry_run: true }, dividendResponseSchema, 200);
    const reinvested = await post('/events/dividend', reinvest, dividendResponseSchema, 201);
    expect(reinvested.lot_uuid).toEqual(expect.any(String));

    const fee = { account_uuid: account, fee_type: 'advisory', amount: '2.50', event_date: '2025-05-01', external_reference: 'WA-FEE-1' };
    expect((await post('/events/fee', fee, feeResponseSchema, 201)).status).toBe('created');
    expect((await post('/events/fee', fee, feeResponseSchema, 201)).status).toBe('skipped');

    await post('/cost-basis-method', { account_uuid: account, security_uuid: sec, method: 'hifo' }, costBasisMethodResponseSchema, 200);
  });

  it('answers each corporate action, applied and as a dry run', async () => {
    const split = await security();
    await buy(split, '2024-01-02');
    const splitBody = { security_uuid: split, action_date: '2024-06-03', numerator: '2', denominator: '1' };
    await post('/corporate-actions/split', { ...splitBody, dry_run: true }, splitResponseSchema, 200);
    await post('/corporate-actions/split', splitBody, splitResponseSchema, 201);
    await post('/corporate-actions/split', { ...splitBody, action_date: '2024-07-01', reverse: true }, splitResponseSchema, 201);

    const roc = await security();
    await buy(roc, '2024-01-02');
    const rocBody = { security_uuid: roc, action_date: '2024-06-03', amount_per_share: '1.25' };
    await post('/corporate-actions/return-of-capital', { ...rocBody, dry_run: true }, returnOfCapitalResponseSchema, 200);
    await post('/corporate-actions/return-of-capital', rocBody, returnOfCapitalResponseSchema, 201);

    const parent = await security();
    const child = await security();
    await buy(parent, '2024-01-02');
    const spinoff = { source_security_uuid: parent, new_security_uuid: child, action_date: '2024-06-03', allocation_fraction: '0.2', share_ratio: '0.5' };
    await post('/corporate-actions/spinoff', { ...spinoff, dry_run: true }, spinoffResponseSchema, 200);
    await post('/corporate-actions/spinoff', spinoff, spinoffResponseSchema, 201);

    const target = await security();
    const acquirer = await security();
    await buy(target, '2024-01-02');
    const stock = { security_uuid: target, acquirer_security_uuid: acquirer, action_date: '2024-06-03', exchange_ratio: '1.5' };
    await post('/corporate-actions/merger-stock', { ...stock, dry_run: true }, mergerStockResponseSchema, 200);
    await post('/corporate-actions/merger-stock', stock, mergerStockResponseSchema, 201);

    const cashed = await security();
    await buy(cashed, '2024-01-02');
    const cash = { security_uuid: cashed, action_date: '2024-06-03', cash_per_share: '25' };
    await post('/corporate-actions/merger-cash', { ...cash, dry_run: true }, mergerCashResponseSchema, 200);
    await post('/corporate-actions/merger-cash', cash, mergerCashResponseSchema, 201);
  });

  it("answers a fund's composition and underlying holdings, written and read", async () => {
    const fund = await security({ security_type: 'etf', is_pass_through: true });
    await post('/compositions', {
      security_uuid: fund,
      snapshot_date: '2025-06-30',
      dimensions: { asset_class: [{ dimension_value: 'equity', weight_percentage: '60' }, { dimension_value: 'fixed_income', weight_percentage: '40' }] },
    }, compositionUpsertResponseSchema, 201);
    const composition = await request(app).get(`/api/investments/securities/${fund}/composition`).expect(200);
    expect(composition.body).toHaveLength(2);
    expect(answerProblem(fundCompositionResponseSchema, composition.body)).toBeNull();

    await request(app).post('/api/investments/underlying-holdings').send({
      security_uuid: fund,
      snapshot_date: '2025-06-30',
      holdings: [{ underlying_ticker: 'WAU1', weight_percentage: '55.5', shares: '120.5' }, { underlying_ticker: 'WAU2', weight_percentage: '30' }],
    }).expect(201);
    const underlying = await request(app).get(`/api/investments/securities/${fund}/underlying-holdings`).expect(200);
    expect(underlying.body.map((r: { shares: unknown }) => r.shares)).toEqual([120.5, null]);
    expect(answerProblem(underlyingHoldingsResponseSchema, underlying.body)).toBeNull();
  });
});
