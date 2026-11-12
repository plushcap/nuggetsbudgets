import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import ViewTagPage from '../ViewTagPage';

const TAG_UUID = '0190a6f2-7c1e-7b3a-9f00-000000000077';
const slice = (id: number, name: string, net: number) => ({
  id, uuid: `0190a6f2-7c1e-7b3a-9f00-00000000010${id}`, name, color: '#3b82f6', icon: null, is_parent: false,
  value: Math.abs(net), net, count: 1,
});
const data = vi.hoisted(() => ({ breakdown: [] as unknown[] }));

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useTagQuery: () => ({ data: { uuid: '0190a6f2-7c1e-7b3a-9f00-000000000077', name: 'Holiday', color: null, icon: null, child_count: 3 }, isLoading: false, isError: false }),
  useTagSummaryQuery: () => ({ data: { income_amount: 0, expense_amount: -0.16, total_amount: -0.16, transaction_count: 3 } }),
  useTagTimeseriesQuery: () => ({ data: { series: [] }, isLoading: false, isFetching: false }),
  useTagBreakdownQuery: () => ({ data: { breakdown: data.breakdown }, isLoading: false, isFetching: false }),
  useTagTransactionsQuery: () => ({ data: { transactions: [], total: 0 }, isLoading: false }),
}));
// The charts need a laid-out DOM; the table beside the pie is what is checked.
vi.mock('@nivo/pie', () => ({ ResponsivePie: () => null }));
vi.mock('@nivo/bar', () => ({ ResponsiveBar: () => null }));

const renderPage = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/tags/:tagUuid" element={<ViewTagPage />} />
      </Routes>
    </Theme>,
    { route: `/tags/${TAG_UUID}` },
  );

describe('ViewTagPage', () => {
  // The shares were of a float total: 0.01 + 0.14 + 0.01 is 0.16000000000000003,
  // so a share of exactly 6.25% read 6.2% where its cents make it 6.3%.
  it("works out each sub-tag's share of a total added in whole cents", async () => {
    data.breakdown = [slice(1, 'Ferry', -0.01), slice(2, 'Hotel', -0.14), slice(3, 'Snacks', -0.01)];
    renderPage();
    expect(await screen.findByText('Hotel')).toBeInTheDocument();
    expect(screen.getAllByText('6.3%')).toHaveLength(2);
    expect(screen.getByText('87.5%')).toBeInTheDocument();
  });
});
