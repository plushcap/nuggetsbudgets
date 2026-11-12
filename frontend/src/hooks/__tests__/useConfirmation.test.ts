import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useConfirmation, type UseConfirmationOptions } from '../useConfirmation';

const defaults: UseConfirmationOptions = {
  title: 'Delete tag',
  message: 'This removes the tag from every transaction.',
  confirmText: 'Delete',
  variant: 'danger',
};

/** What the dialog is given: its words and variant. */
const shown = ({ dialogProps }: ReturnType<typeof useConfirmation>) => ({
  title: dialogProps.title,
  message: dialogProps.message,
  confirmText: dialogProps.confirmText,
  variant: dialogProps.variant,
});

// confirm() spread its options over the defaults, so an option passed as undefined (an
// optional value not set, `{ confirmText: label }`) blanked the default: a dialog with no title,
// or a Delete button that read "Confirm".
describe('useConfirmation', () => {
  it("keeps the hook's defaults for an option passed as undefined", () => {
    const { result } = renderHook(() => useConfirmation(defaults));
    act(() => result.current.confirm(vi.fn(), { title: undefined, confirmText: undefined, variant: undefined, message: 'Delete Groceries?' }));
    expect(shown(result.current)).toEqual({ title: 'Delete tag', message: 'Delete Groceries?', confirmText: 'Delete', variant: 'danger' });
  });

  it("keeps them in confirmAsync too, and its own defaults without the hook's", () => {
    const { result } = renderHook(() => useConfirmation(defaults));
    act(() => {
      void result.current.confirmAsync({ title: undefined, variant: undefined });
    });
    expect(shown(result.current)).toEqual({ title: 'Delete tag', message: defaults.message, confirmText: 'Delete', variant: 'danger' });

    const bare = renderHook(() => useConfirmation()).result;
    act(() => bare.current.confirm(vi.fn(), { title: undefined, message: undefined }));
    expect(bare.current.dialogProps.title).toBe('Confirm Action');
    expect(bare.current.dialogProps.message).toBe('Are you sure you want to continue?');
  });

  it('still lets an option given a value replace the default', () => {
    const { result } = renderHook(() => useConfirmation(defaults));
    act(() => result.current.confirm(vi.fn(), { title: 'Archive tag', variant: 'warning' }));
    expect(shown(result.current)).toEqual({ title: 'Archive tag', message: defaults.message, confirmText: 'Delete', variant: 'warning' });
  });
});
