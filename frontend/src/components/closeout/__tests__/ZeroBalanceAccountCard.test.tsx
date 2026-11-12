import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import ZeroBalanceAccountCard from '../ZeroBalanceAccountCard';
import type { ZeroBalanceAccount } from '../../../services/api';

const zero: ZeroBalanceAccount = {
  uuid: '0190c3a0-0000-7000-8000-000000000001',
  name: 'Payroll clearing',
  account_type: 'checking',
  icon: 'Wallet',
  color: '#3b82f6',
  period_balance: 0,
  current_balance: 0,
  is_balanced: true,
  adjustment_needed: 0,
  adjustment_direction: 'balanced',
};

describe('ZeroBalanceAccountCard', () => {
  it('opens the transactions with one link, not a link around a button', () => {
    renderWithProviders(
      <Theme>
        <ZeroBalanceAccountCard account={zero} periodId="p-1" fullAccounts={[]} budgetPeriods={[]} />
      </Theme>,
    );
    const link = screen.getByRole('link', { name: 'View Transactions' });
    expect(link).toHaveAttribute('href', `/accounts/${zero.uuid}`);
    expect(within(link).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('button', { name: 'View Transactions' })).toBeNull();
  });

  it('draws a balanced zero in the accent, which the theme picker drives, not a fixed purple', () => {
    renderWithProviders(
      <Theme>
        <ZeroBalanceAccountCard account={zero} periodId="p-1" fullAccounts={[]} budgetPeriods={[]} />
      </Theme>,
    );
    const balance = screen.getByText('Period Balance').nextElementSibling as HTMLElement;
    expect(balance).toHaveTextContent('$0.00');
    expect(balance.className).toContain('text-[var(--accent-11)]');
    expect(balance.className).not.toContain('purple');
  });

  // The account's balance was written with toLocaleString ("12.34", "(12.34)"), not
  // formatMoney, which money is shown with (CLAUDE.md).
  it.each([
    [12.34, '$12.34', 'text-[var(--green-12)]'],
    [-1234.5, '($1,234.50)', 'text-[var(--red-11)]'],
  ])('shows the current balance %s as money: %s', (current, text, tone) => {
    renderWithProviders(
      <Theme>
        <ZeroBalanceAccountCard account={{ ...zero, current_balance: current }} periodId="p-1" fullAccounts={[]} budgetPeriods={[]} />
      </Theme>,
    );
    expect(screen.getByText(text)).toHaveClass(tone);
  });
});
