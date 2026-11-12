import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import type { ZeroBalanceAccount, ZeroBalanceSummary } from '../../../services/api';
import ZeroBalanceAccountsSection from '../ZeroBalanceAccountsSection';
import EnvelopeReconciliationSection from '../EnvelopeReconciliationSection';

const clearing: ZeroBalanceAccount = {
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
const summary = { total_accounts: 1, balanced_accounts: 1, unbalanced_accounts: 0 } as unknown as ZeroBalanceSummary;

const renderSection = (props: { accounts?: ZeroBalanceAccount[]; isLoading?: boolean }) =>
  renderWithProviders(
    <Theme>
      <ZeroBalanceAccountsSection accounts={[]} summary={summary} periodId="p-1" fullAccounts={[]} budgetPeriods={[]} {...props} />
    </Theme>,
  );

/**
 * Tailwind layout on an element: spacing, margins, padding and grids, which belong in
 * Radix props (a Card's padding is its `size`).
 */
const TAILWIND_LAYOUT = /^-?(?:space-[xy]|[mp][trblxy]?|gap(?:-[xy])?|grid-cols)-\d+$|^(?:grid|block|flex)$/;
const tailwindLayout = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('*')].flatMap((el) =>
    [...el.classList].filter((name) => TAILWIND_LAYOUT.test(name)).map((name) => `${el.tagName.toLowerCase()}.${name}`),
  );

describe('ZeroBalanceAccountsSection', () => {
  // The loading and empty states drew a bare Info icon, with no tip behind it, where
  // the envelope reconciliation beside it has an InfoPopover in every state.
  it.each([
    ['loading', { isLoading: true }],
    ['with no zero-balance accounts', {}],
    ['with its accounts', { accounts: [clearing] }],
  ])('explains the section from its tip when %s', async (_state, props) => {
    renderSection(props);
    await userEvent.click(screen.getByRole('button', { name: 'About zero-balance accounts' }));
    expect(await screen.findByText(/require a zero balance at month-end/)).toBeInTheDocument();
  });

  it.each([
    ['loading', { isLoading: true }],
    ['with no zero-balance accounts', {}],
    ['with its accounts', { accounts: [clearing] }],
  ])('is laid out with Radix, not Tailwind spacing, when %s', (_state, props) => {
    const { container } = renderSection(props);
    expect(tailwindLayout(container)).toEqual([]);
  });
});

// The Radix layout first used Radix's md and lg (1024px, 1280px) for the grid, where
// the Tailwind classes it replaced switched at 768px and 1024px; and a Card size that gave the
// old padding gave larger corners too (size 3 radius-5, size 5 radius-6), where every Close-Out
// card has size 1's and 2's (radius-4). Measured in a browser against ddbfc362, the boxes match.
/** Whether a card has the corners every Close-Out card has: its size's, or put back. */
const cornersKept = (card: Element) =>
  card.classList.contains('rt-r-size-1') || card.classList.contains('rt-r-size-2')
  || card.classList.contains('[--card-border-radius:var(--radius-4)]');

describe('Close-Out cards and grid, as they were', () => {
  it('shows the accounts one a row, two from 768px and three from 1024px', () => {
    const { container } = renderSection({ accounts: [clearing] });
    const grid = container.querySelector('.rt-Grid');
    // Radix's sm is 768px and its md 1024px, Tailwind's md and lg here (index.css).
    expect([...(grid?.classList ?? [])].filter((name) => /gtc/.test(name)).sort()).toEqual(['md:rt-r-gtc-3', 'rt-r-gtc-1', 'sm:rt-r-gtc-2']);
  });

  it.each([
    ['the zero-balance section loading', () => renderSection({ isLoading: true })],
    ['the zero-balance section empty', () => renderSection({})],
    ['the envelope reconciliation loading', () => renderWithProviders(<Theme><EnvelopeReconciliationSection reconciliation={null} isLoading /></Theme>)],
    ['the envelope reconciliation empty', () => renderWithProviders(<Theme><EnvelopeReconciliationSection reconciliation={null} /></Theme>)],
  ])('keeps the 8px corners on every card of %s', (_state, render) => {
    const { container } = render();
    const cards = [...container.querySelectorAll('.rt-Card')];
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((card) => !cornersKept(card)).map((card) => card.className)).toEqual([]);
  });
});

describe('EnvelopeReconciliationSection layout', () => {
  // Its empty state's card kept `p-12`.
  it.each([
    ['loading', { isLoading: true }],
    ['with no envelope account', {}],
  ])('is laid out with Radix, not Tailwind spacing, when %s', (_state, props) => {
    const { container } = renderWithProviders(
      <Theme>
        <EnvelopeReconciliationSection reconciliation={null} {...props} />
      </Theme>,
    );
    expect(tailwindLayout(container)).toEqual([]);
  });
});
