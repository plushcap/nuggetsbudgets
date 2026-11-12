import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import ViewBudgetItemPage from '../ViewBudgetItemPage';

/**
 * The budget item page lists the item's transactions in the chosen window, newest
 * first, without split parents (their splits carry the spending), and goes back
 * to the first page of the list when the window changes.
 */
const item = vi.hoisted(() => ({
  id: 9,
  uuid: 'bi-9',
  name: 'Groceries',
  type: 'Monthly',
  subtype: 'Flexible',
  expense_type: 'Expense',
  icon: 'Tag',
  color: 'gray',
  priority: 'Optional',
  rollover: false,
  status: 'active',
}));
const tx = (n: number, day: string, extra: Record<string, unknown> = {}) => ({
  id: n,
  uuid: `tx-${n}`,
  description: `purchase ${n}`,
  amount: -n,
  transaction_date: day,
  budget_item_uuid: 'bi-9',
  merchant_name: null, // the table then shows the description
  is_split_parent: false,
  review_status: 'reviewed',
  status: 'cleared',
  type: 'expense',
  ...extra,
});
const scoped = vi.hoisted(() => ({ data: [] as unknown[] }));
const empty = vi.hoisted(() => [] as never[]);
const items = vi.hoisted(() => [item] as Record<string, unknown>[]);
const history = vi.hoisted(() => ({ data: undefined as unknown }));

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useBudgetItemsQuery: () => ({ data: items, isLoading: false }),
  useBudgetItemHistoryQuery: () => ({ data: history.data, isLoading: false, isError: false }),
  useCategoriesQuery: () => ({ data: empty }),
  useMerchantsQuery: () => ({ data: empty }),
  useTransactionsWithFiltersQuery: () => ({ data: scoped.data, isLoading: false, refetch: vi.fn() }),
}));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'light' }) }));
// The charts need a laid-out DOM: list the bars and merchant tiles they are given instead.
vi.mock('@nivo/bar', () => ({
  ResponsiveBar: ({ data }: { data: { month: string; total: number }[] }) => (
    <ul>{data.map((d) => <li key={d.month} data-testid="bar" data-total={d.total} />)}</ul>
  ),
}));
vi.mock('@nivo/treemap', () => ({
  ResponsiveTreeMap: ({ data }: { data: { children: { name: string; value: number }[] } }) => (
    <ul>{data.children.map((c) => <li key={c.name} data-testid="merchant" data-value={c.value} />)}</ul>
  ),
}));

const client = makeTestQueryClient();
const page = () => (
  <QueryClientProvider client={client}>
    <Theme>
      <MemoryRouter initialEntries={['/budget-items/bi-9/view']}>
        <Routes>
          <Route path="/budget-items/:budgetItemUuid/view" element={<ViewBudgetItemPage />} />
        </Routes>
      </MemoryRouter>
    </Theme>
  </QueryClientProvider>
);
const renderPage = () => render(page());

describe('ViewBudgetItemPage transactions', () => {
  it('lists the spending newest first, without split parents', async () => {
    scoped.data = [
      tx(1, '2026-10-01'),
      tx(2, '2026-10-05'),
      tx(3, '2026-10-03', { is_split_parent: true }),
      tx(4, '2026-10-04', { budget_item_uuid: 'another item' }),
    ];
    renderPage();
    expect(await screen.findByText('2 transactions in the last 1 month')).toBeInTheDocument();
    const descriptions = screen.getAllByText(/^purchase \d$/).map((el) => el.textContent);
    expect(descriptions.filter((d, i) => descriptions.indexOf(d) === i)).toEqual(['purchase 2', 'purchase 1']);
  });

  it('goes back to the first page of the list when the window changes', async () => {
    scoped.data = Array.from({ length: 30 }, (_, i) => tx(i + 1, `2026-09-${String(i + 1).padStart(2, '0')}`));
    renderPage();
    const pages = await screen.findByRole('button', { name: 'Page 2' });
    await userEvent.click(pages);
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');

    await userEvent.click(screen.getByRole('button', { name: '3 months' }));
    expect(await screen.findByText('30 transactions in the last 3 months')).toBeInTheDocument();
    const pagination = screen.getByRole('button', { name: 'Page 1' });
    expect(pagination).toHaveAttribute('aria-current', 'page');
    expect(within(document.body).queryAllByText('purchase 30').length).toBeGreaterThan(0);
  });

  // After transactions were moved or deleted while a later page was open, the
  // list showed an empty page.
  it('goes back to the last page when the list shrinks under the page shown', async () => {
    scoped.data = Array.from({ length: 60 }, (_, i) => tx(i + 1, `2026-10-${String((i % 28) + 1).padStart(2, '0')}`));
    const { rerender } = renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Page 3' }));
    expect(screen.getByRole('button', { name: 'Page 3' })).toHaveAttribute('aria-current', 'page');

    scoped.data = scoped.data.slice(0, 40); // two pages of 25 now
    rerender(page());
    expect(await screen.findByText('40 transactions in the last 1 month')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByText(/^purchase \d+$/).length).toBeGreaterThan(0);
  });

  it('charts the net of an income and an expense on the same item, not their sum', async () => {
    scoped.data = [
      // Made-up figures: a gross paycheck and its deductions, netting to 3,749.25. Their sum
      // of magnitudes would be 6,250.75.
      tx(1, '2026-11-01', { amount: 5000, type: 'income', merchant_name: 'Acme Payroll' }),
      tx(2, '2026-11-01', { amount: -1250.75, merchant_name: 'Acme Payroll' }),
    ];
    renderPage();
    await screen.findByText('2 transactions in the last 1 month');
    const bars = screen.getAllByTestId('bar').map((el) => Number(el.dataset.total));
    expect(bars.length).toBeGreaterThan(0);
    for (const total of bars) expect(total).toBeCloseTo(3749.25, 2);
    const merchants = screen.getAllByTestId('merchant').map((el) => Number(el.dataset.value));
    expect(merchants).toHaveLength(1);
    expect(merchants[0]).toBeCloseTo(3749.25, 2);
  });

  // The buckets and merchants were float sums, so purchases of 0.10 and 0.20
  // refunded as 0.30 left 5.6e-17 behind, a merchant drawn and listed at $0.00.
  it('adds each bucket and merchant in whole cents, so a refunded merchant leaves nothing', async () => {
    scoped.data = [
      tx(1, '2026-11-02', { amount: -0.1, merchant_name: 'Corner shop' }),
      tx(2, '2026-11-02', { amount: -0.2, merchant_name: 'Corner shop' }),
      tx(3, '2026-11-02', { amount: 0.3, type: 'income', merchant_name: 'Corner shop' }),
      tx(4, '2026-11-02', { amount: -5.1, merchant_name: 'Bakery' }),
    ];
    renderPage();
    await screen.findByText('4 transactions in the last 1 month');
    const merchants = screen.getAllByTestId('merchant').map((el) => Number(el.dataset.value));
    expect(merchants).toEqual([5.1]);
    for (const total of screen.getAllByTestId('bar').map((el) => Number(el.dataset.total))) expect(total).toBe(5.1);
  });
});

// An expense's actual is pre-signed (negative when it spent), and the goal card
// showed "Previously Spent" only for a positive one, so never for an expense that had spent.
describe('ViewBudgetItemPage goal progress', () => {
  const figures = (actual: string) => ({
    budget_item_uuid: 'bi-9',
    periods: [],
    current: { period_uuid: 'p-1', budget: '100.00', actual, transfers: '0.00', remaining: '80.00' },
  });
  const envelope = { ...item, type: 'Envelope', rollover: true, rollover_target_amount: 500 };

  const withEnvelope = async (actual: string, check: () => void | Promise<void>) => {
    scoped.data = [];
    items[0] = envelope;
    history.data = figures(actual);
    try {
      renderPage();
      expect(await screen.findByText('Progress Toward Target')).toBeInTheDocument();
      await check();
    } finally {
      items[0] = item;
      history.data = undefined;
    }
  };

  it('shows what an expense spent this period as Previously Spent', async () => {
    await withEnvelope('-20.00', () => {
      // The card wants the amount spent, positive, and shows it as "-$20.00".
      expect(screen.getByText('Previously Spent:').parentElement).toHaveTextContent('Previously Spent:-$20.00');
    });
  });

  it('shows no Previously Spent line for a period of net refunds', async () => {
    await withEnvelope('15.00', () => {
      expect(screen.queryByText('Previously Spent:')).not.toBeInTheDocument();
    });
  });
});

// A frequency below 1 (one stored before the API refused it) is no schedule. The
// page showed a stray 0 for 0 (`0 && …`), and "Every -5 month(s)".
describe('ViewBudgetItemPage payment information', () => {
  it.each([0, -5])('says a bill whose frequency is %i has none set', async (months) => {
    items[0] = { ...item, isbill: true, recurring_payment_frequency: months };
    try {
      renderPage();
      const label = await screen.findByText('Payment Frequency:');
      expect(label.parentElement?.parentElement).toHaveTextContent(
        /^Payment Frequency: None set, so the Bills page doesn’t list it\. Edit the bill to choose one\.$/,
      );
      expect(screen.queryByText(/Every -?\d+ month/)).not.toBeInTheDocument();
    } finally {
      items[0] = item;
    }
  });

  it('shows the months between payments of a bill that has them', async () => {
    items[0] = { ...item, isbill: true, recurring_payment_frequency: 3 };
    try {
      renderPage();
      expect((await screen.findByText('Payment Frequency:')).parentElement).toHaveTextContent('Payment Frequency: Every 3 month(s)');
    } finally {
      items[0] = item;
    }
  });
});
