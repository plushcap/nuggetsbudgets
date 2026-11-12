import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import TasksPage from '../TasksPage';
import TransactionsPage from '../TransactionsPage';

/**
 * The Tasks and Transactions lists open on the URL's ?page= (a reload or a shared
 * link keeps it), and go back to page 1 when their filters change.
 */
const paged = vi.hoisted(() => vi.fn());
const empty = vi.hoisted(() => [] as never[]);

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  usePaginatedTransactionsQuery: (page: number, _limit: number, params: unknown) => {
    paged(page, params);
    // Ten pages, so the page asked for is in range (usePageInRange brings one past the end back).
    return { data: { transactions: empty, pagination: { total: 300, totalPages: 10 } }, isLoading: false };
  },
  useBudgetPeriodsQuery: () => ({ data: empty }),
  useBudgetItemsQuery: () => ({ data: empty }),
  useUsersQuery: () => ({ data: empty }),
  useAccountsQuery: () => ({ data: empty }),
}));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 7 } }) }));

const lastPage = () => paged.mock.calls[paged.mock.calls.length - 1]?.[0];

const at = (route: string, page: React.ReactNode) =>
  render(
    <QueryClientProvider client={makeTestQueryClient()}>
      <Theme>
        <MemoryRouter initialEntries={[route]}>{page}</MemoryRouter>
      </Theme>
    </QueryClientProvider>,
  );

describe('?page= on the transaction lists', () => {
  beforeEach(() => {
    paged.mockClear();
    sessionStorage.clear();
  });

  it('Tasks opens on the URL page, and goes back to page 1 when a switch changes', async () => {
    at('/tasks?page=3', <TasksPage />);
    expect(lastPage()).toBe(3);
    await userEvent.click(screen.getByRole('switch', { name: /Include Unassigned/ }));
    await waitFor(() => expect(lastPage()).toBe(1));
  });

  it('Transactions opens on the URL page, and goes back to page 1 when the filters change', async () => {
    at('/transactions?page=4', <TransactionsPage />);
    expect(lastPage()).toBe(4);
    await userEvent.type(screen.getByPlaceholderText('Search transactions...'), 'rent');
    await waitFor(() => expect(lastPage()).toBe(1));
  });
});
