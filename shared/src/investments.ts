import { z } from 'zod';
import {
  money, moneyInput, decimalInput, isPositiveDecimal, isNonNegativeDecimal, calendarDay,
  CALENDAR_DAY_YEARS, DECIMAL_TEXT, DECIMAL_TEXT_MAX_LENGTH, QUERY_MAX_PAGE, emptyAsUndefined, queryBoolean,
  queryCalendarDay, queryEnum, queryUuid,
} from './primitives.js';
import {
  dayText, instant, nullableInstant, nullableResponseAmount, nullableResponseDecimal, responseAmount, responseDecimal, storedValue,
} from './responses.js';
import { nulTextMessage } from './queryString.js';

/**
 * Investment Tracking shared schemas. One definition feeds backend
 * request validation + response coercion, the frontend forms/types, and the MCP
 * tool input schemas. NUMERIC columns in a response are coerced to real numbers via `money`.
 *
 * In a request, every decimal is read exactly at its column's scale: an amount in
 * dollars (fees, totals, cost basis) is `moneyInput`, which the route reads in cents; a share
 * count, a price per share, a ratio or a percentage is `decimalInput` at its column's
 * NUMERIC(precision, scale). The route does its arithmetic on those in whole units
 * (backend utils/decimal.ts), never on floats.
 */

/** Shares, and the split and merger ratios: NUMERIC(18,6) (tax_lots, holding_events, security_corporate_actions). */
const shareInput = (field: string) => decimalInput(6, `${field} must be a number`, { precision: 18 });
/** A price or amount per share: NUMERIC(12,4) (security_prices, holding_events, dividend_records, security_corporate_actions). */
const perShareInput = (field: string) => decimalInput(4, `${field} must be a number`, { precision: 12 });
/** A fund weight in percent: NUMERIC(9,6) (fund_compositions, fund_underlying_holdings). */
const weightInput = (field: string) => decimalInput(6, `${field} must be a number`, { precision: 9 });
/** An annual expense ratio in percent: NUMERIC(6,4) (securities). */
const expenseRatioInput = () => decimalInput(4, 'expense_ratio_percentage must be a number', { precision: 6 });
const positive = (field: string) => [isPositiveDecimal, `${field} must be greater than zero`] as const;
const nonNegative = (field: string) => [isNonNegativeDecimal, `${field} must be zero or more`] as const;

// --- enums ------------------------------------------------------------------
export const securityType = z.enum(['stock', 'etf', 'mutual_fund', 'bond', 'money_market', 'crypto', 'other']);
export type SecurityType = z.infer<typeof securityType>;

// NOTE: asset class (and sector) are no longer a single column on a security.
// Classification lives in fund_compositions as dimension rows — one row per
// dimension for a plain security, weighted rows for a pass-through fund.

export const costBasisMethod = z.enum(['fifo', 'lifo', 'hifo', 'specific_id', 'average_cost']);
export type CostBasisMethod = z.infer<typeof costBasisMethod>;

export const holdingEventType = z.enum([
  'buy', 'sell', 'dividend', 'dividend_reinvest', 'split', 'reverse_split', 'spinoff',
  'merger_cash', 'merger_stock', 'return_of_capital', 'transfer_in', 'transfer_out',
  'fee', 'manual_adjustment', 'lot_correction', 'historical_import',
]);
export type HoldingEventType = z.infer<typeof holdingEventType>;

export const feeType = z.enum([
  'commission', 'advisory', 'account_maintenance', 'inactivity', 'wire_transfer',
  'transfer_out', 'paper_statement', 'tax_loss_harvesting', 'expense_ratio_drag', 'other',
]);
export type FeeType = z.infer<typeof feeType>;

export const dataQuality = z.enum(['complete', 'imputed_date', 'imputed_basis', 'aggregate_only', 'unknown_provenance']);
export type DataQuality = z.infer<typeof dataQuality>;

// Every value the tax_lots.acquisition_method CHECK constraint permits — the
// source of truth for what won't 500 on write. Keep in sync with
// tax_lots_acquisition_method_check (backend/init.sql).
// `historical_balance_plant` is an internal sentinel; the rest are user-facing.
export const acquisitionMethod = z.enum([
  'purchase', 'dividend_reinvest', 'split_adjustment', 'spinoff', 'transfer_in',
  'inheritance', 'gift_received', 'employer_match', 'espp', 'manual_adjustment',
  'historical_balance_plant', 'merger',
]);
export type AcquisitionMethod = z.infer<typeof acquisitionMethod>;

// --- securities -------------------------------------------------------------
/**
 * The code points a ticker and an exchange are trimmed of: exactly those JavaScript's trim()
 * removes, ECMAScript's WhiteSpace and LineTerminator (tab, line breaks, vertical tab, form feed,
 * the Unicode space separators, no-break spaces and U+FEFF). Before v3.0.0 a migration
 * trimmed stored ones of the same set (public.trim_space), and its checks,
 * securities_ticker_trimmed and securities_exchange_normalized, refuse a value it would trim
 * (the database trimmed fewer, so a ticker with a no-break space beside the bare one was a
 * second security).
 */
export const TRIMMED_SPACE_CODE_POINTS: readonly number[] = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680,
  0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a,
  0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];
const TRIMMED_SPACES = new Set(TRIMMED_SPACE_CODE_POINTS.map((code) => String.fromCodePoint(code)));

/** `text` without the TRIMMED_SPACE_CODE_POINTS around it, the same as the database trims it. */
export function trimSpaces(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && TRIMMED_SPACES.has(text.charAt(start))) start++;
  while (end > start && TRIMMED_SPACES.has(text.charAt(end - 1))) end--;
  return text.slice(start, end);
}

/** The most characters a ticker column holds (securities.ticker varchar(20)). */
export const TICKER_MAX_LENGTH = 20;
/** The most characters an exchange column holds (securities.exchange varchar(50)). */
export const EXCHANGE_MAX_LENGTH = 50;

/**
 * A ticker as written in upper case, which the column must hold for a holdings snapshot (which
 * stores it so): upper case can be longer (ß is SS, ﬃ is FFI), and was a 500 past 20.
 */
const fitsInUpperCase = (max: number) => (text: string) => text.toUpperCase().length <= max;

/**
 * A security's body. A ledger has one security per ticker and exchange, each in any case, no
 * exchange counting as one: another with them is a 409 SECURITY_EXISTS answering
 * it. The ticker is read without surrounding spaces (trimSpaces); the exchange without them and
 * in upper case, as it is stored, and an exchange of only spaces is none. Each up to its column's
 * length as stored: the exchange in upper case, which can be longer than what was typed.
 */
export const securityCreateSchema = z.object({
  ticker: z.string().overwrite(trimSpaces).min(1, 'Ticker is required').max(TICKER_MAX_LENGTH, `A ticker is at most ${TICKER_MAX_LENGTH} characters`),
  name: z.string().min(1, 'Name is required'),
  security_type: securityType.default('stock'),
  exchange: z.string()
    .overwrite((exchange) => trimSpaces(exchange).toUpperCase())
    .max(EXCHANGE_MAX_LENGTH, `An exchange is at most ${EXCHANGE_MAX_LENGTH} characters in upper case`)
    .transform((exchange) => exchange || null)
    .nullable()
    .optional(),
  currency: z.string().length(3).default('USD'),
  is_active: z.boolean().default(true),
  is_custom: z.boolean().default(false),
  is_pass_through: z.boolean().default(false),
  track_underlying_holdings: z.boolean().default(false),
  expense_ratio_percentage: expenseRatioInput().nullable().optional(),
  notes: z.string().nullable().optional(),
});
export type SecurityCreateInput = z.infer<typeof securityCreateSchema>;

export const securityUpdateSchema = securityCreateSchema.partial();
export type SecurityUpdateInput = z.infer<typeof securityUpdateSchema>;

const SECURITY_UUIDS_REQUIRED = 'uuids[] is required';
/**
 * POST /api/investments/securities/bulk-delete body: the securities' uuids, 1 to 1000.
 * An entry that isn't text is left out; one that names no security is answered "not found".
 */
export const securityBulkDeleteSchema = z.object({
  uuids: z
    .array(z.unknown(), { error: SECURITY_UUIDS_REQUIRED })
    .transform((list) => list.filter((uuid): uuid is string => typeof uuid === 'string'))
    .refine((list) => list.length > 0, SECURITY_UUIDS_REQUIRED)
    .refine((list) => list.length <= 1000, 'at most 1000 uuids per call'),
});
export type SecurityBulkDeleteInput = z.infer<typeof securityBulkDeleteSchema>;

/**
 * A security as the lists (`GET /api/investments/securities`, `/paginated`'s `data`: with its
 * latest close) and one security (`GET` and the update answer) carry it.
 */
export const securityResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  tenant_id: z.number().int(),
  ticker: z.string(),
  /** The ticker in upper case, which a holdings snapshot looks it up by. */
  ticker_key: z.string().nullable(),
  name: z.string(),
  security_type: storedValue(securityType.options),
  exchange: z.string().nullable(),
  currency: z.string(),
  is_active: z.boolean(),
  is_custom: z.boolean(),
  is_pass_through: z.boolean(),
  track_underlying_holdings: z.boolean(),
  expense_ratio_percentage: nullableResponseDecimal,
  notes: z.string().nullable(),
  last_price_update_at: nullableInstant,
  last_composition_update_at: nullableInstant,
  last_expense_ratio_update_at: nullableInstant,
  created_at: instant,
  updated_at: nullableInstant,
  /** The lists only: the latest close. */
  latest_price: nullableResponseDecimal.optional(),
});
export type Security = z.infer<typeof securityResponseSchema>;

// --- prices -----------------------------------------------------------------
export const priceUpsertSchema = z.object({
  security_uuid: z.uuid(),
  price_date: calendarDay, // YYYY-MM-DD
  close: perShareInput('close'),
  adjusted_close: perShareInput('adjusted_close').nullable().optional(),
  // security_prices.volume is a bigint: a whole number, below 10^18.
  volume: decimalInput(0, 'volume must be a whole number', { precision: 18 }).nullable().optional(),
  source: z.string().default('mcp_manual'),
});
export type PriceUpsertInput = z.infer<typeof priceUpsertSchema>;

export const priceBulkUpsertSchema = z.object({
  // A record's date is checked per record (the route answers each one's result), so one bad
  // date doesn't refuse the others.
  prices: z.array(priceUpsertSchema.extend({ price_date: z.string() })).min(1).max(500),
});
export type PriceBulkUpsertInput = z.infer<typeof priceBulkUpsertSchema>;

/** A close, as `GET /api/investments/securities/:uuid/prices` lists them. */
export const priceResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  tenant_id: z.number().int(),
  security_id: z.number().int(),
  price_date: dayText,
  close: responseDecimal,
  adjusted_close: nullableResponseDecimal,
  /** A bigint, which pg sends as text. */
  volume: z.union([z.number().int(), z.string().regex(/^\d+$/)]).transform(Number).nullable(),
  source: z.string(),
  user_id: z.number().int().nullable(),
  created_at: instant,
  updated_at: nullableInstant,
});
export type SecurityPrice = z.infer<typeof priceResponseSchema>;

/**
 * A buy's, sale's, reinvested dividend's or imported lot's shares and prices are already adjusted
 * for the splits and reverse splits of its security recorded after its date, as a
 * broker's history gives them: backfilling behind a split. It is then recorded as given, those
 * splits don't apply to it again, and they don't refuse it (409
 * EVENT_BEFORE_RECORDED_CORPORATE_ACTION). A return of capital, spinoff or merger after it still
 * does. A split recorded later applies to it as to any lot.
 */
/**
 * What the event forms call `adjusted_for_splits`, a switch's label: the API's refusal of an
 * event dated before a recorded split names it, so people are told what to turn on.
 */
export const ADJUSTED_FOR_SPLITS_LABELS = {
  /** A buy's or sale's. */
  trade: 'The shares and price are already adjusted for later splits',
  /** A reinvested dividend's. */
  reinvestment: 'The reinvestment price is already adjusted for later splits',
} as const;

const adjustedForSplits = z.boolean().default(false)
  .describe('Shares and prices already adjusted for the splits recorded after the event (backfilling behind a split)');

// --- events (buy / sell / dividend) -----------------------------------------
export const buyEventSchema = z.object({
  account_uuid: z.uuid(),
  security_uuid: z.uuid(),
  event_date: calendarDay,
  shares: shareInput('shares').refine(...positive('shares')),
  price_per_share: perShareInput('price_per_share').refine(...nonNegative('price_per_share')),
  fees: moneyInput('fees must be a number').refine(...nonNegative('fees')).default(0),
  acquisition_method: z
    .enum(['purchase', 'transfer_in', 'inheritance', 'gift_received', 'employer_match', 'espp', 'manual_adjustment'])
    .default('purchase'),
  source: z.string().default('manual'),
  description: z.string().nullable().optional(),
  external_reference: z.string().nullable().optional(),
  // Flag imputed/estimated provenance on the created lot (e.g. transferred lots
  // with an estimated basis or acquisition date). Defaults to 'complete'.
  data_quality: dataQuality.optional(),
  /**
   * Whether the lot is covered (its broker reports its basis), which keeps covered and
   * noncovered lots in separate average-cost pools. When not given it follows the date: bought
   * before 2012-01-01, noncovered (the date for mutual fund and dividend-reinvestment-plan shares,
   * the ones average cost applies to; stock's was 2011-01-01).
   */
  is_covered: z.boolean().optional()
    .describe('Covered by broker basis reporting; when not given, noncovered if bought before 2012-01-01'),
  adjusted_for_splits: adjustedForSplits,
  dry_run: z.boolean().default(false),
});
export type BuyEventInput = z.infer<typeof buyEventSchema>;

export const sellEventSchema = z.object({
  account_uuid: z.uuid(),
  security_uuid: z.uuid(),
  event_date: calendarDay,
  shares: shareInput('shares').refine(...positive('shares')),
  price_per_share: perShareInput('price_per_share').refine(...nonNegative('price_per_share')),
  fees: moneyInput('fees must be a number').refine(...nonNegative('fees')).default(0),
  method: costBasisMethod.optional(),
  // Required when the effective method is specific_id. Lot uuids + share counts.
  specific_lots: z
    .array(z.object({ lot_uuid: z.uuid(), shares: shareInput('shares').refine(...positive('shares')) }))
    .optional(),
  source: z.string().default('manual'),
  description: z.string().nullable().optional(),
  external_reference: z.string().nullable().optional(),
  adjusted_for_splits: adjustedForSplits,
  dry_run: z.boolean().default(false),
});
export type SellEventInput = z.infer<typeof sellEventSchema>;

export const dividendEventSchema = z.object({
  account_uuid: z.uuid(),
  security_uuid: z.uuid(),
  event_date: calendarDay,
  total_amount: moneyInput('total_amount must be a number'),
  amount_per_share: perShareInput('amount_per_share').nullable().optional(),
  ex_date: calendarDay.nullable().optional(),
  record_date: calendarDay.nullable().optional(),
  pay_date: calendarDay.nullable().optional(),
  is_qualified: z.boolean().default(true),
  // When true (or DRIP configured), creates a reinvestment lot at price_per_share.
  reinvest: z.boolean().default(false),
  price_per_share: perShareInput('price_per_share').refine(...positive('price_per_share')).nullable().optional(),
  // Cross-security reinvestment (e.g. a robo-advisor pools a dividend and buys the
  // target-allocation fund): the dividend is recorded on `security_uuid` but the
  // reinvestment lot is opened in this security instead of the payer. Requires
  // reinvest=true and a positive price_per_share (the target's price).
  reinvest_into_security_uuid: z.uuid().nullable().optional(),
  source: z.string().default('manual'),
  external_reference: z.string().nullable().optional(),
  /** The reinvestment's price (and so its shares); a cash dividend has none to adjust. */
  adjusted_for_splits: adjustedForSplits,
  dry_run: z.boolean().default(false),
}).refine(
  (d) => !d.reinvest_into_security_uuid || (d.reinvest && d.price_per_share != null && isPositiveDecimal(d.price_per_share)),
  { message: 'reinvest_into_security_uuid requires reinvest=true and a positive price_per_share', path: ['reinvest_into_security_uuid'] },
);
export type DividendEventInput = z.infer<typeof dividendEventSchema>;

export const splitActionSchema = z.object({
  security_uuid: z.uuid(),
  action_date: calendarDay,
  numerator: shareInput('numerator').refine(...positive('numerator')),
  denominator: shareInput('denominator').refine(...positive('denominator')),
  reverse: z.boolean().default(false),
  dry_run: z.boolean().default(false),
});
export type SplitActionInput = z.infer<typeof splitActionSchema>;

export const returnOfCapitalSchema = z.object({
  security_uuid: z.uuid(),
  action_date: calendarDay,
  amount_per_share: perShareInput('amount_per_share').refine(...positive('amount_per_share')),
  dry_run: z.boolean().default(false),
});
export type ReturnOfCapitalInput = z.infer<typeof returnOfCapitalSchema>;

export const spinoffActionSchema = z.object({
  source_security_uuid: z.uuid(),
  new_security_uuid: z.uuid(),
  action_date: calendarDay,
  // A share of the basis, 0 to 1, kept in the spinoff's event metadata: read to 6 places.
  allocation_fraction: decimalInput(6, 'allocation_fraction must be a number', { precision: 7 })
    .refine((v) => Number(v) >= 0 && Number(v) <= 1, 'allocation_fraction must be between 0 and 1'),
  share_ratio: shareInput('share_ratio').refine(...positive('share_ratio')),
  dry_run: z.boolean().default(false),
});
export type SpinoffActionInput = z.infer<typeof spinoffActionSchema>;

export const mergerCashSchema = z.object({
  security_uuid: z.uuid(),
  action_date: calendarDay,
  cash_per_share: perShareInput('cash_per_share').refine(...nonNegative('cash_per_share')),
  dry_run: z.boolean().default(false),
});
export type MergerCashInput = z.infer<typeof mergerCashSchema>;

export const mergerStockSchema = z.object({
  security_uuid: z.uuid(),
  acquirer_security_uuid: z.uuid(),
  action_date: calendarDay,
  exchange_ratio: shareInput('exchange_ratio').refine(...positive('exchange_ratio')),
  dry_run: z.boolean().default(false),
});
export type MergerStockInput = z.infer<typeof mergerStockSchema>;

export const batchImportLotsSchema = z.object({
  lots: z.array(z.object({
    account_uuid: z.uuid(),
    security_uuid: z.uuid(),
    acquisition_date: calendarDay,
    shares: shareInput('shares').refine(...positive('shares')),
    total_cost_basis: moneyInput('total_cost_basis must be a number').refine(...nonNegative('total_cost_basis')),
    acquisition_method: acquisitionMethod.optional(),
    data_quality: dataQuality.optional(),
    holding_period_start: calendarDay.optional(),
    external_reference: z.string().nullable().optional(),
    /** As a buy's: when not given, noncovered if acquired before 2012-01-01. */
    is_covered: z.boolean().optional(),
    /** Its shares and basis per share; the lot's total basis is the same either way. */
    adjusted_for_splits: adjustedForSplits,
  })).min(1).max(500),
  dry_run: z.boolean().default(false),
});
export type BatchImportLotsInput = z.infer<typeof batchImportLotsSchema>;

/**
 * PATCH /api/investments/lots/:uuid: correct a lot's covered status, the flag average
 * cost pools lots by (a lot stored with the wrong one, an imported pre-2012 lot say). It is the
 * only field a lot takes: any other is refused, not ignored.
 */
export const lotUpdateSchema = z.object({
  is_covered: z.boolean(),
}).strict();
export type LotUpdateInput = z.infer<typeof lotUpdateSchema>;

export const costBasisMethodSettingSchema = z.object({
  account_uuid: z.uuid(),
  security_uuid: z.uuid().nullable().optional(),
  method: costBasisMethod,
  drip_enabled: z.boolean().optional(),
});
export type CostBasisMethodSettingInput = z.infer<typeof costBasisMethodSettingSchema>;

// --- fees -------------------------------------------------------------------
export const feeEventSchema = z.object({
  account_uuid: z.uuid(),
  security_uuid: z.uuid().nullable().optional(),
  fee_type: feeType,
  amount: moneyInput('amount must be a number'),
  event_date: calendarDay,
  description: z.string().nullable().optional(),
  // Idempotency + correlation key. Share it with the sell event that funded the
  // fee (e.g. a robo-advisor auto-sells shares to pay an advisory fee) so the two are
  // linkable. Re-sending the same reference for an account/security is a no-op.
  external_reference: z.string().nullable().optional(),
  source: z.string().default('manual'),
});
export type FeeEventInput = z.infer<typeof feeEventSchema>;

// --- fund composition / look-through ----------------------------------------
export const compositionUpsertSchema = z.object({
  security_uuid: z.uuid(),
  snapshot_date: calendarDay,
  // { sector: [{dimension_value, weight_percentage}, ...], region: [...] }
  dimensions: z.record(
    z.string(),
    z.array(z.object({ dimension_value: z.string(), weight_percentage: weightInput('weight_percentage') })).min(1)
  ),
  source: z.string().default('mcp_manual'),
});
export type CompositionUpsertInput = z.infer<typeof compositionUpsertSchema>;

export const expenseRatioUpdateSchema = z.object({
  security_uuid: z.uuid(),
  expense_ratio_percentage: expenseRatioInput(),
});
export type ExpenseRatioUpdateInput = z.infer<typeof expenseRatioUpdateSchema>;

// --- holdings-level look-through (underlying securities) ---------------------
// Populate a fund's actual underlying securities (by ticker) so portfolio
// exposure can be resolved all the way to individual stocks.
export const underlyingHoldingsUpsertSchema = z.object({
  security_uuid: z.uuid(),
  snapshot_date: calendarDay,
  // Underlying securities referenced by ticker; unknown tickers are auto-created
  // as minimal stock securities so an ETF's holdings can be pasted in one call.
  holdings: z
    .array(
      z.object({
        // Trimmed and compared in upper case, as a security's ticker is; one the
        // snapshot creates is stored in upper case, so it must fit the column so.
        underlying_ticker: z.string().overwrite(trimSpaces).min(1, 'underlying_ticker is required')
          .refine(fitsInUpperCase(TICKER_MAX_LENGTH), `An underlying ticker is at most ${TICKER_MAX_LENGTH} characters in upper case`),
        underlying_name: z.string().optional(),
        weight_percentage: weightInput('weight_percentage'),
        shares: shareInput('shares').optional(),
      })
    )
    .min(1)
    .max(20000),
  source: z.string().default('mcp_manual'),
});
export type UnderlyingHoldingsUpsertInput = z.infer<typeof underlyingHoldingsUpsertSchema>;

export const underlyingTrackingSchema = z.object({
  security_uuid: z.uuid(),
  track_underlying_holdings: z.coerce.boolean(),
});
export type UnderlyingTrackingInput = z.infer<typeof underlyingTrackingSchema>;

// --- organization price-sync settings (scheduled EOD price fetch) -----------
export const priceSyncSettingsUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  schedule_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM').optional(),
  timezone: z.string().min(1).optional(),
});
export type PriceSyncSettingsUpdateInput = z.infer<typeof priceSyncSettingsUpdateSchema>;

// --- read responses ---------------------------------------------------------
/** A tax lot, as `GET /api/investments/holdings/:uuid/lots` lists them. */
export const taxLotResponseSchema = z.object({
  id: z.number().int(),
  uuid: z.uuid(),
  tenant_id: z.number().int(),
  account_id: z.number().int(),
  security_id: z.number().int(),
  acquisition_date: dayText,
  holding_period_start: dayText,
  shares_original: responseDecimal,
  shares_remaining: responseDecimal,
  cost_basis_per_share: responseDecimal,
  total_cost_basis: responseAmount,
  acquisition_method: storedValue(acquisitionMethod.options),
  is_open: z.boolean(),
  /**
   * Whether the lot is a covered security, as average-cost pooling reads it. A lot
   * recorded without the flag is covered when acquired on or after 2012-01-01: the date for
   * mutual fund and dividend-reinvestment-plan shares, the only ones average cost applies to.
   * Stock's own date was 2011-01-01, so a 2011 stock purchase recorded without the flag reads
   * as noncovered here though a broker reports it covered; it changes no basis, since average
   * cost doesn't apply to stock outside a plan. A lot imported with the flag keeps what was sent.
   */
  is_covered: z.boolean(),
  data_quality: storedValue(dataQuality.options),
  created_by_event_id: z.number().int().nullable(),
  parent_lot_id: z.number().int().nullable(),
  external_reference: z.string().nullable(),
  metadata: z.unknown(),
  created_at: instant,
  updated_at: nullableInstant,
});
export type TaxLot = z.infer<typeof taxLotResponseSchema>;

/** A holding (a security in an account, its open lots added up), as `GET /api/investments/holdings` lists them. */
export const holdingResponseSchema = z.object({
  security_id: z.number().int(),
  security_uuid: z.uuid(),
  ticker: z.string(),
  name: z.string(),
  account_id: z.number().int(),
  total_shares: responseDecimal,
  total_cost_basis: responseAmount,
  average_cost_per_share: nullableResponseDecimal,
  latest_price: nullableResponseDecimal,
  market_value: nullableResponseAmount,
  unrealized_gain_loss: nullableResponseAmount,
});
export type Holding = z.infer<typeof holdingResponseSchema>;

/**
 * One replacement lot's wash-sale adjustment (IRC §1091(d)): the loss shares it
 * replaces and the disallowed loss added to its basis, with its basis after. `lot_uuid` is null
 * for the lot a dry run of a buy, a reinvested dividend or an import would create.
 */
export const washSaleAdjustmentSchema = z.object({
  lot_uuid: z.uuid().nullable(),
  /** Loss shares it replaces. */
  replacement_shares: money,
  /** Dollars of disallowed loss added to its basis. */
  basis_added: money,
  /** Its remaining basis after the adjustment, in dollars, and that per share. */
  total_cost_basis: money,
  cost_basis_per_share: money,
});
export type WashSaleAdjustment = z.infer<typeof washSaleAdjustmentSchema>;

/**
 * The wash sales a buy, sale, reinvested dividend or imported lot makes, or its dry run would
 * make: `flagged` loss sales, the loss `disallowed` (dollars) and each replacement lot's
 * adjustment. A dry run answers what the real call would, writing nothing.
 */
export const washSaleOutcomeSchema = z.object({
  flagged: z.number().int(),
  disallowed: money,
  adjustments: z.array(washSaleAdjustmentSchema),
});
export type WashSaleOutcome = z.infer<typeof washSaleOutcomeSchema>;

/** One sale's realized gain or loss, as `GET /api/investments/reports/realized-gain-loss` lists them. */
export const realizedGainLossRowSchema = z.object({
  security_id: z.number().int(),
  ticker: z.string(),
  sell_date: dayText,
  shares_consumed: responseDecimal,
  basis_consumed: responseAmount,
  proceeds: responseAmount,
  realized_gain_loss: responseAmount,
  is_long_term: z.boolean(),
  is_wash_sale: z.boolean(),
});
export type RealizedGainLossRow = z.infer<typeof realizedGainLossRowSchema>;

// --- query strings ----------------------------------------------------------
//
// The investments routes' query strings, parsed by validateQuery before a
// handler runs: a value they refuse is 400 VALIDATION_ERROR, naming the field. The MCP tools
// (mcp/src/tools/investments.ts) send these as text; a value a tool leaves out is not sent.
// Ids and days reached SQL as uuid and date, where a malformed one failed with a 500; a
// well-formed id that names nothing just matches nothing.

/** The sell objectives the lot suggestions rank open lots for. */
export const LOT_OBJECTIVES = ['minimize_gain', 'maximize_loss', 'longest_held', 'highest_cost'] as const;
export type LotObjective = (typeof LOT_OBJECTIVES)[number];

/** What GET /reports/securities-needing-data lists securities without: a price, a composition, an expense ratio. */
export const SECURITY_DATA_NEEDS = ['price', 'composition', 'expense_ratio'] as const;
export type SecurityDataNeed = (typeof SECURITY_DATA_NEEDS)[number];

const uuidQuery = (name: string) => queryUuid({ message: `${name} must be a uuid` });

/** The days the request bodies take (calendarDay): 0001-01-01 reached SQL as the day before it, year 0, a 500. */
const dayQuery = (name: string) =>
  queryCalendarDay({ message: `${name} must be a real YYYY-MM-DD date, from ${CALENDAR_DAY_YEARS.min} to ${CALENDAR_DAY_YEARS.max}` });

/** Text a number reads from: not blank, and finite as Number() reads it (NaN reached SQL as a 500). */
const isNumberText = (text: string) => text.trim() !== '' && Number.isFinite(Number(text));

/** A what-if figure (a share count, a price, a rate, a threshold): any finite number. */
const numberQuery = (name: string) => {
  const message = `${name} must be a number`;
  return emptyAsUndefined(z.string({ error: message }).refine(isNumberText, message).transform(Number));
};

/**
 * The what-if figures a report takes, bounded to what the ledger can hold: a price
 * a close can have (NUMERIC(12,4)), shares a lot can have (NUMERIC(18,6)) and a tax rate as a
 * fraction. Unbounded, a price of 1e20 made figures no answer could carry (proceeds of 1e+21).
 * With them, a sale's figures stay under 10^20 dollars, as stored shares at a stored close do.
 */
const MAX_WHAT_IF_PRICE = 99_999_999.9999;
/**
 * Shares a lot can hold are below 10^12 (NUMERIC(18,6): at most 999,999,999,999.999999). Compared
 * as "below 10^12", which a double holds exactly: 999,999,999,999.999999 itself isn't one (it
 * rounds to 10^12, so "at most" it would let 10^12 through).
 */
const WHAT_IF_SHARES_LIMIT = 1e12;
const whatIfPriceQuery = () =>
  numberQuery('price').refine(
    (n) => n === undefined || (n >= 0 && n <= MAX_WHAT_IF_PRICE),
    'price must be a price per share from 0 to 99,999,999.9999'
  );
const rateQuery = (name: string) =>
  numberQuery(name).refine((n) => n === undefined || (n >= 0 && n <= 1), `${name} must be a tax rate from 0 to 1, such as 0.24 for 24%`);

/**
 * A count (a page, a page size): a positive whole number of at most 9 digits, else 400; the
 * default when not given, and at most `max` (a larger one is the cap, as pageParams reads it).
 */
const countQuery = (name: string, options: { default: number; max: number }) => {
  const message = `${name} must be a positive whole number`;
  return emptyAsUndefined(z.string({ error: message }).regex(/^[1-9][0-9]{0,8}$/, message).transform(Number)).transform((n) =>
    n === undefined ? options.default : Math.min(n, options.max)
  );
};

/** `page` and `limit` as the investments lists read them: refused when not a count, the cap past it. */
const pageQuery = (options: { defaultLimit: number; maxLimit: number }) => ({
  page: countQuery('page', { default: 1, max: QUERY_MAX_PAGE }),
  limit: countQuery('limit', { default: options.defaultLimit, max: options.maxLimit }),
});

/** Free text (a search, an event type, a dimension). Postgres refuses a NUL in text with an error (a 500). */
const textQuery = (name: string) =>
  emptyAsUndefined(z.string({ error: `${name} must be text` }).refine((text) => !text.includes(String.fromCharCode(0)), nulTextMessage(name)));

/** A search term, trimmed; '' when not given. */
const searchQuery = () => textQuery('search').transform((text) => text?.trim() ?? '');

/** Absent or empty (`?x=`) as undefined, for a value a schema requires. */
const givenOrUndefined = (value: unknown) => (value === '' ? undefined : value);

/** The account or security a tax report is about: required (400 without both). */
const holdingQuery = (name: 'account' | 'security') =>
  z.preprocess(
    givenOrUndefined,
    z.uuid({ error: (issue) => (issue.input === undefined ? 'account and security are required' : `${name} must be a uuid`) })
  );

/** GET /securities: the active securities, or every one. */
export const securityListQuery = z.object({
  include_inactive: queryBoolean({ default: false }),
});
export type SecurityListQuery = z.infer<typeof securityListQuery>;

/** GET /securities/paginated: a page of the catalog, searched by ticker or name. */
export const securityPageQuery = z.object({
  ...pageQuery({ defaultLimit: 100, maxLimit: 500 }),
  include_inactive: queryBoolean({ default: false }),
  search: searchQuery(),
});
export type SecurityPageQuery = z.infer<typeof securityPageQuery>;

/** GET /securities/cleanup/unused: the securities not held, searched; only the custom ones when asked. */
export const unusedSecuritiesQuery = z.object({
  search: searchQuery(),
  custom_only: queryBoolean({ default: false }),
  limit: countQuery('limit', { default: 1000, max: 2000 }),
});
export type UnusedSecuritiesQuery = z.infer<typeof unusedSecuritiesQuery>;

/** The routes about one account's holdings, or every account's: holdings, lots, costs, exposure. */
export const holdingsQuery = z.object({
  account: uuidQuery('account'),
});
export type HoldingsQuery = z.infer<typeof holdingsQuery>;

/** GET /events: a page of the holding-events ledger, filtered. */
export const holdingEventsQuery = z.object({
  ...pageQuery({ defaultLimit: 50, maxLimit: 200 }),
  account: uuidQuery('account'),
  security: uuidQuery('security'),
  /** One holding_events.event_type, or 'all'; another matches nothing. */
  event_type: textQuery('event_type'),
  start_date: dayQuery('start_date'),
  end_date: dayQuery('end_date'),
});
export type HoldingEventsQuery = z.infer<typeof holdingEventsQuery>;

/** The reports over a range of days, for one account or every one: gains, fees, performance, dividends, wash sales. */
export const investmentRangeQuery = z.object({
  start_date: dayQuery('start_date'),
  end_date: dayQuery('end_date'),
  account: uuidQuery('account'),
});
export type InvestmentRangeQuery = z.infer<typeof investmentRangeQuery>;

/** GET /reports/sell-tax-impact: what selling `shares` of a holding on `date` (today when not given) would realize. */
export const sellTaxImpactQuery = z.object({
  account: holdingQuery('account'),
  security: holdingQuery('security'),
  shares: z.preprocess(
    givenOrUndefined,
    z
      .string({ error: (issue) => (issue.input === undefined ? 'shares must be a positive number' : 'shares must be a number') })
      .refine(isNumberText, { message: 'shares must be a number', abort: true })
      .transform(Number)
      .refine((n) => n > 0, { message: 'shares must be a positive number', abort: true })
      .refine((n) => n < WHAT_IF_SHARES_LIMIT, 'shares must be at most 999,999,999,999.999999, the most a lot can hold')
  ),
  date: dayQuery('date'),
  method: emptyAsUndefined(z.enum(costBasisMethod.enum, { error: `method must be one of ${costBasisMethod.options.join(', ')}` })),
  price: whatIfPriceQuery(),
  st_rate: rateQuery('st_rate'),
  lt_rate: rateQuery('lt_rate'),
});
export type SellTaxImpactQuery = z.infer<typeof sellTaxImpactQuery>;

const MIN_LOSS_FORMAT = 'min_loss must be an amount in dollars, written in digits (such as 100 or 99.95)';

/**
 * GET /reports/tax-loss-harvest: the lots at a loss of at least `min_loss` dollars. The
 * amount is text written in digits (1e2 and 0x10 were "a number with at most 2 decimal
 * places") and not negative (that listed lots at a gain); the route reads it exactly,
 * in cents, which refuses more than 2 decimal places (as a double, 0.29 * 100 let a $0.29
 * loss through).
 */
export const taxLossHarvestQuery = z.object({
  account: uuidQuery('account'),
  min_loss: emptyAsUndefined(
    z
      .string({ error: MIN_LOSS_FORMAT })
      .trim()
      .max(DECIMAL_TEXT_MAX_LENGTH, { message: MIN_LOSS_FORMAT, abort: true })
      .regex(DECIMAL_TEXT, { message: MIN_LOSS_FORMAT, abort: true })
      .refine((text) => !text.startsWith('-') || Number(text) === 0, 'min_loss must not be negative')
  ),
});
export type TaxLossHarvestQuery = z.infer<typeof taxLossHarvestQuery>;

/** GET /reports/lot-suggestions: a holding's open lots on `date` (today when not given), ranked for `objective`. */
export const lotSuggestionsQuery = z.object({
  account: holdingQuery('account'),
  security: holdingQuery('security'),
  objective: queryEnum(LOT_OBJECTIVES, { default: 'minimize_gain', message: `objective must be one of ${LOT_OBJECTIVES.join(', ')}` }),
  date: dayQuery('date'),
  price: whatIfPriceQuery(),
});
export type LotSuggestionsQuery = z.infer<typeof lotSuggestionsQuery>;

/** GET /reports/concentration: each holding's share of the portfolio, flagged past `threshold` percent. */
export const concentrationQuery = z.object({
  threshold: numberQuery('threshold'),
});
export type ConcentrationQuery = z.infer<typeof concentrationQuery>;

/** GET /reports/data-freshness: stale and missing data, for holdings worth at least `min_holding_value`. */
export const dataFreshnessQuery = z.object({
  min_holding_value: numberQuery('min_holding_value'),
});
export type DataFreshnessQuery = z.infer<typeof dataFreshnessQuery>;

/** GET /reports/lookthrough: the holdings' allocation by a composition dimension (asset_class when not given). */
export const lookThroughQuery = z.object({
  dimension: textQuery('dimension').transform((text) => text || 'asset_class'),
  account: uuidQuery('account'),
});
export type LookThroughQuery = z.infer<typeof lookThroughQuery>;

/** GET /reports/value-series: the portfolio's daily values from `start_date`, at most ten years of days (five by default). */
export const valueSeriesQuery = z.object({
  start_date: dayQuery('start_date'),
  limit: countQuery('limit', { default: 1825, max: 3650 }),
});
export type ValueSeriesQuery = z.infer<typeof valueSeriesQuery>;

/** GET /reports/securities-needing-data: securities with no price (the default), composition or expense ratio. */
export const securitiesNeedingDataQuery = z.object({
  category: queryEnum(SECURITY_DATA_NEEDS, { default: 'price', message: `category must be one of ${SECURITY_DATA_NEEDS.join(', ')}` }),
});
export type SecuritiesNeedingDataQuery = z.infer<typeof securitiesNeedingDataQuery>;

/** GET /securities/:uuid/price-gaps: the gaps in its price history longer than `threshold_days` (5 when not given). */
export const priceGapsQuery = z.object({
  threshold_days: numberQuery('threshold_days'),
});
export type PriceGapsQuery = z.infer<typeof priceGapsQuery>;
