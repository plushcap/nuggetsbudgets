import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { Merchant } from '../../../services/api';
import DeleteMerchantDialog from '../DeleteMerchantDialog';
import MergeMerchantDialog from '../MergeMerchantDialog';

const acme = { id: 1, uuid: 'm-1', name: 'Acme' } as Merchant;
const others = [{ id: 2, uuid: 'm-2', name: 'Acme Inc' }] as Merchant[];

describe('the merchant dialogs', () => {
  it('delete: names its replacement choice, and deletes on confirm', async () => {
    const onConfirm = vi.fn();
    render(
      <Theme>
        <DeleteMerchantDialog merchant={acme} merchants={others} replacementMerchant={null} onReplacementChange={vi.fn()} onConfirm={onConfirm} onCancel={vi.fn()} />
      </Theme>,
    );
    expect(screen.getByRole('combobox', { name: 'Replace with (optional):' })).toHaveTextContent('-- No replacement --');
    await userEvent.click(screen.getByRole('button', { name: 'Delete Merchant' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('delete: offers no replacement when there is no other merchant', () => {
    render(
      <Theme>
        <DeleteMerchantDialog merchant={acme} merchants={[]} replacementMerchant={null} onReplacementChange={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />
      </Theme>,
    );
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('merge: waits for a target, then names it as the one that remains', () => {
    const props = { sourceMerchant: acme, merchants: others, onTargetChange: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() };
    const { rerender } = render(<Theme><MergeMerchantDialog {...props} targetMerchant={null} /></Theme>);
    expect(screen.getByRole('combobox', { name: 'Select target merchant (will keep):' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge Merchants' })).toBeDisabled();
    expect(screen.getByText('Select below...')).toBeInTheDocument();

    rerender(<Theme><MergeMerchantDialog {...props} targetMerchant="m-2" /></Theme>);
    expect(screen.getByRole('button', { name: 'Merge Merchants' })).toBeEnabled();
    expect(screen.getAllByText('Acme Inc').length).toBeGreaterThan(0);
    expect(screen.queryByText('Select below...')).toBeNull();
  });
});
