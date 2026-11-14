import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { useLocation } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi, type ApiRequest } from '../../test/apiServer';
import { accountsResponse, account, transaction, transactionsPage, user as userFixture } from '../../test/fixtures';
import TransactionsPage from '../TransactionsPage';

/**
 * All Transactions against the API: the filters in the page URL are the
 * filters the list request sends, a filter chosen on the page goes into both, and
 * the page shown is the page asked for.
 */

// jsdom lacks the pointer-capture APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
});

const checking = account({ id: 1, name: 'Everyday checking', calculated_balance: '1234.56' });
const rows = [
  transaction({ id: 1, description: 'Corner Store', amount: '-12.34', account_id: 1, account_name: 'Everyday checking' }),
  transaction({ id: 2, description: 'Paycheck deposit', amount: '2500.00', type: 'income', account_id: 1, account_name: 'Everyday checking' }),
];

let api: ReturnType<typeof mockApi>;

const routes = () => ({
  'GET /budgets/periods': [],
  'GET /budgets/items': [],
  'GET /tags': [],
  'GET /tenants/current/users': [userFixture({ id: 1, first_name: 'Ada' })],
  'GET /accounts': accountsResponse([checking]),
  // 125 matches: three pages of 50, the default size.
  'GET /transactions/paginated': ({ query }: ApiRequest) =>
    transactionsPage(rows, { page: Number(query.get('page')), limit: Number(query.get('limit')), total: 125 }),
});

const Where = () => {
  const { search } = useLocation();
  return <output data-testid="where">{search}</output>;
};

const renderAt = (route: string) =>
  renderWithProviders(<Theme><TransactionsPage /><Where /></Theme>, { route });

/** The query of the newest list request, as an object. */
const lastListQuery = () => {
  const calls = api.calls('GET /transactions/paginated');
  return Object.fromEntries(calls[calls.length - 1].query);
};
const urlParams = () => Object.fromEntries(new URLSearchParams(screen.getByTestId('where').textContent ?? ''));

beforeEach(() => {
  api = mockApi(routes());
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem('transaction-page-size');
});

describe('TransactionsPage', () => {
  it('lists what the API answers, an expense in parentheses', async () => {
    renderAt('/transactions');
    expect((await screen.findAllByText('Corner Store')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paycheck deposit').length).toBeGreaterThan(0);
    expect(screen.getAllByText('($12.34)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('$2,500.00').length).toBeGreaterThan(0);
    expect(api.unhandled).toEqual([]);
  });

  it("sends the URL's filters and page to the API under the API's names", async () => {
    renderAt('/transactions?search=rent&reviewStatus=flagged&transactionType=expense&dateFrom=2026-10-01&dateTo=2026-10-31&amountMin=10&page=2');

    await waitFor(() => expect(api.calls('GET /transactions/paginated').length).toBeGreaterThan(0));
    expect(lastListQuery()).toEqual({
      page: '2',
      limit: '50',
      search: 'rent',
      review_status: 'flagged',
      type: 'expense',
      date_from: '2026-10-01',
      date_to: '2026-10-31',
      amount_min: '10',
    });
    // The URL keeps them (it isn't reset to page 1 or stripped on load).
    await waitFor(() => expect(urlParams()).toMatchObject({ search: 'rent', reviewStatus: 'flagged', page: '2' }));
  });

  it('a search typed on the page goes into the request and the URL, from page 1', async () => {
    const user = userEvent.setup();
    renderAt('/transactions?page=3');
    await waitFor(() => expect(lastListQuery().page).toBe('3'));

    await user.type(screen.getByRole('textbox', { name: 'Search transactions' }), 'coffee');

    await waitFor(() => expect(lastListQuery()).toMatchObject({ search: 'coffee', page: '1' }));
    await waitFor(() => expect(urlParams()).toEqual({ search: 'coffee' }));
  });

  it('a review status chosen on the page filters the request by it', async () => {
    const user = userEvent.setup();
    renderAt('/transactions');
    await waitFor(() => expect(api.calls('GET /transactions/paginated').length).toBeGreaterThan(0));
    expect(lastListQuery().review_status).toBeUndefined();

    await user.click(screen.getByRole('combobox', { name: 'Review status' }));
    await user.click(await screen.findByRole('option', { name: 'Reviewed' }));

    await waitFor(() => expect(lastListQuery().review_status).toBe('reviewed'));
    await waitFor(() => expect(urlParams()).toEqual({ reviewStatus: 'reviewed' }));
  });

  it('asks for the next page, and the URL says which page is shown', async () => {
    const user = userEvent.setup();
    renderAt('/transactions');
    await screen.findAllByText('Corner Store');

    await user.click(screen.getByRole('button', { name: 'Next page' }));

    await waitFor(() => expect(lastListQuery().page).toBe('2'));
    await waitFor(() => expect(urlParams()).toEqual({ page: '2' }));
  });

  it('asks for pages of the size chosen in the footer, keeps the first row shown in view, and remembers it', async () => {
    const user = userEvent.setup();
    const { unmount } = renderAt('/transactions?page=3');
    await waitFor(() => expect(lastListQuery()).toMatchObject({ page: '3', limit: '50' }));
    const picker = await screen.findByRole('combobox', { name: 'Rows per page' });
    expect(picker).toHaveTextContent('50');

    // Page 3 of 50 starts at row 101, which is on page 2 of 100.
    await user.click(picker);
    await user.click(await screen.findByRole('option', { name: '100' }));
    await waitFor(() => expect(lastListQuery()).toMatchObject({ page: '2', limit: '100' }));
    await waitFor(() => expect(urlParams()).toEqual({ page: '2' }));
    expect(screen.getByText('Showing 101 to 125 of 125 transactions')).toBeInTheDocument();
    expect(localStorage.getItem('transaction-page-size')).toBe('100');

    // The next visit starts at the size chosen.
    unmount();
    renderAt('/transactions');
    await waitFor(() => expect(lastListQuery()).toMatchObject({ page: '1', limit: '100' }));
    expect(await screen.findByRole('combobox', { name: 'Rows per page' })).toHaveTextContent('100');
  });

  it('asks for the default 50 when the stored size is not one it offers', async () => {
    localStorage.setItem('transaction-page-size', '1000');
    renderAt('/transactions');
    await waitFor(() => expect(lastListQuery()).toMatchObject({ limit: '50' }));
  });

  // A page past the end (after deletes, or a link to a page that no longer
  // exists) showed "No transactions found" with no pagination to get back.
  it('goes back to the last page when the one in the URL is past the end', async () => {
    api = mockApi({
      ...routes(),
      // 80 matches: two pages of 50.
      'GET /transactions/paginated': ({ query }: ApiRequest) =>
        transactionsPage(Number(query.get('page')) <= 2 ? rows : [], { page: Number(query.get('page')), limit: Number(query.get('limit')), total: 80 }),
    });
    renderAt('/transactions?page=3');
    await waitFor(() => expect(lastListQuery().page).toBe('2'));
    await waitFor(() => expect(urlParams()).toEqual({ page: '2' }));
    expect((await screen.findAllByText('Corner Store')).length).toBeGreaterThan(0);
  });

  // A cached answer for a page (from before the list grew) brought the page
  // back while its refetch was still on the way.
  it('stays on a page that exists again, while its cached answer is refreshed', async () => {
    let total = 80; // two pages of 50
    api = mockApi({
      ...routes(),
      'GET /transactions/paginated': async ({ query }: ApiRequest) => {
        const page = Number(query.get('page'));
        const limit = Number(query.get('limit'));
        await new Promise((resolve) => setTimeout(resolve, 50));
        return transactionsPage(page <= Math.ceil(total / limit) ? rows : [], { page, limit, total });
      },
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000, refetchOnWindowFocus: false } } });
    renderWithProviders(<Theme><TransactionsPage /><Where /></Theme>, { route: '/transactions?page=3', client });
    await waitFor(() => expect(urlParams()).toEqual({ page: '2' }));
    // The list grows back to three pages; a write invalidates the lists.
    total = 140;
    await act(() => client.invalidateQueries({ queryKey: ['transactions'] }));
    await userEvent.click(await screen.findByRole('button', { name: 'Page 3' }));
    await waitFor(() => expect(lastListQuery().page).toBe('3'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(urlParams()).toEqual({ page: '3' });
  });
});
