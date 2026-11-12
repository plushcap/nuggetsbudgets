import { sql } from 'kysely';
import { getDb } from '../../db/withTenant.js';
import { xirr, modifiedDietz, totalReturn, annualize, type CashFlow } from './performance.js';
import { appToday } from '../../utils/appDate.js';
import { addDays, daysBetween } from '../../utils/calendarDate.js';
import { notFoundError } from '../controlPlaneErrors.js';
import { inSharesAfter } from './splitUnits.js';
import { CENTS, PER_SHARE, SHARES, SHARE_VALUE_SCALE, centsNumber, divRound, numericUnits, pow10, unitsToNumber } from '../../utils/decimal.js';
import { corporateActionType, holdingEventType } from '@nuggets/shared';

/**
 * External cash flows of the securities portfolio. Money in at cost:
 * buys, imported lots (the onboarding path) and transfers in. Money out: sells, cash
 * mergers, cash dividends and transfers out. Everything else is internal: a
 * reinvested dividend is a dividend paid into the portfolio and spent in it at once;
 * spinoffs, stock mergers and splits move basis between holdings; and standalone fee
 * events are reported (total_fees) but aren't flows, so the returns are before them
 * (commissions are already in the lots' basis and the sells' proceeds).
 */
const CONTRIBUTIONS = new Set(['buy', 'historical_import', 'transfer_in']);
const DISTRIBUTIONS = new Set(['sell', 'merger_cash', 'dividend', 'transfer_out']);

/** A portfolio value as of a day's close. */
interface Valuation {
  /** Cents. */
  value: bigint;
  /** Securities held that day with no close on or before it. */
  unpriced: number;
}

/**
 * An exact fraction, n / d with d > 0: a share count adjusted for splits after a day (its
 * shares × each split's denominator ÷ numerator) has no finite decimal (a 3:1 split's third).
 */
interface Fraction {
  n: bigint;
  d: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

function addFraction(a: Fraction, b: Fraction): Fraction {
  const n = a.n * b.d + b.n * a.d;
  const d = a.d * b.d;
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
}

/**
 * Portfolio performance: money-weighted (xIRR) and Modified
 * Dietz returns from the external cash flows plus the portfolio's value at the
 * start and end of the period, computed on read (no snapshots).
 *
 * The period runs from the close of the day before `startDate` to the close of
 * `endDate`; a flow happens at the close of its day, so one on `endDate` has no time
 * weight. With no `startDate` it starts from nothing with the first flow (which then
 * has a full weight). A value as of a day counts the lots held at its
 * close (acquired by then, plus the shares sales after it took) at the latest close
 * on or before it, and splits after it divided out, since prices are stored raw.
 * When a security held then has no price by then, the returns are null.
 *
 * Exact: money in cents, a value as a sum of exact fractions (shares, split ratios and
 * closes are bigint units) rounded to cents once; the returns are ratios of those figures.
 */
export class PerformanceService {
  /** An account no one can see is a 404, not the whole portfolio's numbers. */
  private async accountIdByUuid(uuid: string): Promise<number> {
    const r = await getDb().selectFrom('accounts').select('id').where('uuid', '=', uuid).executeTakeFirst();
    if (!r) throw notFoundError('account');
    return r.id;
  }

  /** Market value of the holdings (optionally one account) at the close of `date`. */
  private async valueAsOf(date: string, accountId: number | null): Promise<Valuation> {
    const lots = await sql<{ id: number; security_id: number; shares_remaining: string }>`
      SELECT tl.id, tl.security_id, tl.shares_remaining
      FROM tax_lots tl
      WHERE tl.acquisition_date <= ${date} ${accountId != null ? sql`AND tl.account_id = ${accountId}` : sql``}
    `.execute(getDb());
    if (lots.rows.length === 0) return { value: 0n, unpriced: 0 };
    const lotIds = lots.rows.map((l) => l.id);
    const securityIds = [...new Set(lots.rows.map((l) => l.security_id))];

    // What left each lot after `date`: sales and cash mergers (lot_consumptions), and stock
    // mergers, which close the lot without one (its shares = the acquirer shares / ratio).
    // A stock merger's shares then are the acquirer shares ÷ the ratio: both are returned, and
    // divided exactly below (a NUMERIC division rounds).
    //
    // A sale recorded in figures already adjusted for the splits after it sold
    // shares after those splits: adjusted_through says which (splitUnits.ts).
    const outflows = await sql<{ lot_id: number; shares: string | null; merger: boolean; ratio: string | null; event_date: string; adjusted_through: number | null }>`
      SELECT lc.tax_lot_id AS lot_id, lc.shares_consumed AS shares, false AS merger, NULL::text AS ratio, he.event_date,
             he.adjusted_through_action_id AS adjusted_through
      FROM lot_consumptions lc JOIN holding_events he ON he.id = lc.sell_event_id
      WHERE he.event_date > ${date} AND lc.tax_lot_id = ANY(${lotIds}::int[])
      UNION ALL
      SELECT child.parent_lot_id, he.shares, true, he.metadata->>'exchangeRatio', he.event_date, NULL::int
      FROM tax_lots child JOIN holding_events he ON he.id = child.created_by_event_id
      WHERE child.acquisition_method = 'merger' AND he.event_type = 'merger_stock'
        AND he.event_date > ${date} AND child.parent_lot_id = ANY(${lotIds}::int[])
    `.execute(getDb());
    const splits = await sql<{ id: number; security_id: number; action_date: string; numerator: string; denominator: string }>`
      SELECT id, security_id, action_date, numerator, denominator
      FROM security_corporate_actions
      WHERE action_type IN (${sql.lit(corporateActionType.enum.split)}, ${sql.lit(corporateActionType.enum.reverse_split)}) AND action_date > ${date} AND security_id = ANY(${securityIds}::int[])
    `.execute(getDb());
    const prices = await sql<{ security_id: number; close: string }>`
      SELECT DISTINCT ON (security_id) security_id, close
      FROM security_prices
      WHERE security_id = ANY(${securityIds}::int[]) AND price_date <= ${date}
      ORDER BY security_id, price_date DESC
    `.execute(getDb());

    // A share then is `factor` shares on a later day: the splits after `date` that a figure of
    // that day is in the shares after (splitUnits.ts inSharesAfter: up to that day, a split's own
    // day being post-split, and those an adjusted sale was adjusted for), all of them for a lot
    // as it is now. A lot acquired by `date` predates them, so they split it. As a fraction of the
    // ratios' units (both at the share scale), so dividing by it is exact.
    const factor = (securityId: number, until: { date: string; adjustedThrough: number | null } | null): Fraction =>
      splits.rows
        .filter((s) => s.security_id === securityId
          && (until == null || inSharesAfter({ id: s.id, actionDate: s.action_date }, until.date, until.adjustedThrough)))
        .reduce((f, s) => ({ n: f.n * numericUnits(s.numerator, SHARES.scale), d: f.d * numericUnits(s.denominator, SHARES.scale) }), { n: 1n, d: 1n });
    /** `shares` (millionths, as a fraction) on a day `f` splits, back in shares then. */
    const before = (shares: Fraction, f: Fraction): Fraction => ({ n: shares.n * f.d, d: shares.d * f.n });
    const outByLot = new Map<number, Array<{ shares: Fraction; date: string; adjustedThrough: number | null }>>();
    for (const o of outflows.rows) {
      if (o.shares == null) continue;
      const shares = numericUnits(o.shares, SHARES.scale);
      let out: Fraction = { n: shares, d: 1n };
      if (o.merger) {
        // Acquirer shares ÷ the exchange ratio (millionths of a share ÷ millionths of 1).
        const ratio = o.ratio != null ? numericUnits(o.ratio, SHARES.scale) : 0n;
        if (ratio <= 0n) continue;
        out = { n: shares * pow10(SHARES.scale), d: ratio };
      }
      outByLot.set(o.lot_id, [...(outByLot.get(o.lot_id) ?? []), { shares: out, date: o.event_date, adjustedThrough: o.adjusted_through }]);
    }
    const sharesBySecurity = new Map<number, Fraction>();
    for (const l of lots.rows) {
      let held = before({ n: numericUnits(l.shares_remaining, SHARES.scale), d: 1n }, factor(l.security_id, null));
      for (const o of outByLot.get(l.id) ?? []) held = addFraction(held, before(o.shares, factor(l.security_id, o)));
      sharesBySecurity.set(l.security_id, addFraction(sharesBySecurity.get(l.security_id) ?? { n: 0n, d: 1n }, held));
    }

    const closeBySecurity = new Map(prices.rows.map((p) => [p.security_id, numericUnits(p.close, PER_SHARE.scale)]));
    // Millionths of a share × ten-thousandths of a dollar: 10^-10 dollars, as a fraction.
    let value: Fraction = { n: 0n, d: 1n };
    let unpriced = 0;
    for (const [securityId, shares] of sharesBySecurity) {
      if (divRound(shares.n, shares.d) === 0n) continue;
      const close = closeBySecurity.get(securityId);
      if (close == null) unpriced++;
      else value = addFraction(value, { n: shares.n * close, d: shares.d });
    }
    return { value: divRound(value.n, value.d * pow10(SHARE_VALUE_SCALE - CENTS.scale)), unpriced };
  }

  async getPerformance(opts: { accountUuid?: string; startDate?: string; endDate?: string } = {}) {
    const accountId = opts.accountUuid ? await this.accountIdByUuid(opts.accountUuid) : null;
    const endDate = opts.endDate ?? (await appToday());

    // Cash flows from the event stream, within the period.
    const evRows = await sql<{ event_type: string; event_date: string; total_amount: string | null }>`
      SELECT he.event_type, he.event_date, he.total_amount
      FROM holding_events he
      WHERE he.total_amount IS NOT NULL
        ${accountId != null ? sql`AND he.account_id = ${accountId}` : sql``}
        ${opts.startDate ? sql`AND he.event_date >= ${opts.startDate}` : sql``}
        AND he.event_date <= ${endDate}
      ORDER BY he.event_date ASC, he.id ASC
    `.execute(getDb());

    // Money in cents; a flow's amount is answered (and used by the return math) in dollars.
    const flows: Array<{ date: string; cents: bigint }> = []; // Dietz: money in = +, money out = -
    let totalContributed = 0n;
    let totalDistributed = 0n;
    let totalFees = 0n;
    for (const e of evRows.rows) {
      const amt = numericUnits(e.total_amount!, CENTS.scale);
      if (CONTRIBUTIONS.has(e.event_type)) {
        flows.push({ date: e.event_date, cents: amt });
        totalContributed += amt;
      } else if (DISTRIBUTIONS.has(e.event_type)) {
        flows.push({ date: e.event_date, cents: -amt });
        totalDistributed += amt;
      } else if (e.event_type === holdingEventType.enum.fee) {
        totalFees += amt;
      }
    }
    // The return math is in doubles (a rate); the answer's figures are exact (centsNumber).
    const asDouble = (cents: bigint) => unitsToNumber(cents, CENTS.scale);
    const contributions: CashFlow[] = flows.map((f) => ({ date: f.date, amount: asDouble(f.cents) }));

    // The close the begin value is taken at: the day before the start date. With no start
    // date the period starts from nothing at the first flow, which is its first instant.
    const startDate = opts.startDate ?? contributions[0]?.date ?? endDate;
    const beginDate = opts.startDate ? addDays(startDate, -1) : startDate;
    const begin = opts.startDate ? await this.valueAsOf(beginDate, accountId) : { value: 0n, unpriced: 0 };
    const end = await this.valueAsOf(endDate, accountId);
    const unpriced = Math.max(begin.unpriced, end.unpriced);

    const beginValue = asDouble(begin.value);
    const currentValue = asDouble(end.value);
    const netInvestedCents = begin.value + totalContributed - totalDistributed;
    const netInvested = asDouble(netInvestedCents);
    const days = Math.max(0, daysBetween(beginDate, endDate));

    let irr: number | null = null;
    let twr: number | null = null;
    let tret: number | null = null;
    let annualized: number | null = null;
    if (unpriced === 0) {
      // IRR (investor's view): the begin value and money in are paid, money out and the
      // end value received.
      const irrFlows: CashFlow[] = [
        ...(beginValue !== 0 ? [{ date: beginDate, amount: -beginValue }] : []),
        ...contributions.map((c) => ({ date: c.date, amount: -c.amount })),
        { date: endDate, amount: currentValue },
      ];
      irr = xirr(irrFlows);
      twr = modifiedDietz(beginValue, currentValue, contributions, beginDate, endDate);
      tret = totalReturn(netInvested, currentValue);
      annualized = tret != null ? annualize(tret, days) : null;
    }

    // Cumulative net invested from the begin value (+ current value endpoint).
    let cum = begin.value;
    const timeline = flows.map((f) => { cum += f.cents; return { date: f.date, net_invested: centsNumber(cum) }; });

    return {
      account: opts.accountUuid ?? null,
      start_date: startDate,
      end_date: endDate,
      begin_value: centsNumber(begin.value),
      current_value: centsNumber(end.value),
      net_invested: centsNumber(netInvestedCents),
      total_contributed: centsNumber(totalContributed),
      total_distributed: centsNumber(totalDistributed),
      total_fees: centsNumber(totalFees),
      unpriced_securities: unpriced,
      irr,
      twr,
      total_return: tret,
      annualized_return: annualized,
      timeline,
      note: unpriced > 0
        ? `${unpriced} held securit${unpriced === 1 ? 'y has' : 'ies have'} no price for the period's start or end, so the returns can't be computed. Add a price to see them.`
        : 'IRR is money-weighted; TWR is Modified Dietz. Returns are before standalone fee events. Timeline shows cumulative net invested vs current value (not daily mark-to-market).',
    };
  }
}
