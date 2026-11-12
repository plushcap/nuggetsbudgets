import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { pinTimeZone } from '../../test/timeZone';
import BudgetPeriodsPage from '../BudgetPeriodsPage';

// The API has sent DATE columns both as 'YYYY-MM-DD' and as an ISO instant at
// UTC midnight; either must show that calendar day.
const periods = [
  { id: 4, uuid: 'p4', name: 'August 2026', year: 2026, month_number: 8, start_date: '2026-08-01', end_date: '2026-08-31', archived_at: '2026-11-01T12:00:00.000Z', transaction_count: 5, budget_item_count: 2, budget_transaction_count: 2 },
  { id: 3, uuid: 'p3', name: 'September 2026', year: 2026, month_number: 9, start_date: '2026-09-01', end_date: '2026-09-30', archived_at: null, transaction_count: 0, budget_item_count: 2, budget_transaction_count: 4 },
  { id: 1, uuid: 'p1', name: 'October 2026', year: 2026, month_number: 10, start_date: '2026-10-01', end_date: '2026-10-31', archived_at: null, transaction_count: 3, budget_item_count: 2, budget_transaction_count: 2 },
  { id: 2, uuid: 'p2', name: 'November 2026', year: 2026, month_number: 11, start_date: '2026-11-01T00:00:00.000Z', end_date: '2026-11-30T00:00:00.000Z', archived_at: null, transaction_count: 0, budget_item_count: 0, budget_transaction_count: 0 },
];

const mutations = vi.hoisted(() => ({ delete: vi.fn(), archive: vi.fn(), restore: vi.fn() }));
// The periods the page is given; a test may replace them.
const listed = vi.hoisted(() => ({ periods: [] as unknown[] }));
vi.mock('../../hooks/queries', () => ({
  useBudgetPeriodsManagementQuery: () => ({ data: { periods: listed.periods, stats: null }, isLoading: false }),
  useDeleteBudgetPeriodMutation: () => ({ mutateAsync: mutations.delete, isPending: false }),
  useArchiveBudgetPeriodMutation: () => ({ mutateAsync: mutations.archive, isPending: false }),
  useRestoreBudgetPeriodMutation: () => ({ mutateAsync: mutations.restore, isPending: false }),
}));

beforeEach(() => {
  listed.periods = periods;
  mutations.delete.mockReset().mockResolvedValue({});
  mutations.archive.mockReset().mockResolvedValue({});
  mutations.restore.mockReset().mockResolvedValue({});
});

const renderPage = () => renderWithProviders(<Theme><BudgetPeriodsPage /></Theme>);
/** The first of a button's copies: the mobile cards and the desktop table both render one. */
const button = (name: string) => screen.getAllByRole('button', { name })[0]!;

// A period's start/end are calendar days; read as UTC instants they show
// a day early anywhere west of UTC.
describe('BudgetPeriodsPage date ranges in Los Angeles', () => {
  pinTimeZone('America/Los_Angeles');

  it('shows each period from its first to its last day', () => {
    renderPage();
    expect(screen.getAllByText('10/1/2026 - 10/31/2026').length).toBeGreaterThan(0);
    expect(screen.getAllByText('11/1/2026 - 11/30/2026').length).toBeGreaterThan(0);
  });
});

describe('Deleting a budget period', () => {
  // An envelope's balance runs through every period up to each one, so deleting a period
  // with budgets changes the later periods' balances.
  const ENVELOPES = "Envelope balances in later periods include this period's budgets, so they will change";

  it("doesn't delete one that has transactions: it offers to archive it instead", async () => {
    renderPage();
    await userEvent.click(button('Delete October 2026'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText("This period can't be deleted")).toBeInTheDocument();
    expect(within(dialog).getByText(/"October 2026" has 3 transactions, so it can't be deleted/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Archive Period' }));
    expect(mutations.archive).toHaveBeenCalledWith('p1');
    expect(mutations.delete).not.toHaveBeenCalled();
  });

  it('deletes one without transactions, warning that later envelope balances change', async () => {
    renderPage();
    await userEvent.click(button('Delete September 2026'));
    expect(await screen.findByText(ENVELOPES)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete Period' }));
    expect(mutations.delete).toHaveBeenCalledWith('p3');
    expect(mutations.archive).not.toHaveBeenCalled();
  });

  it("doesn't warn for the latest period", async () => {
    renderPage();
    await userEvent.click(button('Delete November 2026'));
    expect(await screen.findByText('This action cannot be undone')).toBeInTheDocument();
    expect(screen.queryByText(ENVELOPES)).not.toBeInTheDocument();
  });
});

describe('Archiving a budget period', () => {
  it('archives a period from its row', async () => {
    renderPage();
    await userEvent.click(button('Archive November 2026'));
    expect(mutations.archive).toHaveBeenCalledWith('p2');
  });

  it('hides archived periods until asked, then shows them marked, to restore', async () => {
    renderPage();
    expect(screen.queryByText('August 2026')).not.toBeInTheDocument();
    expect(screen.queryByText('Archived')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show archived (1)' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    expect(screen.getAllByText('August 2026').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Archived').length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('button', { name: 'Archive August 2026' })).toEqual([]);

    await userEvent.click(button('Restore August 2026'));
    expect(mutations.restore).toHaveBeenCalledWith('p4');

    await userEvent.click(screen.getByRole('button', { name: 'Hide archived' }));
    expect(screen.queryByText('August 2026')).not.toBeInTheDocument();
  });

  it('says every period is archived, not that there are none, when all of them are', async () => {
    listed.periods = periods.map((p) => ({ ...p, archived_at: '2026-11-01T12:00:00.000Z' }));
    renderPage();
    expect(screen.getByText('Every budget period is archived')).toBeInTheDocument();
    expect(screen.queryByText('No budget periods yet')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: `Show archived (${periods.length})` }));
    expect(screen.queryByText('Every budget period is archived')).not.toBeInTheDocument();
    expect(screen.getAllByText('October 2026').length).toBeGreaterThan(0);
  });
});
