import { describe, it, expect, afterEach, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../../test/renderWithProviders';
import { mockApi } from '../../../test/apiServer';
import MoveBalanceToNextPeriodModal, { moveBalanceSchema } from '../MoveBalanceToNextPeriodModal';

vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});

afterEach(() => vi.unstubAllGlobals());

const renderModal = (periodBalance: number) =>
  renderWithProviders(
    <Theme>
      <MoveBalanceToNextPeriodModal
        open
        onClose={vi.fn()}
        accountUuid="a-1"
        accountName="Card"
        periodBalance={periodBalance}
        sourcePeriodUuid="p-1"
        sourcePeriodName="March"
        nextPeriodName="April"
        onSuccess={vi.fn()}
      />
    </Theme>,
  );

// The amount is counted in whole cents, not compared as a float with 0.01.
describe('MoveBalanceToNextPeriodModal', () => {
  it('moves a cent worked out in floats as one cent', async () => {
    // 8.03 − 8.02 is 0.009999999999999787 in floats, which `>= 0.01` called less than a cent.
    const oneCent = 8.03 - 8.02;
    expect(oneCent).toBeLessThan(0.01);
    expect(moveBalanceSchema.safeParse({ amount: oneCent }).success).toBe(true);
    expect(moveBalanceSchema.safeParse({ amount: -oneCent }).success).toBe(true);

    // Through the dialog: the box shows it as 0.01, and that is what moves.
    const api = mockApi({ 'POST /transfer/period': { success: true, next_period_name: 'April' } });
    renderModal(oneCent);
    await userEvent.click(screen.getByRole('button', { name: 'Move balance' }));
    await waitFor(() => expect(api.calls('POST /transfer/period')).toHaveLength(1));
    expect(api.calls('POST /transfer/period')[0].body).toMatchObject({ account_uuid: 'a-1', source_period_uuid: 'p-1', amount: 0.01 });
  });

  it('refuses an amount under half a cent, either way, and takes a cent either way', () => {
    expect(moveBalanceSchema.safeParse({ amount: 0.004 }).success).toBe(false);
    expect(moveBalanceSchema.safeParse({ amount: -0.004 }).success).toBe(false);
    expect(moveBalanceSchema.safeParse({ amount: 0 }).success).toBe(false);
    expect(moveBalanceSchema.safeParse({ amount: null }).success).toBe(false);
    expect(moveBalanceSchema.safeParse({ amount: 0.01 }).success).toBe(true);
    expect(moveBalanceSchema.safeParse({ amount: -0.01 }).success).toBe(true);
  });
});

// Text the box can't read is NaN in the form (nullableAmountInput), so a reset
// empties the box; it is refused as no amount is, in the field's words.
describe('MoveBalanceToNextPeriodModal with an amount it cannot read', () => {
  it('refuses it beside the box and moves nothing', async () => {
    expect(moveBalanceSchema.safeParse({ amount: Number.NaN }).error?.issues[0]?.message).toBe('Enter the amount to move (at least a cent).');
    const api = mockApi({ 'POST /transfer/period': { success: true, next_period_name: 'April' } });
    renderModal(50);
    const box = screen.getByRole('textbox', { name: 'Amount to move' });
    await userEvent.clear(box);
    await userEvent.type(box, '12o');
    await userEvent.click(screen.getByRole('button', { name: 'Move balance' }));
    expect(await screen.findByText('Enter the amount to move (at least a cent).')).toBeInTheDocument();
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls('POST /transfer/period')).toHaveLength(0);
  });
});
