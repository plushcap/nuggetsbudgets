import { apiGet, apiPost, apiPut, apiDelete, API_BASE_URL, assertOk, getAuthHeaders } from './base';
import { saveBlob } from '../../utils/saveBlob';
import { parseAnswer } from './parseAnswer';
import { z } from 'zod';
import {
  buyResponseSchema,
  compositionUpsertResponseSchema,
  concentrationQuery,
  concentrationResponseSchema,
  costBasisMethodResponseSchema,
  costOfOwnershipResponseSchema,
  dataFreshnessResponseSchema,
  dividendHistoryResponseSchema,
  dividendResponseSchema,
  feeResponseSchema,
  feesSummaryResponseSchema,
  fundCompositionResponseSchema,
  holdingEventsPageResponseSchema,
  holdingEventsQuery,
  holdingResponseSchema,
  holdingsQuery,
  investmentRangeQuery,
  lookThroughQuery,
  lookThroughResponseSchema,
  mergerCashResponseSchema,
  mergerStockResponseSchema,
  passThroughCleanupPreviewResponseSchema,
  passThroughCleanupResponseSchema,
  performanceResponseSchema,
  priceUpsertResponseSchema,
  queryString,
  realizedGainLossRowSchema,
  reconciliationResponseSchema,
  returnOfCapitalResponseSchema,
  securityCreateResponseSchema,
  securityListQuery,
  securityPageQuery,
  securityPageResponseSchema,
  securityResponseSchema,
  sellResponseSchema,
  sellTaxImpactQuery,
  sellTaxImpactResponseSchema,
  splitResponseSchema,
  spinoffResponseSchema,
  taxLossHarvestQuery,
  taxLossHarvestResponseSchema,
  taxLotResponseSchema,
  underlyingExposureResponseSchema,
  underlyingHoldingsResponseSchema,
  valueSeriesQuery,
  valueSeriesResponseSchema,
  washSalesResponseSchema,
  type QueryValues,
} from '@nuggets/shared';
import type {
  SecurityCreateInput,
  SecurityUpdateInput,
  BuyEventInput,
  SellEventInput,
  DividendEventInput,
  FeeEventInput,
  PriceUpsertInput,
  SplitActionInput,
  ReturnOfCapitalInput,
  SpinoffActionInput,
  MergerCashInput,
  MergerStockInput,
  CostBasisMethodSettingInput,
  CompositionUpsertInput,
} from '@nuggets/shared';

/**
 * Investment Tracking API client. NOTE: base.ts already prepends `/api`, so paths
 * here start with `/investments`, never `/api/investments`.
 *
 * Every answer is parsed with its @nuggets/shared schema (investments.ts, lookThrough.ts and
 * investmentResponses.ts), and every query string is built from the route's
 * own query schema with `queryString`, which refuses a value the route would.
 */

// --- answer types (the shared schemas' own) ----------------------------------
export type {
  CostOfOwnershipHolding,
  CostOfOwnershipResult,
  DataFreshnessReport,
  DividendHistory,
  FeesSummary,
  FundCompositionRow,
  HoldingEventRow,
  HoldingEventsPage,
  LookThroughBucket,
  LookThroughResult,
  PerformanceResult,
  ReconciliationResult,
  SecuritiesPage,
  SellTaxImpact,
  TlhResult,
  ConcentrationResult,
  UnderlyingExposureResult,
  UnderlyingHoldingRow,
  UnusedPassThroughResult,
  ValueSeriesPoint,
  WashSaleRow,
} from '@nuggets/shared';

// --- request filters (the routes' query schemas' keys) -----------------------
/** GET /investments/events: its filters and page. */
export type HoldingEventsFilters = QueryValues<typeof holdingEventsQuery>;
/** GET /investments/securities/paginated: its search, page and whether inactive ones count. */
export type SecuritiesPageParams = QueryValues<typeof securityPageQuery>;
/** GET /investments/reports/sell-tax-impact: the holding and the shares are required. */
export type SellTaxImpactParams = QueryValues<typeof sellTaxImpactQuery> & { account: string; security: string; shares: number | string };

// --- securities -------------------------------------------------------------
export const getSecurities = async (includeInactive = false) =>
  parseAnswer(z.array(securityResponseSchema), await apiGet<unknown>(`/investments/securities${queryString(securityListQuery, { include_inactive: includeInactive })}`), 'securities');
export const createSecurity = async (data: SecurityCreateInput) => parseAnswer(securityCreateResponseSchema, await apiPost<unknown>('/investments/securities', data), 'security created');
export const getSecurity = async (uuid: string) => parseAnswer(securityResponseSchema, await apiGet<unknown>(`/investments/securities/${uuid}`), 'security');
export const updateSecurity = async (uuid: string, data: SecurityUpdateInput) =>
  parseAnswer(securityResponseSchema, await apiPut<unknown>(`/investments/securities/${uuid}`, data), 'security updated');
export const getSecuritiesPaginated = async (params: SecuritiesPageParams = {}) =>
  parseAnswer(securityPageResponseSchema, await apiGet<unknown>(`/investments/securities/paginated${queryString(securityPageQuery, params)}`), 'securities page');

export const getUnusedPassThroughSecurities = async () =>
  parseAnswer(passThroughCleanupPreviewResponseSchema, await apiGet<unknown>('/investments/securities/cleanup/pass-through-unused'), 'unused pass-through securities');
export const deleteUnusedPassThroughSecurities = async () =>
  parseAnswer(passThroughCleanupResponseSchema, await apiDelete<unknown>('/investments/securities/cleanup/pass-through-unused'), 'pass-through cleanup');

// --- prices / fees / corporate actions / settings ---------------------------
export const upsertPrice = async (data: PriceUpsertInput) => parseAnswer(priceUpsertResponseSchema, await apiPost<unknown>('/investments/prices', data), 'price recorded');
export const recordFee = async (data: FeeEventInput) => parseAnswer(feeResponseSchema, await apiPost<unknown>('/investments/events/fee', data), 'fee recorded');
export const applySplit = async (data: SplitActionInput) => parseAnswer(splitResponseSchema, await apiPost<unknown>('/investments/corporate-actions/split', data), 'split');
export const applyReturnOfCapital = async (data: ReturnOfCapitalInput) =>
  parseAnswer(returnOfCapitalResponseSchema, await apiPost<unknown>('/investments/corporate-actions/return-of-capital', data), 'return of capital');
export const setCostBasisMethod = async (data: CostBasisMethodSettingInput) =>
  parseAnswer(costBasisMethodResponseSchema, await apiPost<unknown>('/investments/cost-basis-method', data), 'cost basis method');
// A ratio or a fraction goes as decimal text or a number, which the API reads exactly.
export const applySpinoff = async (data: SpinoffActionInput) => parseAnswer(spinoffResponseSchema, await apiPost<unknown>('/investments/corporate-actions/spinoff', data), 'spinoff');
export const applyMergerCash = async (data: MergerCashInput) => parseAnswer(mergerCashResponseSchema, await apiPost<unknown>('/investments/corporate-actions/merger-cash', data), 'cash merger');
export const applyMergerStock = async (data: MergerStockInput) => parseAnswer(mergerStockResponseSchema, await apiPost<unknown>('/investments/corporate-actions/merger-stock', data), 'stock merger');

export const getDividendHistory = async (account?: string) =>
  parseAnswer(dividendHistoryResponseSchema, await apiGet<unknown>(`/investments/reports/dividend-history${queryString(investmentRangeQuery, { account: account })}`), 'dividend history');
export const getPerformance = async (account?: string) =>
  parseAnswer(performanceResponseSchema, await apiGet<unknown>(`/investments/reports/performance${queryString(investmentRangeQuery, { account: account })}`), 'performance');
export const getReconciliation = async () => parseAnswer(reconciliationResponseSchema, await apiGet<unknown>('/investments/reports/reconciliation'), 'reconciliation');
export const getValueSeries = async (startDate?: string) =>
  parseAnswer(valueSeriesResponseSchema, await apiGet<unknown>(`/investments/reports/value-series${queryString(valueSeriesQuery, { start_date: startDate })}`), 'value series');

/** Auth-aware CSV download (fetch + Blob; sends the same auth as apiGet). */
export const downloadCsv = async (endpoint: string, filename: string): Promise<void> => {
  const res = await fetch(`${API_BASE_URL}${endpoint}`, { headers: getAuthHeaders(), credentials: 'include' });
  await assertOk(res);
  saveBlob(await res.blob(), filename);
};

// --- holdings / lots --------------------------------------------------------
export const getHoldings = async (accountUuid?: string) =>
  parseAnswer(z.array(holdingResponseSchema), await apiGet<unknown>(`/investments/holdings${queryString(holdingsQuery, { account: accountUuid })}`), 'holdings');
export const getLots = async (securityUuid: string, accountUuid?: string) =>
  parseAnswer(z.array(taxLotResponseSchema), await apiGet<unknown>(`/investments/holdings/${securityUuid}/lots${queryString(holdingsQuery, { account: accountUuid })}`), 'lots');

// --- events -----------------------------------------------------------------
export const recordBuy = async (data: BuyEventInput) => parseAnswer(buyResponseSchema, await apiPost<unknown>('/investments/events/buy', data), 'buy recorded');
export const recordSell = async (data: SellEventInput) => parseAnswer(sellResponseSchema, await apiPost<unknown>('/investments/events/sell', data), 'sale recorded');
export const recordDividend = async (data: DividendEventInput) => parseAnswer(dividendResponseSchema, await apiPost<unknown>('/investments/events/dividend', data), 'dividend recorded');

// --- reports ----------------------------------------------------------------
export const getRealizedGainLoss = async (accountUuid?: string) =>
  parseAnswer(z.array(realizedGainLossRowSchema), await apiGet<unknown>(`/investments/reports/realized-gain-loss${queryString(investmentRangeQuery, { account: accountUuid })}`), 'realized gain/loss');
export const getLookthrough = async (dimension: string, accountUuid?: string) =>
  parseAnswer(lookThroughResponseSchema, await apiGet<unknown>(`/investments/reports/lookthrough${queryString(lookThroughQuery, { dimension, account: accountUuid })}`), 'look-through allocation');
export const getCostOfOwnership = async (accountUuid?: string) =>
  parseAnswer(costOfOwnershipResponseSchema, await apiGet<unknown>(`/investments/reports/cost-of-ownership${queryString(holdingsQuery, { account: accountUuid })}`), 'cost of ownership');
export const getFeesSummary = async (accountUuid?: string) =>
  parseAnswer(feesSummaryResponseSchema, await apiGet<unknown>(`/investments/reports/fees${queryString(investmentRangeQuery, { account: accountUuid })}`), 'fees');
export const getWashSales = async () => parseAnswer(washSalesResponseSchema, await apiGet<unknown>('/investments/reports/wash-sales'), 'wash sales');
export const getDataFreshness = async () => parseAnswer(dataFreshnessResponseSchema, await apiGet<unknown>('/investments/reports/data-freshness'), 'data freshness');
export const getFundComposition = async (securityUuid: string) =>
  parseAnswer(fundCompositionResponseSchema, await apiGet<unknown>(`/investments/securities/${securityUuid}/composition`), 'fund composition');
export const upsertComposition = async (data: CompositionUpsertInput) =>
  parseAnswer(compositionUpsertResponseSchema, await apiPost<unknown>('/investments/compositions', data), 'composition saved');

// --- holdings-level look-through (underlying securities) ---------------------
export const getUnderlyingHoldings = async (securityUuid: string) =>
  parseAnswer(underlyingHoldingsResponseSchema, await apiGet<unknown>(`/investments/securities/${securityUuid}/underlying-holdings`), 'underlying holdings');
export const getUnderlyingExposure = async (accountUuid?: string) =>
  parseAnswer(underlyingExposureResponseSchema, await apiGet<unknown>(`/investments/reports/underlying-exposure${queryString(holdingsQuery, { account: accountUuid })}`), 'underlying exposure');

// --- tax planning / advisory ------------------------------------------------
export const getSellTaxImpact = async (p: SellTaxImpactParams) =>
  parseAnswer(sellTaxImpactResponseSchema, await apiGet<unknown>(`/investments/reports/sell-tax-impact${queryString(sellTaxImpactQuery, p)}`), 'sell tax impact');
export const getTaxLossHarvest = async (account?: string) =>
  parseAnswer(taxLossHarvestResponseSchema, await apiGet<unknown>(`/investments/reports/tax-loss-harvest${queryString(taxLossHarvestQuery, { account })}`), 'tax-loss harvest');
export const getConcentration = async (threshold = 10) =>
  parseAnswer(concentrationResponseSchema, await apiGet<unknown>(`/investments/reports/concentration${queryString(concentrationQuery, { threshold })}`), 'concentration');

export const getHoldingEvents = async (filters: HoldingEventsFilters = {}) =>
  parseAnswer(holdingEventsPageResponseSchema, await apiGet<unknown>(`/investments/events${queryString(holdingEventsQuery, filters)}`), 'investment events');
