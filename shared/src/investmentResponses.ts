import { z } from 'zod';
import {
  costBasisMethod,
  feeType,
  holdingEventType,
  LOT_OBJECTIVES,
  SECURITY_DATA_NEEDS,
  securityResponseSchema,
  securityType,
  washSaleOutcomeSchema,
} from './investments.js';
import {
  dayText,
  instant,
  nullableDayText,
  nullableInstant,
  nullableResponseAmount,
  nullableResponseDecimal,
  responseAmount,
  responseDecimal,
  storedValue,
} from './responses.js';
import { pageResponseSchema } from './transactions.js';

/**
 * The investments routes' answers: every report and list `/api/investments`
 * answers, and the answers to the writes the app sends, each a strict schema of what the
 * route sends (its route tests check the service's real output with `answerProblem`). The
 * frontend parses each answer with its schema (`parseAnswer`), and its types are these.
 *
 * - **Dollars** are `responseAmount`: whole cents, as text (a NUMERIC(12,2) column) or a
 *   number the server added up in cents, and past 15 significant digits exact text (stored
 *   shares at a stored close reach 10^20 dollars, which a double holds without its cents). A
 *   sum with float dust is refused.
 * - **Shares, prices per share, weights** are `responseDecimal`, at their columns' scales.
 * - **A ratio or a percentage the server worked out** (a return, a share of the portfolio)
 *   is a plain number: it has no column, and is rounded to what it shows.
 *
 * The request schemas and the answers pinned earlier (a security, a lot, a
 * holding, a price, a realized sale, a wash-sale outcome) are in investments.ts.
 */

const pageOf = <T extends z.ZodType>(row: T) => z.object({ data: z.array(row), pagination: pageResponseSchema });

/** A security named in a list: its uuid, ticker and name. */
const namedSecuritySchema = z.object({ uuid: z.uuid(), ticker: z.string(), name: z.string() });

// --- securities -------------------------------------------------------------

/** GET /api/investments/securities/paginated: a page of the catalog, each with its latest close. */
export const securityPageResponseSchema = pageOf(securityResponseSchema);
export type SecuritiesPage = z.infer<typeof securityPageResponseSchema>;

/** GET /securities/cleanup/pass-through-unused: how many unused pass-through funds the cleanup would delete, and the first 50. */
export const passThroughCleanupPreviewResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  samples: z.array(namedSecuritySchema),
});
export type UnusedPassThroughResult = z.infer<typeof passThroughCleanupPreviewResponseSchema>;

/** DELETE /securities/cleanup/pass-through-unused: how many it deleted. */
export const passThroughCleanupResponseSchema = z.object({ deleted: z.number().int().nonnegative() });
export type PassThroughCleanupResult = z.infer<typeof passThroughCleanupResponseSchema>;

/** GET /securities/cleanup/unused: the securities not held, up to `limit` of `count`. */
export const unusedSecuritiesResponseSchema = z.object({
  count: z.number().int().nonnegative(),
  returned: z.number().int().nonnegative(),
  items: z.array(
    namedSecuritySchema.extend({
      security_type: storedValue(securityType.options),
      is_pass_through: z.boolean(),
      is_custom: z.boolean(),
      /** In a fund's latest underlying-holdings snapshot (informational: still deletable). */
      currently_underlying: z.boolean(),
    })
  ),
});
export type UnusedSecurities = z.infer<typeof unusedSecuritiesResponseSchema>;

/** GET /reports/securities-needing-data: the active securities with no price, composition or expense ratio. */
export const securitiesNeedingDataResponseSchema = z.object({
  category: z.enum(SECURITY_DATA_NEEDS),
  securities: z.array(namedSecuritySchema),
});
export type SecuritiesNeedingData = z.infer<typeof securitiesNeedingDataResponseSchema>;

/** GET /securities/:uuid/price-gaps: its first and last close, and each gap longer than the threshold. */
export const priceGapsResponseSchema = z.object({
  security_uuid: z.uuid(),
  first_price: nullableDayText,
  last_price: nullableDayText,
  gaps: z.array(z.object({ after: dayText, before: dayText, gap_days: z.number().int().positive() })),
});
export type PriceGaps = z.infer<typeof priceGapsResponseSchema>;

/** POST /securities: the security created (no latest close yet). */
export const securityCreateResponseSchema = securityResponseSchema;

/** POST /prices: the close recorded (or replaced) for the day. */
export const priceUpsertResponseSchema = z.object({ uuid: z.uuid(), price_date: dayText });
export type PriceUpsertResult = z.infer<typeof priceUpsertResponseSchema>;

// --- events -----------------------------------------------------------------

/** One holding event, as GET /api/investments/events lists them (newest first). */
export const holdingEventResponseSchema = z.object({
  uuid: z.uuid(),
  event_type: storedValue(holdingEventType.options),
  event_date: dayText,
  shares: nullableResponseDecimal,
  price_per_share: nullableResponseDecimal,
  total_amount: nullableResponseAmount,
  /** A buy's or sale's commission; 0 for the other events. */
  fees: responseAmount,
  fee_type: storedValue(feeType.options).nullable(),
  source: z.string(),
  description: z.string().nullable(),
  /** Null for an account-level event (a fee on no security). */
  ticker: z.string().nullable(),
  security_uuid: z.uuid().nullable(),
  account_name: z.string(),
  account_uuid: z.uuid(),
  /** Recorded in figures already adjusted for the splits after it. */
  adjusted_for_splits: z.boolean(),
});
export type HoldingEventRow = z.infer<typeof holdingEventResponseSchema>;

/** GET /api/investments/events: a page of the ledger. `totalPages` is 0 when nothing matches. */
export const holdingEventsPageResponseSchema = pageOf(holdingEventResponseSchema);
export type HoldingEventsPage = z.infer<typeof holdingEventsPageResponseSchema>;

/** One lot a sale (or its estimate) takes shares from: what it consumes and realizes. */
export const lotConsumptionSchema = z.object({
  lotId: z.number().int(),
  sharesConsumed: responseDecimal,
  basisConsumed: responseAmount,
  proceeds: responseAmount,
  realizedGainLoss: responseAmount,
  holdingPeriodDays: z.number().int(),
  isLongTerm: z.boolean(),
});
export type LotConsumption = z.infer<typeof lotConsumptionSchema>;

/** A sale's plan: the lots it consumes and its totals, long and short term apart. */
export const sellPlanSchema = z.object({
  consumptions: z.array(lotConsumptionSchema),
  totalProceeds: responseAmount,
  totalBasis: responseAmount,
  totalRealized: responseAmount,
  longTermRealized: responseAmount,
  shortTermRealized: responseAmount,
});
export type SellPlanAmounts = z.infer<typeof sellPlanSchema>;

/** POST /events/buy: the event and lot recorded, or with `dry_run` the lot it would create; each with the wash sales it makes. */
export const buyResponseSchema = z.union([
  z.object({
    event_uuid: z.uuid(),
    lot_uuid: z.uuid(),
    total_cost_basis: responseAmount,
    wash_sale: washSaleOutcomeSchema,
  }),
  z.object({
    dry_run: z.literal(true),
    would_create_lot: z.object({ shares: responseDecimal, total_cost_basis: responseAmount, cost_basis_per_share: responseDecimal }),
    wash_sale: washSaleOutcomeSchema,
  }),
]);
export type BuyResult = z.infer<typeof buyResponseSchema>;

/** POST /events/sell: the sale recorded (or with `dry_run`, planned), its plan and the wash sales it makes. */
export const sellResponseSchema = z.union([
  z.object({ event_uuid: z.uuid(), method: costBasisMethod, plan: sellPlanSchema, wash_sale: washSaleOutcomeSchema }),
  z.object({ dry_run: z.literal(true), method: costBasisMethod, plan: sellPlanSchema, wash_sale: washSaleOutcomeSchema }),
]);
export type SellResult = z.infer<typeof sellResponseSchema>;

/**
 * POST /events/dividend: the payout recorded, or with `dry_run` what it would be. A reinvested
 * one has its new lot and that lot's wash sales; a dividend paid in cash has neither.
 */
export const dividendResponseSchema = z.union([
  z.object({
    event_uuid: z.uuid(),
    reinvest: z.boolean(),
    lot_uuid: z.uuid().optional(),
    reinvested_into_security_uuid: z.uuid().nullable(),
    wash_sale: washSaleOutcomeSchema.optional(),
  }),
  z.object({ dry_run: z.literal(true), reinvest: z.boolean(), total_amount: responseAmount, wash_sale: washSaleOutcomeSchema.optional() }),
]);
export type DividendResult = z.infer<typeof dividendResponseSchema>;

/** POST /events/fee: the fee recorded, or the one already recorded under its external reference. */
export const feeResponseSchema = z.object({ event_uuid: z.uuid(), status: z.enum(['created', 'skipped']) });
export type FeeResult = z.infer<typeof feeResponseSchema>;

/** POST /cost-basis-method: the setting written for the account (or one of its securities). */
export const costBasisMethodResponseSchema = z.object({ uuid: z.uuid() });
export type CostBasisMethodResult = z.infer<typeof costBasisMethodResponseSchema>;

// --- corporate actions --------------------------------------------------------
// Each answers what it changed, or with `dry_run` what it would change, writing nothing.

/** A lot a spinoff or a stock merger makes from one of the source's. */
const derivedLotSchema = z.object({
  sourceLotId: z.number().int(),
  newShares: responseDecimal,
  newCostBasisPerShare: responseDecimal,
  newTotalCostBasis: responseAmount,
  holdingPeriodStart: dayText,
});

/** POST /corporate-actions/split. */
export const splitResponseSchema = z.union([
  z.object({ action_type: z.enum(['split', 'reverse_split']), affected_lots: z.number().int() }),
  z.object({
    dry_run: z.literal(true),
    affected_lots: z.number().int(),
    results: z.array(z.object({ accountId: z.number().int(), lotId: z.number().int(), sharesRemaining: responseDecimal, costBasisPerShare: responseDecimal })),
  }),
]);
export type SplitResult = z.infer<typeof splitResponseSchema>;

/** POST /corporate-actions/return-of-capital: what it takes off each lot's basis, past basis a long-term gain. */
export const returnOfCapitalResponseSchema = z.union([
  z.object({ action_type: z.literal('return_of_capital'), affected_lots: z.number().int(), realized_long_term_gain: responseAmount }),
  z.object({
    dry_run: z.literal(true),
    lots: z.array(z.object({ lotId: z.number().int(), costBasisPerShare: responseDecimal, realizedLongTermGain: responseAmount })),
    totalRealizedLongTermGain: responseAmount,
  }),
]);
export type ReturnOfCapitalResult = z.infer<typeof returnOfCapitalResponseSchema>;

/** POST /corporate-actions/spinoff. */
export const spinoffResponseSchema = z.union([
  z.object({ action_type: z.literal('spinoff'), source_lots: z.number().int(), new_lots: z.number().int() }),
  z.object({
    dry_run: z.literal(true),
    affected_lots: z.number().int(),
    results: z.array(derivedLotSchema.extend({ sourceNewCostBasisPerShare: responseDecimal })),
  }),
]);
export type SpinoffResult = z.infer<typeof spinoffResponseSchema>;

/** POST /corporate-actions/merger-cash: the lots it closes, sold for the cash. */
export const mergerCashResponseSchema = z.union([
  z.object({ action_type: z.literal('merger_cash'), closed_lots: z.number().int(), total_realized: responseAmount }),
  z.object({ dry_run: z.literal(true), consumptions: z.array(lotConsumptionSchema) }),
]);
export type MergerCashResult = z.infer<typeof mergerCashResponseSchema>;

/** POST /corporate-actions/merger-stock: the lots it converts into the acquirer's. */
export const mergerStockResponseSchema = z.union([
  z.object({ action_type: z.literal('merger_stock'), converted_lots: z.number().int(), new_lots: z.number().int() }),
  z.object({ dry_run: z.literal(true), results: z.array(derivedLotSchema) }),
]);
export type MergerStockResult = z.infer<typeof mergerStockResponseSchema>;

// --- reports ----------------------------------------------------------------

/** GET /reports/dividend-history: each payout, newest first, and the totals, qualified and ordinary apart. */
export const dividendHistoryResponseSchema = z.object({
  records: z.array(
    z.object({
      ticker: z.string(),
      /** The pay date (the event's date when none was given). */
      pay_date: nullableDayText,
      total_amount: responseAmount,
      is_qualified: z.boolean(),
      is_reinvested: z.boolean(),
    })
  ),
  total: responseAmount,
  qualified: responseAmount,
  ordinary: responseAmount,
});
export type DividendHistory = z.infer<typeof dividendHistoryResponseSchema>;

/**
 * GET /reports/performance: an account's (or the portfolio's) returns over a range. The
 * returns are null while a held security has no price at the range's start or end
 * (`unpriced_securities`); `note` says which.
 */
export const performanceResponseSchema = z.object({
  /** The account asked for, or null for every account. */
  account: z.uuid().nullable(),
  start_date: dayText,
  end_date: dayText,
  begin_value: responseAmount,
  current_value: responseAmount,
  net_invested: responseAmount,
  total_contributed: responseAmount,
  total_distributed: responseAmount,
  total_fees: responseAmount,
  unpriced_securities: z.number().int().nonnegative(),
  irr: z.number().nullable(),
  twr: z.number().nullable(),
  total_return: z.number().nullable(),
  annualized_return: z.number().nullable(),
  timeline: z.array(z.object({ date: dayText, net_invested: responseAmount })),
  note: z.string(),
});
export type PerformanceResult = z.infer<typeof performanceResponseSchema>;

/** One investment account's reconciliation: its holdings and cash against the broker's imported balance. */
export const reconciliationAccountSchema = z.object({
  account_uuid: z.uuid(),
  account_name: z.string(),
  /** Holdings plus cash; null when the account has no separate cash figure (see `reason`). */
  calculated_value: nullableResponseAmount,
  holdings_value: responseAmount,
  cash_value: nullableResponseAmount,
  imported_balance: nullableResponseAmount,
  imported_balance_date: nullableInstant,
  difference: responseAmount,
  absDifference: responseAmount,
  /** The difference as a percentage of the imported balance, to the hundredth; null without one. */
  pctDifference: z.number().nullable(),
  threshold: responseAmount,
  flagged: z.boolean(),
  reason: z.string().nullable(),
});

/** GET /reports/reconciliation: each open investment account, and how many are past their threshold. */
export const reconciliationResponseSchema = z.object({
  accounts: z.array(reconciliationAccountSchema),
  flagged_count: z.number().int().nonnegative(),
  note: z.string(),
});
export type ReconciliationResult = z.infer<typeof reconciliationResponseSchema>;

/** One day of the equity curve: the portfolio's value, its basis, and how many holdings were valued on a stale close. */
export const valueSeriesPointSchema = z.object({
  snapshot_date: dayText,
  total_value: responseAmount,
  cost_basis: nullableResponseAmount,
  stale_securities: z.number().int().nonnegative(),
});
export type ValueSeriesPoint = z.infer<typeof valueSeriesPointSchema>;

/** GET /reports/value-series: the daily values, oldest first. */
export const valueSeriesResponseSchema = z.object({ series: z.array(valueSeriesPointSchema) });
export type ValueSeries = z.infer<typeof valueSeriesResponseSchema>;

/** A holding's cost of ownership: its explicit fees, its estimated expense-ratio drag, and both as a share of its value. */
export const costOfOwnershipFiguresSchema = z.object({
  explicitFees: responseAmount,
  imputedDrag: responseAmount,
  totalCost: responseAmount,
  /** The total cost as a percentage of the holding's value, to 2 places. */
  effectiveCostPct: z.number(),
});
export type CostOfOwnershipFigures = z.infer<typeof costOfOwnershipFiguresSchema>;
/** As the API sends them (a figure may be exact text), for the backend. */
export type CostOfOwnershipFiguresAnswer = z.input<typeof costOfOwnershipFiguresSchema>;

export const costOfOwnershipHoldingSchema = costOfOwnershipFiguresSchema.extend({
  security_id: z.number().int(),
  ticker: z.string(),
  /** Its current market value, standing in for the period's average (an estimate). */
  average_holding_value: responseAmount,
  imputed_drag_is_estimated: z.boolean(),
});
export type CostOfOwnershipHolding = z.infer<typeof costOfOwnershipHoldingSchema>;

/** GET /reports/cost-of-ownership: each priced holding's cost, the account-level fees, and the totals. */
export const costOfOwnershipResponseSchema = z.object({
  per_holding: z.array(costOfOwnershipHoldingSchema),
  account_level_fees: responseAmount,
  total_explicit_fees: responseAmount,
  total_imputed_drag: responseAmount,
  total_cost: responseAmount,
  note: z.string(),
});
export type CostOfOwnershipResult = z.infer<typeof costOfOwnershipResponseSchema>;
/** The answer as the API sends it (a figure may be exact text), for the backend. */
export type CostOfOwnershipAnswer = z.input<typeof costOfOwnershipResponseSchema>;

/** GET /reports/fees: the standalone fees by type, largest first, and their total. */
export const feesSummaryResponseSchema = z.object({
  by_type: z.array(z.object({ fee_type: storedValue(feeType.options), total: responseAmount, count: z.number().int().positive() })),
  total: responseAmount,
});
export type FeesSummary = z.infer<typeof feesSummaryResponseSchema>;
/** The answer as the API sends it (a figure may be exact text), for the backend. */
export type FeesSummaryAnswer = z.input<typeof feesSummaryResponseSchema>;

/** One wash sale, as GET /reports/wash-sales lists them (latest detected first). */
export const washSaleRowSchema = z.object({
  ticker: z.string(),
  detection_date: dayText,
  disallowed_loss: responseAmount,
  sell_date: dayText,
});
export type WashSaleRow = z.infer<typeof washSaleRowSchema>;
export const washSalesResponseSchema = z.array(washSaleRowSchema);

/**
 * GET /reports/data-freshness: the active securities whose price, composition or expense
 * ratio is stale or missing, held ones first, then by value.
 */
export const dataFreshnessResponseSchema = z.object({
  stale_prices: z.array(
    z.object({
      security_uuid: z.uuid(),
      ticker: z.string(),
      is_held: z.boolean(),
      /** Its open shares at its latest close, as SQL multiplies them (not rounded to the cent); 0 unpriced. */
      market_value: responseDecimal,
      /** Days since its latest close; null when it has none. */
      price_age_days: z.number().int().nullable(),
      never_recorded: z.boolean(),
    })
  ),
  stale_compositions: z.array(
    z.object({ security_uuid: z.uuid(), ticker: z.string(), composition_age_days: z.number().int().nullable(), never_recorded: z.boolean() })
  ),
  missing_expense_ratios: z.array(z.object({ security_uuid: z.uuid(), ticker: z.string() })),
  summary: z.object({
    stale_price_count: z.number().int().nonnegative(),
    stale_composition_count: z.number().int().nonnegative(),
    missing_expense_ratio_count: z.number().int().nonnegative(),
  }),
});
export type DataFreshnessReport = z.infer<typeof dataFreshnessResponseSchema>;

/** One category of a fund's composition, as GET /securities/:uuid/composition lists them (latest snapshot of each dimension). */
export const fundCompositionRowSchema = z.object({
  dimension: z.string(),
  dimension_value: z.string(),
  weight_percentage: responseDecimal,
  snapshot_date: dayText,
});
export type FundCompositionRow = z.infer<typeof fundCompositionRowSchema>;
export const fundCompositionResponseSchema = z.array(fundCompositionRowSchema);

/** POST /compositions: the snapshot written and how many rows. */
export const compositionUpsertResponseSchema = z.object({
  security_uuid: z.uuid(),
  snapshot_date: dayText,
  rows_written: z.number().int().nonnegative(),
});
export type CompositionUpsertResult = z.infer<typeof compositionUpsertResponseSchema>;

/** One security a fund holds, as GET /securities/:uuid/underlying-holdings lists them (its latest snapshot, largest first). */
export const underlyingHoldingResponseSchema = z.object({
  underlying_uuid: z.uuid(),
  ticker: z.string(),
  name: z.string(),
  weight_percentage: responseDecimal,
  shares: nullableResponseDecimal,
  snapshot_date: dayText,
});
export type UnderlyingHoldingRow = z.infer<typeof underlyingHoldingResponseSchema>;
export const underlyingHoldingsResponseSchema = z.array(underlyingHoldingResponseSchema);

/** The tax a sale's estimate works out at the rates given: a loss is a negative tax (an offset). */
export const sellTaxEstimateSchema = z.object({
  shortTermGain: responseAmount,
  longTermGain: responseAmount,
  estimatedShortTermTax: responseAmount,
  estimatedLongTermTax: responseAmount,
  estimatedTotalTax: responseAmount,
  netProceedsAfterTax: responseAmount,
});

/** GET /reports/sell-tax-impact: what selling the shares would consume and realize, and the estimated tax. */
export const sellTaxImpactResponseSchema = z.object({
  price_per_share: responseDecimal,
  method: costBasisMethod,
  plan: sellPlanSchema,
  tax: sellTaxEstimateSchema,
  estimated: z.literal(true),
});
export type SellTaxImpact = z.infer<typeof sellTaxImpactResponseSchema>;

/** GET /reports/tax-loss-harvest: the open lots at a loss, largest first. */
export const taxLossHarvestResponseSchema = z.object({
  candidates: z.array(
    z.object({
      security_id: z.number().int(),
      ticker: z.string(),
      lot_uuid: z.uuid(),
      market_value: responseAmount,
      /** The size of the loss (positive). */
      unrealized_loss: responseAmount,
    })
  ),
  note: z.string(),
});
export type TlhResult = z.infer<typeof taxLossHarvestResponseSchema>;

/** GET /reports/lot-suggestions: a holding's open lots on the day, ranked for the objective. */
export const lotSuggestionsResponseSchema = z.object({
  price_per_share: responseDecimal,
  objective: z.enum(LOT_OBJECTIVES),
  lots: z.array(
    z.object({
      id: z.number().int(),
      uuid: z.uuid(),
      acquisitionDate: dayText,
      holdingPeriodStart: dayText,
      sharesRemaining: responseDecimal,
      costBasisPerShare: responseDecimal,
      totalCostBasis: responseAmount,
      isCovered: z.boolean(),
      /** What selling all of it at the price would realize. */
      unrealizedGain: responseAmount,
    })
  ),
});
export type LotSuggestions = z.infer<typeof lotSuggestionsResponseSchema>;

/** GET /reports/concentration: each priced holding's share of the portfolio, largest first, flagged past the threshold. */
export const concentrationResponseSchema = z.object({
  threshold_pct: z.number(),
  rows: z.array(
    z.object({
      securityId: z.number().int(),
      ticker: z.string(),
      marketValue: responseAmount,
      portfolioPct: z.number(),
      netWorthPct: z.number().nullable(),
      exceedsThreshold: z.boolean(),
    })
  ),
});
export type ConcentrationResult = z.infer<typeof concentrationResponseSchema>;

// --- price sync (an organization's, under /api/organizations/:uuid/price-sync) ----------

/**
 * GET and PUT /api/organizations/:uuid/price-sync/settings: the organization's daily price
 * fetch. Its defaults (off, 17:00 New York) until it is first saved.
 */
export const priceSyncSettingsResponseSchema = z.object({
  organization_id: z.number().int(),
  enabled: z.boolean(),
  /** HH:MM, in `timezone`. */
  schedule_time: z.string().regex(/^\d{2}:\d{2}$/),
  timezone: z.string(),
  provider: z.string(),
  last_run_at: nullableInstant,
});
export type PriceSyncSettings = z.infer<typeof priceSyncSettingsResponseSchema>;

/** One run of the organization's price sync, as the run log lists them (newest first). */
export const priceSyncRunResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  organization_id: z.number().int(),
  /** running, then success, partial or error. */
  run_status: z.string(),
  /** user or scheduler. */
  run_trigger: z.string(),
  started_at: instant,
  completed_at: nullableInstant,
  tenants_synced: z.number().int(),
  securities_total: z.number().int(),
  prices_updated: z.number().int(),
  prices_failed: z.number().int(),
  snapshots_written: z.number().int(),
  error_message: z.string().nullable(),
  user_id: z.number().int().nullable(),
  created_at: instant,
  updated_at: instant,
});
export type PriceSyncRun = z.infer<typeof priceSyncRunResponseSchema>;

/** GET /api/organizations/:uuid/price-sync/runs: a page of the run log. */
export const priceSyncRunsResponseSchema = z.object({
  runs: z.array(priceSyncRunResponseSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
});
export type PriceSyncRuns = z.infer<typeof priceSyncRunsResponseSchema>;

/** POST /api/organizations/:uuid/price-sync/run: the run's outcome. */
export const priceSyncRunResultResponseSchema = z.object({
  run_id: z.number().int(),
  status: z.enum(['success', 'partial', 'error']),
  tenants_synced: z.number().int(),
  prices_updated: z.number().int(),
  prices_failed: z.number().int(),
  snapshots_written: z.number().int(),
});
export type PriceSyncRunResult = z.infer<typeof priceSyncRunResultResponseSchema>;
