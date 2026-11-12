import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useMerchantRuleTest } from '../useMerchantRuleTest';
import { applyMerchantRules, testMerchantRules, type Merchant } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, testMerchantRules: vi.fn(), applyMerchantRules: vi.fn() };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const acme = { id: 1, uuid: 'm-1', name: 'Acme' } as Merchant;
const match = (id: number) => ({
  id,
  uuid: `t-${id}`,
  description: `ACME ${id}`,
  import_payee: null,
  amount: -10,
  transaction_date: '2026-10-20',
  type: 'expense',
  account_name: 'Checking',
  matchingRule: { id: 1, method: 'contains' as const, matching_text: 'ACME' },
});

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useMerchantRuleTest(acme), { wrapper }).result;
}

describe('useMerchantRuleTest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(testMerchantRules).mockResolvedValue({ matchingTransactions: [match(11), match(12)], totalRules: 1, message: 'Found 2' });
    vi.mocked(applyMerchantRules).mockResolvedValue({ updatedCount: 1, merchantName: 'Acme', message: 'Updated 1 transaction' });
  });

  it('selects matches one by one, all at once, and none again', async () => {
    const test = setup();
    await act(() => test.current.runTest());
    expect(testMerchantRules).toHaveBeenCalledWith('m-1');
    expect(test.current.results?.matchingTransactions).toHaveLength(2);

    act(() => test.current.toggle(11));
    expect([...test.current.selected]).toStrictEqual([11]);
    expect(test.current.allSelected).toBe(false);
    act(() => test.current.toggleAll());
    expect([...test.current.selected].sort()).toStrictEqual([11, 12]);
    expect(test.current.allSelected).toBe(true);
    act(() => test.current.toggleAll());
    expect(test.current.selected.size).toBe(0);
    act(() => test.current.toggle(12));
    act(() => test.current.toggle(12));
    expect(test.current.selected.size).toBe(0);
  });

  it('asks for a selection before applying', async () => {
    const test = setup();
    await act(() => test.current.applySelected());
    expect(toast.error).toHaveBeenCalledWith('Please select transactions to apply rules to');
    expect(applyMerchantRules).not.toHaveBeenCalled();
  });

  it('applies the merchant to the chosen matches once confirmed, then tests again with nothing chosen', async () => {
    const test = setup();
    await act(() => test.current.runTest());
    act(() => test.current.toggle(12));
    let done: Promise<void> = Promise.resolve();
    act(() => { done = test.current.applySelected(); });
    await waitFor(() => expect(test.current.confirmationProps.isOpen).toBe(true));
    act(() => test.current.confirmationProps.onConfirm());
    await act(() => done);

    expect(applyMerchantRules).toHaveBeenCalledWith('m-1', [12]);
    expect(toast.success).toHaveBeenCalledWith('Updated 1 transaction');
    expect(testMerchantRules).toHaveBeenCalledTimes(2);
    expect(test.current.selected.size).toBe(0);
    expect(test.current.applying).toBe(false);
  });

  it("says why a test failed, and keeps the last results", async () => {
    const test = setup();
    await act(() => test.current.runTest());
    vi.mocked(testMerchantRules).mockRejectedValue(new Error('Rule pattern timed out'));
    await act(() => test.current.runTest());
    expect(toast.error).toHaveBeenCalledWith('Rule pattern timed out');
    expect(test.current.results?.matchingTransactions).toHaveLength(2);
    expect(test.current.testing).toBe(false);
  });
});
