import { useMemo } from 'react';
import type { FieldValues, Path } from 'react-hook-form';
import { Coins, DollarSign, GitFork, Minus, Plus, Receipt } from 'lucide-react';
import {
  buyEventSchema,
  dividendEventSchema,
  feeEventSchema,
  mergerCashSchema,
  mergerStockSchema,
  priceUpsertSchema,
  returnOfCapitalSchema,
  sellEventSchema,
  spinoffActionSchema,
  splitActionSchema,
  ADJUSTED_FOR_SPLITS_LABELS,
  COST_BASIS_METHODS,
  COST_BASIS_METHOD_LABELS,
  CORPORATE_ACTION_TYPES,
  CORPORATE_ACTION_TYPE_LABELS,
  FEE_TYPES,
  FEE_TYPE_LABELS,
  type BuyEventInput,
  type DividendEventInput,
  type FeeEventInput,
  type FeeType,
  type MergerCashInput,
  type MergerStockInput,
  type PriceUpsertInput,
  type ReturnOfCapitalInput,
  type SellEventInput,
  type SpinoffActionInput,
  type SplitActionInput,
  accountGroup,
  accountType,
  corporateActionType,
  costBasisMethod,
} from '@nuggets/shared';
import {
  useApplyMergerCashMutation,
  useApplyMergerStockMutation,
  useApplyReturnOfCapitalMutation,
  useApplySpinoffMutation,
  useApplySplitMutation,
  useLotsQuery,
  useRecordBuyMutation,
  useRecordDividendMutation,
  useRecordFeeMutation,
  useRecordSellMutation,
  useUpsertPriceMutation,
} from '../../hooks/queries/investments';
import {
  ACCOUNT_LEVEL_FEE,
  createDefaultBuyEventForm,
  createDefaultCorporateActionForm,
  createDefaultDividendEventForm,
  createDefaultFeeEventForm,
  createDefaultPriceForm,
  createDefaultSellEventForm,
  type BuyEventFormData,
  type CorporateActionFormData,
  type DividendEventFormData,
  type FeeEventFormData,
  type PriceFormData,
  type SellEventFormData,
} from '../../types/forms';
import { decimalPlaces, decimalTextProblem, decimalUnits, percentToFraction, unitsText } from '../../utils/decimalText';
import { EMPTY_LIST } from '../../utils/emptyList';
import { isUnreadableAmount } from '../forms/optionalAmount';
import type { AmountSpec, DateSpec, DecimalSpec, InvestmentEventConfig, Option, OptionLists, SelectSpec, SwitchSpec } from './investmentEventForm';
import SellLotsField, { SELL_LOTS_ID, SHARE_PLACES, lotFieldId, lotTally, type SellLookups } from './SellLotsField';

/**
 * Each investment event's field config for InvestmentEventForm: its fields,
 * their problems in the pages' own words, the request it sends (exactly what each page sent
 * on its own form) and the `@nuggets/shared` schema the route checks that with.
 */

/** Ratios are kept to 6 decimal places. */
const RATIO_PLACES = 6;

// --- fields more than one event has ------------------------------------------

const investmentAccounts = (lists: OptionLists): Option[] =>
  lists.accounts
    .filter((a) => a.account_type === accountType.enum.investment || a.account_group === accountGroup.enum.investments)
    .map((a) => ({ value: a.uuid, label: a.name }));

const securityOptions = (lists: OptionLists): Option[] => lists.securities.map((s) => ({ value: s.uuid, label: `${s.ticker} — ${s.name}` }));

const accountField = <T extends FieldValues & { account_uuid: string }, C>(id: string): SelectSpec<T, C> => ({
  kind: 'select',
  id,
  name: 'account_uuid' as Path<T>,
  label: 'Account',
  placeholder: 'Select an investment account',
  options: investmentAccounts,
  problem: (v) => (v.account_uuid ? null : 'Choose an investment account.'),
});

const securityField = <T extends FieldValues & { security_uuid: string }, C>(id: string): SelectSpec<T, C> => ({
  kind: 'select',
  id,
  name: 'security_uuid' as Path<T>,
  label: 'Security',
  placeholder: 'Select a security',
  options: securityOptions,
  problem: (v) => (v.security_uuid ? null : 'Choose a security.'),
});

const dateField = <T extends FieldValues, C>(id: string, name: Path<T>, label = 'Date'): DateSpec<T, C> => ({ kind: 'date', id, name, label });

/** A share count: a plain decimal, above zero (a number field takes 1e2, which the API refuses). */
const sharesField = <T extends FieldValues & { shares: string }, C>(id: string): DecimalSpec<T, C> => ({
  kind: 'decimal',
  id,
  name: 'shares' as Path<T>,
  label: 'Shares',
  step: '0.000001',
  placeholder: '100',
  problem: (v) => decimalTextProblem(v.shares, SHARE_PLACES),
});

/** A trade's price per share, to 4 decimal places as the API keeps it. */
const tradePriceField = <T extends FieldValues & { price_per_share: number | null }, C>(id: string): AmountSpec<T, C> => ({
  kind: 'amount',
  id,
  name: 'price_per_share' as Path<T>,
  label: 'Price per share',
  decimals: 4,
  problem: (v) => (v.price_per_share != null ? null : 'Enter the price per share.'),
});

/** A trade's fees: optional, so empty is no fees; text it can't read is refused, not sent as 0. */
const feesField = <T extends FieldValues & { fees: number }, C>(id: string): AmountSpec<T, C> => ({
  kind: 'amount',
  id,
  name: 'fees' as Path<T>,
  label: 'Commission / fees (optional)',
  decimals: 2,
  optional: true,
  problem: (v) => (isUnreadableAmount(v.fees) ? 'Not an amount: enter the fees like 4.95, or leave them empty.' : null),
});

const noLookups = (): undefined => undefined;

/**
 * Backfilling behind a split: the shares and price as a broker's history gives
 * them today, after the splits recorded since the event's date. The API records them as given and
 * doesn't apply those splits again; without it, an event dated before a recorded split is refused.
 */
const adjustedForSplitsField = <T extends FieldValues & { adjusted_for_splits: boolean }, C>(
  id: string,
  label: string = ADJUSTED_FOR_SPLITS_LABELS.trade,
  note = 'For an event dated before a split recorded here: enter the shares and price as your broker shows them today, after the split. The split isn\'t applied to them again.',
): SwitchSpec<T, C> => ({ kind: 'switch', id, name: 'adjusted_for_splits' as Path<T>, label, note });

// --- buy -----------------------------------------------------------------------

function useSendBuy() {
  const { mutateAsync } = useRecordBuyMutation();
  return (body: Parameters<typeof mutateAsync>[0]) => mutateAsync(body);
}

/** Manual buy entry. Bulk/CSV imports are handled by AI agents via MCP, not here. */
export const buyEventConfig: InvestmentEventConfig<BuyEventFormData, undefined, BuyEventInput> = {
  id: 'buy',
  title: 'Record buy',
  icon: <Plus />,
  backPath: '/investments',
  submitLabel: 'Record buy',
  successMessage: 'Buy recorded',
  failureMessage: 'Failed to record buy',
  defaults: createDefaultBuyEventForm,
  accounts: true,
  rows: [
    accountField('buy-account'),
    securityField('buy-security'),
    [dateField('buy-date', 'event_date'), sharesField('buy-shares')],
    [tradePriceField('buy-price'), feesField('buy-fees')],
    adjustedForSplitsField('buy-adjusted'),
  ],
  useLookups: noLookups,
  toRequest: (v) => ({
    account_uuid: v.account_uuid,
    security_uuid: v.security_uuid,
    event_date: v.event_date,
    // As typed: the API reads it exactly, to 6 places (a number can't carry 18 digits).
    shares: v.shares.trim(),
    price_per_share: v.price_per_share as number,
    fees: v.fees,
    acquisition_method: 'purchase',
    source: 'manual',
    adjusted_for_splits: v.adjusted_for_splits,
    dry_run: false,
  }),
  requestSchema: () => buyEventSchema,
  useSend: useSendBuy,
};

// --- sell ----------------------------------------------------------------------

function useSellLookups(values: SellEventFormData): SellLookups {
  const specific = values.method === costBasisMethod.enum.specific_id;
  const { data: lots = EMPTY_LIST } = useLotsQuery(specific && values.security_uuid ? values.security_uuid : undefined, values.account_uuid || undefined);
  return useMemo(() => ({ openLots: lots.filter((lot) => lot.is_open) }), [lots]);
}

function useSendSell() {
  const { mutateAsync } = useRecordSellMutation();
  return (body: Parameters<typeof mutateAsync>[0]) => mutateAsync(body);
}

const sellsSpecificLots = (v: SellEventFormData) => v.method === costBasisMethod.enum.specific_id;

export const sellEventConfig: InvestmentEventConfig<SellEventFormData, SellLookups, SellEventInput> = {
  id: 'sell',
  title: 'Record sell',
  icon: <Minus />,
  backPath: '/investments',
  submitLabel: 'Record sell',
  successMessage: 'Sell recorded',
  failureMessage: 'Failed to record sell',
  defaults: createDefaultSellEventForm,
  accounts: true,
  rows: [
    accountField('sell-account'),
    securityField('sell-security'),
    [
      dateField('sell-date', 'event_date'),
      {
        kind: 'select',
        id: 'sell-method',
        name: 'method',
        label: 'Cost basis method',
        options: () => COST_BASIS_METHODS.map((m) => ({ value: m, label: COST_BASIS_METHOD_LABELS[m] })),
      },
    ],
    [sharesField('sell-shares'), tradePriceField('sell-price')],
    feesField('sell-fees'),
    adjustedForSplitsField('sell-adjusted'),
    {
      kind: 'custom',
      id: SELL_LOTS_ID,
      when: sellsSpecificLots,
      // Each lot's shares, then whether they add up to the shares sold, exactly.
      problems: (v, { openLots }) => {
        const { picks, pickedUnits, lotsAddUp } = lotTally(v, openLots);
        return [
          ...picks.map(({ lot, text }) => [lotFieldId(lot.uuid), text === '' ? null : decimalTextProblem(text, SHARE_PLACES, { allowZero: true })] as const),
          [
            SELL_LOTS_ID,
            openLots.length === 0
              ? 'Choose an account and a security with open lots, then the shares to sell from each.'
              : lotsAddUp ? null : `The lots' shares add up to ${unitsText(pickedUnits, SHARE_PLACES)}; they must add up to the shares sold.`,
          ] as const,
        ];
      },
      render: (props) => <SellLotsField {...props} />,
    },
  ],
  useLookups: useSellLookups,
  toRequest: (v, { openLots }) => ({
    account_uuid: v.account_uuid,
    security_uuid: v.security_uuid,
    event_date: v.event_date,
    // As typed: the API reads share counts exactly, to 6 places (a number can't carry 18 digits).
    shares: v.shares.trim(),
    price_per_share: v.price_per_share as number,
    fees: v.fees,
    method: v.method,
    specific_lots: sellsSpecificLots(v)
      ? lotTally(v, openLots).picks
        .filter(({ text }) => (decimalUnits(text, SHARE_PLACES) ?? 0n) > 0n)
        .map(({ lot, text }) => ({ lot_uuid: lot.uuid, shares: text }))
      : undefined,
    source: 'manual',
    adjusted_for_splits: v.adjusted_for_splits,
    dry_run: false,
  }),
  requestSchema: () => sellEventSchema,
  requestFields: { specific_lots: SELL_LOTS_ID },
  useSend: useSendSell,
};

// --- dividend ------------------------------------------------------------------

function useSendDividend() {
  const { mutateAsync } = useRecordDividendMutation();
  return (body: Parameters<typeof mutateAsync>[0]) => mutateAsync(body);
}

export const dividendEventConfig: InvestmentEventConfig<DividendEventFormData, undefined, DividendEventInput> = {
  id: 'dividend',
  title: 'Record dividend',
  icon: <Coins />,
  backPath: '/investments',
  submitLabel: 'Record dividend',
  successMessage: 'Dividend recorded',
  failureMessage: 'Failed to record dividend',
  defaults: createDefaultDividendEventForm,
  accounts: true,
  rows: [
    accountField('dividend-account'),
    securityField('dividend-security'),
    [
      dateField('dividend-date', 'event_date'),
      {
        kind: 'amount',
        id: 'dividend-total',
        name: 'total_amount',
        label: 'Total amount',
        decimals: 2,
        problem: (v) => (v.total_amount != null && v.total_amount > 0 ? null : 'Enter the total amount paid, more than 0.'),
      },
    ],
    { kind: 'switch', id: 'dividend-qualified', name: 'is_qualified', label: 'Qualified dividend' },
    { kind: 'switch', id: 'dividend-reinvest', name: 'reinvest', label: 'Reinvest (DRIP) — creates a new lot' },
    {
      kind: 'amount',
      id: 'dividend-price',
      name: 'price_per_share',
      label: 'Reinvestment price per share',
      decimals: 4,
      when: (v) => v.reinvest,
      problem: (v) => (v.price_per_share != null && v.price_per_share > 0 ? null : 'Enter the price the dividend was reinvested at, more than 0.'),
    },
    {
      ...adjustedForSplitsField<DividendEventFormData, undefined>(
        'dividend-adjusted',
        ADJUSTED_FOR_SPLITS_LABELS.reinvestment,
        'For a dividend reinvested before a split recorded here: enter the price as your broker shows it today, after the split. The split isn\'t applied to the shares it bought again.',
      ),
      when: (v) => v.reinvest,
    },
  ],
  useLookups: noLookups,
  toRequest: (v) => ({
    account_uuid: v.account_uuid,
    security_uuid: v.security_uuid,
    event_date: v.event_date,
    total_amount: v.total_amount as number,
    is_qualified: v.is_qualified,
    reinvest: v.reinvest,
    price_per_share: v.reinvest ? (v.price_per_share as number) : null,
    source: 'manual',
    adjusted_for_splits: v.reinvest && v.adjusted_for_splits,
    dry_run: false,
  }),
  requestSchema: () => dividendEventSchema,
  useSend: useSendDividend,
};

// --- fee -----------------------------------------------------------------------

// Every fee type but the expense-ratio drag, which the costs report estimates from each fund's
// expense ratio (FeeService) rather than reading it from a recorded fee.
export const RECORDED_FEE_TYPES: FeeType[] = FEE_TYPES.filter((t) => t !== 'expense_ratio_drag');

function useSendFee() {
  const { mutateAsync } = useRecordFeeMutation();
  return (body: Parameters<typeof mutateAsync>[0]) => mutateAsync(body);
}

export const feeEventConfig: InvestmentEventConfig<FeeEventFormData, undefined, FeeEventInput> = {
  id: 'fee',
  title: 'Record fee',
  subtitle: 'Advisory, account, and other charges (commissions on trades are captured by buy/sell)',
  icon: <Receipt />,
  backPath: '/investments/costs',
  submitLabel: 'Record fee',
  successMessage: 'Fee recorded',
  failureMessage: 'Failed to record fee',
  defaults: createDefaultFeeEventForm,
  accounts: true,
  rows: [
    accountField('fee-account'),
    [
      {
        kind: 'select',
        id: 'fee-type',
        name: 'fee_type',
        label: 'Fee type',
        options: () => RECORDED_FEE_TYPES.map((t) => ({ value: t, label: FEE_TYPE_LABELS[t] })),
      },
      {
        kind: 'select',
        id: 'fee-security',
        name: 'security_uuid',
        label: 'Security (optional)',
        options: (lists) => [
          { value: ACCOUNT_LEVEL_FEE, label: 'Account-level (no security)' },
          ...lists.securities.map((s) => ({ value: s.uuid, label: s.ticker })),
        ],
      },
    ],
    [
      {
        kind: 'amount',
        id: 'fee-amount',
        name: 'amount',
        label: 'Amount',
        decimals: 2,
        problem: (v) => (v.amount != null && v.amount > 0 ? null : 'Enter the fee, more than 0.'),
      },
      dateField('fee-date', 'event_date'),
    ],
    { kind: 'text', id: 'fee-description', name: 'description', label: 'Description (optional)', placeholder: 'e.g. Q1 advisory fee' },
  ],
  useLookups: noLookups,
  toRequest: (v) => ({
    account_uuid: v.account_uuid,
    security_uuid: v.security_uuid === ACCOUNT_LEVEL_FEE ? null : v.security_uuid,
    fee_type: v.fee_type,
    amount: v.amount as number,
    event_date: v.event_date,
    description: v.description || null,
    source: 'manual',
  }),
  requestSchema: () => feeEventSchema,
  useSend: useSendFee,
};

// --- price ---------------------------------------------------------------------

function useSendPrice() {
  const { mutateAsync } = useUpsertPriceMutation();
  return (body: Parameters<typeof mutateAsync>[0]) => mutateAsync(body);
}

/** Manual EOD price entry (custom securities / one-off corrections). Bulk price refresh is an agent/MCP job per the MCP-first design. */
export const priceConfig: InvestmentEventConfig<PriceFormData, undefined, PriceUpsertInput> = {
  id: 'price',
  title: 'Add price',
  subtitle: 'Manual end-of-day price entry',
  icon: <DollarSign />,
  backPath: '/investments/securities',
  submitLabel: 'Save price',
  successMessage: 'Price saved',
  failureMessage: 'Failed to save price',
  // ?security=<uuid> chooses the security (from its page's "Add price").
  defaults: (params) => createDefaultPriceForm(params.get('security') ?? ''),
  allSecurities: true,
  rows: [
    securityField('price-security'),
    [
      dateField('price-date', 'price_date'),
      {
        kind: 'amount',
        id: 'price-close',
        name: 'close',
        label: 'Close price',
        decimals: 4,
        problem: (v) => (v.close != null ? null : 'Enter the closing price.'),
      },
    ],
  ],
  useLookups: noLookups,
  toRequest: (v) => ({ security_uuid: v.security_uuid, price_date: v.price_date, close: v.close as number, source: 'mcp_manual' }),
  requestSchema: () => priceUpsertSchema,
  useSend: useSendPrice,
};

// --- corporate actions ---------------------------------------------------------

type CorporateActionRequest = SplitActionInput | ReturnOfCapitalInput | SpinoffActionInput | MergerCashInput | MergerStockInput;

const isSplit = (v: CorporateActionFormData) => v.action_type === corporateActionType.enum.split || v.action_type === corporateActionType.enum.reverse_split;
const needsOther = (v: CorporateActionFormData) => v.action_type === corporateActionType.enum.spinoff || v.action_type === corporateActionType.enum.merger_stock;
const hasAmount = (v: CorporateActionFormData) => v.action_type === corporateActionType.enum.return_of_capital || v.action_type === corporateActionType.enum.merger_cash;
const isSpinoff = (v: CorporateActionFormData) => v.action_type === corporateActionType.enum.spinoff;

/**
 * The spinoff's basis share, as the exact fraction the API reads to 6 places: sent as
 * text, so 14.3% is 0.143 (Number(14.3) / 100 was 0.14300000000000002, which it refused).
 */
export function allocationProblem(percent: string): string | null {
  const fraction = percentToFraction(percent);
  if (fraction === null || Number(fraction) > 1) return 'Enter a percentage from 0 to 100.';
  return decimalPlaces(fraction) > 6 ? 'Enter at most 4 decimal places.' : null;
}

/** A ratio box: a plain decimal, above zero, kept to 6 places. */
const ratioProblem = (v: CorporateActionFormData) => decimalTextProblem(v.numerator, RATIO_PLACES);

function useSendCorporateAction() {
  const split = useApplySplitMutation().mutateAsync;
  const roc = useApplyReturnOfCapitalMutation().mutateAsync;
  const spinoff = useApplySpinoffMutation().mutateAsync;
  const mergerCash = useApplyMergerCashMutation().mutateAsync;
  const mergerStock = useApplyMergerStockMutation().mutateAsync;
  return (body: CorporateActionRequest, v: CorporateActionFormData): Promise<unknown> => {
    if (isSplit(v)) return split(body as SplitActionInput);
    if (v.action_type === corporateActionType.enum.return_of_capital) return roc(body as ReturnOfCapitalInput);
    if (v.action_type === corporateActionType.enum.spinoff) return spinoff(body as Parameters<typeof spinoff>[0]);
    if (v.action_type === corporateActionType.enum.merger_cash) return mergerCash(body as Parameters<typeof mergerCash>[0]);
    return mergerStock(body as Parameters<typeof mergerStock>[0]);
  };
}

export const corporateActionConfig: InvestmentEventConfig<CorporateActionFormData, undefined, CorporateActionRequest> = {
  id: 'ca',
  title: 'Corporate action',
  subtitle: 'Split, return of capital, spinoff, or merger across all open lots',
  icon: <GitFork />,
  backPath: '/investments',
  submitLabel: 'Apply',
  successMessage: 'Corporate action applied',
  failureMessage: 'Failed to apply corporate action',
  defaults: createDefaultCorporateActionForm,
  rows: [
    [
      securityField('ca-security'),
      {
        kind: 'select',
        id: 'ca-action',
        name: 'action_type',
        label: 'Action',
        options: () => CORPORATE_ACTION_TYPES.map((t) => ({ value: t, label: CORPORATE_ACTION_TYPE_LABELS[t] })),
      },
    ],
    dateField('ca-date', 'action_date', 'Effective date'),
    {
      kind: 'select',
      id: 'ca-other',
      name: 'other_security_uuid',
      label: (v) => (v.action_type === corporateActionType.enum.spinoff ? 'New (spun-off) security' : 'Acquirer security'),
      placeholder: 'Select a security',
      when: needsOther,
      options: (lists, v) => securityOptions(lists).filter((option) => option.value !== v.security_uuid),
      problem: (v) => (v.other_security_uuid ? null : v.action_type === corporateActionType.enum.spinoff ? 'Choose the new security.' : 'Choose the acquirer.'),
    },
    {
      kind: 'ratio',
      id: 'split-ratio',
      label: 'Ratio (new : old shares)',
      when: isSplit,
      parts: [
        { kind: 'decimal', id: 'split-numerator', name: 'numerator', label: 'New shares', labelHidden: true, step: '0.000001', problem: ratioProblem },
        {
          kind: 'decimal', id: 'split-denominator', name: 'denominator', label: 'Old shares', labelHidden: true, step: '0.000001',
          problem: (v) => decimalTextProblem(v.denominator, RATIO_PLACES),
        },
      ],
      note: 'e.g. 4 : 1 = a 4-for-1 split. Total basis preserved.',
    },
    {
      kind: 'amount',
      id: 'ca-amount',
      name: 'amount_per_share',
      // An amount per share keeps 4 decimal places.
      decimals: 4,
      label: (v) => (v.action_type === corporateActionType.enum.return_of_capital ? 'Return of capital per share' : 'Cash per share'),
      when: hasAmount,
      problem: (v) => {
        if (v.action_type === corporateActionType.enum.return_of_capital) {
          return v.amount_per_share == null ? 'Enter the return of capital per share.' : v.amount_per_share > 0 ? null : 'Enter an amount above zero.';
        }
        return v.amount_per_share == null ? 'Enter the cash per share.' : null;
      },
      note: (v) => (v.action_type === corporateActionType.enum.return_of_capital
        ? 'Reduces per-share basis; below zero becomes long-term gain.'
        : 'Closes all open lots with realized gain/loss vs. cash proceeds.'),
    },
    [
      {
        kind: 'decimal',
        id: 'spinoff-allocation',
        name: 'allocation_percent',
        label: 'Basis allocated to new security (%)',
        step: '0.01',
        max: '100',
        when: isSpinoff,
        // Shown as typed.
        live: true,
        problem: (v) => allocationProblem(v.allocation_percent),
      },
      { kind: 'decimal', id: 'spinoff-ratio', name: 'numerator', label: 'New shares per source share', step: '0.000001', when: isSpinoff, problem: ratioProblem },
    ],
    {
      kind: 'decimal',
      id: 'merger-ratio',
      name: 'numerator',
      label: 'Exchange ratio (acquirer shares per source share)',
      step: '0.000001',
      when: (v) => v.action_type === corporateActionType.enum.merger_stock,
      problem: ratioProblem,
    },
  ],
  useLookups: noLookups,
  toRequest: (v): CorporateActionRequest => {
    // Ratios go as typed: the API reads them exactly, to 6 places.
    const ratio = v.numerator.trim();
    if (isSplit(v)) {
      return { security_uuid: v.security_uuid, action_date: v.action_date, numerator: ratio, denominator: v.denominator.trim(), reverse: v.action_type === corporateActionType.enum.reverse_split, dry_run: false };
    }
    if (v.action_type === corporateActionType.enum.return_of_capital) {
      return { security_uuid: v.security_uuid, action_date: v.action_date, amount_per_share: v.amount_per_share as number, dry_run: false };
    }
    if (v.action_type === corporateActionType.enum.spinoff) {
      return {
        source_security_uuid: v.security_uuid,
        new_security_uuid: v.other_security_uuid,
        action_date: v.action_date,
        allocation_fraction: percentToFraction(v.allocation_percent) as string,
        share_ratio: ratio,
      } as SpinoffActionInput;
    }
    if (v.action_type === corporateActionType.enum.merger_cash) {
      return { security_uuid: v.security_uuid, action_date: v.action_date, cash_per_share: v.amount_per_share as number } as MergerCashInput;
    }
    return { security_uuid: v.security_uuid, acquirer_security_uuid: v.other_security_uuid, action_date: v.action_date, exchange_ratio: ratio } as MergerStockInput;
  },
  requestSchema: (v) => {
    if (isSplit(v)) return splitActionSchema;
    if (v.action_type === corporateActionType.enum.return_of_capital) return returnOfCapitalSchema;
    if (v.action_type === corporateActionType.enum.spinoff) return spinoffActionSchema;
    if (v.action_type === corporateActionType.enum.merger_cash) return mergerCashSchema;
    return mergerStockSchema;
  },
  requestFields: {
    source_security_uuid: 'ca-security',
    new_security_uuid: 'ca-other',
    acquirer_security_uuid: 'ca-other',
    amount_per_share: 'ca-amount',
    cash_per_share: 'ca-amount',
    allocation_fraction: 'spinoff-allocation',
    share_ratio: 'spinoff-ratio',
    exchange_ratio: 'merger-ratio',
    numerator: 'split-numerator',
    denominator: 'split-denominator',
  },
  useSend: useSendCorporateAction,
};
