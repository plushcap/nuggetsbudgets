import { describe, it, expect, vi } from 'vitest';
import type { ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import ReauthDialog from '../ReauthDialog';
import AdjustBalanceModal from '../AdjustBalanceModal';
import MoveBalanceToNextPeriodModal from '../closeout/MoveBalanceToNextPeriodModal';

/**
 * Dialogs that hold what was typed in their own state, which lives on while they
 * are closed: each starts over (or clears) when it opens or closes.
 */

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useUserPasskeysQuery: () => ({ data: [] }),
  useAdjustBalanceMutation: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

const client = makeTestQueryClient();
const wrap = (ui: ReactElement) => (
  <QueryClientProvider client={client}>
    <Theme>{ui}</Theme>
  </QueryClientProvider>
);

describe('ReauthDialog', () => {
  const dialog = (open: boolean) => wrap(<ReauthDialog open={open} onConfirmed={vi.fn()} onCancel={vi.fn()} />);

  it('forgets the typed password when it closes', async () => {
    const { rerender } = render(dialog(true));
    await userEvent.type(screen.getByLabelText('Password'), 'hunter2');
    rerender(dialog(false));
    rerender(dialog(true));
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('opens with the password field focused (the dialog focuses its first field)', async () => {
    render(dialog(true));
    await waitFor(() => expect(screen.getByLabelText('Password')).toHaveFocus());
  });
});

describe('AdjustBalanceModal', () => {
  const modal = (open: boolean) =>
    wrap(<AdjustBalanceModal open={open} onOpenChange={vi.fn()} accountUuid="a-1" accountName="Checking" currentBalance={100} />);

  it('starts with an empty new balance each time it opens', async () => {
    const { rerender } = render(modal(true));
    await userEvent.type(screen.getByLabelText('New balance'), '250');
    expect(screen.getByText('+$150.00')).toBeInTheDocument();
    rerender(modal(false));
    rerender(modal(true));
    expect(screen.getByLabelText('New balance')).toHaveValue('');
    expect(screen.queryByText('+$150.00')).not.toBeInTheDocument();
  });
});

describe('MoveBalanceToNextPeriodModal', () => {
  const modal = (open: boolean, periodBalance: number) =>
    wrap(
      <MoveBalanceToNextPeriodModal
        open={open}
        onClose={vi.fn()}
        accountUuid="a-1"
        accountName="Card"
        periodBalance={periodBalance}
        sourcePeriodUuid="p-1"
        sourcePeriodName="March"
        nextPeriodName="April"
        onSuccess={vi.fn()}
      />,
    );
  const amount = () => screen.getByRole('textbox');

  it("starts from the period's balance each time it opens, and follows a new balance while open", async () => {
    // The dialog focuses the amount box when it opens, which shows the plain number.
    const { rerender } = render(modal(true, 50));
    expect(amount()).toHaveFocus();
    expect(amount()).toHaveValue('50');
    await userEvent.clear(amount());
    await userEvent.type(amount(), '20');
    await userEvent.tab();
    expect(amount()).toHaveValue('20.00');

    rerender(modal(false, 50));
    rerender(modal(true, 50));
    await userEvent.tab();
    expect(amount()).not.toHaveFocus();
    expect(amount()).toHaveValue('50.00');

    rerender(modal(true, 75));
    expect(amount()).toHaveValue('75.00');
  });
});

// Text the box can't read is NaN in the form (nullableAmountInput), so a reset
// empties the box. No adjustment is worked out from it, and it is refused as no balance is.
describe('AdjustBalanceModal with a balance it cannot read', () => {
  it('shows no adjustment, and refuses it in the field’s words', async () => {
    render(wrap(<AdjustBalanceModal open onOpenChange={vi.fn()} accountUuid="a-1" accountName="Checking" currentBalance={100} />));
    await userEvent.type(screen.getByLabelText('New balance'), '25o');
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Adjust balance' }));
    expect(await screen.findByText('Enter the balance the account should have.')).toBeInTheDocument();
    expect(screen.getByLabelText('New balance')).toHaveAttribute('aria-invalid', 'true');
  });
});
