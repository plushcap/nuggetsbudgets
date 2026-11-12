import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import { createTestTenant, type TestTenant } from '../../test/testTenant.js';
import { startRouteHarness, type RouteHarness, type Verb } from './routeHarness.js';
import {
  answerProblem,
  buyResponseSchema,
  concentrationResponseSchema,
  costOfOwnershipResponseSchema,
  dataFreshnessResponseSchema,
  dividendHistoryResponseSchema,
  dividendResponseSchema,
  feeResponseSchema,
  feesSummaryResponseSchema,
  holdingEventsPageResponseSchema,
  holdingResponseSchema,
  lookThroughResponseSchema,
  lotSuggestionsResponseSchema,
  passThroughCleanupPreviewResponseSchema,
  passThroughCleanupResponseSchema,
  performanceResponseSchema,
  priceGapsResponseSchema,
  priceResponseSchema,
  priceUpsertResponseSchema,
  realizedGainLossRowSchema,
  reconciliationResponseSchema,
  securitiesNeedingDataResponseSchema,
  securityCreateResponseSchema,
  securityPageResponseSchema,
  securityResponseSchema,
  sellResponseSchema,
  sellTaxImpactResponseSchema,
  taxLossHarvestResponseSchema,
  taxLotResponseSchema,
  underlyingExposureResponseSchema,
  unusedSecuritiesResponseSchema,
  valueSeriesResponseSchema,
  washSalesResponseSchema,
} from '@nuggets/shared';
import { z } from 'zod';

/**
 * The investments routes' whole answers, pinned: status, body and the download
 * headers, through the real app (so the request scope's `code` and `requestId` are in each
 * error answer as a client sees it). Written before the routes' database work moved to
 * services/investments/ and their query checks to shared schemas, so each move is checked
 * against what the routes answered before it.
 *
 * The answers carry ids, uuids and instants that differ from run to run: each uuid is
 * replaced with a placeholder numbered in the order it first appears, each id with one per
 * column (`<security_id:2>`; a row's own `id` takes the name of what the route lists), each
 * instant with `<instant>` and each request id with `<requestId>`. The fixture's days are
 * all in the past and every report that defaults to today is given its day, so the answers
 * don't change from one day to the next.
 */

const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeDb = connectionString ? describe : describe.skip;

type Ref = { id: number; uuid: string };

describeDb('Investments routes: whole answers', () => {
  let h: RouteHarness;
  let tenant: TestTenant;
  let session: string;
  const accounts = {} as Record<'brokerage' | 'ira', Ref>;
  const securities = {} as Record<'aaa' | 'bbb' | 'fund' | 'idle' | 'pct' | 'held2', Ref>;

  const uuids = new Map<string, string>();
  const ids = new Map<string, Map<number, string>>();
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ID_KEYS = new Set(['lotId', 'sourceLotId', 'securityId']);
  const placeholder = (kind: string, id: number) => {
    const forKind = ids.get(kind) ?? ids.set(kind, new Map()).get(kind)!;
    if (!forKind.has(id)) forKind.set(id, `<${kind}:${forKind.size + 1}>`);
    return forKind.get(id);
  };
  const normalize = (value: unknown, idOf: string, key = ''): unknown => {
    if (Array.isArray(value)) return value.map((v) => normalize(v, idOf, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v, idOf, k)]));
    }
    if (key === 'requestId' && typeof value === 'string') return '<requestId>';
    if (typeof value === 'string' && UUID.test(value)) {
      if (!uuids.has(value)) uuids.set(value, `<uuid:${uuids.size + 1}>`);
      return uuids.get(value);
    }
    if (/_at$/.test(key) && value != null) return '<instant>';
    if (typeof value === 'number' && (key === 'id' || key.endsWith('_id') || ID_KEYS.has(key))) {
      return placeholder(key === 'id' ? idOf : key, value);
    }
    return value;
  };
  /** A CSV download with its uuids replaced as in the JSON answers. */
  const normalizeText = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => String(normalize(u, '')));

  /**
   * Call, and pin the whole answer under the snapshot name `label`. Softly: an answer that
   * differs is reported, and the steps after it still run, so one difference doesn't change
   * the state (and the placeholders) the next answers are pinned with.
   */
  /**
   * The shared response schema of each answer, by label: the answer must be
   * exactly what it names, so a field a route adds fails here until the schema has it.
   */
  const securities_ = z.array(securityResponseSchema);
  const ANSWERS: Record<string, z.ZodType> = {
    'GET /securities': securities_,
    'GET /securities include_inactive': securities_,
    'GET /securities after deletes': securities_,
    'GET /securities/paginated': securityPageResponseSchema,
    'GET /securities/paginated page 2': securityPageResponseSchema,
    'GET /securities/paginated search': securityPageResponseSchema,
    'GET /securities/paginated capped limit': securityPageResponseSchema,
    'GET /securities/:uuid': securityResponseSchema,
    'PUT /securities/:uuid': securityResponseSchema,
    'GET /securities/:uuid/prices': z.array(priceResponseSchema),
    'GET /holdings/:uuid/lots': z.array(taxLotResponseSchema),
    'GET /holdings/:uuid/lots account': z.array(taxLotResponseSchema),
    'GET /holdings': z.array(holdingResponseSchema),
    'GET /holdings account': z.array(holdingResponseSchema),
    'GET /reports/realized-gain-loss': z.array(realizedGainLossRowSchema),
    // Every report and list.
    'POST /prices': priceUpsertResponseSchema,
    'GET /events': holdingEventsPageResponseSchema,
    'GET /events page': holdingEventsPageResponseSchema,
    'GET /events filtered': holdingEventsPageResponseSchema,
    'GET /events all types': holdingEventsPageResponseSchema,
    'GET /reports/unrealized-gain-loss': z.array(holdingResponseSchema),
    'GET /reports/sell-tax-impact': sellTaxImpactResponseSchema,
    'GET /reports/sell-tax-impact latest price': sellTaxImpactResponseSchema,
    'GET /reports/tax-loss-harvest': taxLossHarvestResponseSchema,
    'GET /reports/lot-suggestions': lotSuggestionsResponseSchema,
    'GET /reports/concentration': concentrationResponseSchema,
    'GET /reports/wash-sales': washSalesResponseSchema,
    'GET /reports/fees': feesSummaryResponseSchema,
    'GET /reports/cost-of-ownership': costOfOwnershipResponseSchema,
    'GET /reports/lookthrough': lookThroughResponseSchema,
    'GET /reports/underlying-exposure': underlyingExposureResponseSchema,
    'GET /reports/securities-needing-data': securitiesNeedingDataResponseSchema,
    'GET /reports/securities-needing-data composition': securitiesNeedingDataResponseSchema,
    'GET /reports/securities-needing-data expense_ratio': securitiesNeedingDataResponseSchema,
    'GET /securities/:uuid/price-gaps': priceGapsResponseSchema,
    'GET /securities/:uuid/price-gaps default': priceGapsResponseSchema,
    'GET /reports/performance': performanceResponseSchema,
    'GET /reports/dividend-history': dividendHistoryResponseSchema,
    'GET /reports/value-series': valueSeriesResponseSchema,
    'GET /reports/value-series default': valueSeriesResponseSchema,
    'GET /reports/reconciliation': reconciliationResponseSchema,
    'GET /securities/cleanup/unused': unusedSecuritiesResponseSchema,
    'GET /securities/cleanup/unused filtered': unusedSecuritiesResponseSchema,
    'GET /securities/cleanup/unused limited': unusedSecuritiesResponseSchema,
    'GET /securities/cleanup/pass-through-unused': passThroughCleanupPreviewResponseSchema,
    'DELETE /securities/cleanup/pass-through-unused': passThroughCleanupResponseSchema,
    'DELETE /securities/cleanup/pass-through-unused again': passThroughCleanupResponseSchema,
  };
  const pin = async (label: string, verb: Verb, path: string, body?: object, idOf = 'row') => {
    const res = await h.call(session, verb, `/api/investments${path}`, body);
    if (ANSWERS[label]) {
      expect.soft(res.status, label).toBeLessThan(400);
      expect.soft(answerProblem(ANSWERS[label], res.body), label).toBeNull();
    }
    const csv = /^text\/csv/.test(String(res.headers['content-type'] ?? ''));
    expect.soft({
      status: res.status,
      ...(csv && { contentType: res.headers['content-type'], disposition: res.headers['content-disposition'] }),
      body: csv ? normalizeText(res.text) : normalize(res.body, idOf),
    }).toMatchSnapshot(label);
    return res;
  };

  const one = async <T = Ref>(text: string, params: unknown[] = []) => (await tenant.pool.query(text, params)).rows[0] as T;
  /** The writes the fixture makes, with their answers' schemas (the app parses them). */
  const WRITES: Record<string, z.ZodType> = {
    '/securities': securityCreateResponseSchema,
    '/prices': priceUpsertResponseSchema,
    '/events/buy': buyResponseSchema,
    '/events/sell': sellResponseSchema,
    '/events/dividend': dividendResponseSchema,
    '/events/fee': feeResponseSchema,
  };
  const ok = async (verb: Verb, path: string, body?: object) => {
    const res = await h.call(session, verb, `/api/investments${path}`, body);
    expect(res.status, `${verb} ${path}: ${res.text}`).toBeLessThan(300);
    if (verb === 'post' && WRITES[path]) expect(answerProblem(WRITES[path], res.body), `${verb} ${path}`).toBeNull();
    return res;
  };

  beforeAll(async () => {
    h = await startRouteHarness('Investments characterization');
    tenant = await createTestTenant('Investments characterization');
    session = await h.signIn(tenant.userId, tenant.tenantId);

    accounts.brokerage = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('Brokerage', 'investment', 'investments', 'Asset') RETURNING id, uuid`);
    accounts.ira = await one(`INSERT INTO accounts (name, account_type, account_group, type) VALUES ('IRA', 'investment', 'investments', 'Asset') RETURNING id, uuid`);
    const security = async (values: Record<string, unknown>) => (await ok('post', '/securities', values)).body as Ref;
    securities.aaa = await security({ ticker: 'AAA', name: 'Alpha Co', security_type: 'stock' });
    securities.held2 = await security({ ticker: 'HLD', name: 'Held Two', security_type: 'etf', expense_ratio_percentage: '0.0300' });
    securities.bbb = await security({ ticker: 'BBB', name: 'Beta stub', security_type: 'stock', is_custom: true, notes: 'imported' });
    securities.fund = await security({ ticker: 'FND', name: 'Pass Fund', security_type: 'mutual_fund', is_pass_through: true });
    securities.idle = await security({ ticker: 'IDL', name: 'Idle Co', security_type: 'stock', is_active: false });
    securities.pct = await security({ ticker: 'PCT', name: '100% Growth', security_type: 'stock' });

    for (const [uuid, day, close] of [
      [securities.aaa.uuid, '2025-01-02', '10.0000'],
      [securities.aaa.uuid, '2025-01-20', '11.0000'],
      [securities.aaa.uuid, '2025-06-02', '15.0000'],
      [securities.aaa.uuid, '2025-07-01', '8.5000'],
      [securities.held2.uuid, '2025-02-03', '50.0000'],
      [securities.bbb.uuid, '2025-02-03', '3.2100'],
    ] as const) {
      await ok('post', '/prices', { security_uuid: uuid, price_date: day, close, source: 'test' });
    }

    const buy = (account: Ref, sec: Ref, day: string, shares: string, price: string) =>
      ok('post', '/events/buy', { account_uuid: account.uuid, security_uuid: sec.uuid, event_date: day, shares, price_per_share: price, fees: '1.00' });
    await buy(accounts.brokerage, securities.aaa, '2025-01-02', '10', '10');
    await buy(accounts.ira, securities.aaa, '2025-03-03', '5', '12.5');
    await buy(accounts.brokerage, securities.held2, '2025-02-03', '2.5', '50');
    await ok('post', '/events/sell', {
      account_uuid: accounts.brokerage.uuid, security_uuid: securities.aaa.uuid, event_date: '2025-06-02', shares: '3', price_per_share: '15', method: 'fifo',
    });
    await ok('post', '/events/dividend', {
      account_uuid: accounts.brokerage.uuid, security_uuid: securities.aaa.uuid, event_date: '2025-04-01', total_amount: '3.50', is_qualified: true,
    });
    await ok('post', '/events/fee', { account_uuid: accounts.brokerage.uuid, fee_type: 'advisory', amount: '2.25', event_date: '2025-05-01', description: 'Q2 advisory' });
    await tenant.pool.query(
      `INSERT INTO portfolio_value_snapshots (snapshot_date, total_value, cost_basis, stale_securities)
       VALUES ('2024-12-31', 0, NULL, 0), ('2025-01-02', 100.00, 101.00, 0), ('2025-01-03', 100.00, 101.00, 1), ('2025-01-06', 110.00, 101.00, 0), ('2025-01-07', 111.11, 101.00, 0)`
    );
  }, 60_000);

  afterAll(async () => {
    const settled = await Promise.allSettled([tenant?.cleanup(), h?.close()]);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
  }, 60_000);

  it('lists and pages securities', async () => {
    await pin('GET /securities', 'get', '/securities', undefined, 'security');
    await pin('GET /securities include_inactive', 'get', '/securities?include_inactive=true', undefined, 'security');
    await pin('GET /securities/paginated', 'get', '/securities/paginated?page=1&limit=2', undefined, 'security');
    await pin('GET /securities/paginated page 2', 'get', '/securities/paginated?page=2&limit=2&include_inactive=true', undefined, 'security');
    await pin('GET /securities/paginated search', 'get', '/securities/paginated?search=%25', undefined, 'security');
    await pin('GET /securities/paginated capped limit', 'get', '/securities/paginated?limit=600&search=a', undefined, 'security');
  });

  it('reads, updates and prices one security', async () => {
    await pin('GET /securities/:uuid', 'get', `/securities/${securities.held2.uuid}`, undefined, 'security');
    await pin('GET /securities/:uuid unknown', 'get', '/securities/01900000-0000-7000-8000-000000000001');
    await pin('GET /securities/:uuid malformed', 'get', '/securities/not-a-uuid');
    await pin('PUT /securities/:uuid', 'put', `/securities/${securities.pct.uuid}`, { name: '100% Growth Inc', expense_ratio_percentage: '0.125', exchange: null }, 'security');
    await pin('PUT /securities/:uuid unknown', 'put', '/securities/01900000-0000-7000-8000-000000000001', { name: 'Nobody' });
    await pin('GET /securities/:uuid/prices', 'get', `/securities/${securities.aaa.uuid}/prices`, undefined, 'price');
    await pin('GET /securities/:uuid/prices unknown', 'get', '/securities/01900000-0000-7000-8000-000000000001/prices');
    await pin('POST /prices', 'post', '/prices', { security_uuid: securities.bbb.uuid, price_date: '2025-02-03', close: '3.3', volume: '1200' });
    await pin('POST /prices unknown security', 'post', '/prices', { security_uuid: '01900000-0000-7000-8000-000000000001', price_date: '2025-02-03', close: '1' });
    await pin('POST /prices/bulk', 'post', '/prices/bulk', {
      prices: [
        { security_uuid: securities.bbb.uuid, price_date: '2025-02-04', close: '3.4' },
        { security_uuid: '01900000-0000-7000-8000-000000000001', price_date: '2025-02-04', close: '1' },
        { security_uuid: securities.bbb.uuid, price_date: '2025-02-05', close: '3.5', adjusted_close: '3.45' },
      ],
    });
  });

  it('lists lots and events', async () => {
    await pin('GET /holdings/:uuid/lots', 'get', `/holdings/${securities.aaa.uuid}/lots`, undefined, 'lot');
    await pin('GET /holdings/:uuid/lots account', 'get', `/holdings/${securities.aaa.uuid}/lots?account=${accounts.ira.uuid}`, undefined, 'lot');
    await pin('GET /holdings/:uuid/lots unknown', 'get', '/holdings/01900000-0000-7000-8000-000000000001/lots', undefined, 'lot');
    await pin('GET /events', 'get', '/events');
    await pin('GET /events page', 'get', '/events?page=2&limit=2');
    await pin('GET /events filtered', 'get', `/events?account=${accounts.brokerage.uuid}&security=${securities.aaa.uuid}&event_type=buy&start_date=2025-01-01&end_date=2025-12-31`);
    await pin('GET /events all types', 'get', `/events?event_type=all&end_date=2025-03-31`);
    await pin('GET /holdings', 'get', '/holdings');
    await pin('GET /holdings account', 'get', `/holdings?account=${accounts.ira.uuid}`);
  });

  it('answers the reports their queries ask for', async () => {
    const holding = `account=${accounts.brokerage.uuid}&security=${securities.aaa.uuid}`;
    await pin('GET /reports/realized-gain-loss', 'get', `/reports/realized-gain-loss?start_date=2025-01-01&end_date=2025-12-31&account=${accounts.brokerage.uuid}`);
    await pin('GET /reports/unrealized-gain-loss', 'get', '/reports/unrealized-gain-loss');
    await pin('GET /reports/sell-tax-impact', 'get', `/reports/sell-tax-impact?${holding}&shares=2&date=2025-07-01&method=fifo&price=9.5&st_rate=0.24&lt_rate=0.15`);
    await pin('GET /reports/sell-tax-impact latest price', 'get', `/reports/sell-tax-impact?${holding}&shares=1.5&date=2025-07-01`);
    await pin('GET /reports/tax-loss-harvest', 'get', '/reports/tax-loss-harvest?min_loss=1.00');
    await pin('GET /reports/lot-suggestions', 'get', `/reports/lot-suggestions?${holding}&objective=maximize_loss&date=2025-07-01&price=9`);
    await pin('GET /reports/concentration', 'get', '/reports/concentration?threshold=50');
    await pin('GET /reports/wash-sales', 'get', '/reports/wash-sales?start_date=2025-01-01&end_date=2025-12-31');
    await pin('GET /reports/fees', 'get', `/reports/fees?start_date=2025-01-01&end_date=2025-12-31&account=${accounts.brokerage.uuid}`);
    await pin('GET /reports/cost-of-ownership', 'get', `/reports/cost-of-ownership?account=${accounts.brokerage.uuid}`);
    await pin('GET /reports/lookthrough', 'get', `/reports/lookthrough?dimension=sector&account=${accounts.brokerage.uuid}`);
    await pin('GET /reports/underlying-exposure', 'get', '/reports/underlying-exposure');
    await pin('GET /reports/securities-needing-data', 'get', '/reports/securities-needing-data', undefined, 'security');
    await pin('GET /reports/securities-needing-data composition', 'get', '/reports/securities-needing-data?category=composition');
    await pin('GET /reports/securities-needing-data expense_ratio', 'get', '/reports/securities-needing-data?category=expense_ratio');
    await pin('GET /securities/:uuid/price-gaps', 'get', `/securities/${securities.aaa.uuid}/price-gaps?threshold_days=30`);
    await pin('GET /securities/:uuid/price-gaps default', 'get', `/securities/${securities.aaa.uuid}/price-gaps`);
    await pin('GET /reports/performance', 'get', `/reports/performance?account=${accounts.ira.uuid}&start_date=2025-01-01&end_date=2025-06-30`);
    await pin('GET /reports/dividend-history', 'get', '/reports/dividend-history?start_date=2025-01-01&end_date=2025-12-31');
    await pin('GET /export/holdings.csv', 'get', `/export/holdings.csv?account=${accounts.brokerage.uuid}`);
    await pin('GET /export/realized-gain-loss.csv', 'get', '/export/realized-gain-loss.csv?start_date=2025-01-01');
    await pin('GET /export/dividends.csv', 'get', '/export/dividends.csv?end_date=2025-12-31');
    // Today's figures change from day to day; the answer's shape doesn't.
    const freshness = await h.call(session, 'get', '/api/investments/reports/data-freshness?min_holding_value=10');
    expect(freshness.status).toBe(200);
    expect(answerProblem(dataFreshnessResponseSchema, freshness.body)).toBeNull();
    expect(Object.keys(freshness.body)).toEqual(['stale_prices', 'stale_compositions', 'missing_expense_ratios', 'summary']);
    expect(freshness.body.stale_prices.map((p: { ticker: string }) => p.ticker)).toEqual(['HLD', 'AAA']);
    await pin('GET /reports/value-series', 'get', '/reports/value-series?start_date=2025-01-01&limit=3');
    await pin('GET /reports/value-series default', 'get', '/reports/value-series');
    // The IRA as a synced account, its broker's balance read at a fixed instant.
    await tenant.pool.query(
      `UPDATE accounts SET import_balance = 80.00, import_balance_date = '2025-07-01T16:00:00Z', import_account_rebalance = false WHERE id = $1`,
      [accounts.ira.id]
    );
    await pin('GET /reports/reconciliation', 'get', '/reports/reconciliation');
  });

  it('refuses query values that are not ones', async () => {
    const holding = `account=${accounts.brokerage.uuid}&security=${securities.aaa.uuid}`;
    for (const [label, path] of [
      ['malformed account', '/holdings?account=nope'],
      ['malformed security', '/events?security=123'],
      ['malformed day', '/reports/wash-sales?start_date=2025-02-30'],
      ['day out of range', '/reports/performance?end_date=3000-01-01'],
      ['number', `/reports/sell-tax-impact?${holding}&shares=abc`],
      ['shares not positive', `/reports/sell-tax-impact?${holding}&shares=0`],
      ['missing holding', `/reports/lot-suggestions?account=${accounts.brokerage.uuid}`],
      ['count', '/events?limit=0'],
      ['count text', '/securities/cleanup/unused?limit=ten'],
      ['choice', `/reports/sell-tax-impact?${holding}&shares=1&method=fifoo`],
      ['objective', `/reports/lot-suggestions?${holding}&objective=all`],
      ['NUL', '/securities/paginated?search=a%00'],
      ['negative min_loss', '/reports/tax-loss-harvest?min_loss=-1'],
      ['min_loss not digits', '/reports/tax-loss-harvest?min_loss=1e2'],
      ['min_loss too precise', '/reports/tax-loss-harvest?min_loss=1.005'],
      ['list for a number', '/reports/concentration?threshold=1&threshold=2'],
    ] as const) {
      await pin(`refusal: ${label}`, 'get', path);
    }
  });

  it('cleans up unused securities', async () => {
    await pin('GET /securities/cleanup/unused', 'get', '/securities/cleanup/unused', undefined, 'security');
    await pin('GET /securities/cleanup/unused filtered', 'get', '/securities/cleanup/unused?custom_only=true&search=beta&limit=5', undefined, 'security');
    await pin('GET /securities/cleanup/unused limited', 'get', '/securities/cleanup/unused?limit=2', undefined, 'security');
    await pin('GET /securities/cleanup/pass-through-unused', 'get', '/securities/cleanup/pass-through-unused');
    await pin('DELETE /securities/cleanup/pass-through-unused', 'delete', '/securities/cleanup/pass-through-unused');
    await pin('DELETE /securities/cleanup/pass-through-unused again', 'delete', '/securities/cleanup/pass-through-unused');
  });

  it('deletes securities, one or several, but not a held one', async () => {
    await pin('POST /securities/bulk-delete none', 'post', '/securities/bulk-delete', { uuids: [] });
    await pin('POST /securities/bulk-delete no list', 'post', '/securities/bulk-delete', { uuids: 'x' });
    await pin('POST /securities/bulk-delete too many', 'post', '/securities/bulk-delete', { uuids: Array.from({ length: 1001 }, () => securities.bbb.uuid) });
    await pin('POST /securities/bulk-delete', 'post', '/securities/bulk-delete', {
      uuids: [securities.bbb.uuid, securities.aaa.uuid, '01900000-0000-7000-8000-000000000001', 'not-a-uuid', 42, securities.aaa.uuid],
    });
    await pin('DELETE /securities/:uuid held', 'delete', `/securities/${securities.held2.uuid}`);
    await pin('DELETE /securities/:uuid', 'delete', `/securities/${securities.pct.uuid}`);
    await pin('DELETE /securities/:uuid again', 'delete', `/securities/${securities.pct.uuid}`);
    await pin('DELETE /securities/:uuid malformed', 'delete', '/securities/not-a-uuid');
    await pin('GET /securities after deletes', 'get', '/securities?include_inactive=true', undefined, 'security');
  });
});
