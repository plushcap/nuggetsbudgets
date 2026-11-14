import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { tagTransactionsResponseSchema } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { transaction } from '../../test/fixtures';
import ViewTagPage from '../ViewTagPage';

// jsdom lacks the pointer-capture APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const TAG_UUID = '0190a6f2-7c1e-7b3a-9f00-000000000077';
const slice = (id: number, name: string, net: number) => ({
  id, uuid: `0190a6f2-7c1e-7b3a-9f00-00000000010${id}`, name, color: '#3b82f6', icon: null, is_parent: false,
  value: Math.abs(net), net, count: 1,
});
const data = vi.hoisted(() => ({
  breakdown: [] as unknown[],
  // The tag's transactions: how many there are, and the pages asked for ({ limit, offset }).
  transactionTotal: 0,
  transactionPages: [] as Array<{ limit?: number; offset?: number } | undefined>,
}));
// One row as the API module hands it over (parsed), for every page asked for.
const tagRows = tagTransactionsResponseSchema.parse({ transactions: [transaction({ id: 1, description: 'Ferry ticket', amount: '-40.00' })], total: 1, limit: 50, offset: 0 }).transactions;

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useTagQuery: () => ({ data: { uuid: '0190a6f2-7c1e-7b3a-9f00-000000000077', name: 'Holiday', color: null, icon: null, child_count: 3 }, isLoading: false, isError: false }),
  useTagSummaryQuery: () => ({ data: { income_amount: 0, expense_amount: -0.16, total_amount: -0.16, transaction_count: 3 } }),
  useTagTimeseriesQuery: () => ({ data: { series: [] }, isLoading: false, isFetching: false }),
  useTagBreakdownQuery: () => ({ data: { breakdown: data.breakdown }, isLoading: false, isFetching: false }),
  useTagTransactionsQuery: (_uuid: string, params?: { limit?: number; offset?: number }) => {
    data.transactionPages.push(params);
    return data.transactionTotal === 0
      ? { data: { transactions: [], total: 0 }, isLoading: false }
      : { data: { transactions: tagRows, total: data.transactionTotal }, isLoading: false };
  },
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

afterEach(() => {
  data.transactionTotal = 0;
  data.transactionPages = [];
  localStorage.removeItem('transaction-page-size');
});

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

  it('asks for pages of the rows-per-page size, and of the size chosen in its footer, from the page holding the first row shown', async () => {
    data.transactionTotal = 300;
    renderPage();
    await waitFor(() => expect(data.transactionPages[data.transactionPages.length - 1]).toEqual({ limit: 50, offset: 0 }));
    expect(screen.getByText('Showing 1 to 50 of 300 transactions')).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(data.transactionPages[data.transactionPages.length - 1]).toEqual({ limit: 50, offset: 100 }));

    // Page 3 of 50 starts at row 101, which is on page 2 of 100.
    await user.click(screen.getByRole('combobox', { name: 'Rows per page' }));
    await user.click(await screen.findByRole('option', { name: '100' }));
    await waitFor(() => expect(data.transactionPages[data.transactionPages.length - 1]).toEqual({ limit: 100, offset: 100 }));
    expect(screen.getByText('Showing 101 to 200 of 300 transactions')).toBeInTheDocument();
    expect(localStorage.getItem('transaction-page-size')).toBe('100');
  });

  // The footer holds the picker: shown while a size could change what shows, even on one page.
  it('shows the footer for more rows than the smallest size, and not for fewer', async () => {
    data.transactionTotal = 40;
    const { unmount } = renderPage();
    expect(await screen.findByRole('combobox', { name: 'Rows per page' })).toHaveTextContent('50');
    unmount();

    data.transactionTotal = 25;
    renderPage();
    expect((await screen.findAllByText('Ferry ticket')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('combobox', { name: 'Rows per page' })).not.toBeInTheDocument();
  });
});
