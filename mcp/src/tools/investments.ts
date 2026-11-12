import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ACQUISITION_METHODS,
  COST_BASIS_METHODS,
  DATA_QUALITIES,
  DECIMAL_TEXT,
  DECIMAL_TEXT_MAX_LENGTH,
  FEE_TYPES,
  LOT_OBJECTIVES,
  SECURITY_DATA_NEEDS,
  SECURITY_TYPES,
  calendarDay,
  concentrationQuery,
  dataFreshnessQuery,
  holdingEventsQuery,
  holdingsQuery,
  investmentRangeQuery,
  lookThroughQuery,
  lotSuggestionsQuery,
  priceGapsQuery,
  queryString,
  securitiesNeedingDataQuery,
  securityListQuery,
  sellTaxImpactQuery,
  taxLossHarvestQuery,
  unusedSecuritiesQuery,
  valueSeriesQuery,
} from '@nuggets/shared';
import { apiPath } from '../client.js';
import { booleanInput } from '../schemas.js';
import { registerTool, type ToolContext } from './helpers.js';

/** A buy's, sale's, reinvested dividend's or imported lot's adjusted_for_splits. */
const adjustedForSplitsArg = () =>
  booleanInput.optional().describe(
    'Set true when backfilling behind a split: the event is dated before a split or reverse split of the security already recorded, and its shares and price are already adjusted for it (as a broker\'s history shows them today). It is then recorded as given and the split is not applied to it again; without it such an event is refused (409 EVENT_BEFORE_RECORDED_CORPORATE_ACTION). A return of capital, spinoff or merger after it still refuses it. A split recorded later applies to it as to any lot.'
  );

const securityTypeEnum = z.enum(SECURITY_TYPES);
const costBasisMethodEnum = z.enum(COST_BASIS_METHODS);
const dataQualityEnum = z.enum(DATA_QUALITIES);

/**
 * An amount, price, share count, ratio or weight the backend stores: a number, or decimal
 * text ("12.34", "-5", ".5") sent on unchanged. The backend reads either exactly, at its
 * column's scale, and refuses what the column can't hold as written; z.coerce.number() made a
 * model's "12.3400000000000001" 12.34 (and "1e2" 100) before the backend saw it. Text that
 * isn't a decimal at all is refused here. Ids and pages keep z.coerce.number(), and so do the
 * what-if figures the reports read from a query string.
 */
const DECIMAL_ARG_MESSAGE = 'must be a number, or a decimal number as text';
// Trimmed, as the backend's moneyInput and decimalInput trim (" 12.3" reads as 12.3), and capped at its length.
const decimalArg = () =>
  z.union([z.number(), z.string().trim().max(DECIMAL_TEXT_MAX_LENGTH, DECIMAL_ARG_MESSAGE).regex(DECIMAL_TEXT, DECIMAL_ARG_MESSAGE)]);
/** A decimalArg above zero. Text that isn't a number passes, for the backend to refuse with its reason. */
const positiveDecimalArg = (message: string) => decimalArg().refine((v) => !(Number(v) <= 0), message);

export function registerInvestmentTools(server: McpServer, ctx: ToolContext): void {
  // ----------------------------------------------------------- securities CRUD
  registerTool(server, ctx, {
    name: 'list_securities',
    title: 'List securities',
    description:
      'Return all tracked securities (stocks, ETFs, funds, …) with their latest known price. By default only active securities are returned; pass includeInactive to include deactivated ones.',
    inputSchema: {
      includeInactive: z.boolean().optional().describe('Include securities flagged inactive. Defaults to false.'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/securities', queryString(securityListQuery, {
        include_inactive: args.includeInactive ? true : undefined,
      })),
  });

  registerTool(server, ctx, {
    name: 'get_security',
    title: 'Get security',
    description: 'Fetch a single security by UUID.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/investments/securities/${uuid}`),
  });

  registerTool(server, ctx, {
    name: 'create_security',
    title: 'Create a security',
    description:
      'Register a new security to track. Required: ticker, name, securityType. Optional fields cover exchange, currency, flags (isActive/isCustom/isPassThrough/trackUnderlyingHoldings), expenseRatioPercentage, and notes. Classification (asset class, sector, region, …) is set separately via update_fund_composition — one category for a plain security, weighted rows for a pass-through fund. The ledger has one security per ticker and exchange, each compared in any case and without surrounding spaces (no exchange counting as one; an exchange is stored in upper case): a ticker it has already is refused (409 SECURITY_EXISTS) with that security as `security`; use its uuid.',
    inputSchema: {
      ticker: z.string().describe('Trading symbol, e.g. "STKIDX".'),
      name: z.string(),
      securityType: securityTypeEnum,
      exchange: z.string().optional(),
      currency: z.string().optional().describe('ISO 4217 currency code, e.g. "USD".'),
      isActive: z.boolean().optional(),
      isCustom: z.boolean().optional(),
      isPassThrough: z.boolean().optional(),
      trackUnderlyingHoldings: z.boolean().optional(),
      expenseRatioPercentage: decimalArg().optional().describe('Annual expense ratio as a percentage, e.g. 0.03.'),
      notes: z.string().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        ticker: args.ticker,
        name: args.name,
        security_type: args.securityType,
      };
      if (args.exchange !== undefined) body.exchange = args.exchange;
      if (args.currency !== undefined) body.currency = args.currency;
      if (args.isActive !== undefined) body.is_active = args.isActive;
      if (args.isCustom !== undefined) body.is_custom = args.isCustom;
      if (args.isPassThrough !== undefined) body.is_pass_through = args.isPassThrough;
      if (args.trackUnderlyingHoldings !== undefined) body.track_underlying_holdings = args.trackUnderlyingHoldings;
      if (args.expenseRatioPercentage !== undefined) body.expense_ratio_percentage = args.expenseRatioPercentage;
      if (args.notes !== undefined) body.notes = args.notes;
      return client.post('/api/investments/securities', body);
    },
  });

  registerTool(server, ctx, {
    name: 'update_security',
    title: 'Update a security',
    description:
      'Partially update a security by UUID. Only the fields you supply are changed. Use isActive=false to deactivate a security instead of deleting it. A ticker or exchange another security of the ledger has is refused (409 SECURITY_EXISTS) with that security as `security`.',
    inputSchema: {
      uuid: z.string().uuid(),
      ticker: z.string().optional(),
      name: z.string().optional(),
      securityType: securityTypeEnum.optional(),
      exchange: z.string().optional(),
      currency: z.string().optional(),
      isActive: z.boolean().optional(),
      isCustom: z.boolean().optional(),
      isPassThrough: z.boolean().optional(),
      trackUnderlyingHoldings: z.boolean().optional(),
      expenseRatioPercentage: decimalArg().nullable().optional(),
      notes: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {};
      if (args.ticker !== undefined) body.ticker = args.ticker;
      if (args.name !== undefined) body.name = args.name;
      if (args.securityType !== undefined) body.security_type = args.securityType;
      if (args.exchange !== undefined) body.exchange = args.exchange;
      if (args.currency !== undefined) body.currency = args.currency;
      if (args.isActive !== undefined) body.is_active = args.isActive;
      if (args.isCustom !== undefined) body.is_custom = args.isCustom;
      if (args.isPassThrough !== undefined) body.is_pass_through = args.isPassThrough;
      if (args.trackUnderlyingHoldings !== undefined) body.track_underlying_holdings = args.trackUnderlyingHoldings;
      if (args.expenseRatioPercentage !== undefined) body.expense_ratio_percentage = args.expenseRatioPercentage;
      if (args.notes !== undefined) body.notes = args.notes;
      return client.put(apiPath`/api/investments/securities/${args.uuid}`, body);
    },
  });

  registerTool(server, ctx, {
    name: 'list_unused_securities',
    title: 'List unused securities',
    description:
      "List securities that are NOT held (no tax lots, no transaction history) — cleanup candidates, including agent-created stub securities and ones only attached to OLD underlying-holdings snapshots (those delete cleanly). `currently_underlying` flags ones still in a fund's LATEST underlying snapshot (deleting those removes that line from the fund's look-through, so review them first). Filter with `search` / `customOnly` (customOnly = is_custom, usually the import stubs). Returns {count, returned, items:[{uuid, ticker, name, security_type, is_pass_through, is_custom, currently_underlying}]} up to `limit` (default 1000). Pair with delete_securities.",
    inputSchema: {
      search: z.string().optional(),
      customOnly: z.boolean().optional().describe('Only agent/manually-created (is_custom) securities — usually the bulk-import stubs.'),
      limit: z.coerce.number().int().min(1).optional(),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/securities/cleanup/unused', queryString(unusedSecuritiesQuery, {
        search: args.search,
        custom_only: args.customOnly,
        limit: args.limit,
      })),
  });

  registerTool(server, ctx, {
    name: 'delete_securities',
    title: 'Delete securities',
    description:
      "Delete one or more securities by UUID (pass a single uuid in the array for one, or many for bulk). The ONLY protected securities are HELD ones (with tax lots or transaction history) — those are skipped and reported, never deleted. Everything else is removed and its prices, classifications, and underlying-holding rows cascade away — so old bulk-import stubs that are still 'attached' to superseded underlying snapshots delete cleanly. Returns {deleted, deletedUuids, skipped:[{uuid, reason}]}. Find candidates with list_unused_securities. Up to 1000 per call.",
    inputSchema: { uuids: z.array(z.string().uuid()).min(1).max(1000) },
    destructive: true,
    handler: async ({ uuids }, { client }) => client.post('/api/investments/securities/bulk-delete', { uuids }),
  });

  // -------------------------------------------------------------------- prices
  registerTool(server, ctx, {
    name: 'get_security_price_history',
    title: 'Get security price history',
    description: 'Return the recorded price history for a security (most recent first), by security UUID.',
    inputSchema: { uuid: z.string().uuid() },
    readOnly: true,
    handler: async ({ uuid }, { client }) => client.get(apiPath`/api/investments/securities/${uuid}/prices`),
  });

  registerTool(server, ctx, {
    name: 'update_security_price',
    title: 'Record a security price',
    description:
      'Upsert a single end-of-day price point for a security. Required: securityUuid, priceDate (YYYY-MM-DD), close. Optional: adjustedClose, volume, source.',
    inputSchema: {
      securityUuid: z.string().uuid(),
      priceDate: calendarDay.describe('Calendar date of the price, YYYY-MM-DD.'),
      close: decimalArg(),
      adjustedClose: decimalArg().optional(),
      volume: decimalArg().optional(),
      source: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        security_uuid: args.securityUuid,
        price_date: args.priceDate,
        close: args.close,
      };
      if (args.adjustedClose !== undefined) body.adjusted_close = args.adjustedClose;
      if (args.volume !== undefined) body.volume = args.volume;
      if (args.source !== undefined) body.source = args.source;
      return client.post('/api/investments/prices', body);
    },
  });

  registerTool(server, ctx, {
    name: 'update_security_prices_bulk',
    title: 'Record security prices (bulk)',
    description:
      'Upsert up to 500 price points in one call. Each price needs securityUuid, priceDate (YYYY-MM-DD), and close; adjustedClose, volume, and source are optional. Failed records do not roll back successful ones — a per-record status is returned.',
    inputSchema: {
      prices: z
        .array(
          z.object({
            securityUuid: z.string().uuid(),
            priceDate: calendarDay.describe('YYYY-MM-DD'),
            close: decimalArg(),
            adjustedClose: decimalArg().optional(),
            volume: decimalArg().optional(),
            source: z.string().optional(),
          })
        )
        .min(1)
        .max(500),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const prices = args.prices.map((p) => {
        const out: Record<string, unknown> = {
          security_uuid: p.securityUuid,
          price_date: p.priceDate,
          close: p.close,
        };
        if (p.adjustedClose !== undefined) out.adjusted_close = p.adjustedClose;
        if (p.volume !== undefined) out.volume = p.volume;
        if (p.source !== undefined) out.source = p.source;
        return out;
      });
      return client.post('/api/investments/prices/bulk', { prices });
    },
  });

  // -------------------------------------------------------------------- events
  registerTool(server, ctx, {
    name: 'record_buy_event',
    title: 'Record a buy',
    description:
      'Record a purchase of a security into an account, opening a new tax lot. Required: accountUuid, securityUuid, eventDate (YYYY-MM-DD), shares, pricePerShare. Optional: fees, acquisitionMethod, source, description, externalReference, dataQuality (flag imputed/estimated basis or acquisition date on the lot, e.g. a transferred non-covered lot). Pass dryRun=true to preview the effect without persisting. The answer\'s wash_sale gives the wash sales it makes: flagged (loss sales), disallowed (an amount) and adjustments (each replacement lot: lot_uuid, replacement_shares, basis_added, total_cost_basis and cost_basis_per_share after); a dry run answers the same, writing nothing, its new lot with lot_uuid null.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid(),
      eventDate: calendarDay.describe('YYYY-MM-DD'),
      shares: decimalArg(),
      pricePerShare: decimalArg(),
      fees: decimalArg().optional(),
      acquisitionMethod: z.enum(ACQUISITION_METHODS).optional(),
      source: z.string().optional(),
      description: z.string().optional(),
      externalReference: z.string().optional(),
      dataQuality: dataQualityEnum.optional()
        .describe('Provenance flag for the created lot; defaults to complete.'),
      isCovered: z.boolean().optional()
        .describe('Whether the broker reports the lot\'s basis (a covered lot). Only average cost reads it: it pools covered and noncovered lots apart. When not given: noncovered if eventDate is before 2012-01-01, else covered. 2012-01-01 is the date for mutual fund and dividend-reinvestment-plan shares, the only ones average cost applies to; stock\'s was 2011-01-01, so pass true for a 2011 stock purchase the broker reports as covered.'),
      adjustedForSplits: adjustedForSplitsArg(),
      dryRun: z.boolean().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        account_uuid: args.accountUuid,
        security_uuid: args.securityUuid,
        event_date: args.eventDate,
        shares: args.shares,
        price_per_share: args.pricePerShare,
      };
      if (args.fees !== undefined) body.fees = args.fees;
      if (args.acquisitionMethod !== undefined) body.acquisition_method = args.acquisitionMethod;
      if (args.source !== undefined) body.source = args.source;
      if (args.description !== undefined) body.description = args.description;
      if (args.externalReference !== undefined) body.external_reference = args.externalReference;
      if (args.dataQuality !== undefined) body.data_quality = args.dataQuality;
      if (args.isCovered !== undefined) body.is_covered = args.isCovered;
      if (args.adjustedForSplits !== undefined) body.adjusted_for_splits = args.adjustedForSplits;
      if (args.dryRun !== undefined) body.dry_run = args.dryRun;
      return client.post('/api/investments/events/buy', body);
    },
  });

  registerTool(server, ctx, {
    name: 'record_sell_event',
    title: 'Record a sell',
    description:
      'Record a sale of a security from an account, closing or reducing tax lots and realizing gain/loss. Required: accountUuid, securityUuid, eventDate (YYYY-MM-DD), shares, pricePerShare. Optional: fees, method (cost-basis method override), specificLots (for specific-ID lot selection), source, description, externalReference. A sale sells only lots acquired on or before eventDate. Each lot sold from gives its remaining total basis pro rata (shares sold ÷ shares held, to the cent; the last share takes what is left). With method average_cost the pool of the account\'s lots of the security held then gives it instead, covered and noncovered (pre-2012) lots in separate pools, and every lot in a pool sold from then holds its shares\' part of what is left (shares still sold oldest first). Pass dryRun=true to preview the realized gain/loss without persisting. The answer\'s wash_sale gives the wash sales it makes: flagged (loss sales), disallowed (an amount) and adjustments (each replacement lot: lot_uuid, replacement_shares, basis_added, total_cost_basis and cost_basis_per_share after); a dry run answers the same, writing nothing.\n\nFor a specific-ID sale you need the target lot UUIDs: call get_holding_lots to list a security\'s open lots (each with lot_uuid + acquisition_date). If the lot was never imported (common for older fractional/transferred positions), first create it with batch_import_lots (set data_quality=imputed_basis/imputed_date), then sell against its lot_uuid.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid(),
      eventDate: calendarDay.describe('YYYY-MM-DD'),
      shares: decimalArg(),
      pricePerShare: decimalArg(),
      fees: decimalArg().optional(),
      method: costBasisMethodEnum.optional().describe('Cost-basis method to use for this sale, e.g. "fifo".'),
      specificLots: z
        .array(z.object({ lotUuid: z.string().uuid(), shares: decimalArg() }))
        .optional()
        .describe('For specific_id method: the exact lots and share counts to draw from.'),
      source: z.string().optional(),
      description: z.string().optional(),
      externalReference: z.string().optional(),
      adjustedForSplits: adjustedForSplitsArg(),
      dryRun: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        account_uuid: args.accountUuid,
        security_uuid: args.securityUuid,
        event_date: args.eventDate,
        shares: args.shares,
        price_per_share: args.pricePerShare,
      };
      if (args.fees !== undefined) body.fees = args.fees;
      if (args.method !== undefined) body.method = args.method;
      if (args.specificLots !== undefined) {
        body.specific_lots = args.specificLots.map((l) => ({ lot_uuid: l.lotUuid, shares: l.shares }));
      }
      if (args.source !== undefined) body.source = args.source;
      if (args.description !== undefined) body.description = args.description;
      if (args.externalReference !== undefined) body.external_reference = args.externalReference;
      if (args.adjustedForSplits !== undefined) body.adjusted_for_splits = args.adjustedForSplits;
      if (args.dryRun !== undefined) body.dry_run = args.dryRun;
      return client.post('/api/investments/events/sell', body);
    },
  });

  registerTool(server, ctx, {
    name: 'record_dividend_event',
    title: 'Record a dividend',
    description:
      'Record a dividend paid on a holding. Required: accountUuid, securityUuid, eventDate (YYYY-MM-DD), totalAmount. Optional: amountPerShare, exDate, recordDate, payDate, isQualified, reinvest (DRIP), pricePerShare (reinvestment price), reinvestIntoSecurityUuid, source, externalReference. Pass dryRun=true to preview without persisting. When reinvested, the answer\'s wash_sale gives the wash sales its new lot makes: flagged (loss sales), disallowed (an amount) and adjustments (each replacement lot: lot_uuid, replacement_shares, basis_added, total_cost_basis and cost_basis_per_share after); a dry run answers the same, writing nothing, its new lot with lot_uuid null.\n\nCROSS-SECURITY REINVESTMENT: for pooled reinvestment (e.g. a robo-advisor pays a dividend on EQFUND and reinvests it into BDFUND per target allocation), set reinvest=true, pricePerShare=the TARGET security\'s price, and reinvestIntoSecurityUuid=the target. The dividend is recorded on securityUuid (the payer) and the reinvestment lot is opened in the target — one call, correctly linked.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid(),
      eventDate: calendarDay.describe('YYYY-MM-DD'),
      totalAmount: decimalArg(),
      amountPerShare: decimalArg().optional(),
      exDate: calendarDay.optional().describe('YYYY-MM-DD'),
      recordDate: calendarDay.optional().describe('YYYY-MM-DD'),
      payDate: calendarDay.optional().describe('YYYY-MM-DD'),
      isQualified: z.boolean().optional(),
      reinvest: z.boolean().optional().describe('If true, the dividend is reinvested (DRIP) opening a new lot.'),
      pricePerShare: decimalArg().optional().describe('Price per share used when reinvesting (the target security\'s price for cross-security reinvestment).'),
      reinvestIntoSecurityUuid: z.string().uuid().optional()
        .describe('Reinvest the dividend into a DIFFERENT security (the payer is securityUuid). Requires reinvest=true and pricePerShare.'),
      source: z.string().optional(),
      externalReference: z.string().optional(),
      adjustedForSplits: adjustedForSplitsArg().describe('With reinvest: the reinvestment price is already adjusted for the splits recorded after payDate (else eventDate) of the security the lot is opened in. Recorded as given, and those splits are not applied to the lot again; without it, a reinvestment dated before such a split is refused (409 EVENT_BEFORE_RECORDED_CORPORATE_ACTION). A return of capital, spinoff or merger after it still refuses it.'),
      dryRun: z.boolean().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        account_uuid: args.accountUuid,
        security_uuid: args.securityUuid,
        event_date: args.eventDate,
        total_amount: args.totalAmount,
      };
      if (args.amountPerShare !== undefined) body.amount_per_share = args.amountPerShare;
      if (args.exDate !== undefined) body.ex_date = args.exDate;
      if (args.recordDate !== undefined) body.record_date = args.recordDate;
      if (args.payDate !== undefined) body.pay_date = args.payDate;
      if (args.isQualified !== undefined) body.is_qualified = args.isQualified;
      if (args.reinvest !== undefined) body.reinvest = args.reinvest;
      if (args.pricePerShare !== undefined) body.price_per_share = args.pricePerShare;
      if (args.reinvestIntoSecurityUuid !== undefined) body.reinvest_into_security_uuid = args.reinvestIntoSecurityUuid;
      if (args.source !== undefined) body.source = args.source;
      if (args.externalReference !== undefined) body.external_reference = args.externalReference;
      if (args.adjustedForSplits !== undefined) body.adjusted_for_splits = args.adjustedForSplits;
      if (args.dryRun !== undefined) body.dry_run = args.dryRun;
      return client.post('/api/investments/events/dividend', body);
    },
  });

  // ------------------------------------------------------------------ holdings
  registerTool(server, ctx, {
    name: 'list_holdings',
    title: 'List holdings',
    description:
      'Return current holdings (positions) with cost basis and market value. Optionally filter to a single account by UUID.',
    inputSchema: {
      accountUuid: z.string().uuid().optional().describe('Limit to a single account.'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/holdings', queryString(holdingsQuery, { account: args.accountUuid })),
  });

  registerTool(server, ctx, {
    name: 'get_holding_lots',
    title: 'Get holding tax lots',
    description:
      'Return the open tax lots for a security (oldest first), useful for choosing specific lots to sell. Filter to a single account with accountUuid. A lot\'s is_covered is the flag average cost pools by: recorded without one, a lot acquired before 2012-01-01 reads as noncovered (the date for fund and plan shares; a 2011 stock purchase a broker reports covered reads noncovered here).',
    inputSchema: {
      securityUuid: z.string().uuid(),
      accountUuid: z.string().uuid().optional().describe('Limit to a single account.'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get(apiPath`/api/investments/holdings/${args.securityUuid}/lots`, queryString(holdingsQuery, { account: args.accountUuid })),
  });

  // ------------------------------------------------------------------- reports
  registerTool(server, ctx, {
    name: 'get_unrealized_gain_loss',
    title: 'Unrealized gain/loss report',
    description:
      'Return the unrealized gain/loss across current holdings (market value vs cost basis). Optionally filter to a single account.',
    inputSchema: {
      accountUuid: z.string().uuid().optional().describe('Limit to a single account.'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/reports/unrealized-gain-loss', queryString(holdingsQuery, { account: args.accountUuid })),
  });

  registerTool(server, ctx, {
    name: 'get_realized_gain_loss',
    title: 'Realized gain/loss report',
    description:
      'Return realized gain/loss from closed lots, optionally bounded by date range and/or filtered to a single account. Dates are YYYY-MM-DD.',
    inputSchema: {
      startDate: calendarDay.optional().describe('Inclusive lower bound, YYYY-MM-DD.'),
      endDate: calendarDay.optional().describe('Inclusive upper bound, YYYY-MM-DD.'),
      accountUuid: z.string().uuid().optional().describe('Limit to a single account.'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/reports/realized-gain-loss', queryString(investmentRangeQuery, {
        start_date: args.startDate,
        end_date: args.endDate,
        account: args.accountUuid,
      })),
  });

  // -------------------------------------------------------- cost-basis setting
  registerTool(server, ctx, {
    name: 'set_cost_basis_method',
    title: 'Set cost-basis method',
    description:
      'Set the default cost-basis method for an account, or for a specific security within an account if securityUuid is given. Optionally toggle DRIP (dividend reinvestment) with dripEnabled.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid().optional().describe('Scope the setting to one security; omit for the account default.'),
      method: costBasisMethodEnum,
      dripEnabled: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = {
        account_uuid: args.accountUuid,
        method: args.method,
      };
      if (args.securityUuid !== undefined) body.security_uuid = args.securityUuid;
      if (args.dripEnabled !== undefined) body.drip_enabled = args.dripEnabled;
      return client.post('/api/investments/cost-basis-method', body);
    },
  });

  // -------------------------------------------------------- corporate actions
  registerTool(server, ctx, {
    name: 'record_split_event',
    title: 'Record stock split',
    description:
      'Apply a stock split (or reverse split) to a security across all open lots, expressed as newShares:oldShares (e.g. numerator 4, denominator 1 for a 4:1 split). Set reverse=true for a reverse split. Preserves total cost basis. Supports dryRun.',
    inputSchema: {
      securityUuid: z.string().uuid(),
      actionDate: calendarDay.describe('YYYY-MM-DD'),
      numerator: positiveDecimalArg('numerator must be positive'),
      denominator: positiveDecimalArg('denominator must be positive'),
      reverse: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/corporate-actions/split', {
        security_uuid: args.securityUuid,
        action_date: args.actionDate,
        numerator: args.numerator,
        denominator: args.denominator,
        reverse: args.reverse ?? false,
        dry_run: args.dryRun ?? false,
      }),
  });

  registerTool(server, ctx, {
    name: 'record_return_of_capital_event',
    title: 'Record return of capital',
    description:
      'Apply a return-of-capital distribution of amountPerShare to a security, reducing per-share cost basis across open lots; any amount that would drive basis below zero is recorded as long-term capital gain. Supports dryRun.',
    inputSchema: {
      securityUuid: z.string().uuid(),
      actionDate: calendarDay.describe('YYYY-MM-DD'),
      amountPerShare: positiveDecimalArg('amountPerShare must be positive'),
      dryRun: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/corporate-actions/return-of-capital', {
        security_uuid: args.securityUuid,
        action_date: args.actionDate,
        amount_per_share: args.amountPerShare,
        dry_run: args.dryRun ?? false,
      }),
  });

  registerTool(server, ctx, {
    name: 'list_holding_events',
    title: 'List holding events',
    description:
      'Browse the full holding-events ledger (buys, sells, dividends, fees, splits, etc.), filterable by account, security, event_type, and date range. Paginated. Use this for read-before-write reconciliation when importing from a statement.',
    inputSchema: {
      accountUuid: z.string().uuid().optional(),
      securityUuid: z.string().uuid().optional(),
      eventType: z.string().optional().describe('e.g. buy, sell, dividend, fee, split'),
      startDate: calendarDay.optional().describe('YYYY-MM-DD'),
      endDate: calendarDay.optional().describe('YYYY-MM-DD'),
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/events', queryString(holdingEventsQuery, {
        account: args.accountUuid,
        security: args.securityUuid,
        event_type: args.eventType,
        start_date: args.startDate,
        end_date: args.endDate,
        page: args.page,
        limit: args.limit,
      })),
  });

  // -------------------------------------------------------------- freshness
  registerTool(server, ctx, {
    name: 'get_data_freshness_report',
    title: 'Data freshness report',
    description:
      "The agent's checklist of stale/missing reference data: securities with stale or never-recorded prices, pass-through funds with stale/missing composition, and funds missing an expense ratio. Ordered actively-held first then by holding value. Use this to discover what to refresh, then call the bulk price / composition / expense-ratio write tools.",
    inputSchema: { minHoldingValue: z.coerce.number().optional().describe('Only include holdings worth at least this much.') },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/data-freshness', queryString(dataFreshnessQuery, { min_holding_value: args.minHoldingValue })),
  });

  // -------------------------------------------------------------------- fees
  registerTool(server, ctx, {
    name: 'record_fee_event',
    title: 'Record fee',
    description:
      'Record a standalone fee (advisory, account_maintenance, wire_transfer, etc.). Account-level fees omit securityUuid; security-specific fees include it. Commissions on trades are handled by the buy/sell tools, not here. When a fee was funded by auto-selling shares (e.g. an advisory fee a robo-advisor charges), record the sell too and pass the SAME externalReference on both so they are linkable. Re-sending the same externalReference is idempotent.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid().optional(),
      feeType: z.enum(FEE_TYPES),
      amount: decimalArg(),
      eventDate: calendarDay.describe('YYYY-MM-DD'),
      description: z.string().optional(),
      externalReference: z.string().optional().describe('Idempotency + correlation key; share it with the funding sell event.'),
    },
    destructive: false,
    handler: async (args, { client }) => {
      const body: Record<string, unknown> = { account_uuid: args.accountUuid, fee_type: args.feeType, amount: args.amount, event_date: args.eventDate };
      if (args.securityUuid !== undefined) body.security_uuid = args.securityUuid;
      if (args.description !== undefined) body.description = args.description;
      if (args.externalReference !== undefined) body.external_reference = args.externalReference;
      return client.post('/api/investments/events/fee', body);
    },
  });

  registerTool(server, ctx, {
    name: 'get_fees_summary',
    title: 'Total fees report',
    description: 'Aggregate explicit fees paid by fee_type over a period, optionally scoped to one account.',
    inputSchema: { startDate: calendarDay.optional(), endDate: calendarDay.optional(), accountUuid: z.string().uuid().optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/fees', queryString(investmentRangeQuery, { start_date: args.startDate, end_date: args.endDate, account: args.accountUuid })),
  });

  registerTool(server, ctx, {
    name: 'get_total_cost_of_ownership',
    title: 'Total cost of ownership',
    description: 'Combine explicit fees with imputed expense-ratio drag per holding (estimated) to show the true annual cost of ownership. Optionally scope to one account.',
    inputSchema: { accountUuid: z.string().uuid().optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/cost-of-ownership', queryString(holdingsQuery, { account: args.accountUuid })),
  });

  // -------------------------------------------------- tax planning / advisory
  registerTool(server, ctx, {
    name: 'preview_sell_tax_impact',
    title: 'Preview sell tax impact',
    description:
      'What-if: if I sell N shares of a security in an account on a date using method M, what lots are consumed and what is the estimated realized gain (LT/ST) and tax at the given marginal rates? Without method, the method the sale would use (the security\'s or account\'s setting, else FIFO); a holding set to specific lots needs one given. Only lots acquired on or before the date count. Read-only; persists nothing. Estimates only — not tax advice.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid(),
      shares: z.coerce.number().positive(),
      date: calendarDay.optional().describe('Proposed sell date YYYY-MM-DD; defaults to today'),
      method: costBasisMethodEnum.optional(),
      pricePerShare: z.coerce.number().optional().describe('Override; defaults to latest stored price'),
      shortTermRate: z.coerce.number().optional().describe('e.g. 0.24'),
      longTermRate: z.coerce.number().optional().describe('e.g. 0.15'),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/reports/sell-tax-impact', queryString(sellTaxImpactQuery, {
        account: args.accountUuid, security: args.securityUuid, shares: args.shares, date: args.date,
        method: args.method, price: args.pricePerShare, st_rate: args.shortTermRate, lt_rate: args.longTermRate,
      })),
  });

  registerTool(server, ctx, {
    name: 'find_tax_loss_harvest_candidates',
    title: 'Find tax-loss-harvest candidates',
    description: 'Open lots held today that are at a loss at the latest price (largest loss first), with a wash-sale caution: a lot sold, or acquired after today, is not listed. Optionally scope to one account and a minimum loss.',
    // An amount, sent as given (decimalArg): the backend reads it exactly, in cents.
    inputSchema: { accountUuid: z.string().uuid().optional(), minLoss: decimalArg().optional().describe("Minimum loss, in the tenant's currency (get_general_settings), e.g. 100 or \"99.95\".") },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/tax-loss-harvest', queryString(taxLossHarvestQuery, { account: args.accountUuid, min_loss: args.minLoss })),
  });

  registerTool(server, ctx, {
    name: 'suggest_lot_selection',
    title: 'Suggest lot selection',
    description: 'Rank a security\'s open lots for a sell objective (minimize_gain, maximize_loss, longest_held, highest_cost) to inform a specific-ID sell. Only lots acquired on or before date (today when not given) are ranked: a sale on that date can sell no others.',
    inputSchema: {
      accountUuid: z.string().uuid(),
      securityUuid: z.string().uuid(),
      objective: z.enum(LOT_OBJECTIVES),
      date: calendarDay.optional().describe('The sale\'s date, YYYY-MM-DD; defaults to today'),
      pricePerShare: z.coerce.number().optional(),
    },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/lot-suggestions', queryString(lotSuggestionsQuery, {
      account: args.accountUuid, security: args.securityUuid, objective: args.objective, date: args.date, price: args.pricePerShare,
    })),
  });

  registerTool(server, ctx, {
    name: 'get_concentration_risk',
    title: 'Concentration risk',
    description: 'Per-security share of the portfolio, flagging positions above a threshold percentage (default 10%).',
    inputSchema: { thresholdPct: z.coerce.number().optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/concentration', queryString(concentrationQuery, { threshold: args.thresholdPct })),
  });

  registerTool(server, ctx, {
    name: 'get_wash_sale_report',
    title: 'Wash sale report',
    description: 'Return disallowed wash-sale losses for a period (security, sell date, disallowed amount) for tax reporting.',
    inputSchema: { startDate: calendarDay.optional().describe('YYYY-MM-DD'), endDate: calendarDay.optional().describe('YYYY-MM-DD') },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/wash-sales', queryString(investmentRangeQuery, { start_date: args.startDate, end_date: args.endDate })),
  });

  registerTool(server, ctx, {
    name: 'record_spinoff_event',
    title: 'Record spinoff',
    description: 'Apply a spinoff: move a fraction (0–1) of each source-security lot\'s basis into a new security, creating shares at shareRatio that inherit the holding period. Both securities must already exist. Supports dryRun.',
    inputSchema: {
      sourceSecurityUuid: z.string().uuid(),
      newSecurityUuid: z.string().uuid(),
      actionDate: calendarDay.describe('YYYY-MM-DD'),
      allocationFraction: decimalArg().refine((v) => !(Number(v) < 0 || Number(v) > 1), 'allocationFraction must be between 0 and 1'),
      shareRatio: positiveDecimalArg('shareRatio must be positive'),
      dryRun: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/corporate-actions/spinoff', {
        source_security_uuid: args.sourceSecurityUuid, new_security_uuid: args.newSecurityUuid, action_date: args.actionDate,
        allocation_fraction: args.allocationFraction, share_ratio: args.shareRatio, dry_run: args.dryRun ?? false,
      }),
  });

  registerTool(server, ctx, {
    name: 'record_merger_event',
    title: 'Record merger',
    description: 'Apply a merger. type=cash closes lots at cashPerShare (realized gain/loss); type=stock converts lots to the acquirer at exchangeRatio (basis & holding period preserved). Supports dryRun.',
    inputSchema: {
      type: z.enum(['cash', 'stock']),
      securityUuid: z.string().uuid(),
      actionDate: calendarDay.describe('YYYY-MM-DD'),
      cashPerShare: decimalArg().optional().describe('Required for type=cash'),
      acquirerSecurityUuid: z.string().uuid().optional().describe('Required for type=stock'),
      exchangeRatio: decimalArg().optional().describe('Required for type=stock'),
      dryRun: z.boolean().optional(),
    },
    destructive: true,
    handler: async (args, { client }) => {
      if (args.type === 'cash') {
        return client.post('/api/investments/corporate-actions/merger-cash', { security_uuid: args.securityUuid, action_date: args.actionDate, cash_per_share: args.cashPerShare, dry_run: args.dryRun ?? false });
      }
      return client.post('/api/investments/corporate-actions/merger-stock', { security_uuid: args.securityUuid, acquirer_security_uuid: args.acquirerSecurityUuid, action_date: args.actionDate, exchange_ratio: args.exchangeRatio, dry_run: args.dryRun ?? false });
    },
  });

  registerTool(server, ctx, {
    name: 'batch_import_lots',
    title: 'Batch import historical lots',
    description: 'Bulk-load historical tax lots (the multi-year backfill). Each row creates a historical_import event + a lot atomically; rows whose external_reference already exists are skipped (idempotent). Supports dryRun to preview. Each created row answers its lot\'s wash_sale (flagged, disallowed, adjustments), the dry run\'s what it would be with lot_uuid null. Up to 500 lots per call. acquisition_method must be one of the allowed values (default purchase) — an unrecognized value is rejected in both dryRun and real modes.',
    inputSchema: {
      lots: z.array(z.object({
        account_uuid: z.string().uuid(),
        security_uuid: z.string().uuid(),
        acquisition_date: calendarDay,
        shares: positiveDecimalArg('shares must be positive'),
        total_cost_basis: decimalArg().refine((v) => !(Number(v) < 0), 'total_cost_basis must not be negative'),
        acquisition_method: z.enum(ACQUISITION_METHODS).optional(),
        data_quality: dataQualityEnum.optional(),
        holding_period_start: calendarDay.optional(),
        external_reference: z.string().nullable().optional(),
        is_covered: z.boolean().optional().describe('Covered by broker basis reporting, as average cost pools it; when not given, noncovered if acquired before 2012-01-01 (the date for fund and plan shares; a 2011 stock lot a broker reports covered needs true)'),
        adjusted_for_splits: adjustedForSplitsArg(),
      })).min(1).max(500),
      dryRun: z.boolean().optional(),
    },
    destructive: false,
    handler: async (args, { client }) => client.post('/api/investments/lots/batch-import', { lots: args.lots, dry_run: args.dryRun ?? false }),
  });

  registerTool(server, ctx, {
    name: 'set_lot_covered',
    title: "Correct a lot's covered status",
    description:
      "Correct whether a tax lot is covered (its cost basis reported by the broker), the flag average cost pools lots by: covered and noncovered lots are separate pools. Use it for a lot stored with the wrong flag, e.g. a lot acquired before 2012 that the broker reports as covered (get_holding_lots shows each lot's is_covered and uuid). Answers the lot, and records the change as a lot_correction event; the same value again changes nothing. Refused (409 LOT_POOLED) once a sale under average cost may have pooled it (a sale of the security in that account dated on or after the lot was acquired, or recorded after it) or the lot a merger or spinoff made it from (such a sale recorded before that action): that sale's basis, and the lots it re-based, were worked out from the flag as it is. A lot sold from under another method can be corrected. Lots a spinoff or merger made from this one keep their own flag.",
    inputSchema: {
      lotUuid: z.string().uuid().describe('The lot, as get_holding_lots lists it (uuid).'),
      isCovered: booleanInput.describe('true: covered; false: noncovered.'),
    },
    destructive: true,
    handler: async (args, { client }) => client.patch(apiPath`/api/investments/lots/${args.lotUuid}`, { is_covered: args.isCovered }),
  });

  registerTool(server, ctx, {
    name: 'get_reconciliation_status',
    title: 'Reconciliation status',
    description: 'Per investment account: holdings at their latest prices plus the account\'s cash (its balance in Nuggets, without pending) vs the balance the broker reports through the SimpleFin sync, flagging discrepancies beyond max(1%, 50 in the tenant\'s currency). An account that auto-rebalances to the imported balance has no separate cash figure and is not compared (calculated_value null, with a reason).',
    inputSchema: {},
    readOnly: true,
    handler: async (_args, { client }) => client.get('/api/investments/reports/reconciliation'),
  });

  registerTool(server, ctx, {
    name: 'get_securities_needing_data',
    title: 'Securities needing data',
    description: 'Securities lacking a data category: price (never recorded), composition (pass-through funds with none), or expense_ratio (pass-through funds missing it). Use to prioritize agent refresh.',
    inputSchema: { category: z.enum(SECURITY_DATA_NEEDS).optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/securities-needing-data', queryString(securitiesNeedingDataQuery, { category: args.category ?? 'price' })),
  });

  registerTool(server, ctx, {
    name: 'get_price_history_gaps',
    title: 'Price history gaps',
    description: 'Date ranges within a security\'s price history where consecutive prices are more than thresholdDays apart — used to target historical backfill.',
    inputSchema: { securityUuid: z.string().uuid(), thresholdDays: z.coerce.number().int().min(1).optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get(apiPath`/api/investments/securities/${args.securityUuid}/price-gaps`, queryString(priceGapsQuery, { threshold_days: args.thresholdDays })),
  });

  registerTool(server, ctx, {
    name: 'get_portfolio_performance',
    title: 'Portfolio performance',
    description: 'Money-weighted (xIRR) and time-weighted (Modified Dietz) returns plus total/annualized return and current value, computed from the cash-flow stream. Optionally scope to one account and a date range.',
    inputSchema: { accountUuid: z.string().uuid().optional(), startDate: calendarDay.optional(), endDate: calendarDay.optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/performance', queryString(investmentRangeQuery, { account: args.accountUuid, start_date: args.startDate, end_date: args.endDate })),
  });

  registerTool(server, ctx, {
    name: 'get_dividend_history',
    title: 'Dividend history',
    description: 'Dividend income over a period (qualified vs ordinary split), optionally scoped to one account.',
    inputSchema: { startDate: calendarDay.optional(), endDate: calendarDay.optional(), accountUuid: z.string().uuid().optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/dividend-history', queryString(investmentRangeQuery, { start_date: args.startDate, end_date: args.endDate, account: args.accountUuid })),
  });

  // ----------------------------------------------------- look-through / funds
  registerTool(server, ctx, {
    name: 'update_fund_composition',
    title: 'Update fund composition',
    description:
      "Classify a security along one or more dimensions (the look-through that powers the allocation report). `dimensions` maps each dimension to an array of {dimension_value, weight_percentage}; weights per dimension must sum to 95–105% or the write is rejected.\n\n" +
      "WHICH DIMENSIONS APPLY (a security is made of 'sleeves' — its stock part vs its bond part):\n" +
      "• asset_class — the whole holding. Always applies. Use the Morningstar 8: Domestic Stock, Foreign Stock, Domestic Bond, Foreign Bond, Cash, Preferred, Convertibles, Other.\n" +
      "• region / country — the whole holding (any stocks or bonds). Not for money_market or crypto.\n" +
      "• sector / market_cap / style — the EQUITY sleeve only (the stock holdings). Valid for a `stock` or a fund; NOT for a `bond`. sector = GICS 11 (verbatim); market_cap = Large/Mid/Small Cap; style = Value/Blend/Growth.\n" +
      "• credit_quality / rate_sensitivity — the BOND sleeve only (the bond holdings). Valid for a `bond` or a fund; NOT for a `stock`. credit_quality = High/Medium/Low; rate_sensitivity = Limited/Moderate/Extensive.\n\n" +
      "The backend WARNS/REJECTS a dimension that can't apply to the security's type (e.g. sector on a bond, credit_quality on a stock, region on cash) — don't send those.\n\n" +
      "MIXED FUNDS (e.g. target-date / balanced): a sleeve-only dimension only covers part of the fund, but it must still sum to ~100% of the WHOLE fund. Enter each weight as a share of the whole fund and add a residual row for the rest — 'Non-equity' (or 'Non-bond') — so it totals 100%. Example for a 70% stock / 30% bond fund's sector: {Information Technology: 25, Financials: 20, Health Care: 25, 'Non-equity': 30}.\n\n" +
      "A plain (non-pass-through) security takes a single 100% row per dimension; a pass-through fund takes multiple weighted rows.",
    inputSchema: {
      securityUuid: z.string().uuid(),
      snapshotDate: calendarDay.describe('YYYY-MM-DD'),
      dimensions: z.record(
        z.string(),
        z.array(z.object({ dimension_value: z.string(), weight_percentage: decimalArg() })).min(1)
      ),
      source: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/compositions', {
        security_uuid: args.securityUuid,
        snapshot_date: args.snapshotDate,
        dimensions: args.dimensions,
        source: args.source ?? 'mcp_manual',
      }),
  });

  registerTool(server, ctx, {
    name: 'update_expense_ratio',
    title: 'Update expense ratio',
    description: "Set a security's published net expense ratio (percentage, e.g. 0.03 for 3 bps). Stamps the expense-ratio freshness timestamp.",
    inputSchema: { securityUuid: z.string().uuid(), expenseRatioPercentage: decimalArg() },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/expense-ratio', { security_uuid: args.securityUuid, expense_ratio_percentage: args.expenseRatioPercentage }),
  });

  registerTool(server, ctx, {
    name: 'get_fund_composition',
    title: 'Get fund composition',
    description: "Return a fund's current composition (latest snapshot per dimension) with weights.",
    inputSchema: { securityUuid: z.string().uuid() },
    readOnly: true,
    handler: async (args, { client }) => client.get(apiPath`/api/investments/securities/${args.securityUuid}/composition`),
  });

  registerTool(server, ctx, {
    name: 'get_lookthrough_allocation',
    title: 'Look-through allocation',
    description:
      "Answer 'where is my money?' — aggregate portfolio exposure along a dimension (default asset_class), combining direct holdings (100% to own classification) and pass-through funds (weighted by composition). Optionally scope to one account.",
    inputSchema: {
      dimension: z.string().optional().describe('asset_class | region | country | sector | market_cap | style | …'),
      accountUuid: z.string().uuid().optional(),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/reports/lookthrough', queryString(lookThroughQuery, { dimension: args.dimension ?? 'asset_class', account: args.accountUuid })),
  });

  // ------------------------------------------- holdings-level look-through (stocks)
  registerTool(server, ctx, {
    name: 'update_underlying_holdings',
    title: 'Update fund underlying holdings',
    description:
      "Populate a fund/ETF's actual underlying securities (its real stock/bond holdings, by ticker) so portfolio exposure can be resolved all the way to individual stocks. `holdings` is an array of {underlying_ticker, weight_percentage, shares?}. Unknown tickers are auto-created as minimal securities. Each weight must be >0 and ≤100; the sum must be ≤105% (a sum under 100% leaves a cash/unaccounted residual, reported as unknown; a sum over 100% is scaled down to 100% in look-through, so the fund's exposures add up to its value, never more). Up to 20000 holdings per snapshot (a full total-market fund); for very large funds you may also send the holdings across multiple calls with the same snapshot date — they accumulate. Recording holdings marks the security pass-through and tracked. Use update_fund_composition instead for dimensional (asset-class/sector/region) breakdowns.",
    inputSchema: {
      securityUuid: z.string().uuid(),
      snapshotDate: calendarDay.describe('YYYY-MM-DD'),
      holdings: z
        .array(
          z.object({
            underlying_ticker: z.string().min(1),
            underlying_name: z.string().optional(),
            weight_percentage: decimalArg(),
            shares: decimalArg().optional(),
          })
        )
        .min(1)
        .max(20000),
      source: z.string().optional(),
    },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/underlying-holdings', {
        security_uuid: args.securityUuid,
        snapshot_date: args.snapshotDate,
        holdings: args.holdings,
        source: args.source ?? 'mcp_manual',
      }),
  });

  registerTool(server, ctx, {
    name: 'set_underlying_holdings_tracking',
    title: 'Toggle underlying-holdings tracking',
    description:
      "Turn holdings-level look-through on/off for a fund. When off, the fund is treated as opaque (its value lands in the 'unknown' bucket of underlying-exposure reports). Recording holdings via update_underlying_holdings turns this on automatically.",
    inputSchema: { securityUuid: z.string().uuid(), trackUnderlyingHoldings: booleanInput },
    destructive: true,
    handler: async (args, { client }) =>
      client.post('/api/investments/underlying-tracking', {
        security_uuid: args.securityUuid,
        track_underlying_holdings: args.trackUnderlyingHoldings,
      }),
  });

  registerTool(server, ctx, {
    name: 'get_underlying_holdings',
    title: 'Get fund underlying holdings',
    description: "Return a fund's current underlying securities (latest snapshot) with each ticker, weight, and optional share count.",
    inputSchema: { securityUuid: z.string().uuid() },
    readOnly: true,
    handler: async (args, { client }) => client.get(apiPath`/api/investments/securities/${args.securityUuid}/underlying-holdings`),
  });

  registerTool(server, ctx, {
    name: 'find_underlying_exposure',
    title: 'Find underlying stock exposure',
    description:
      "Answer 'what is my total exposure to a given stock?' — resolve every portfolio position down to its individual underlying securities (recursing through funds-of-funds) and aggregate by leaf security. Direct holdings count toward their own ticker; funds are expanded by their underlying-holdings weights (scaled to 100% when they add up to more); opaque funds and weight residuals under 100% land in unknown_value. `exposures` lists each security worth a cent or more, largest first; the securities worth less than a cent each are not listed but summed in below_a_cent (how many, amount, percentage), so a security missing from `exposures` may be among them. The exposures, below_a_cent.amount and unknown_value add up to total_value. Optionally scope to one account.",
    inputSchema: { accountUuid: z.string().uuid().optional() },
    readOnly: true,
    handler: async (args, { client }) => client.get('/api/investments/reports/underlying-exposure', queryString(holdingsQuery, { account: args.accountUuid })),
  });

  registerTool(server, ctx, {
    name: 'get_portfolio_value_series',
    title: 'Portfolio value series (equity curve)',
    description:
      "Return the daily mark-to-market portfolio value series (the equity curve) — one point per day the value was snapshotted, ascending by date. Each point has total_value, cost_basis, and stale_securities (positions valued on a carried-forward close). Snapshots are produced by the scheduled/manual price sync, so the series is forward-only (it grows from when sync was enabled). Optional start_date (YYYY-MM-DD) and limit.",
    inputSchema: {
      startDate: calendarDay.optional().describe('YYYY-MM-DD lower bound'),
      limit: z.coerce.number().int().min(1).optional(),
    },
    readOnly: true,
    handler: async (args, { client }) =>
      client.get('/api/investments/reports/value-series', queryString(valueSeriesQuery, { start_date: args.startDate, limit: args.limit })),
  });
}
