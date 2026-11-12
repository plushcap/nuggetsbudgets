import { Router, Response } from 'express';
import { tenantHandler, AuthenticatedRequest } from '../utils/routeHandler.js';
import { parsedQuery, validateBody, validateQuery } from '../middleware/validate.js';
import {
  securityBulkDeleteSchema,
  securityCreateSchema,
  type SecurityBulkDeleteInput,
  securityUpdateSchema,
  priceUpsertSchema,
  priceBulkUpsertSchema,
  buyEventSchema,
  sellEventSchema,
  dividendEventSchema,
  costBasisMethodSettingSchema,
  splitActionSchema,
  returnOfCapitalSchema,
  spinoffActionSchema,
  mergerCashSchema,
  mergerStockSchema,
  batchImportLotsSchema,
  lotUpdateSchema,
  type LotUpdateInput,
  compositionUpsertSchema,
  expenseRatioUpdateSchema,
  underlyingHoldingsUpsertSchema,
  underlyingTrackingSchema,
  feeEventSchema,
  rowsToCsv,
  securityListQuery,
  securityPageQuery,
  unusedSecuritiesQuery,
  holdingsQuery,
  holdingEventsQuery,
  investmentRangeQuery,
  sellTaxImpactQuery,
  taxLossHarvestQuery,
  lotSuggestionsQuery,
  concentrationQuery,
  dataFreshnessQuery,
  lookThroughQuery,
  valueSeriesQuery,
  securitiesNeedingDataQuery,
  priceGapsQuery,
  type InvestmentRangeQuery,
} from '@nuggets/shared';
import { HoldingsService } from '../services/investments/HoldingsService.js';
import { LotService } from '../services/investments/LotService.js';
import { SecurityService } from '../services/investments/SecurityService.js';
import { CorporateActionService } from '../services/investments/CorporateActionService.js';
import { LookThroughService } from '../services/investments/LookThroughService.js';
import { WashSaleService } from '../services/investments/WashSaleService.js';
import { FeeService } from '../services/investments/FeeService.js';
import { FreshnessService } from '../services/investments/FreshnessService.js';
import { TaxPlanningService } from '../services/investments/TaxPlanningService.js';
import { PerformanceService } from '../services/investments/PerformanceService.js';
import { ReconciliationService } from '../services/investments/ReconciliationService.js';
import { PortfolioValuationService } from '../services/investments/PortfolioValuationService.js';
import { appToday } from '../utils/appDate.js';
import { contentDisposition } from '../utils/uploadSafety.js';
import { withoutUndefined } from '../utils/withoutUndefined.js';
import { requestCents, type DecimalValue } from '../utils/decimal.js';

/**
 * Investment Tracking routes. Mounted at /api/investments behind
 * authenticateToken -> resolveTenant -> requireTenantMember; every handler runs
 * inside tenantHandler so getDb() is RLS-scoped.
 *
 * Each route that reads a query string parses it with validateQuery and its schema in
 * @nuggets/shared (investments.ts): a malformed id, day, number, count or choice, or a NUL
 * in text, is 400 VALIDATION_ERROR before any of it reaches SQL.
 */
export function createInvestmentsRoutes(): Router {
  const router = Router();
  const securities = new SecurityService();
  const holdings = new HoldingsService();
  const lots = new LotService();
  const corporateActions = new CorporateActionService();
  const lookThrough = new LookThroughService();
  const washSale = new WashSaleService();
  const fees = new FeeService();
  const freshness = new FreshnessService();
  const taxPlanning = new TaxPlanningService();
  const performance = new PerformanceService();
  const reconciliation = new ReconciliationService();
  const valuation = new PortfolioValuationService();

  /** A range report's days and account, as the services take them (what wasn't given left out). */
  const rangeOf = (q: InvestmentRangeQuery) => withoutUndefined({ startDate: q.start_date, endDate: q.end_date, accountUuid: q.account });

  const sendCsv = (res: Response, filename: string, csv: string) => {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', contentDisposition('attachment', filename));
    res.send(csv);
  };

  // ----------------------------------------------------------- securities CRUD
  router.get('/securities', validateQuery(securityListQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.list({ includeInactive: parsedQuery(req, securityListQuery).include_inactive }));
  }));

  // Server-side searched + paginated catalog (the securities list can be huge).
  router.get('/securities/paginated', validateQuery(securityPageQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { page, limit, include_inactive, search } = parsedQuery(req, securityPageQuery);
    res.json(await securities.listPage({ page, limit, offset: (page - 1) * limit, includeInactive: include_inactive, search }));
  }));

  // Bulk cleanup of unused pass-through (fund) securities: GET previews the set; DELETE removes it.
  router.get('/securities/cleanup/pass-through-unused', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.previewPassThroughCleanup());
  }));

  router.delete('/securities/cleanup/pass-through-unused', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.deletePassThroughUnused());
  }));

  // General "what can I safely delete?" list. Filters: search, custom_only.
  router.get('/securities/cleanup/unused', validateQuery(unusedSecuritiesQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { search, custom_only, limit } = parsedQuery(req, unusedSecuritiesQuery);
    res.json(await securities.listUnused({ search, customOnly: custom_only, limit }));
  }));

  // Bulk delete by uuid. Skips securities that are HELD (tax lots / holding events) and reports them.
  // The refusals keep their code.
  router.post('/securities/bulk-delete', validateBody(securityBulkDeleteSchema, { codes: { uuids: 'BAD_REQUEST' } }), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.deleteMany((req.body as SecurityBulkDeleteInput).uuids));
  }));

  // Single delete. 404 if missing, 409 if held, else removed (with cascades).
  router.delete('/securities/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.delete(req.params.uuid as string));
  }));

  router.post('/securities', validateBody(securityCreateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.status(201).json(await securities.create(req.body));
  }));

  router.get('/securities/:uuid', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.get(req.params.uuid as string));
  }));

  router.put('/securities/:uuid', validateBody(securityUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.update(req.params.uuid as string, req.body));
  }));

  // -------------------------------------------------------------------- prices
  router.get('/securities/:uuid/prices', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.listPrices(req.params.uuid as string));
  }));

  router.post('/prices', validateBody(priceUpsertSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.status(201).json(await securities.upsertPrice(req.body));
  }));

  router.post('/prices/bulk', validateBody(priceBulkUpsertSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await securities.upsertPrices(req.body.prices));
  }));

  // -------------------------------------------------------------- events/holds
  router.post('/events/buy', validateBody(buyEventSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await holdings.recordBuy({
      accountUuid: b.account_uuid, securityUuid: b.security_uuid, eventDate: b.event_date,
      shares: b.shares, pricePerShare: b.price_per_share, fees: b.fees, acquisitionMethod: b.acquisition_method,
      source: b.source, description: b.description, externalReference: b.external_reference, dataQuality: b.data_quality,
      isCovered: b.is_covered, adjustedForSplits: b.adjusted_for_splits, userId: req.user?.userId, dryRun: b.dry_run,
    });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.post('/events/sell', validateBody(sellEventSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await holdings.recordSell({
      accountUuid: b.account_uuid, securityUuid: b.security_uuid, eventDate: b.event_date,
      shares: b.shares, pricePerShare: b.price_per_share, fees: b.fees, method: b.method,
      specificLots: b.specific_lots?.map((s: { lot_uuid: string; shares: DecimalValue }) => ({ lotUuid: s.lot_uuid, shares: s.shares })),
      source: b.source, description: b.description, externalReference: b.external_reference,
      adjustedForSplits: b.adjusted_for_splits, userId: req.user?.userId, dryRun: b.dry_run,
    });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.post('/events/dividend', validateBody(dividendEventSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await holdings.recordDividend({
      accountUuid: b.account_uuid, securityUuid: b.security_uuid, eventDate: b.event_date,
      totalAmount: b.total_amount, amountPerShare: b.amount_per_share, exDate: b.ex_date, recordDate: b.record_date,
      payDate: b.pay_date, isQualified: b.is_qualified, reinvest: b.reinvest, pricePerShare: b.price_per_share,
      reinvestIntoSecurityUuid: b.reinvest_into_security_uuid,
      source: b.source, externalReference: b.external_reference, adjustedForSplits: b.adjusted_for_splits,
      userId: req.user?.userId, dryRun: b.dry_run,
    });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.get('/holdings', validateQuery(holdingsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await holdings.getHoldings(parsedQuery(req, holdingsQuery).account));
  }));

  router.get('/holdings/:securityUuid/lots', validateQuery(holdingsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await holdings.getLots(req.params.securityUuid as string, parsedQuery(req, holdingsQuery).account));
  }));

  // Full holding-events ledger (all transaction types), filterable + paginated.
  router.get('/events', validateQuery(holdingEventsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const q = parsedQuery(req, holdingEventsQuery);
    res.json(await holdings.listEvents({
      page: q.page, limit: q.limit, offset: (q.page - 1) * q.limit,
      accountUuid: q.account, securityUuid: q.security, eventType: q.event_type, startDate: q.start_date, endDate: q.end_date,
    }));
  }));

  router.get('/reports/realized-gain-loss', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await holdings.getRealizedGainLoss(rangeOf(parsedQuery(req, investmentRangeQuery))));
  }));

  router.get('/reports/unrealized-gain-loss', validateQuery(holdingsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await holdings.getHoldings(parsedQuery(req, holdingsQuery).account));
  }));

  // ----------------------------------------------------- tax planning / advisory
  router.get('/reports/sell-tax-impact', validateQuery(sellTaxImpactQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const q = parsedQuery(req, sellTaxImpactQuery);
    res.json(await taxPlanning.previewSellTaxImpact(withoutUndefined({
      accountUuid: q.account,
      securityUuid: q.security,
      shares: q.shares,
      sellDate: q.date ?? (await appToday()),
      method: q.method,
      pricePerShare: q.price,
      shortTermRate: q.st_rate,
      longTermRate: q.lt_rate,
    })));
  }));

  router.get('/reports/tax-loss-harvest', validateQuery(taxLossHarvestQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { account, min_loss } = parsedQuery(req, taxLossHarvestQuery);
    // Read exactly, in cents: as a double, 0.29 * 100 let a $0.29 loss through,
    // 0.289 rounded up, and 1e307 overflowed to a 500. More than 2 decimal places, or more
    // than DECIMAL(12,2) holds, is 400 INVALID_AMOUNT.
    const minLossCents = min_loss === undefined ? undefined : Number(requestCents(min_loss, 'min_loss'));
    res.json(await taxPlanning.findTaxLossHarvest(withoutUndefined({ accountUuid: account, minLossCents })));
  }));

  router.get('/reports/lot-suggestions', validateQuery(lotSuggestionsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const q = parsedQuery(req, lotSuggestionsQuery);
    res.json(await taxPlanning.suggestLotSelection(withoutUndefined({
      accountUuid: q.account,
      securityUuid: q.security,
      objective: q.objective,
      // The lots a sale on that day could sell (today when not given), as sell-tax-impact reads.
      date: q.date ?? (await appToday()),
      pricePerShare: q.price,
    })));
  }));

  router.get('/reports/concentration', validateQuery(concentrationQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await taxPlanning.getConcentration(withoutUndefined({ thresholdPct: parsedQuery(req, concentrationQuery).threshold })));
  }));

  router.get('/reports/wash-sales', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { start_date, end_date } = parsedQuery(req, investmentRangeQuery);
    res.json(await washSale.getReport(withoutUndefined({ startDate: start_date, endDate: end_date })));
  }));

  router.post('/corporate-actions/split', validateBody(splitActionSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await corporateActions.applySplitAction({ securityUuid: b.security_uuid, actionDate: b.action_date, numerator: b.numerator, denominator: b.denominator, reverse: b.reverse, userId: req.user?.userId, dryRun: b.dry_run });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.post('/corporate-actions/return-of-capital', validateBody(returnOfCapitalSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await corporateActions.applyReturnOfCapitalAction({ securityUuid: b.security_uuid, actionDate: b.action_date, amountPerShare: b.amount_per_share, userId: req.user?.userId, dryRun: b.dry_run });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  // -------------------------------------------------------------- freshness
  router.get('/reports/data-freshness', validateQuery(dataFreshnessQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await freshness.getReport(withoutUndefined({ minHoldingValue: parsedQuery(req, dataFreshnessQuery).min_holding_value })));
  }));

  // ------------------------------------------------------------------- fees
  router.post('/events/fee', validateBody(feeEventSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    res.status(201).json(await fees.recordFee({ accountUuid: b.account_uuid, securityUuid: b.security_uuid ?? null, feeType: b.fee_type, amount: b.amount, eventDate: b.event_date, description: b.description, externalReference: b.external_reference, source: b.source, userId: req.user?.userId }));
  }));

  router.get('/reports/fees', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await fees.getFeesSummary(rangeOf(parsedQuery(req, investmentRangeQuery))));
  }));

  router.get('/reports/cost-of-ownership', validateQuery(holdingsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await fees.getCostOfOwnership(withoutUndefined({ accountUuid: parsedQuery(req, holdingsQuery).account })));
  }));

  // ----------------------------------------------------- look-through / funds
  router.post('/compositions', validateBody(compositionUpsertSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    res.status(201).json(await lookThrough.upsertComposition({ securityUuid: b.security_uuid, snapshotDate: b.snapshot_date, dimensions: b.dimensions, source: b.source, userId: req.user?.userId }));
  }));

  router.post('/expense-ratio', validateBody(expenseRatioUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    res.json(await lookThrough.updateExpenseRatio({ securityUuid: b.security_uuid, expenseRatioPercentage: b.expense_ratio_percentage }));
  }));

  router.get('/securities/:uuid/composition', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await lookThrough.getFundComposition(req.params.uuid as string));
  }));

  router.get('/reports/lookthrough', validateQuery(lookThroughQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { dimension, account } = parsedQuery(req, lookThroughQuery);
    res.json(await lookThrough.getLookThroughAllocation(dimension, account));
  }));

  // Holdings-level look-through: underlying securities + portfolio stock exposure.
  router.post('/underlying-holdings', validateBody(underlyingHoldingsUpsertSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    res.status(201).json(await lookThrough.upsertUnderlyingHoldings({ securityUuid: b.security_uuid, snapshotDate: b.snapshot_date, holdings: b.holdings, source: b.source }));
  }));

  router.post('/underlying-tracking', validateBody(underlyingTrackingSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    res.json(await lookThrough.setUnderlyingTracking({ securityUuid: b.security_uuid, track: b.track_underlying_holdings }));
  }));

  router.get('/securities/:uuid/underlying-holdings', tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await lookThrough.getUnderlyingHoldings(req.params.uuid as string));
  }));

  router.get('/reports/underlying-exposure', validateQuery(holdingsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await lookThrough.getUnderlyingExposure(parsedQuery(req, holdingsQuery).account));
  }));

  router.post('/corporate-actions/spinoff', validateBody(spinoffActionSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await corporateActions.applySpinoffAction({ sourceSecurityUuid: b.source_security_uuid, newSecurityUuid: b.new_security_uuid, actionDate: b.action_date, allocationFraction: b.allocation_fraction, shareRatio: b.share_ratio, userId: req.user?.userId, dryRun: b.dry_run });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.post('/corporate-actions/merger-cash', validateBody(mergerCashSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await corporateActions.applyMergerCashAction({ securityUuid: b.security_uuid, actionDate: b.action_date, cashPerShare: b.cash_per_share, userId: req.user?.userId, dryRun: b.dry_run });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.post('/corporate-actions/merger-stock', validateBody(mergerStockSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await corporateActions.applyMergerStockAction({ securityUuid: b.security_uuid, acquirerSecurityUuid: b.acquirer_security_uuid, actionDate: b.action_date, exchangeRatio: b.exchange_ratio, userId: req.user?.userId, dryRun: b.dry_run });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  router.post('/lots/batch-import', validateBody(batchImportLotsSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    const out = await holdings.batchImportLots({ lots: b.lots, userId: req.user?.userId, dryRun: b.dry_run });
    res.status(b.dry_run ? 200 : 201).json(out);
  }));

  // Correct a lot's covered status; refused once an average-cost sale pooled it.
  router.patch('/lots/:uuid', validateBody(lotUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await lots.setCovered(req.params.uuid as string, (req.body as LotUpdateInput).is_covered, req.user?.userId));
  }));

  router.get('/reports/reconciliation', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    res.json(await reconciliation.getStatus({}));
  }));

  // Equity curve: daily mark-to-market portfolio value series.
  router.get('/reports/value-series', validateQuery(valueSeriesQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    // At most ten years of days, five by default (as getSeries bounds it).
    const { start_date, limit } = parsedQuery(req, valueSeriesQuery);
    res.json({ series: await valuation.getSeries(withoutUndefined({ startDate: start_date, limit })) });
  }));

  // An unknown category was read as expense_ratio and echoed back; it is refused now.
  router.get('/reports/securities-needing-data', validateQuery(securitiesNeedingDataQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await freshness.getSecuritiesNeedingData(parsedQuery(req, securitiesNeedingDataQuery).category));
  }));

  router.get('/securities/:uuid/price-gaps', validateQuery(priceGapsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await freshness.getPriceHistoryGaps(req.params.uuid as string, parsedQuery(req, priceGapsQuery).threshold_days));
  }));

  // --- CSV exports -----------------------------------------------------------
  router.get('/export/holdings.csv', validateQuery(holdingsQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const rows = await holdings.getHoldings(parsedQuery(req, holdingsQuery).account);
    sendCsv(res, 'holdings.csv', rowsToCsv(rows as unknown as Array<Record<string, unknown>>,
      ['ticker', 'name', 'total_shares', 'average_cost_per_share', 'latest_price', 'market_value', 'total_cost_basis', 'unrealized_gain_loss']));
  }));

  router.get('/export/realized-gain-loss.csv', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const rows = await holdings.getRealizedGainLoss(rangeOf(parsedQuery(req, investmentRangeQuery)));
    sendCsv(res, 'realized-gain-loss.csv', rowsToCsv(rows as unknown as Array<Record<string, unknown>>,
      ['ticker', 'sell_date', 'shares_consumed', 'basis_consumed', 'proceeds', 'realized_gain_loss', 'is_long_term', 'is_wash_sale']));
  }));

  router.get('/export/dividends.csv', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const out = await holdings.getDividendHistory(rangeOf(parsedQuery(req, investmentRangeQuery)));
    sendCsv(res, 'dividends.csv', rowsToCsv(out.records as unknown as Array<Record<string, unknown>>, ['ticker', 'pay_date', 'total_amount', 'is_qualified', 'is_reinvested']));
  }));

  router.get('/reports/performance', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await performance.getPerformance(rangeOf(parsedQuery(req, investmentRangeQuery))));
  }));

  router.get('/reports/dividend-history', validateQuery(investmentRangeQuery), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    res.json(await holdings.getDividendHistory(rangeOf(parsedQuery(req, investmentRangeQuery))));
  }));

  router.post('/cost-basis-method', validateBody(costBasisMethodSettingSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const b = req.body;
    res.json(await holdings.setCostBasisMethod({ accountUuid: b.account_uuid, securityUuid: b.security_uuid ?? null, method: b.method, dripEnabled: b.drip_enabled }));
  }));

  return router;
}
