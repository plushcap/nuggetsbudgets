import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi, type ApiRequest } from '../../test/apiServer';
import { account, accountsResponse, transaction, transactionsPage, user as userFixture } from '../../test/fixtures';
import AccountDetailPage from '../AccountDetailPage';
import TasksPage from '../TasksPage';

/**
 * The rows-per-page choice on an account's register and on Tasks, against the API: each
 * asks for pages of the size this browser chose (50 until one is), and the footer's picker
 * changes it, from the page that keeps the first row shown in view. (All Transactions:
 * TransactionsPage.test.tsx; the merchant's, tag's and budget item's pages: their own tests.)
 */

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1 } }) }));

// jsdom lacks the pointer-capture APIs Radix Select calls.
Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const KEY = 'transaction-page-size';
const ACCOUNT_UUID = '0190a000-0000-7000-8000-0000000000a1';
const checking = account({ id: 1, uuid: ACCOUNT_UUID, name: 'Everyday checking', calculated_balance: '1234.56' });
const rows = [
  transaction({ id: 1, description: 'Corner Store', amount: '-12.34', account_id: 1, account_name: 'Everyday checking', review_status: 'pending' }),
];

// 300 matches, whatever page size is asked for.
const page = ({ query }: ApiRequest) =>
  transactionsPage(rows, { page: Number(query.get('page') ?? 1), limit: Number(query.get('limit') ?? 50), total: 300 });

let api: ReturnType<typeof mockApi>;

beforeEach(() => {
  api = mockApi({
    'GET /budgets/periods': [],
    'GET /budgets/items': [],
    'GET /tags': [],
    'GET /tenants/current/users': [userFixture({ id: 1, first_name: 'Ada' })],
    'GET /accounts': accountsResponse([checking]),
    'GET /accounts/:uuid': checking,
    'GET /accounts/:uuid/balance': { account_id: 1, balance: '1234.56', balance_unavailable: false },
    'GET /accounts/:uuid/transactions': page,
    'GET /transactions/paginated': page,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.removeItem(KEY);
});

const lastQuery = (route: string) => {
  const calls = api.calls(route);
  return Object.fromEntries(calls[calls.length - 1]?.query ?? []);
};

const choose = async (size: string) => {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('combobox', { name: 'Rows per page' }));
  await user.click(await screen.findByRole('option', { name: size }));
};

describe.each([
  {
    name: "an account's register",
    route: 'GET /accounts/:uuid/transactions',
    render: (search: string) =>
      renderWithProviders(
        <Theme><Routes><Route path="/accounts/:uuid" element={<AccountDetailPage />} /></Routes></Theme>,
        { route: `/accounts/${ACCOUNT_UUID}${search}` },
      ),
  },
  {
    name: 'Tasks',
    route: 'GET /transactions/paginated',
    render: (search: string) => renderWithProviders(<Theme><TasksPage /></Theme>, { route: `/tasks${search}` }),
  },
])('rows per page on $name', ({ route, render }) => {
  it('asks for pages of 50 until a size is chosen, and of the size stored once one is', async () => {
    const first = render('');
    await waitFor(() => expect(lastQuery(route)).toMatchObject({ limit: '50' }));
    first.unmount();

    localStorage.setItem(KEY, '200');
    render('');
    await waitFor(() => expect(lastQuery(route)).toMatchObject({ limit: '200' }));
    expect(await screen.findByRole('combobox', { name: 'Rows per page' })).toHaveTextContent('200');
  });

  it('asks for the size chosen in the footer, from the page holding the first row shown, and keeps it', async () => {
    render('?page=4');
    await waitFor(() => expect(lastQuery(route)).toMatchObject({ page: '4', limit: '50' }));

    // Page 4 of 50 starts at row 151, which is on page 7 of 25.
    await choose('25');
    await waitFor(() => expect(lastQuery(route)).toMatchObject({ page: '7', limit: '25' }));
    expect(await screen.findByText(/^Showing 151 to 175 of 300 /)).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe('25');
  });
});
