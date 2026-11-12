import { describe, it, expect, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import ConvertToBillDialog from '../ConvertToBillDialog';

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});

const update = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/queries')>();
  return {
    ...actual,
    useUpdateBudgetItemMutation: () => ({ mutateAsync: update, isPending: false }),
    useBudgetItemUsageQuery: (uuid: string | null) => ({ data: uuid ? { balance: 120 } : undefined, isLoading: false }),
  };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe('ConvertToBillDialog', () => {
  it("makes the envelope a bill from its target amount and date, due yearly unless changed", async () => {
    update.mockResolvedValue({});
    const onClose = vi.fn();
    renderWithProviders(
      <Theme>
        <ConvertToBillDialog
          open
          onClose={onClose}
          item={{ uuid: 'item-1', name: 'Property tax' }}
          defaults={{ amount: 1800, dueDate: '2027-01-15' }}
        />
      </Theme>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));

    await waitFor(() => expect(update).toHaveBeenCalledWith({
      uuid: 'item-1',
      data: {
        isbill: true,
        recurring_payment: true,
        recurring_payment_amount: 1800,
        recurring_payment_frequency: 12,
        recurring_next_payment_date: '2027-01-15',
        subtype: 'Fixed',
        type: 'Envelope',
        rollover: true,
        rollover_target_amount: 1800,
      },
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('asks for a due date when the envelope has none', async () => {
    renderWithProviders(
      <Theme>
        <ConvertToBillDialog open onClose={vi.fn()} item={{ uuid: 'item-1', name: 'Gifts' }} defaults={{ amount: 175 }} />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('Give its next due date.')).toBeInTheDocument();
  });

  it('makes a monthly expense a monthly bill from its budget', async () => {
    update.mockReset().mockResolvedValue({});
    renderWithProviders(
      <Theme>
        <ConvertToBillDialog
          open
          onClose={vi.fn()}
          item={{ uuid: 'item-2', name: 'Phone', rollover: false }}
          defaults={{ amount: 85, frequency: 1, dueDate: '2026-11-20' }}
        />
      </Theme>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({
      uuid: 'item-2',
      data: expect.objectContaining({ recurring_payment_frequency: 1, type: 'Monthly', rollover: false, recurring_payment_amount: 85 }),
    }));
  });

  it("won't make a funded envelope a monthly bill", async () => {
    renderWithProviders(
      <Theme>
        <ConvertToBillDialog
          open
          onClose={vi.fn()}
          item={{ uuid: 'item-3', name: 'Gifts', rollover: true }}
          defaults={{ amount: 175, frequency: 1, dueDate: '2026-12-01' }}
        />
      </Theme>,
    );
    expect(await screen.findByText(/It holds \$120\.00/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Convert' })).toBeDisabled();
  });
});

// Text the box can't read was null in the form, as no amount is, so a reset to
// no amount (new defaults while open) left it in the box. It is NaN now (nullableAmountInput).
describe('ConvertToBillDialog with an amount it cannot read', () => {
  const dialog = (dueDate: string) => (
    <Theme>
      <ConvertToBillDialog open onClose={vi.fn()} item={{ uuid: 'item-1', name: 'Property tax' }} defaults={{ amount: null, dueDate }} />
    </Theme>
  );

  it('empties the box when the dialog starts over, and refuses it meanwhile', async () => {
    update.mockClear();
    const { rerender } = renderWithProviders(dialog('2027-01-15'));
    const box = screen.getByRole('textbox', { name: 'Bill amount' });
    await userEvent.type(box, '12o');
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    expect(await screen.findByText('Give the bill’s amount.')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(box).toHaveValue('12o');
    rerender(dialog('2027-02-15'));
    expect(screen.getByRole('textbox', { name: 'Bill amount' })).toHaveValue('');
  });

  // One past what can be stored was sent, and the server's refusal, which names
  // the body's key, came back as a toast.
  it('refuses an amount past what can be stored beside the box, and sends nothing', async () => {
    update.mockClear();
    renderWithProviders(dialog('2027-01-15'));
    const box = screen.getByRole('textbox', { name: 'Bill amount' });
    await userEvent.type(box, '10000000000');
    await userEvent.click(screen.getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(box).toHaveAccessibleDescription('Enter an amount up to 9,999,999,999.99.'));
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(update).not.toHaveBeenCalled();
  });
});
