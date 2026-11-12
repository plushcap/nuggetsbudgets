import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import RecordBuyPage from '../RecordBuyPage';
import RecordSellPage from '../RecordSellPage';
import RecordDividendPage from '../RecordDividendPage';
import RecordFeePage from '../RecordFeePage';
import CorporateActionPage from '../CorporateActionPage';
import AddPricePage from '../AddPricePage';

const { list, mutation } = vi.hoisted(() => ({
  list: () => ({ data: [], isLoading: false }),
  mutation: () => ({ mutateAsync: () => Promise.resolve(), isPending: false }),
}));
vi.mock('../../hooks/queries/accounts', () => ({ useAccountsQuery: list }));
vi.mock('../../hooks/queries/investments', () => ({
  useSecuritiesQuery: list,
  useLotsQuery: list,
  useRecordBuyMutation: mutation,
  useRecordSellMutation: mutation,
  useRecordDividendMutation: mutation,
  useRecordFeeMutation: mutation,
  useApplySplitMutation: mutation,
  useApplyReturnOfCapitalMutation: mutation,
  useApplySpinoffMutation: mutation,
  useApplyMergerCashMutation: mutation,
  useApplyMergerStockMutation: mutation,
  useUpsertPriceMutation: mutation,
}));

const pages: [string, React.FC][] = [
  ['RecordBuyPage', RecordBuyPage],
  ['RecordSellPage', RecordSellPage],
  ['RecordDividendPage', RecordDividendPage],
  ['RecordFeePage', RecordFeePage],
  ['CorporateActionPage', CorporateActionPage],
  ['AddPricePage', AddPricePage],
];

// The date picker's "today" default is the user's local day.
describe('investment entry pages, 9:30 pm on Oct 31 in Los Angeles (Nov 1 in UTC)', () => {
  pinTimeZone('America/Los_Angeles', '2026-10-31T21:30:00-07:00');

  it.each(pages)('%s defaults the date to Oct 31', (_name, Page) => {
    renderWithProviders(<Theme><Page /></Theme>);
    expect(screen.getByText('October 31st, 2026')).toBeInTheDocument();
  });
});

describe('investment entry pages, 8:00 am on Nov 1 in Kiritimati (Oct 31 in UTC)', () => {
  pinTimeZone('Pacific/Kiritimati', '2026-11-01T08:00:00+14:00');

  it.each(pages)('%s defaults the date to Nov 1', (_name, Page) => {
    renderWithProviders(<Theme><Page /></Theme>);
    expect(screen.getByText('November 1st, 2026')).toBeInTheDocument();
  });
});
