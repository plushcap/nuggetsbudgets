import { describe, it, expect, afterEach, vi } from 'vitest';
import { QueryStringError } from '@nuggets/shared';
import { mockApi } from '../../../test/apiServer';
import { holding, investmentAnswers, taxLot, uuidFor } from '../../../test/fixtures';
import { AnswerContractError } from '../parseAnswer';
import * as investments from '../investments';
import { getPriceSyncRuns, getPriceSyncSettings, runPriceSync, updatePriceSyncSettings } from '../organizations';

/**
 * The investments api module reads every answer with its @nuggets/shared schema
 * and builds every query string from its route's own query schema. Before, each call
 * was `apiGet<T>` cast to a hand-written type: an answer of any shape was handed to the page,
 * NUMERIC columns stayed text, and a query value the route refuses was sent anyway.
 */

const SECURITY = uuidFor(7, 1);
const ACCOUNT = uuidFor(1, 1);
const ORG = uuidFor(13, 1);
/** An answer no investments schema takes: a field none names, and none of the ones they need. */
const STRAY = { unexpected: true };

afterEach(() => vi.unstubAllGlobals());

const reads: Array<[string, string, () => Promise<unknown>, unknown]> = [
  ['getSecurities', 'GET /investments/securities', () => investments.getSecurities(), [STRAY]],
  ['getSecurity', 'GET /investments/securities/:uuid', () => investments.getSecurity(SECURITY), STRAY],
  ['getSecuritiesPaginated', 'GET /investments/securities/paginated', () => investments.getSecuritiesPaginated(), STRAY],
  ['getUnusedPassThroughSecurities', 'GET /investments/securities/cleanup/pass-through-unused', () => investments.getUnusedPassThroughSecurities(), STRAY],
  ['getHoldings', 'GET /investments/holdings', () => investments.getHoldings(), [STRAY]],
  ['getLots', 'GET /investments/holdings/:uuid/lots', () => investments.getLots(SECURITY), [STRAY]],
  ['getHoldingEvents', 'GET /investments/events', () => investments.getHoldingEvents(), STRAY],
  ['getRealizedGainLoss', 'GET /investments/reports/realized-gain-loss', () => investments.getRealizedGainLoss(), [STRAY]],
  ['getCostOfOwnership', 'GET /investments/reports/cost-of-ownership', () => investments.getCostOfOwnership(), STRAY],
  ['getFeesSummary', 'GET /investments/reports/fees', () => investments.getFeesSummary(), STRAY],
  ['getWashSales', 'GET /investments/reports/wash-sales', () => investments.getWashSales(), [STRAY]],
  ['getDataFreshness', 'GET /investments/reports/data-freshness', () => investments.getDataFreshness(), STRAY],
  ['getFundComposition', 'GET /investments/securities/:uuid/composition', () => investments.getFundComposition(SECURITY), [STRAY]],
  ['getUnderlyingHoldings', 'GET /investments/securities/:uuid/underlying-holdings', () => investments.getUnderlyingHoldings(SECURITY), [STRAY]],
  ['getDividendHistory', 'GET /investments/reports/dividend-history', () => investments.getDividendHistory(), STRAY],
  ['getPerformance', 'GET /investments/reports/performance', () => investments.getPerformance(), STRAY],
  ['getReconciliation', 'GET /investments/reports/reconciliation', () => investments.getReconciliation(), STRAY],
  ['getValueSeries', 'GET /investments/reports/value-series', () => investments.getValueSeries(), STRAY],
  ['getSellTaxImpact', 'GET /investments/reports/sell-tax-impact', () => investments.getSellTaxImpact({ account: ACCOUNT, security: SECURITY, shares: 1 }), STRAY],
  ['getTaxLossHarvest', 'GET /investments/reports/tax-loss-harvest', () => investments.getTaxLossHarvest(), STRAY],
  ['getConcentration', 'GET /investments/reports/concentration', () => investments.getConcentration(), STRAY],
  ['getPriceSyncSettings', 'GET /organizations/:uuid/price-sync/settings', () => getPriceSyncSettings(ORG), STRAY],
  ['getPriceSyncRuns', 'GET /organizations/:uuid/price-sync/runs', () => getPriceSyncRuns(ORG), STRAY],
];

const writes: Array<[string, string, () => Promise<unknown>]> = [
  ['createSecurity', 'POST /investments/securities', () => investments.createSecurity({ ticker: 'X', name: 'X', security_type: 'stock' } as never)],
  ['updateSecurity', 'PUT /investments/securities/:uuid', () => investments.updateSecurity(SECURITY, { name: 'X' })],
  ['deleteUnusedPassThroughSecurities', 'DELETE /investments/securities/cleanup/pass-through-unused', () => investments.deleteUnusedPassThroughSecurities()],
  ['recordBuy', 'POST /investments/events/buy', () => investments.recordBuy({} as never)],
  ['recordSell', 'POST /investments/events/sell', () => investments.recordSell({} as never)],
  ['recordDividend', 'POST /investments/events/dividend', () => investments.recordDividend({} as never)],
  ['recordFee', 'POST /investments/events/fee', () => investments.recordFee({} as never)],
  ['upsertPrice', 'POST /investments/prices', () => investments.upsertPrice({} as never)],
  ['applySplit', 'POST /investments/corporate-actions/split', () => investments.applySplit({} as never)],
  ['applyReturnOfCapital', 'POST /investments/corporate-actions/return-of-capital', () => investments.applyReturnOfCapital({} as never)],
  ['applySpinoff', 'POST /investments/corporate-actions/spinoff', () => investments.applySpinoff({} as never)],
  ['applyMergerCash', 'POST /investments/corporate-actions/merger-cash', () => investments.applyMergerCash({} as never)],
  ['applyMergerStock', 'POST /investments/corporate-actions/merger-stock', () => investments.applyMergerStock({} as never)],
  ['setCostBasisMethod', 'POST /investments/cost-basis-method', () => investments.setCostBasisMethod({} as never)],
  ['upsertComposition', 'POST /investments/compositions', () => investments.upsertComposition({} as never)],
  ['updatePriceSyncSettings', 'PUT /organizations/:uuid/price-sync/settings', () => updatePriceSyncSettings(ORG, { enabled: true })],
  ['runPriceSync', 'POST /organizations/:uuid/price-sync/run', () => runPriceSync(ORG)],
];

describe('the investments api module', () => {
  it.each(reads)('%s reads its answer with its shared schema', async (_name, route, call, stray) => {
    mockApi({ [route]: stray });
    await expect(call()).rejects.toThrow(AnswerContractError);
  });

  it.each(writes)("%s reads the write's answer with its shared schema", async (_name, route, call) => {
    mockApi({ [route]: { status: 201, body: { success: true } } });
    await expect(call()).rejects.toThrow(AnswerContractError);
  });

  it('hands the page numbers for the NUMERIC columns, not their text', async () => {
    mockApi({ 'GET /investments/holdings/:uuid/lots': [taxLot({ id: 1, acquisition_date: '2025-01-02', shares: 2.5 })] });
    const [lot] = await investments.getLots(SECURITY);
    expect(lot).toMatchObject({ shares_remaining: 2.5, cost_basis_per_share: 100, total_cost_basis: 250 });
    mockApi({ 'POST /investments/events/buy': { status: 201, body: investmentAnswers.buy } });
    await expect(investments.recordBuy({} as never)).resolves.toMatchObject({ total_cost_basis: 1000 });
  });

  it('reads the largest figures stored data makes, sent as exact text past what a double holds', async () => {
    // 999,999,999,999 shares closed at $99,999,999.9999, as the API sends them.
    mockApi({
      'GET /investments/holdings': [holding({
        security_id: 1, ticker: 'HUGE', total_shares: '999999999999.000000', total_cost_basis: '100000000.00', average_cost_per_share: 0.0001,
        latest_price: '99999999.9999', market_value: '99999999999800000000.00', unrealized_gain_loss: '99999999999700000000.00',
      })],
    });
    const [huge] = await investments.getHoldings();
    expect(huge).toMatchObject({ market_value: 99999999999800000000, unrealized_gain_loss: 99999999999700000000, total_cost_basis: 100000000 });
  });

  it("builds each query from its route's schema, and sends none the route would refuse", async () => {
    const api = mockApi({
      'GET /investments/events': { data: [], pagination: { page: 2, limit: 25, total: 0, totalPages: 0 } },
      'GET /investments/securities/paginated': { data: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 1 } },
    });
    await investments.getHoldingEvents({ page: 2, limit: 25, event_type: 'buy', security: SECURITY });
    expect(api.calls('GET /investments/events')[0]!.query.toString()).toBe(`page=2&limit=25&event_type=buy&security=${SECURITY}`);
    await investments.getSecuritiesPaginated({ search: 'total market', include_inactive: true });
    expect(api.calls('GET /investments/securities/paginated')[0]!.query.toString()).toBe('search=total+market&include_inactive=true');

    // What the route answers 400 is refused here, with its message, and nothing is sent.
    await expect(investments.getHoldingEvents({ account: 'not-a-uuid' })).rejects.toThrow(new QueryStringError('account must be a uuid'));
    await expect(investments.getHoldingEvents({ start_date: '2025-02-30' })).rejects.toThrow(QueryStringError);
    await expect(investments.getSellTaxImpact({ account: ACCOUNT, security: SECURITY, shares: 0 })).rejects.toThrow('shares must be a positive number');
    expect(api.requests).toHaveLength(2);
  });
});
