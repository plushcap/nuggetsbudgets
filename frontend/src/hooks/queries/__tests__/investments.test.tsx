import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRecordBuyMutation } from '../investments';
import { investmentKeys, accountKeys } from '../keys';
import { recordBuy } from '../../../services/api/investments';

vi.mock('../../../services/api/investments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api/investments')>();
  return { ...actual, recordBuy: vi.fn() };
});

describe('useRecordBuyMutation', () => {
  it('invalidates investments + accounts on success', async () => {
    vi.mocked(recordBuy).mockResolvedValue({ event_uuid: 'e1' } as unknown as Awaited<ReturnType<typeof recordBuy>>);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRecordBuyMutation(), { wrapper });
    await result.current.mutateAsync({
      account_uuid: 'a1', security_uuid: 's1', event_date: '2025-01-01', shares: 1, price_per_share: 1,
      fees: 0, acquisition_method: 'purchase', source: 'manual', adjusted_for_splits: false, dry_run: false,
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: investmentKeys.all });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: accountKeys.all });
  });
});
