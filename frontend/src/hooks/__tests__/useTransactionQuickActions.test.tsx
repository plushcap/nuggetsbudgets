import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'react-hot-toast';
import { useTransactionQuickActions, type QuickActionContext } from '../useTransactionQuickActions';
import { applyTagToTransaction, removeTagFromTransaction, updateTransaction, type Transaction } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, updateTransaction: vi.fn(), applyTagToTransaction: vi.fn(), removeTagFromTransaction: vi.fn() };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const transaction = { uuid: 't-1', review_status: 'needs review' } as Transaction;
const context = {
  budgetPeriods: [{ id: 3, name: 'October 2026' }],
  budgetItems: [{ id: 5, name: 'Groceries' }],
  users: [{ id: 7, first_name: 'Alice' }],
  tags: [{ uuid: 'tag-1', name: 'Vacation' }],
} as unknown as QuickActionContext;

function setup(onUpdated?: () => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useTransactionQuickActions(context, onUpdated), { wrapper }).result;
}

describe('useTransactionQuickActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateTransaction).mockResolvedValue({} as Awaited<ReturnType<typeof updateTransaction>>);
    vi.mocked(applyTagToTransaction).mockResolvedValue();
    vi.mocked(removeTagFromTransaction).mockResolvedValue();
  });

  // The table's own fallback sent `user_id`, which the API ignores, and answered 200.
  it('assigns with assigned_to, and unassigns with null', async () => {
    const actions = setup();
    expect(await actions.current.assignUser(transaction, 7)).toBe(true);
    expect(updateTransaction).toHaveBeenLastCalledWith('t-1', { assigned_to: 7 });
    expect(toast.success).toHaveBeenLastCalledWith('Transaction assigned to Alice');

    expect(await actions.current.assignUser(transaction, null)).toBe(true);
    expect(updateTransaction).toHaveBeenLastCalledWith('t-1', { assigned_to: null });
    expect(toast.success).toHaveBeenLastCalledWith('Transaction unassigned');
  });

  it("shows the server's reason when a save fails, and doesn't report an update", async () => {
    const onUpdated = vi.fn();
    vi.mocked(updateTransaction).mockRejectedValue(new Error('This transaction is split; assign its parts instead'));
    const actions = setup(onUpdated);

    expect(await actions.current.changeBudgetItem(transaction, 5)).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('This transaction is split; assign its parts instead');
    expect(toast.success).not.toHaveBeenCalled();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('saves each action and names what changed', async () => {
    const onUpdated = vi.fn();
    const actions = setup(onUpdated);

    await actions.current.toggleReviewed(transaction);
    expect(updateTransaction).toHaveBeenLastCalledWith('t-1', { review_status: 'reviewed' });
    await actions.current.changeBudgetPeriod(transaction, 3);
    expect(updateTransaction).toHaveBeenLastCalledWith('t-1', { budget_period_id: 3 });
    expect(toast.success).toHaveBeenLastCalledWith('Budget period updated to October 2026');
    await actions.current.changeBudgetItem(transaction, null);
    expect(updateTransaction).toHaveBeenLastCalledWith('t-1', { budget_item_id: null });
    expect(toast.success).toHaveBeenLastCalledWith('Budget item updated to None');
    await actions.current.applyTag(transaction, 'tag-1');
    expect(applyTagToTransaction).toHaveBeenCalledWith('t-1', 'tag-1');
    expect(toast.success).toHaveBeenLastCalledWith('Tag "Vacation" applied');
    await actions.current.removeTag(transaction, 'tag-1');
    expect(removeTagFromTransaction).toHaveBeenCalledWith('t-1', 'tag-1');
    expect(onUpdated).toHaveBeenCalledTimes(5);
  });

  // AuthContext already says the session expired; a second toast repeated it.
  it("doesn't add its own toast when the session has expired", async () => {
    const expired = Object.assign(new Error('Session expired'), { name: 'SessionExpiredError' });
    vi.mocked(updateTransaction).mockRejectedValue(expired);
    const actions = setup();
    expect(await actions.current.toggleReviewed(transaction)).toBe(false);
    expect(toast.error).not.toHaveBeenCalled();
  });
});
