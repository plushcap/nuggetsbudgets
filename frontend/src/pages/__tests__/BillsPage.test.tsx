import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { BillForecastMonth, BillMonthView } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import BillsPage from '../BillsPage';

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const api = vi.hoisted(() => ({
  month: vi.fn(),
  forecast: vi.fn(),
  resolve: vi.fn(),
  candidates: vi.fn(),
  link: vi.fn(),
}));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getBillMonth: (month?: string) => api.month(month),
    getBillForecast: (months: number) => api.forecast(months),
    resolveBillOccurrence: (uuid: string, body: unknown) => api.resolve(uuid, body),
    getBillPaymentCandidates: (uuid: string, query?: string) => api.candidates(uuid, query),
    linkBillPayment: (uuid: string, transactionUuid: string) => api.link(uuid, transactionUuid),
  };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const internet = { uuid: 'bill-internet', name: 'Internet', varies: false };
const electric = { uuid: 'bill-electric', name: 'Electric', varies: true };

const november: BillMonthView = {
  month: '2026-11',
  today: '2026-11-15',
  totals: { expected: 190, paid: 92.5, remaining: 90 },
  occurrences: [
    {
      uuid: 'occ-internet', bill: internet, due_date: '2026-11-05', expected: 100, paid: 92.5, status: 'paid',
      paid_date: '2026-11-03', resolution: null, note: null,
      payments: [{ transaction_uuid: 'tx-1', date: '2026-11-03', amount: 92.5, description: 'EXAMPLE CABLE', account: 'Checking', matched_by: 'auto' }],
    },
    {
      uuid: 'occ-electric', bill: electric, due_date: '2026-11-25', expected: 90, paid: 0, status: 'upcoming',
      paid_date: null, resolution: null, note: null, payments: [],
    },
  ],
  unplaced: [{ transaction_uuid: 'tx-early', date: '2026-11-10', amount: 600, description: 'ACME INSURANCE', account: 'Card', bill: { uuid: 'bill-car', name: 'Car insurance', varies: false } }],
};

const forecast: BillForecastMonth[] = [
  { month: '2026-11', total: 182.5, items: [] },
  { month: '2026-12', total: 790, items: [{ bill: internet, due_date: '2026-12-05', amount: 100, basis: 'expected' }] },
];

const renderPage = (route = '/bills') => renderWithProviders(<Theme><BillsPage /></Theme>, { route });

describe('BillsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.month.mockResolvedValue(november);
    api.forecast.mockResolvedValue(forecast);
  });

  it("shows the month's bills, their status and what paid them, with the month's totals", async () => {
    renderPage('/bills?month=2026-11');
    expect(api.month).toHaveBeenCalledWith('2026-11');
    expect(screen.getByText('November 2026')).toBeInTheDocument();

    const table = await screen.findByRole('table');
    const internetRow = within(table).getByRole('row', { name: /Internet/ });
    expect(within(internetRow).getByText('Paid')).toBeInTheDocument();
    expect(within(internetRow).getByText('$92.50 on Nov 3, 2026')).toBeInTheDocument();
    expect(within(internetRow).getByRole('link', { name: 'EXAMPLE CABLE' })).toHaveAttribute('href', '/transactions/tx-1');
    expect(within(within(table).getByRole('row', { name: /Electric/ })).getByText('Upcoming')).toBeInTheDocument();

    expect(screen.getByText('Still to pay').nextElementSibling).toHaveTextContent('$90.00');
    expect(screen.getByText('Payments with no due date')).toBeInTheDocument();
    expect(screen.getByText('Car insurance')).toBeInTheDocument();
  });

  it('moves between months in the URL', async () => {
    renderPage('/bills?month=2026-11');
    await screen.findByText('November 2026');
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(api.month).toHaveBeenLastCalledWith('2026-12'));
  });

  it('skips a due date with a note', async () => {
    api.resolve.mockResolvedValue({ ...november.occurrences[1], status: 'skipped', resolution: 'skipped' });
    renderPage('/bills?month=2026-11');
    const table = await screen.findByRole('table');
    await userEvent.click(within(table).getByRole('button', { name: /Actions for Electric/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Skip this time…' }));
    await userEvent.type(await screen.findByLabelText('Why'), 'Credit applied');
    await userEvent.click(screen.getByRole('button', { name: 'Skip' }));

    await waitFor(() => expect(api.resolve).toHaveBeenCalledWith('occ-electric', { resolution: 'skipped', note: 'Credit applied' }));
  });

  it("links a payment from the bill's recent transactions", async () => {
    api.candidates.mockResolvedValue([
      { transaction_uuid: 'tx-elec', date: '2026-11-20', amount: 88, description: 'CITY POWER', account: 'Checking', budget_item: 'Electric', linked_due_date: null },
    ]);
    api.link.mockResolvedValue(november.occurrences[1]);
    renderPage('/bills?month=2026-11');
    await userEvent.click(within(await screen.findByRole('table')).getByRole('button', { name: /Actions for Electric/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Link a payment…' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Link' }));

    await waitFor(() => expect(api.link).toHaveBeenCalledWith('occ-electric', 'tx-elec'));
  });

  it('shows the forecast by month', async () => {
    renderPage('/bills?month=2026-11');
    expect(await screen.findByRole('button', { name: 'December 2026: $790.00 in 1 bills' })).toBeInTheDocument();
  });
});
