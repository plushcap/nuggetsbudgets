import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../../test/renderWithProviders';
import AccountsPage from '../AccountsPage';
import { getAccounts, getCurrentNetWorth, type Account } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, getAccounts: vi.fn(), getCurrentNetWorth: vi.fn() };
});

const mockedGetAccounts = vi.mocked(getAccounts);
const mockedGetCurrentNetWorth = vi.mocked(getCurrentNetWorth);

const sampleAccount = {
  id: 1,
  uuid: 'a1',
  name: 'Checking',
  type: 'Asset',
  account_group: 'cash',
  account_type: 'Checking',
  calculated_balance: 100,
} as unknown as Account;

describe('AccountsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetCurrentNetWorth.mockResolvedValue({
      current_net_worth: { snapshot_date: '2026-10-01', total_assets: 100, total_liabilities: 0, net_worth: 100, account_count: 1, active_account_count: 1 },
    });
  });

  it('renders accounts returned by the query', async () => {
    mockedGetAccounts.mockResolvedValue([sampleAccount]);
    renderWithProviders(<AccountsPage />);
    // The page renders each account in both a desktop and a mobile layout.
    const matches = await screen.findAllByText('Checking');
    expect(matches.length).toBeGreaterThan(0);
  });

  // Each layout's badge showed the stored value ("credit_card"), not its label.
  it("shows each account's kind by its label, and a value from before the list as it is", async () => {
    mockedGetAccounts.mockResolvedValue([
      { ...sampleAccount, id: 7, uuid: 'c7', name: 'Travel card', type: 'Liability', account_type: 'credit_card' } as unknown as Account,
      { ...sampleAccount, id: 8, uuid: 'l8', name: 'Home line', type: 'Liability', account_type: 'line_of_credit' } as unknown as Account,
      { ...sampleAccount, id: 9, uuid: 'b9', name: 'Old bank', account_type: 'Banking' } as unknown as Account,
    ]);
    renderWithProviders(<AccountsPage />);
    await screen.findAllByText('Travel card');
    // One badge per layout (the desktop row and the mobile card).
    expect(screen.getAllByText('Credit Card')).toHaveLength(2);
    expect(screen.getAllByText('Line of Credit')).toHaveLength(2);
    expect(screen.getAllByText('Banking')).toHaveLength(2);
    expect(screen.queryByText('credit_card')).not.toBeInTheDocument();
    expect(screen.queryByText('line_of_credit')).not.toBeInTheDocument();
  });

  it('opens each account from a link the keyboard reaches, not a clickable card', async () => {
    mockedGetAccounts.mockResolvedValue([sampleAccount]);
    renderWithProviders(<AccountsPage />);
    // One link per layout (desktop row and mobile card), each named by the account.
    const links = await screen.findAllByRole('link', { name: 'Checking' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link).toHaveAttribute('href', '/accounts/a1');
  });

  it('shows an unavailable balance as Unavailable, never $0', async () => {
    mockedGetAccounts.mockResolvedValue([
      { ...sampleAccount, calculated_balance: null, balance_unavailable: true } as unknown as Account,
    ]);
    renderWithProviders(<AccountsPage />);
    await screen.findAllByText('Checking');
    // The account's own balance (desktop + mobile) and the totals over it (group, type).
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThanOrEqual(4);
  });

  it("shows the server's net worth, not a sum of the listed balances", async () => {
    // A card overpaid by a refund lowers the debts; the server also counts a closed
    // account the list doesn't show and leaves out the points account.
    mockedGetAccounts.mockResolvedValue([
      { ...sampleAccount, calculated_balance: 600 } as unknown as Account,
      { ...sampleAccount, id: 2, uuid: 'c2', name: 'Card', type: 'Liability', account_group: 'credit_cards', calculated_balance: 70 } as unknown as Account,
      { ...sampleAccount, id: 3, uuid: 'l3', name: 'Loan', type: 'Liability', account_group: 'loans', calculated_balance: -500 } as unknown as Account,
      { ...sampleAccount, id: 4, uuid: 'm4', name: 'Miles', account_group: 'other', calculated_balance: 85000 } as unknown as Account,
    ]);
    mockedGetCurrentNetWorth.mockResolvedValue({
      current_net_worth: { snapshot_date: '2026-10-01', total_assets: 640, total_liabilities: 430, net_worth: 210, account_count: 4, active_account_count: 4 },
    });
    renderWithProviders(<AccountsPage />);
    expect(await screen.findByText('$640.00')).toBeInTheDocument();
    expect(screen.getByText('$430.00')).toBeInTheDocument();
    expect(screen.getByText('$210.00')).toBeInTheDocument();
  });

  // accounts.type is nullable: such an account was grouped under the key "null", which the
  // page headed "Liabilities" (anything not 'Asset'). It goes with its kind's class.
  it('lists an account saved without a class under its kind’s class', async () => {
    mockedGetAccounts.mockResolvedValue([
      { ...sampleAccount, id: 5, uuid: 'n5', name: 'Old savings', type: null, account_type: 'savings' } as unknown as Account,
    ]);
    mockedGetCurrentNetWorth.mockResolvedValue({
      current_net_worth: { snapshot_date: '2026-10-01', total_assets: 100, total_liabilities: 0, net_worth: 100, account_count: 1, active_account_count: 1 },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findAllByText('Old savings');
    expect(screen.getByRole('heading', { name: 'Assets' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Liabilities' })).not.toBeInTheDocument();
  });

  // The page guessed a class from the kind, so a credit card saved without one was listed
  // with the liabilities, while net worth (the net_worth_accounts view: a liability only when
  // accounts.type is 'Liability') counts it as an asset. The page lists it where net worth counts it.
  it.each(['credit_card', 'loan', 'mortgage'])('lists a %s saved without a class with the assets, as net worth counts it', async (kind) => {
    mockedGetAccounts.mockResolvedValue([
      { ...sampleAccount, id: 6, uuid: 'n6', name: 'Old card', type: null, account_type: kind, account_group: 'credit_cards' } as unknown as Account,
    ]);
    renderWithProviders(<AccountsPage />);
    await screen.findAllByText('Old card');
    expect(screen.getByRole('heading', { name: 'Assets' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Liabilities' })).not.toBeInTheDocument();
  });

  // A balance or a total was red by its float: -0.004 showed as a red $0.00, and so did
  // -0.10 - 0.20 + 0.30 (-5.6e-17). Both are $0.00 by their cents, and not red.
  it('colours a balance and a total by their cents, adding the total in cents', async () => {
    mockedGetAccounts.mockResolvedValue([
      { ...sampleAccount, id: 7, uuid: 'a7', name: 'Rounding', calculated_balance: -0.004 } as unknown as Account,
      { ...sampleAccount, id: 8, uuid: 'a8', name: 'Coffee', calculated_balance: -0.1 } as unknown as Account,
      { ...sampleAccount, id: 9, uuid: 'a9', name: 'Tea', calculated_balance: -0.2 } as unknown as Account,
      { ...sampleAccount, id: 10, uuid: 'a10', name: 'Refund', calculated_balance: 0.3 } as unknown as Account,
    ]);
    // The summary's Liabilities figure is red whatever it is: keep it off $0.00.
    mockedGetCurrentNetWorth.mockResolvedValue({
      current_net_worth: { snapshot_date: '2026-10-01', total_assets: 1, total_liabilities: 1, net_worth: 0.5, account_count: 4, active_account_count: 4 },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findAllByText('Rounding');
    // The rounding account (desktop + mobile) and the group and type totals.
    const zeros = screen.getAllByText('$0.00');
    expect(zeros.length).toBeGreaterThanOrEqual(4);
    for (const zero of zeros) expect(zero.closest('[data-accent-color="red"]')).toBeNull();
    // A real debt is still red.
    for (const debt of screen.getAllByText('($0.10)')) expect(debt.closest('[data-accent-color="red"]')).not.toBeNull();
  });

  it('shows the summary as Unavailable when net worth fails to load', async () => {
    mockedGetAccounts.mockResolvedValue([sampleAccount]);
    mockedGetCurrentNetWorth.mockRejectedValue(new Error('boom'));
    renderWithProviders(<AccountsPage />);
    await screen.findAllByText('Checking');
    // Assets, liabilities and net worth.
    await waitFor(() => expect(screen.getAllByText('Unavailable')).toHaveLength(3));
  });

  it('shows an error panel when the query fails', async () => {
    mockedGetAccounts.mockRejectedValue(new Error('boom'));
    renderWithProviders(<AccountsPage />);
    await waitFor(() =>
      expect(screen.getByText(/Error loading accounts/i)).toBeInTheDocument()
    );
  });
});
