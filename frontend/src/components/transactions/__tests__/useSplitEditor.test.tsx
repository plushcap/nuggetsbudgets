import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { TransactionWithSplits } from '@nuggets/shared';
import type { Tag } from '../../TagSelector';
import { useSplitEditor } from '../useSplitEditor';

const splitTransaction = vi.hoisted(() => vi.fn().mockResolvedValue({}));
const unsplitTransaction = vi.hoisted(() => vi.fn().mockResolvedValue({}));

vi.mock('../../../hooks/queries', () => ({
  useSplitTransactionMutation: () => ({ mutateAsync: splitTransaction }),
  useUnsplitTransactionMutation: () => ({ mutateAsync: unsplitTransaction }),
}));
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';

const UUID = '0190a000-0000-7000-8000-0000000000a1';
const tag = { id: 4, uuid: '0190a000-0000-7000-8000-0000000000f4', name: 'Trip', color: null, icon: null };

/** Only the fields the editor reads. */
const transaction = (over: Partial<TransactionWithSplits>) =>
  ({ uuid: UUID, amount: -0.3, budget_period_id: 9, is_split_parent: false, split_children: [], ...over }) as TransactionWithSplits;

const child = (id: number, amount: number, tags = [tag]) =>
  ({ id, uuid: `0190a000-0000-7000-8000-0000000001${id}`, amount, budget_item_id: 2, budget_period_id: 9, tags }) as TransactionWithSplits['split_children'][number];

const setUp = (tx: TransactionWithSplits, confirmed = true) => {
  const whileSaving = vi.fn(async (write: () => Promise<void>) => write());
  const confirmAsync = vi.fn().mockResolvedValue(confirmed);
  const hook = renderHook(() => useSplitEditor({ transaction: tx, confirmAsync, whileSaving }));
  return { ...hook, whileSaving, confirmAsync };
};

describe('useSplitEditor', () => {
  beforeEach(() => {
    splitTransaction.mockClear();
    unsplitTransaction.mockClear();
    vi.mocked(toast.error).mockClear();
  });

  it('starts from the splits there are, positive, each with its tags', () => {
    const { result } = setUp(transaction({ amount: -40, is_split_parent: true, split_children: [child(1, -25), child(2, -15, [])] }));
    act(() => result.current.start());
    expect(result.current.isEditing).toBe(true);
    expect(result.current.pendingSplits).toEqual([
      { amount: 25, budget_item_id: 2, budget_period_id: 9, tag_ids: [4] },
      { amount: 15, budget_item_id: 2, budget_period_id: 9, tag_ids: [] },
    ]);
    expect(result.current.canSave).toBe(true);
  });

  it('adds splits in whole cents, and saves once two or more add up exactly, signed as the transaction', async () => {
    const { result } = setUp(transaction({ amount: -0.3 }));
    act(() => result.current.start());
    act(() => result.current.setNewAmount('0.1'));
    act(() => result.current.addSplit());
    expect(result.current.canSave).toBe(false);
    act(() => result.current.setNewAmount('0.2'));
    // A tag as the ledger's list has it (only its id is sent).
    act(() => result.current.setNewTags([{ ...tag, color: '#123456' } as unknown as Tag]));
    act(() => result.current.addSplit());
    // 0.1 + 0.2 in floats is 0.30000000000000004; in cents it is 30, the transaction's.
    expect(result.current.totalCents).toBe(30);
    expect(result.current.remainingCents).toBe(0);
    expect(result.current.canSave).toBe(true);
    // The next split's boxes are emptied once it is added.
    expect(result.current.newSplit).toEqual({ amount: '', budgetItem: null, tags: [] });

    await act(async () => result.current.save());
    expect(splitTransaction).toHaveBeenCalledWith([
      UUID,
      [
        { amount: -0.1, budget_item_id: null, budget_period_id: 9, tag_ids: [] },
        { amount: -0.2, budget_item_id: null, budget_period_id: 9, tag_ids: [4] },
      ],
    ]);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.pendingSplits).toEqual([]);
  });

  it("refuses a split that isn't a positive amount, and doesn't save splits that don't add up", async () => {
    const { result } = setUp(transaction({ amount: 50 }));
    act(() => result.current.start());
    act(() => result.current.setNewAmount('0'));
    act(() => result.current.addSplit());
    expect(toast.error).toHaveBeenCalledWith('Please enter a valid amount');
    expect(result.current.pendingSplits).toEqual([]);
    // Text the box can't read, which the editor holds as "NaN": `NaN <= 0` let it in.
    vi.mocked(toast.error).mockClear();
    act(() => result.current.setNewAmount(String(Number.NaN)));
    act(() => result.current.addSplit());
    expect(toast.error).toHaveBeenCalledWith('Please enter a valid amount');
    expect(result.current.pendingSplits).toEqual([]);
    for (const amount of ['20', '20']) {
      act(() => result.current.setNewAmount(amount));
      act(() => result.current.addSplit());
    }
    expect(result.current.remainingCents).toBe(1000);
    await act(async () => result.current.save());
    expect(splitTransaction).not.toHaveBeenCalled();
    act(() => result.current.removeSplit(0));
    expect(result.current.pendingSplits).toHaveLength(1);
  });

  it('keeps editing, with the splits, when the server refuses them', async () => {
    splitTransaction.mockRejectedValueOnce(new Error('Split amounts must sum to transaction amount'));
    const { result } = setUp(transaction({ amount: 40, is_split_parent: true, split_children: [child(1, 25), child(2, 15)] }));
    act(() => result.current.start());
    await act(async () => result.current.save());
    expect(toast.error).toHaveBeenCalledWith('Split amounts must sum to transaction amount');
    expect(result.current.isEditing).toBe(true);
    expect(result.current.pendingSplits).toHaveLength(2);
  });

  it('cancels back to no edit', () => {
    const { result } = setUp(transaction({ amount: 40 }));
    act(() => result.current.start());
    act(() => result.current.setNewAmount('5'));
    act(() => result.current.cancel());
    expect(result.current.isEditing).toBe(false);
    expect(result.current.newSplit.amount).toBe('');
  });

  it('unsplits only once confirmed, with the page waiting', async () => {
    const declined = setUp(transaction({ is_split_parent: true }), false);
    await act(async () => declined.result.current.unsplit());
    expect(unsplitTransaction).not.toHaveBeenCalled();

    const confirmed = setUp(transaction({ is_split_parent: true }));
    await act(async () => confirmed.result.current.unsplit());
    expect(confirmed.whileSaving).toHaveBeenCalledTimes(1);
    expect(unsplitTransaction).toHaveBeenCalledWith(UUID);
  });
});
