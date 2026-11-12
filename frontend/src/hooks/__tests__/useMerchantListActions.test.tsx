import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useMerchantListActions } from '../useMerchantListActions';
import { deleteMerchant, exportMerchants, mergeMerchants, removeUnusedMerchants, type Merchant } from '../../services/api';
import { saveBlob } from '../../utils/saveBlob';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    deleteMerchant: vi.fn(),
    mergeMerchants: vi.fn(),
    removeUnusedMerchants: vi.fn(),
    exportMerchants: vi.fn(),
  };
});
vi.mock('../../utils/saveBlob', () => ({ saveBlob: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const acme = { id: 1, uuid: 'm-1', name: 'Acme' } as Merchant;

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return { invalidate, result: renderHook(() => useMerchantListActions(), { wrapper }).result };
}

describe('useMerchantListActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(deleteMerchant).mockResolvedValue();
    vi.mocked(mergeMerchants).mockResolvedValue();
  });

  it('deletes the chosen merchant, sending a replacement only when one is chosen, then closes', async () => {
    const { result } = setup();
    act(() => result.current.openDelete(acme));
    expect(result.current).toMatchObject({ dialog: 'delete', selectedMerchant: acme });
    await act(() => result.current.deleteSelected());
    expect(deleteMerchant).toHaveBeenLastCalledWith('m-1', undefined);

    act(() => result.current.openDelete(acme));
    act(() => result.current.setReplacementMerchant('m-2'));
    await act(() => result.current.deleteSelected());
    expect(deleteMerchant).toHaveBeenLastCalledWith('m-1', 'm-2');
    expect(toast.success).toHaveBeenCalledWith('Merchant deleted successfully');
    expect(result.current).toMatchObject({ dialog: null, selectedMerchant: null, replacementMerchant: null });
  });

  it('asks for a replacement when the merchant is in use, and stays open', async () => {
    vi.mocked(deleteMerchant).mockRejectedValue(new Error('Merchant in use by 3 transactions'));
    const { result } = setup();
    act(() => result.current.openDelete(acme));
    await act(() => result.current.deleteSelected());
    expect(toast.error).toHaveBeenCalledWith('This merchant is in use. Please select a replacement merchant.');
    expect(result.current.dialog).toBe('delete');
  });

  it('merges into the chosen target, refreshes the transactions, and closes', async () => {
    const { invalidate, result } = setup();
    act(() => result.current.openMerge(acme));
    await act(() => result.current.mergeSelected());
    expect(mergeMerchants).not.toHaveBeenCalled(); // no target yet

    act(() => result.current.setTargetMerchant('m-2'));
    await act(() => result.current.mergeSelected());
    expect(mergeMerchants).toHaveBeenCalledWith('m-1', 'm-2');
    expect(invalidate).toHaveBeenCalled();
    expect(result.current).toMatchObject({ dialog: null, targetMerchant: null });
  });

  it('removes the unused merchants only once confirmed', async () => {
    vi.mocked(removeUnusedMerchants).mockResolvedValue({ message: 'Removed 2 merchants', removedCount: 2 } as Awaited<ReturnType<typeof removeUnusedMerchants>>);
    const { result } = setup();
    let done: Promise<void> = Promise.resolve();
    act(() => { done = result.current.removeUnused(); });
    await waitFor(() => expect(result.current.confirmationProps.isOpen).toBe(true));
    expect(removeUnusedMerchants).not.toHaveBeenCalled();
    act(() => result.current.confirmationProps.onConfirm());
    await act(() => done);
    expect(removeUnusedMerchants).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Removed 2 merchants');
  });

  it("exports to a dated file, and says why when it can't", async () => {
    vi.mocked(exportMerchants).mockResolvedValue(new Blob(['x']));
    const { result } = setup();
    await act(() => result.current.exportAll());
    expect(saveBlob).toHaveBeenCalledWith(expect.any(Blob), expect.stringMatching(/^merchants_\d{4}-\d{2}-\d{2}\.csv$/));

    vi.mocked(exportMerchants).mockRejectedValue(new Error('Export is busy'));
    await act(() => result.current.exportAll());
    expect(toast.error).toHaveBeenLastCalledWith('Export is busy');
    expect(result.current.exporting).toBe(false);
  });
});
