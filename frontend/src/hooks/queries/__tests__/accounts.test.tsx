import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUpdateAccountWithImageMutation } from '../accounts';
import { accountKeys } from '../keys';
import { updateAccountWithImage } from '../../../services/api';
import type { AccountRow } from '@nuggets/shared';

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return { ...actual, updateAccountWithImage: vi.fn() };
});

describe('useUpdateAccountWithImageMutation', () => {
  it('invalidates account list + detail queries on success', async () => {
    vi.mocked(updateAccountWithImage).mockResolvedValue({ uuid: 'a1' } as unknown as AccountRow);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useUpdateAccountWithImageMutation(), { wrapper });
    await result.current.mutateAsync({ uuid: 'a1', formData: new FormData() });

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: accountKeys.lists() });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: accountKeys.detail('a1') });
  });
});
