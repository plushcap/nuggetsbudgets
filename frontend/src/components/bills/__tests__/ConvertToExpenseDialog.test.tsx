import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import ConvertToExpenseDialog from '../ConvertToExpenseDialog';

const update = vi.hoisted(() => vi.fn());
const usage = vi.hoisted(() => ({ balance: 0, history_before_current_period: false }));
vi.mock('../../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/queries')>();
  return {
    ...actual,
    useUpdateBudgetItemMutation: () => ({ mutateAsync: update, isPending: false }),
    useBudgetItemUsageQuery: (uuid: string | null) => ({ data: uuid ? usage : undefined, isLoading: false }),
  };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderDialog = (rollover: boolean) => renderWithProviders(
  <Theme>
    <ConvertToExpenseDialog open onClose={vi.fn()} item={{ uuid: 'item-1', name: 'Car insurance', rollover }} />
  </Theme>,
);

describe('ConvertToExpenseDialog', () => {
  beforeEach(() => {
    update.mockReset().mockResolvedValue({});
    usage.balance = 0;
    usage.history_before_current_period = false;
  });

  it('keeps an envelope bill an envelope unless told otherwise', async () => {
    renderDialog(true);
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      uuid: 'item-1',
      data: { isbill: false, recurring_payment: false, type: 'Envelope', rollover: true },
    }));
  });

  it('makes a monthly bill a monthly expense, or an envelope when chosen', async () => {
    renderDialog(false);
    await userEvent.click(screen.getByRole('radio', { name: /Envelope/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      uuid: 'item-1',
      data: { isbill: false, recurring_payment: false, type: 'Envelope', rollover: true },
    }));
  });

  // Once it has money in an earlier period, whether it rolls over is fixed.
  it('says, before converting, that its history keeps it rolling over as it does, and converts it as it is', async () => {
    usage.history_before_current_period = true;
    renderDialog(false);
    await userEvent.click(screen.getByRole('radio', { name: /Envelope/ }));
    expect(screen.getByText(/has money recorded in an earlier period/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: /Monthly/ }));
    expect(screen.queryByText(/has money recorded in an earlier period/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      uuid: 'item-1',
      data: { isbill: false, recurring_payment: false, type: 'Monthly', rollover: false },
    }));
  });

  it("won't make a funded envelope monthly", async () => {
    usage.balance = 250;
    renderDialog(true);
    await userEvent.click(screen.getByRole('radio', { name: /Monthly/ }));
    expect(screen.getByText(/It holds \$250\.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
  });
});
