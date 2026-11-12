import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { CheckCircle } from 'lucide-react';
import { renderWithProviders } from '../../test/renderWithProviders';
import DashboardSummaryCard from '../DashboardSummaryCard';
import RadixTransactionTable from '../RadixTransactionTable';
import EnvelopeReconciliationSection from '../closeout/EnvelopeReconciliationSection';
import ZeroBalanceAccountsSection from '../closeout/ZeroBalanceAccountsSection';
import EnvelopeSavingsTransferSection from '../closeout/EnvelopeSavingsTransferSection';
import type { BudgetPeriod, EnvelopeReconciliation, Transaction, User, ZeroBalanceAccount } from '../../services/api';

// The account cards aren't what the close-out tests are about.
vi.mock('../closeout/ZeroBalanceAccountCard', () => ({ default: () => null }));

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getTags: vi.fn(async () => []),
    getBudgetItems: vi.fn(async () => []),
    getEnvelopeTransfers: vi.fn(async () => ({
      data: { envelope_account: { id: 9, uuid: 'acc-9', name: 'Envelope savings' }, net_transfer_amount: 250, transfer_count: 1, transfers: [] },
    })),
  };
});

/**
 * What used to open only on a mouse click (a Card's or a row's onClick, a
 * right-click menu) is a link or a button, which the keyboard reaches and a screen
 * reader names.
 */
describe('cards and rows reach the keyboard', () => {
  it('a dashboard card that leads somewhere is a link named by its label, described by its value', () => {
    renderWithProviders(
      <Theme>
        <DashboardSummaryCard icon={CheckCircle} label="Tasks Assigned To Me" value={3} subtitle="Transactions needing review" borderColor="green" to="/tasks" />
      </Theme>,
    );
    const link = screen.getByRole('link', { name: 'Tasks Assigned To Me' });
    expect(link).toHaveAttribute('href', '/tasks');
    expect(link).toHaveAccessibleDescription('3 Transactions needing review');
  });

  it('a dashboard card that opens something is a button', async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Theme>
        <DashboardSummaryCard icon={CheckCircle} label="Overspent Envelopes" value={2} borderColor="red" onClick={onClick} actionLabel="View items →" />
      </Theme>,
    );
    const button = screen.getByRole('button', { name: 'View items' });
    expect(button).toHaveAccessibleDescription('Overspent Envelopes 2');
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("a desktop transaction row's right-click actions also open from a named button", async () => {
    const transaction = {
      id: 1,
      uuid: 't-1',
      description: 'Corner store',
      amount: -12.5,
      transaction_date: '2026-10-20',
      review_status: 'needs review',
      status: 'cleared',
      assigned_to: null,
      tags: [],
    } as unknown as Transaction;
    renderWithProviders(
      <Theme>
        <RadixTransactionTable
          transactions={[transaction]}
          users={[{ id: 7, first_name: 'Alice', last_name: 'Smith' }] as unknown as User[]}
          budgetPeriods={[{ id: 3, name: 'October 2026' }] as unknown as BudgetPeriod[]}
          budgetItems={[]}
          onTransactionClick={vi.fn()}
        />
      </Theme>,
    );
    const [rowButton] = screen.getAllByRole('button', { name: 'Quick actions for Corner store, 10/20/2026' });
    expect(rowButton).toHaveAttribute('aria-haspopup', 'dialog');
    expect(screen.getAllByRole('button', { name: 'Edit Corner store, 10/20/2026' }).length).toBeGreaterThan(0);

    rowButton.focus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Transaction Actions' });
    expect(within(dialog).getByRole('button', { name: /budget period/i })).toBeInTheDocument();
  });
});

// The close-out sections' info tooltips opened on mouse hover only (a group-hover
// div): the keyboard never reached them, and a tap opened them only because `hover:`
// applied on touch screens.
describe("the close-out sections' explanations reach the keyboard and a tap", () => {
  const reconciliation = {
    envelope_account: { uuid: 'acc-9', name: 'Envelope savings', icon: null, actual_balance: 200 },
    budget_summary: { expected_balance: 250, envelope_items_count: 2, total_budgeted: 700, total_spent: -450 },
    variance: { amount: -50, status: 'underfunded', percentage: -20 },
  } as unknown as EnvelopeReconciliation;

  it('envelope reconciliation: a named button opens the explanation from the keyboard', async () => {
    renderWithProviders(<Theme><EnvelopeReconciliationSection reconciliation={reconciliation} /></Theme>);
    const button = screen.getByRole('button', { name: 'About envelope account reconciliation' });
    expect(screen.queryByText(/matches the sum of all envelope budget items/)).toBeNull();
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/matches the sum of all envelope budget items/)).toBeVisible();
  });

  // The open tip had no name, and Tab and Shift+Tab did nothing there (Radix's focus scope
  // swallowed them, with nothing inside to tab to), so only Escape got out.
  it('the open explanation is named, and Tab or Shift+Tab closes it, back on its button', async () => {
    renderWithProviders(<Theme><EnvelopeReconciliationSection reconciliation={reconciliation} /></Theme>);
    const button = screen.getByRole('button', { name: 'About envelope account reconciliation' });
    for (const key of ['{Tab}', '{Shift>}{Tab}{/Shift}']) {
      button.focus();
      await userEvent.keyboard('{Enter}');
      const tip = await screen.findByRole('dialog', { name: 'About envelope account reconciliation' });
      expect(tip).toBeVisible();
      expect(tip).toHaveAccessibleDescription(/matches the sum of all envelope budget items/);
      await userEvent.keyboard(key);
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(button).toHaveFocus();
    }
  });

  it('zero-balance accounts: the button opens the explanation on a click or tap', async () => {
    const accounts = [{ uuid: 'acc-1', name: 'Payroll clearing' }] as unknown as ZeroBalanceAccount[];
    const summary = { total_accounts: 1, balanced_count: 1, needs_adjustment_count: 0, total_adjustment_amount: 0 };
    renderWithProviders(
      <Theme>
        <ZeroBalanceAccountsSection accounts={accounts} summary={summary} periodId="p-1" fullAccounts={[]} budgetPeriods={[]} />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'About zero-balance accounts' }));
    expect(await screen.findByText(/require a zero balance at month-end/)).toBeVisible();
  });

  // The envelope savings section explained itself in a `title`, which only a
  // mouse shows.
  it('envelope savings transfers: a named button opens the explanation from the keyboard', async () => {
    renderWithProviders(<Theme><EnvelopeSavingsTransferSection budgetPeriodItems={[]} periodUuid="p-1" isLoading={false} /></Theme>);
    const button = await screen.findByRole('button', { name: 'About envelope savings transfer tracking' });
    button.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(/verify that the correct amount has been transferred/)).toBeVisible();
  });
});
