import { describe, it, expect, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRemoveTagFromTransactionMutation } from '../transactions';
import { useAdjustBalanceMutation } from '../accounts';
import { useCreateManagedBudgetPeriodMutation, useDeleteBudgetPeriodMutation } from '../budgets';
import { invalidateTransactionData } from '../invalidation';
import { authKeys } from '../auth';
import { billKeys } from '../bills';
import { goalKeys, merchantKeys, netWorthKeys, reportKeys, settingsKeys, tagKeys, transactionKeys } from '../keys';
import { adjustAccountBalance, createManagedBudgetPeriod, deleteBudgetPeriod, removeTagFromTransaction } from '../../../services/api';

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return {
    ...actual,
    removeTagFromTransaction: vi.fn(),
    adjustAccountBalance: vi.fn(),
    createManagedBudgetPeriod: vi.fn(),
    deleteBudgetPeriod: vi.fn(),
  };
});

// Screens that show totals derived from transactions.
const derived = [
  transactionKeys.detail('t1'),
  tagKeys.detail('tag-1'),
  merchantKeys.detail('m-1'),
  billKeys.month('2026-10'),
  [...netWorthKeys.all, 'current'],
  goalKeys.list(),
  reportKeys.sankey(undefined, {}),
];
const unrelated = [authKeys.me(), [...settingsKeys.all, 'app']];

function seeded() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const key of [...derived, ...unrelated]) client.setQueryData(key, { seeded: true });
  return client;
}
const invalidated = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;

describe('invalidateTransactionData', () => {
  it('marks every transaction-derived screen stale, and nothing else', () => {
    const client = seeded();
    invalidateTransactionData(client);
    for (const key of derived) expect(invalidated(client, key), JSON.stringify(key)).toBe(true);
    for (const key of unrelated) expect(invalidated(client, key), JSON.stringify(key)).toBe(false);
  });

  it("refreshes a tag's page after a transaction loses that tag", async () => {
    vi.mocked(removeTagFromTransaction).mockResolvedValue(undefined as never);
    const client = seeded();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useRemoveTagFromTransactionMutation(), { wrapper });

    await result.current.mutateAsync(['t1', 'tag-1'] as never);

    expect(invalidated(client, tagKeys.detail('tag-1'))).toBe(true);
    expect(invalidated(client, [...netWorthKeys.all, 'current'])).toBe(true);
  });

  // The net-worth report kept the old total after Adjust Balance.
  it('refreshes net worth and every derived total after a balance adjustment', async () => {
    vi.mocked(adjustAccountBalance).mockResolvedValue(undefined as never);
    const client = seeded();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAdjustBalanceMutation(), { wrapper });

    await result.current.mutateAsync({ uuid: 'a1', targetBalance: 100 });

    for (const key of derived) expect(invalidated(client, key), JSON.stringify(key)).toBe(true);
  });

  // A new period takes the transactions in its dates, and a deleted
  // one gives them back; the transaction lists kept showing the old period.
  it('refreshes transactions when a budget period is created or deleted', async () => {
    vi.mocked(createManagedBudgetPeriod).mockResolvedValue({} as never);
    vi.mocked(deleteBudgetPeriod).mockResolvedValue({} as never);
    for (const useMutationHook of [useCreateManagedBudgetPeriodMutation, useDeleteBudgetPeriodMutation]) {
      const client = seeded();
      const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      );
      const { result } = renderHook(() => useMutationHook(), { wrapper });

      await (result.current.mutateAsync as (args: unknown) => Promise<unknown>)(
        useMutationHook === useDeleteBudgetPeriodMutation ? 'p-1' : [2026, 11],
      );

      expect(invalidated(client, transactionKeys.detail('t1')), useMutationHook.name).toBe(true);
    }
  });
});
