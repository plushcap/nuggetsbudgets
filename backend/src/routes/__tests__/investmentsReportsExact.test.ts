import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import { Pool } from 'pg';
import { answerProblem, lookThroughResponseSchema, underlyingExposureResponseSchema } from '@nuggets/shared';
import { createInvestmentsRoutes } from '../investments.js';
import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { withTenant } from '../../db/withTenant.js';
import { PortfolioValuationService } from '../../services/investments/PortfolioValuationService.js';

/**
 * The read-side investment reports sum and round money exactly. They read NUMERIC
 * sums and products (SUM(shares) × close, 10 decimal places) with Number() and added and
 * rounded doubles, so a value that is exactly half a cent could round the wrong way: a close
 * of $1,024.215 is the double 1024.2149999999999, and one share of it read $1,024.21. Each
 * report now works in units and rounds each figure to cents once: $1,024.22.
 *
 * The portfolio, in its own ledger:
 *  - account A: S1 (a stock, 1 share for $1,000), F (a pass-through fund, 1 share for
 *    $2,000, all of it one underlying stock), G (a fund, 1 share for $100, expense ratio 1.5%);
 *  - account B: S3 (a stock, 1 share for $1,000);
 *  - closes on 2025-06-02: S1, F and S3 $1,024.215, G $137.
 */
describe('Investment reports in exact cents', () => {
  let app: Express;
  let tenant: TestTenant;
  let pool: Pool;
  const stamp = Date.now() % 1_000_000;
  const accounts = {} as Record<'A' | 'B', string>;
  const sec = {} as Record<'S1' | 'F' | 'G' | 'S3', string>;
  const DAY = '2025-06-02';
  const get = async (path: string) => {
    const res = await request(app).get(`/api/investments${path}`);
    expect(res.status, `${path}: ${JSON.stringify(res.body)}`).toBe(200);
    return res.body;
  };
  const post = (path: string, body: object) => request(app).post(`/api/investments${path}`).send(body);

  beforeAll(async () => {
    tenant = await createTestTenant('Exact investment reports');
    pool = tenant.pool;
    app = express();
    app.use(express.json());
    app.use(tenant.context());
    app.use('/api/investments', createInvestmentsRoutes());
    for (const key of ['A', 'B'] as const) {
      accounts[key] = (await pool.query(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ($1, 'investment', 'investments', 'Asset') RETURNING uuid`, [`Brokerage ${key} ${stamp}`])).rows[0].uuid;
    }
    const security = async (key: keyof typeof sec, extra: object) => {
      sec[key] = (await post('/securities', { ticker: `RX${key}${stamp}`, name: key, ...extra }).expect(201)).body.uuid;
    };
    await security('S1', { security_type: 'stock' });
    await security('F', { security_type: 'etf', is_pass_through: true });
    await security('G', { security_type: 'mutual_fund' });
    await security('S3', { security_type: 'stock' });
    const buy = (account: 'A' | 'B', key: keyof typeof sec, price: string) =>
      post('/events/buy', { account_uuid: accounts[account], security_uuid: sec[key], event_date: '2025-01-02', shares: '1', price_per_share: price }).expect(201);
    await buy('A', 'S1', '1000');
    await buy('A', 'F', '2000');
    await buy('A', 'G', '100');
    await buy('B', 'S3', '1000');
    for (const [key, close] of [['S1', '1024.215'], ['F', '1024.215'], ['G', '137'], ['S3', '1024.215']] as const) {
      await post('/prices', { security_uuid: sec[key], price_date: DAY, close }).expect(201);
    }
    await post('/compositions', { security_uuid: sec.S1, snapshot_date: DAY, dimensions: { asset_class: [{ dimension_value: 'equity', weight_percentage: 100 }] } }).expect(201);
    await post('/compositions', { security_uuid: sec.F, snapshot_date: DAY, dimensions: { asset_class: [{ dimension_value: 'bond', weight_percentage: 100 }] } }).expect(201);
    await post('/underlying-holdings', { security_uuid: sec.F, snapshot_date: DAY, holdings: [{ underlying_ticker: `RXUND${stamp}`, weight_percentage: 100 }] }).expect(201);
    await post('/expense-ratio', { security_uuid: sec.G, expense_ratio_percentage: '1.5' }).expect(200);
  });
  afterAll(async () => { await tenant.cleanup(); });

  it('holdings: the market value and the unrealized gain', async () => {
    const rows = await get(`/holdings?account=${accounts.A}`);
    const s1 = rows.find((r: { security_uuid: string }) => r.security_uuid === sec.S1);
    expect(s1).toMatchObject({ total_shares: 1, total_cost_basis: 1000, average_cost_per_share: 1000, latest_price: 1024.215, market_value: 1024.22, unrealized_gain_loss: 24.22 });
  });

  it('look-through allocation: each bucket', async () => {
    const body = await get(`/reports/lookthrough?dimension=asset_class&account=${accounts.A}`);
    // The total is $2,185.43 (2,185.43 exactly). The buckets are rounded together, so they add up
    // to it: $1,024.215 twice is one $1,024.22 and one $1,024.21, where each rounded alone
    // was $1,024.22 and the three made $2,185.44.
    expect(body).toMatchObject({ dimension: 'asset_class', totalValue: 2185.43, unknownValue: 137 });
    // The answer is shared's LookThroughResult, as the frontend reads it.
    expect(answerProblem(lookThroughResponseSchema, body)).toBeNull();
    // Largest first; equity and bond are equal, in no set order.
    expect(body.buckets[2]).toEqual({ dimensionValue: 'unknown', amount: 137, percentage: 6.27 });
    const [first, second] = body.buckets.slice(0, 2);
    expect([first.amount, second.amount]).toEqual([1024.22, 1024.21]);
    expect([first.dimensionValue, second.dimensionValue].sort()).toEqual(['bond', 'equity']);
    expect([first.percentage, second.percentage]).toEqual([46.87, 46.87]);
  });

  it('underlying exposure: the fund\'s stock and the direct one', async () => {
    const body = await get(`/reports/underlying-exposure?account=${accounts.A}`);
    expect(body.total_value).toBe(2185.43);
    expect(body.unknown_value).toBe(0);
    expect(answerProblem(underlyingExposureResponseSchema, body)).toBeNull();
    expect(body.below_a_cent).toEqual({ securities: 0, amount: 0, percentage: 0 });
    // Rounded together, as the buckets are: one $1,024.215 is $1,024.22, the other $1,024.21.
    const exposures = body.exposures as Array<{ ticker: string; amount: number }>;
    expect(exposures.map((e) => e.amount)).toEqual([1024.22, 1024.21, 137]);
    expect(exposures.map((e) => e.ticker).sort()).toEqual([`RXG${stamp}`, `RXS1${stamp}`, `RXUND${stamp}`]);
    expect(exposures[2].ticker).toBe(`RXG${stamp}`);
  });

  it('portfolio valuation (the equity curve\'s snapshot)', async () => {
    // Every open lot in the ledger: 3 × $1,024.215 + $137 = $3,209.645, so $3,209.65.
    const v = await withTenant(tenant.tenantId, () => new PortfolioValuationService().upsertSnapshot(DAY, 'test'));
    expect(v).toMatchObject({ total_value: 3209.65, cost_basis: 4100, holdings_count: 4, priced_securities: 4, stale_securities: 0 });
    const { series } = await get('/reports/value-series');
    expect(series).toEqual([{ snapshot_date: DAY, total_value: 3209.65, cost_basis: 4100, stale_securities: 0 }]);
  });

  it('performance: the value at the period\'s end', async () => {
    const body = await get(`/reports/performance?account=${accounts.B}&end_date=${DAY}`);
    expect(body).toMatchObject({ begin_value: 0, current_value: 1024.22, net_invested: 1000, total_contributed: 1000, total_distributed: 0 });
    expect(body.timeline).toEqual([{ date: '2025-01-02', net_invested: 1000 }]);
  });

  it('cost of ownership: the holding value and the imputed drag', async () => {
    const body = await get(`/reports/cost-of-ownership?account=${accounts.A}`);
    const row = (key: keyof typeof sec) => body.per_holding.find((h: { ticker: string }) => h.ticker === `RX${key}${stamp}`);
    // F's value was answered unrounded, 1024.215.
    expect(row('F')).toMatchObject({ average_holding_value: 1024.22, imputedDrag: 0 });
    // $137 × 1.5% = $2.055, so $2.06; as doubles 137 × 0.015 is 2.0549999999999997, so $2.05.
    expect(row('G')).toMatchObject({ average_holding_value: 137, imputedDrag: 2.06, totalCost: 2.06, effectiveCostPct: 1.5 });
    expect(body).toMatchObject({ total_explicit_fees: 0, total_imputed_drag: 2.06, total_cost: 2.06 });
  });

  it('tax-loss harvest: the market value and the loss', async () => {
    const body = await get(`/reports/tax-loss-harvest?account=${accounts.A}`);
    expect(body.candidates.map((c: { ticker: string; market_value: number; unrealized_loss: number }) => [c.ticker, c.market_value, c.unrealized_loss]))
      .toEqual([[`RXF${stamp}`, 1024.22, 975.78]]);
  });

  it('lot suggestions: the unrealized gain', async () => {
    const body = await get(`/reports/lot-suggestions?account=${accounts.A}&security=${sec.S1}&objective=minimize_gain`);
    expect(body.price_per_share).toBe(1024.215);
    expect(body.lots).toEqual([expect.objectContaining({ sharesRemaining: 1, costBasisPerShare: 1000, unrealizedGain: 24.22 })]);
    expect(typeof body.lots[0].uuid).toBe('string');
  });

  it('concentration: each position\'s value', async () => {
    const body = await get('/reports/concentration');
    const value = (key: keyof typeof sec) => body.rows.find((r: { ticker: string }) => r.ticker === `RX${key}${stamp}`).marketValue;
    expect([value('S1'), value('F'), value('S3'), value('G')]).toEqual([1024.22, 1024.22, 1024.22, 137]);
  });

  it('sell-tax impact: the estimated tax and what is left after it', async () => {
    // A $6.10 short-term gain at 35% is $2.135, so $2.14 (6.1 × 0.35 is 2.1349999999999998).
    const body = await get(`/reports/sell-tax-impact?account=${accounts.A}&security=${sec.S1}&shares=1&date=${DAY}&price=1006.10&st_rate=0.35`);
    expect(body.tax).toEqual({ shortTermGain: 6.1, longTermGain: 0, estimatedShortTermTax: 2.14, estimatedLongTermTax: 0, estimatedTotalTax: 2.14, netProceedsAfterTax: 1003.96 });
    // A rate that isn't a number is a 400, not a null.
    const bad = await request(app).get(`/api/investments/reports/sell-tax-impact?account=${accounts.A}&security=${sec.S1}&shares=1&date=${DAY}&price=1006.10&st_rate=abc`);
    expect(bad.status).toBe(400);
  });

  it('reconciliation: the holdings value', async () => {
    const body = await get('/reports/reconciliation');
    const b = body.accounts.find((a: { account_uuid: string }) => a.account_uuid === accounts.B);
    expect(b).toMatchObject({ holdings_value: 1024.22, cash_value: 0, calculated_value: 1024.22 });
  });
});
