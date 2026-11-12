import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { readDecimal, costBasisMethod } from '@nuggets/shared';
import { lotsHeldOn, planSell, sellPlanAmounts, type OpenLot, type CostBasisMethod } from './costBasis.js';
import {
  estimateSellTax,
  rankLotsForObjective,
  tlhCandidates,
  concentration,
  type AdvisoryLot,
  type LotObjective,
} from './taxPlanning.js';
import { invalidRequestError, notFoundError } from '../controlPlaneErrors.js';
import { HoldingsService } from './HoldingsService.js';
import { CENTS, PER_SHARE, SHARES, numericUnits, unitsToNumber, type AnswerDecimal } from '../../utils/decimal.js';

/**
 * A what-if figure from the query (a share count, a price) in units of `scale`, rounded to
 * it: an estimate, nothing is stored. toFixed writes the number's decimal without an exponent.
 */
function whatIfUnits(value: number, scale: number, field: string): bigint {
  const read = readDecimal(value.toFixed(scale), scale, 40);
  if ('problem' in read) throw invalidRequestError(`${field} is too large`);
  return read.units;
}

/**
 * Read-only tax-planning & advisory reports. Fetches lots/prices
 * via getDb() and delegates the math to the pure taxPlanning module. All tax
 * numbers are estimates at the supplied marginal rates.
 */
export class TaxPlanningService {
  private async securityIdByUuid(uuid: string): Promise<number> {
    const r = await getDb().selectFrom('securities').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!r) throw notFoundError('security');
    return r.id;
  }
  private async accountIdByUuid(uuid: string): Promise<number> {
    const r = await getDb().selectFrom('accounts').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!r) throw notFoundError('account');
    return r.id;
  }
  /** The latest close, in ten-thousandths of a dollar. */
  private async latestPrice(securityId: number): Promise<bigint | null> {
    const r = await getDb()
      .selectFrom('security_prices').select('close')
      .where('security_id', '=', securityId)
      .orderBy('price_date', 'desc').limit(1).executeTakeFirst();
    return r ? numericUnits(r.close, PER_SHARE.scale) : null;
  }
  /**
   * Open lots with shares, in exact units; lotsHeldOn keeps those a sale on a day could sell, as
   * HoldingsService.recordSell does. Their remaining basis is what it takes (pro rata,
   * costBasis.ts). An open lot with no shares (a reverse split rounded one to none before v2.1.0)
   * has none to sell, and its basis would read as a loss.
   */
  private async openLots(accountId: number, securityId: number): Promise<(OpenLot & { uuid: string })[]> {
    const rows = await getDb()
      .selectFrom('tax_lots')
      .select(['id', 'uuid', 'acquisition_date', 'holding_period_start', 'shares_remaining', 'cost_basis_per_share', 'total_cost_basis', 'is_covered'])
      .where('account_id', '=', accountId).where('security_id', '=', securityId).where('is_open', '=', true)
      .where('shares_remaining', '>', '0')
      .orderBy('acquisition_date', 'asc').orderBy('id', 'asc').execute();
    return rows.map((r) => ({
      id: r.id, uuid: r.uuid,
      acquisitionDate: r.acquisition_date, holdingPeriodStart: r.holding_period_start,
      sharesRemaining: numericUnits(r.shares_remaining, SHARES.scale), costBasisPerShare: numericUnits(r.cost_basis_per_share, PER_SHARE.scale),
      totalCostBasis: numericUnits(r.total_cost_basis, CENTS.scale),
      isCovered: r.is_covered,
    }));
  }

  /**
   * What a sale would realize and its estimated tax. Its method is the one given, else the one
   * the sale itself would use (the security's, the account's, FIFO: HoldingsService.resolveMethod),
   * where FIFO alone was assumed.
   */
  async previewSellTaxImpact(input: {
    accountUuid: string; securityUuid: string; shares: number; sellDate: string;
    method?: CostBasisMethod; pricePerShare?: number; shortTermRate?: number; longTermRate?: number;
  }) {
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = await this.securityIdByUuid(input.securityUuid);
    const method = input.method ?? (await new HoldingsService().resolveMethod(accountId, securityId));
    // An estimate picks no lots: a holding sold by specific lots needs a method named for it.
    if (method === costBasisMethod.enum.specific_id && input.method === undefined) {
      throw invalidRequestError('This holding is sold by specific lots, which an estimate can\'t pick: give a method (fifo, lifo, hifo or average_cost), or see the lot suggestions');
    }
    const sharesToSell = whatIfUnits(input.shares, SHARES.scale, 'shares');
    const lots = lotsHeldOn(await this.openLots(accountId, securityId), input.sellDate, sharesToSell);
    const price = input.pricePerShare != null ? whatIfUnits(input.pricePerShare, PER_SHARE.scale, 'price') : await this.latestPrice(securityId);
    if (price == null) throw invalidRequestError('error: no price available; supply pricePerShare');
    const plan = planSell({ lots, sharesToSell, pricePerShare: price, sellDate: input.sellDate, method });
    // The tax at each rate is figured on the plan's exact cents.
    const tax = estimateSellTax(plan, input.shortTermRate, input.longTermRate);
    return { price_per_share: unitsToNumber(price, PER_SHARE.scale), method, plan: sellPlanAmounts(plan), tax, estimated: true };
  }

  /** The open lots a sale on `date` could sell, ranked for `objective`. */
  async suggestLotSelection(input: { accountUuid: string; securityUuid: string; objective: LotObjective; date: string; pricePerShare?: number }) {
    const accountId = await this.accountIdByUuid(input.accountUuid);
    const securityId = await this.securityIdByUuid(input.securityUuid);
    const lots = lotsHeldOn(await this.openLots(accountId, securityId), input.date);
    const price = input.pricePerShare != null ? whatIfUnits(input.pricePerShare, PER_SHARE.scale, 'price') : await this.latestPrice(securityId);
    if (price == null) throw invalidRequestError('error: no price available; supply pricePerShare');
    // Each lot keeps its uuid for the caller.
    return { price_per_share: unitsToNumber(price, PER_SHARE.scale), objective: input.objective, lots: rankLotsForObjective(lots, price, input.objective) };
  }

  /**
   * Loss lots across all (or one) accounts, with wash-sale risk window noted: the open lots a
   * sale today could sell, as the sell estimate and the lot suggestions read a day's lots. A
   * lot dated after the household's today (app_today) isn't held yet.
   */
  async findTaxLossHarvest(input: { accountUuid?: string; minLossCents?: number } = {}) {
    const accountId = input.accountUuid ? await this.accountIdByUuid(input.accountUuid) : null;
    // Open lots with shares (one with none has nothing to harvest, and its basis would read as a loss).
    const rows = await sql<{ security_id: number; ticker: string; uuid: string; acquisition_date: string; holding_period_start: string; shares_remaining: string; cost_basis_per_share: string; total_cost_basis: string; close: string | null }>`
      SELECT tl.security_id, s.ticker, tl.uuid, tl.acquisition_date, tl.holding_period_start,
             tl.shares_remaining, tl.cost_basis_per_share, tl.total_cost_basis,
             (SELECT close FROM security_prices sp WHERE sp.security_id = tl.security_id ORDER BY sp.price_date DESC LIMIT 1) AS close
      FROM tax_lots tl JOIN securities s ON s.id = tl.security_id
      WHERE tl.is_open = true AND tl.shares_remaining > 0 AND tl.acquisition_date <= app_today()
        ${accountId != null ? sql`AND tl.account_id = ${accountId}` : sql``}
    `.execute(getDb());

    // Exact units: the market value and the loss are figured in cents.
    const bySecurity = new Map<number, { ticker: string; price: bigint; lots: (AdvisoryLot & { uuid: string })[] }>();
    for (const r of rows.rows) {
      if (r.close == null) continue;
      const e = bySecurity.get(r.security_id) ?? { ticker: r.ticker, price: numericUnits(r.close, PER_SHARE.scale), lots: [] };
      e.lots.push({
        id: 0, uuid: r.uuid, acquisitionDate: r.acquisition_date, holdingPeriodStart: r.holding_period_start,
        sharesRemaining: numericUnits(r.shares_remaining, SHARES.scale), costBasisPerShare: numericUnits(r.cost_basis_per_share, PER_SHARE.scale),
        totalCostBasis: numericUnits(r.total_cost_basis, CENTS.scale),
      });
      bySecurity.set(r.security_id, e);
    }
    const found: Array<{ lossCents: bigint; candidate: { security_id: number; ticker: string; lot_uuid: string; market_value: AnswerDecimal; unrealized_loss: AnswerDecimal } }> = [];
    for (const [securityId, e] of bySecurity) {
      for (const c of tlhCandidates(e.lots, e.price, input.minLossCents ?? 0)) {
        found.push({ lossCents: c.lossCents, candidate: { security_id: securityId, ticker: e.ticker, lot_uuid: c.lot.uuid, market_value: c.marketValue, unrealized_loss: c.unrealizedLoss } });
      }
    }
    // The largest loss first, compared in cents (a figure may be text); a stable sort.
    found.sort((a, b) => (a.lossCents < b.lossCents ? 1 : a.lossCents > b.lossCents ? -1 : 0));
    const out = found.map((f) => f.candidate);
    return { candidates: out, note: 'Check wash-sale risk before harvesting (a buy of the same security within 30 days disallows the loss).' };
  }

  async getConcentration(input: { thresholdPct?: number } = {}) {
    const rows = await sql<{ security_id: number; ticker: string; market_value: string | null }>`
      SELECT tl.security_id, s.ticker,
             SUM(tl.shares_remaining) * (SELECT close FROM security_prices sp WHERE sp.security_id = tl.security_id ORDER BY sp.price_date DESC LIMIT 1) AS market_value
      FROM tax_lots tl JOIN securities s ON s.id = tl.security_id
      WHERE tl.is_open = true
      GROUP BY tl.security_id, s.ticker
    `.execute(getDb());
    // The market values as SQL gives them, exact: concentration sums them in units.
    const holdings = rows.rows.filter((r) => r.market_value != null).map((r) => ({ securityId: r.security_id, ticker: r.ticker, marketValue: r.market_value! }));
    return { threshold_pct: input.thresholdPct ?? 10, rows: concentration(holdings, input.thresholdPct ?? 10) };
  }
}

