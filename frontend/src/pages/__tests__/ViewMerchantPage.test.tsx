import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import ViewMerchantPage from '../ViewMerchantPage';

// The charts need a laid-out DOM; render the bars they are given instead.
vi.mock('@nivo/bar', () => ({
  ResponsiveBar: ({ data }: { data: { month: string; total: number }[] }) => (
    <ol aria-label="monthly spending">{data.map((d) => <li key={d.month}>{`${d.month}: ${d.total}`}</li>)}</ol>
  ),
}));
vi.mock('@nivo/treemap', () => ({ ResponsiveTreeMap: () => null }));
vi.mock('../../components/RadixTransactionTable', () => ({ default: () => null }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useParams: () => ({ merchantUuid: 'm1' }) };
});

// The server buckets the merchant's spending by its 'YYYY-MM' month; the
// page only labels each month.
const spending = {
  merchant_uuid: 'm1',
  since: '2024-10-27',
  transaction_count: 3,
  rule_count: 0,
  monthly: [
    { month: '2026-06', total: '15.00' },
    { month: '2026-07', total: '7.00' },
  ],
  by_budget_item: [{ budget_item_uuid: null, budget_item_name: null, total: '22.00' }],
};

// The merchant's transactions in all, as the server's pagination counts them.
let transactionTotal = 0;

// Other merchants in the ledger, as GET /merchants answers them: with each one's counts, or
// with ?fields=lite only the names. None by default.
let otherMerchants: { id: number; uuid: string; name: string; transaction_count: number; rule_count: number }[] = [];

vi.mock('../../hooks/queries', () => ({
  useMerchantQuery: () => ({ data: { id: 1, uuid: 'm1', name: 'Corner Cafe' }, isLoading: false, isError: false }),
  useMerchantsQuery: (opts?: { lite?: boolean }, options?: { enabled?: boolean }) => {
    if (options?.enabled === false) return { data: undefined, isLoading: false };
    const all = [{ id: 1, uuid: 'm1', name: 'Corner Cafe', transaction_count: 3, rule_count: 0 }, ...otherMerchants];
    return { data: opts?.lite ? all.map(({ id, uuid, name }) => ({ id, uuid, name })) : all, isLoading: false };
  },
  useMerchantSpendingQuery: () => ({ data: spending, isLoading: false, isError: false }),
  usePaginatedTransactionsQuery: (page: number, limit: number) => ({
    data: { transactions: [], pagination: { total: transactionTotal, totalPages: Math.ceil(transactionTotal / limit), page, limit } },
    isLoading: false,
    isError: false,
  }),
  useBudgetItemsQuery: () => ({ data: [], isLoading: false }),
  useBulkUpdateTransactionsMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  merchantKeys: { all: ['merchants'] },
  transactionKeys: { all: ['transactions'] },
}));

// On the merchant page every monthly bar was labelled with the month
// before, and a transaction on the 1st was counted in the month before.
describe('ViewMerchantPage monthly chart in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles', '2026-10-27T12:00:00-07:00');

  it('labels each month the server bucketed as that month', async () => {
    renderWithProviders(<Theme><ViewMerchantPage /></Theme>);
    const bars = await screen.findByRole('list', { name: 'monthly spending' });
    expect(Array.from(bars.children).map((li) => li.textContent)).toEqual(['Jun 2026: 15', 'Jul 2026: 7']);
  });
});

// After the merchant's transactions were reassigned or deleted while a later
// page was open, the table said "Page 3 of 2" with nothing in it, and stayed so.
describe('ViewMerchantPage transactions paging', () => {
  it('goes back to the last page when the list shrinks under the page shown', async () => {
    transactionTotal = 60; // three pages of 25
    try {
      const { rerender } = renderWithProviders(<Theme><ViewMerchantPage /></Theme>);
      await userEvent.click(await screen.findByRole('button', { name: 'Page 3' }));
      expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');

      transactionTotal = 40; // two pages now
      rerender(<Theme><ViewMerchantPage /></Theme>);
      expect(await screen.findByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
      expect(screen.queryByRole('button', { name: 'Page 3' })).not.toBeInTheDocument();
    } finally {
      transactionTotal = 0;
    }
  });
});

// The duplicates card reads the lite list, which has no counts,
// so it names each candidate and leaves the count to the merge confirmation, which reads
// the full list once it opens.
describe('ViewMerchantPage merchant duplicates', () => {
  it('offers each similar merchant by name, and the merge confirmation says how many transactions it carries', async () => {
    otherMerchants = [
      { id: 2, uuid: 'm2', name: 'Corner Cafe Downtown', transaction_count: 5, rule_count: 1 },
      { id: 3, uuid: 'm3', name: 'Hardware Barn', transaction_count: 9, rule_count: 0 },
    ];
    try {
      renderWithProviders(<Theme><ViewMerchantPage /></Theme>);
      const candidate = await screen.findByRole('checkbox', { name: 'Corner Cafe Downtown' });
      expect(candidate).not.toHaveAttribute('aria-describedby');
      expect(screen.queryByRole('checkbox', { name: 'Hardware Barn' })).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+ transactions?$/)).not.toBeInTheDocument();

      await userEvent.click(candidate);
      await userEvent.click(screen.getByRole('button', { name: 'Merge (1)' }));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm Merchant Merge' });
      expect(dialog).toHaveTextContent('• Corner Cafe Downtown (5 transactions)');
    } finally {
      otherMerchants = [];
    }
  });
});
