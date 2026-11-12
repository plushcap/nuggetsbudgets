import { describe, it, expect } from 'vitest';
import type { FieldValues } from 'react-hook-form';
import { buyEventSchema, dividendEventSchema, feeEventSchema, priceUpsertSchema, sellEventSchema, spinoffActionSchema, type TaxLot } from '@nuggets/shared';
import {
  buyEventConfig,
  corporateActionConfig,
  dividendEventConfig,
  feeEventConfig,
  priceConfig,
  sellEventConfig,
} from '../investmentEventConfigs';
import { formProblemId, investmentEventProblems, investmentEventResolver, shownFields, type InvestmentEventConfig } from '../investmentEventForm';
import type { SellLookups } from '../SellLotsField';
import type {
  BuyEventFormData,
  CorporateActionFormData,
  DividendEventFormData,
  FeeEventFormData,
  PriceFormData,
  SellEventFormData,
} from '../../../types/forms';
import { pinTimeZone } from '../../../test/timeZone';

/**
 * Each investment event's field config: which fields show for which values,
 * what each refuses (in the pages' words, in the order they're focused), the request each
 * builds, and the shared request schema behind them, which refuses on the field what the
 * field checks let through.
 */

pinTimeZone('UTC', '2026-10-15T12:00:00Z');

const ACCOUNT = '0190a000-0001-7000-8000-000000000001';
const SECURITY = '0190a000-0007-7000-8000-000000000001';
const OTHER = '0190a000-0007-7000-8000-000000000002';
const lot = (n: number, shares: number): TaxLot => ({
  id: n, uuid: `0190a000-0009-7000-8000-00000000000${n}`, account_id: 1, security_id: 1, acquisition_date: '2025-01-02',
  holding_period_start: '2025-01-02', shares_original: shares, shares_remaining: shares, cost_basis_per_share: 100,
  total_cost_basis: shares * 100, is_open: true,
} as TaxLot);

const ids = <T extends FieldValues, C, B>(config: InvestmentEventConfig<T, C, B>, values: T) => shownFields(config.rows, values).map((spec) => spec.id);
const problems = <T extends FieldValues, C, B>(config: InvestmentEventConfig<T, C, B>, values: T, context: C) =>
  investmentEventProblems(config, values, context);

const buy = (overrides: Partial<BuyEventFormData> = {}): BuyEventFormData => ({
  ...buyEventConfig.defaults(new URLSearchParams()),
  account_uuid: ACCOUNT, security_uuid: SECURITY, shares: '10', price_per_share: 12.5,
  ...overrides,
});

describe('buy', () => {
  it('starts empty, dated today, with no fees', () => {
    expect(buyEventConfig.defaults(new URLSearchParams())).toEqual({
      account_uuid: '', security_uuid: '', event_date: '2026-10-15', shares: '', price_per_share: null, fees: 0, adjusted_for_splits: false,
    });
  });

  it('refuses an empty form field by field, in the order shown', () => {
    expect(problems(buyEventConfig, buyEventConfig.defaults(new URLSearchParams()), undefined)).toEqual([
      ['buy-account', 'Choose an investment account.'],
      ['buy-security', 'Choose a security.'],
      ['buy-shares', 'Enter a number.'],
      ['buy-price', 'Enter the price per share.'],
    ]);
  });

  it('refuses fees it cannot read, and takes none as 0', () => {
    expect(problems(buyEventConfig, buy({ fees: Number.NaN }), undefined)).toEqual([
      ['buy-fees', 'Not an amount: enter the fees like 4.95, or leave them empty.'],
    ]);
    expect(problems(buyEventConfig, buy(), undefined)).toEqual([]);
  });

  it('builds the body buyEventSchema takes, the share count as typed', () => {
    const body = buyEventConfig.toRequest(buy({ shares: ' 0.000001 ' }), undefined);
    expect(body).toMatchObject({ shares: '0.000001', price_per_share: 12.5, fees: 0, acquisition_method: 'purchase', dry_run: false });
    expect(buyEventSchema.safeParse(body).success).toBe(true);
  });

  it("refuses on its field what only the request schema catches: a date out of the API's years", () => {
    expect(problems(buyEventConfig, buy({ event_date: '1799-12-31' }), undefined)).toEqual([
      ['buy-date', 'Give a real date, as YYYY-MM-DD, from 1800 to 2999.'],
    ]);
  });

  // A required amount's text the box can't read is NaN in the form (so a reset
  // empties the box), refused as no amount is, in the field's words.
  it('refuses a price it cannot read as no price', () => {
    expect(problems(buyEventConfig, buy({ price_per_share: Number.NaN }), undefined)).toEqual([
      ['buy-price', 'Enter the price per share.'],
    ]);
    expect(problems(priceConfig, { security_uuid: SECURITY, price_date: '2026-10-15', close: Number.NaN }, undefined)).toEqual([
      ['price-close', 'Enter the closing price.'],
    ]);
  });

  // The schema's own text was shown as it is ("Invalid UUID", "price_per_share
  // must be a number between -99999999.9999 and 99999999.9999").
  it("says the request schema's issues for people, by the field's label", () => {
    // A choice the list doesn't have (a link's ?account= that isn't one).
    expect(problems(buyEventConfig, buy({ account_uuid: 'not-an-account' }), undefined)).toEqual([
      ['buy-account', 'Choose the account from the list.'],
    ]);
    expect(problems(buyEventConfig, buy({ price_per_share: 123456789 }), undefined)).toEqual([
      ['buy-price', 'Enter the price per share, up to 99,999,999.9999.'],
    ]);
    expect(problems(buyEventConfig, buy({ fees: -1 }), undefined)).toEqual([
      ['buy-fees', 'Enter the commission / fees, 0 or more.'],
    ]);
    // Past what DECIMAL(12,2) holds: a JSON number had no bound in the schema.
    expect(problems(buyEventConfig, buy({ fees: 1e12 }), undefined)).toEqual([
      ['buy-fees', 'Enter the commission / fees, up to 9,999,999,999.99.'],
    ]);
    expect(problems(buyEventConfig, buy({ shares: '1234567890123' }), undefined)).toEqual([
      ['buy-shares', 'Enter the shares, up to 999,999,999,999.999999.'],
    ]);
  });

  it('refuses a submit through the resolver, by control id, and passes the values once it may go', async () => {
    const resolver = investmentEventResolver(buyEventConfig);
    const refused = await resolver(buy({ security_uuid: '' }), undefined);
    expect(refused.values).toEqual({});
    expect(refused.errors).toEqual({ 'buy-security': { type: 'validate', message: 'Choose a security.' } });
    const taken = await resolver(buy(), undefined);
    expect(taken).toEqual({ values: buy(), errors: {} });
  });
});

describe('sell', () => {
  const lots: SellLookups = { openLots: [lot(1, 10), lot(2, 5)] };
  const sell = (overrides: Partial<SellEventFormData> = {}): SellEventFormData => ({
    ...sellEventConfig.defaults(new URLSearchParams()),
    account_uuid: ACCOUNT, security_uuid: SECURITY, shares: '0.3', price_per_share: 99,
    ...overrides,
  });

  it('shows the lots only for a specific-lots sale', () => {
    expect(ids(sellEventConfig, sell())).toEqual(['sell-account', 'sell-security', 'sell-date', 'sell-method', 'sell-shares', 'sell-price', 'sell-fees', 'sell-adjusted']);
    expect(ids(sellEventConfig, sell({ method: 'specific_id' }))).toContain('sell-lots');
  });

  it("checks each lot's shares, then that they add up to the shares sold, exactly", () => {
    const first = lots.openLots[0]!.uuid;
    const second = lots.openLots[1]!.uuid;
    expect(problems(sellEventConfig, sell({ method: 'specific_id', lot_shares: { [first]: '1e-1' } }), lots)).toEqual([
      [`sell-lot-${first}`, 'Enter a plain number, like 12.5, without an exponent or a sign.'],
      ['sell-lots', "The lots' shares add up to 0; they must add up to the shares sold."],
    ]);
    expect(problems(sellEventConfig, sell({ method: 'specific_id', lot_shares: { [first]: '0.1' } }), lots)).toEqual([
      ['sell-lots', "The lots' shares add up to 0.1; they must add up to the shares sold."],
    ]);
    expect(problems(sellEventConfig, sell({ method: 'specific_id', lot_shares: { [first]: '0.1', [second]: '0.2' } }), lots)).toEqual([]);
    expect(problems(sellEventConfig, sell({ method: 'specific_id' }), { openLots: [] })).toEqual([
      ['sell-lots', 'Choose an account and a security with open lots, then the shares to sell from each.'],
    ]);
  });

  it("sends a specific-lots sale's lots with shares, and no lots for another method", () => {
    const first = lots.openLots[0]!.uuid;
    const body = sellEventConfig.toRequest(sell({ method: 'specific_id', shares: '5', lot_shares: { [first]: '0', [lots.openLots[1]!.uuid]: '5' } }), lots);
    expect(body.specific_lots).toEqual([{ lot_uuid: lots.openLots[1]!.uuid, shares: '5' }]);
    expect(sellEventSchema.safeParse(body).success).toBe(true);
    expect(sellEventConfig.toRequest(sell({ lot_shares: { [first]: '5' } }), lots).specific_lots).toBeUndefined();
  });
});

describe('dividend', () => {
  const dividend = (overrides: Partial<DividendEventFormData> = {}): DividendEventFormData => ({
    ...dividendEventConfig.defaults(new URLSearchParams()),
    account_uuid: ACCOUNT, security_uuid: SECURITY, total_amount: 25,
    ...overrides,
  });

  it('asks for a reinvestment price only when reinvested', () => {
    expect(ids(dividendEventConfig, dividend())).not.toContain('dividend-price');
    expect(problems(dividendEventConfig, dividend(), undefined)).toEqual([]);
    expect(ids(dividendEventConfig, dividend({ reinvest: true }))).toContain('dividend-price');
    expect(problems(dividendEventConfig, dividend({ reinvest: true }), undefined)).toEqual([
      ['dividend-price', 'Enter the price the dividend was reinvested at, more than 0.'],
    ]);
  });

  it('refuses a total of 0, and sends no price unless reinvested', () => {
    expect(problems(dividendEventConfig, dividend({ total_amount: 0 }), undefined)).toEqual([
      ['dividend-total', 'Enter the total amount paid, more than 0.'],
    ]);
    const body = dividendEventConfig.toRequest(dividend({ price_per_share: 3 }), undefined);
    expect(body).toMatchObject({ reinvest: false, price_per_share: null, is_qualified: true });
    expect(dividendEventSchema.safeParse(body).success).toBe(true);
  });

  it('asks whether the reinvestment price is adjusted for later splits only when reinvested, and sends it only then', () => {
    expect(ids(dividendEventConfig, dividend())).not.toContain('dividend-adjusted');
    expect(ids(dividendEventConfig, dividend({ reinvest: true }))).toContain('dividend-adjusted');
    expect(dividendEventConfig.toRequest(dividend({ adjusted_for_splits: true }), undefined)).toMatchObject({ reinvest: false, adjusted_for_splits: false });
    expect(dividendEventConfig.toRequest(dividend({ reinvest: true, price_per_share: 3, adjusted_for_splits: true }), undefined)).toMatchObject({ reinvest: true, adjusted_for_splits: true });
  });
});

describe('fee', () => {
  const fee = (overrides: Partial<FeeEventFormData> = {}): FeeEventFormData => ({
    ...feeEventConfig.defaults(new URLSearchParams()),
    account_uuid: ACCOUNT, amount: 10,
    ...overrides,
  });

  it('is on the account as a whole until a security is chosen', () => {
    expect(feeEventConfig.toRequest(fee(), undefined)).toMatchObject({ security_uuid: null, fee_type: 'advisory', description: null });
    const body = feeEventConfig.toRequest(fee({ security_uuid: SECURITY, description: 'Q1' }), undefined);
    expect(body).toMatchObject({ security_uuid: SECURITY, description: 'Q1' });
    expect(feeEventSchema.safeParse(body).success).toBe(true);
  });

  it('offers no expense-ratio drag, which the costs report estimates', () => {
    const typeField = shownFields(feeEventConfig.rows, fee()).find((spec) => spec.id === 'fee-type');
    const offered = typeField?.kind === 'select' ? typeField.options({ accounts: [], securities: [] }, fee()).map((o) => o.value) : [];
    expect(offered).toContain('advisory');
    expect(offered).not.toContain('expense_ratio_drag');
  });

  it('refuses a fee of 0', () => {
    expect(problems(feeEventConfig, fee({ amount: 0 }), undefined)).toEqual([['fee-amount', 'Enter the fee, more than 0.']]);
  });
});

describe('price', () => {
  it('starts on the security its link names', () => {
    expect(priceConfig.defaults(new URLSearchParams(`security=${SECURITY}`))).toEqual({ security_uuid: SECURITY, price_date: '2026-10-15', close: null });
  });

  it("refuses on the close a price past the API's column, which only the request schema knows", () => {
    const values: PriceFormData = { security_uuid: SECURITY, price_date: '2026-10-15', close: 123456789 };
    expect(problems(priceConfig, values, undefined)).toEqual([['price-close', 'Enter the close price, up to 99,999,999.9999.']]);
    expect(priceUpsertSchema.safeParse(priceConfig.toRequest(values, undefined)).success).toBe(false);
    expect(problems(priceConfig, { ...values, close: 12345678.1234 }, undefined)).toEqual([]);
  });
});

describe('corporate actions', () => {
  const action = (overrides: Partial<CorporateActionFormData> = {}): CorporateActionFormData => ({
    ...corporateActionConfig.defaults(new URLSearchParams()),
    security_uuid: SECURITY,
    ...overrides,
  });

  it.each([
    ['split', ['ca-security', 'ca-action', 'ca-date', 'split-numerator', 'split-denominator']],
    ['reverse_split', ['ca-security', 'ca-action', 'ca-date', 'split-numerator', 'split-denominator']],
    ['return_of_capital', ['ca-security', 'ca-action', 'ca-date', 'ca-amount']],
    ['merger_cash', ['ca-security', 'ca-action', 'ca-date', 'ca-amount']],
    ['spinoff', ['ca-security', 'ca-action', 'ca-date', 'ca-other', 'spinoff-allocation', 'spinoff-ratio']],
    ['merger_stock', ['ca-security', 'ca-action', 'ca-date', 'ca-other', 'merger-ratio']],
  ] as const)('shows a %s its own fields', (type, fields) => {
    expect(ids(corporateActionConfig, action({ action_type: type }))).toEqual(fields);
  });

  it("names the other security by the action, and doesn't offer the source itself", () => {
    const other = shownFields(corporateActionConfig.rows, action({ action_type: 'merger_stock' })).find((spec) => spec.id === 'ca-other');
    expect(other?.kind).toBe('select');
    if (other?.kind !== 'select') return;
    const lists = { accounts: [], securities: [{ uuid: SECURITY, ticker: 'A', name: 'A' }, { uuid: OTHER, ticker: 'B', name: 'B' }] } as never;
    expect(other.options(lists, action({ action_type: 'merger_stock' })).map((o) => o.value)).toEqual([OTHER]);
    expect(problems(corporateActionConfig, action({ action_type: 'merger_stock' }), undefined)).toEqual([['ca-other', 'Choose the acquirer.']]);
    expect(problems(corporateActionConfig, action({ action_type: 'spinoff' }), undefined)).toEqual([['ca-other', 'Choose the new security.']]);
  });

  it("refuses a return of capital of 0, and takes a cash merger's", () => {
    expect(problems(corporateActionConfig, action({ action_type: 'return_of_capital', amount_per_share: 0 }), undefined)).toEqual([
      ['ca-amount', 'Enter an amount above zero.'],
    ]);
    expect(problems(corporateActionConfig, action({ action_type: 'merger_cash', amount_per_share: 0 }), undefined)).toEqual([]);
  });

  it("checks the spinoff's basis share as it is typed, and sends it as the exact fraction", () => {
    const allocation = shownFields(corporateActionConfig.rows, action({ action_type: 'spinoff' })).find((spec) => spec.id === 'spinoff-allocation');
    expect(allocation?.kind === 'decimal' && allocation.live).toBe(true);
    const spinoff = action({ action_type: 'spinoff', other_security_uuid: OTHER, allocation_percent: '14.3' });
    expect(problems(corporateActionConfig, { ...spinoff, allocation_percent: '14.33333' }, undefined)).toEqual([
      ['spinoff-allocation', 'Enter at most 4 decimal places.'],
    ]);
    expect(problems(corporateActionConfig, { ...spinoff, allocation_percent: '120' }, undefined)).toEqual([
      ['spinoff-allocation', 'Enter a percentage from 0 to 100.'],
    ]);
    const body = corporateActionConfig.toRequest(spinoff, undefined);
    expect(body).toEqual({ source_security_uuid: SECURITY, new_security_uuid: OTHER, action_date: '2026-10-15', allocation_fraction: '0.143', share_ratio: '2' });
    expect(spinoffActionSchema.safeParse(body).success).toBe(true);
  });

  it('keeps one ratio across the split, the spinoff and the stock merger', () => {
    const values = action({ numerator: '1.5', other_security_uuid: OTHER });
    expect(corporateActionConfig.toRequest({ ...values, action_type: 'split' }, undefined)).toMatchObject({ numerator: '1.5' });
    expect(corporateActionConfig.toRequest({ ...values, action_type: 'spinoff' }, undefined)).toMatchObject({ share_ratio: '1.5' });
    expect(corporateActionConfig.toRequest({ ...values, action_type: 'merger_stock' }, undefined)).toMatchObject({ exchange_ratio: '1.5' });
  });

  it("puts a request schema issue on the field it names, or on the form when no shown field has it", () => {
    // A ratio past NUMERIC(18,6)'s 12 whole digits: the field's check takes it, the schema doesn't.
    const huge = action({ action_type: 'merger_stock', other_security_uuid: OTHER, numerator: '1234567890123' });
    expect(problems(corporateActionConfig, huge, undefined)).toEqual([['merger-ratio', 'Enter the exchange ratio, up to 999,999,999,999.999999.']]);
    // The other security, by the label it has for the action.
    expect(problems(corporateActionConfig, { ...huge, numerator: '2', other_security_uuid: 'not-a-security' }, undefined)).toEqual([
      ['ca-other', 'Choose the acquirer security from the list.'],
    ]);
    expect(problems(corporateActionConfig, { ...huge, numerator: '123456789012' }, undefined)).toEqual([]);
  });

  it('puts a request schema issue no shown field has on the form as a whole', () => {
    // A body key no field edits (a volume that isn't a whole number).
    const config: typeof priceConfig = { ...priceConfig, toRequest: (v, c) => ({ ...priceConfig.toRequest(v, c), volume: 1.5 }) };
    const values: PriceFormData = { security_uuid: SECURITY, price_date: '2026-10-15', close: 10 };
    expect(problems(config, values, undefined)).toEqual([[formProblemId('price'), expect.stringContaining('volume')]]);
  });
});
