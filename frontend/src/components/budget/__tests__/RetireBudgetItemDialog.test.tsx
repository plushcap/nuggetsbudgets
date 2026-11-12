import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import type { BudgetItemUsage } from '@nuggets/shared';
import { renderWithProviders } from '../../../test/renderWithProviders';
import RetireBudgetItemDialog from '../RetireBudgetItemDialog';
import { budgetItem, uuidFor } from '../../../test/fixtures';

const api = vi.hoisted(() => ({ usage: vi.fn(), archive: vi.fn(), restore: vi.fn(), remove: vi.fn(), items: vi.fn() }));
vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return {
    ...actual,
    getBudgetItemUsage: (uuid: string) => api.usage(uuid),
    archiveBudgetItem: (uuid: string) => api.archive(uuid),
    restoreBudgetItem: (uuid: string) => api.restore(uuid),
    deleteBudgetItem: (uuid: string) => api.remove(uuid),
    getBudgetItems: () => api.items(),
  };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const usage = (overrides: Partial<BudgetItemUsage> = {}): BudgetItemUsage => ({
  transactions: 12, first_transaction_date: '2025-04-09', last_transaction_date: '2026-09-28',
  rules: 2, budget_periods: 14, attachments: 0, balance: 0, archived: false, can_delete: false, history_before_current_period: true, linked_goals: [], ...overrides,
});

const renderDialog = (onDone = vi.fn()) => {
  renderWithProviders(
    <Theme>
      <RetireBudgetItemDialog item={{ uuid: 'item-1', name: 'Vacation', income: false }} onClose={vi.fn()} onDone={onDone} />
    </Theme>,
  );
  return onDone;
};

describe('RetireBudgetItemDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.items.mockResolvedValue([]);
    api.archive.mockResolvedValue({ message: 'ok' });
    api.restore.mockResolvedValue({ message: 'ok' });
    api.remove.mockResolvedValue(undefined);
  });

  it("says what the item holds, and won't archive or merge an envelope with money in it", async () => {
    api.usage.mockResolvedValue(usage({ balance: 100 }));
    renderDialog();
    expect(await screen.findByText(/It holds \$100\.00\. Transfer that to another budget item/)).toBeInTheDocument();
    expect(screen.getByText(/12 transactions, Apr 9, 2025 to Sep 28, 2026 · 2 matching rules · budgets in 14 periods/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Merge and archive' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Delete for good' })).not.toBeInTheDocument();
  });

  // By design, a goal counts only envelopes, so an item a goal links (now
  // or before) merges only into an envelope; the server refuses the rest (MERGE_UNLINKS_GOALS).
  it('says, before merging, that a goal counts it, and merges it only into an envelope', async () => {
    api.usage.mockResolvedValue(usage({ linked_goals: [{ uuid: uuidFor(6, 1), name: 'House deposit', deleted: false }] }));
    api.items.mockResolvedValue([
      budgetItem({ id: 2, name: 'Gifts', type: 'Monthly', subtype: 'Flexible', rollover: false }),
      budgetItem({ id: 3, name: 'Savings pot', type: 'Envelope', subtype: 'Flexible', rollover: true }),
    ]);
    renderDialog();
    const choose = async (name: string) => {
      await userEvent.click(await screen.findByRole('button', { name: /Choose the item to merge into|Selected:/ }));
      await userEvent.click(await screen.findByRole('option', { name: new RegExp(name) }));
    };
    await choose('Gifts');
    expect(screen.getByText(/counts toward the goal House deposit, and Gifts isn’t an envelope/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge and archive' })).toBeDisabled();
    await choose('Savings pot');
    expect(screen.queryByText(/counts toward the goal/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge and archive' })).toBeEnabled();
  });

  // By design, a deleted goal keeps blocking such a merge, marked as
  // deleted, with the way through; two goals of one name are each named.
  it('names a deleted goal as deleted, and each of two goals with one name, before merging', async () => {
    api.usage.mockResolvedValue(usage({
      linked_goals: [
        { uuid: uuidFor(6, 2), name: 'Dup goal', deleted: false },
        { uuid: uuidFor(6, 3), name: 'Dup goal', deleted: false },
        { uuid: uuidFor(6, 4), name: 'Old trip', deleted: true },
      ],
    }));
    api.items.mockResolvedValue([budgetItem({ id: 2, name: 'Gifts', type: 'Monthly', subtype: 'Flexible', rollover: false })]);
    renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: /Choose the item to merge into/ }));
    await userEvent.click(await screen.findByRole('option', { name: /Gifts/ }));
    expect(screen.getByText(
      'Vacation counts toward the goals Dup goal, Dup goal, Old trip (deleted), and Gifts isn’t an envelope, which a goal can’t count. ' +
      'Merging would take its money out of those goals’ history, so merge it into an envelope instead. ' +
      'A deleted goal keeps its history, so it counts as well; unlinking a goal doesn’t help either, since its past readings keep the link.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Merge and archive' })).toBeDisabled();
  });

  it('archives an item and reports it', async () => {
    api.usage.mockResolvedValue(usage());
    const onDone = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(api.archive).toHaveBeenCalledWith('item-1'));
    expect(onDone).toHaveBeenCalledWith('archived');
  });

  it('deletes an item nothing uses', async () => {
    api.usage.mockResolvedValue(usage({ transactions: 0, rules: 0, budget_periods: 0, first_transaction_date: null, last_transaction_date: null, can_delete: true }));
    const onDone = renderDialog();
    await userEvent.click(await screen.findByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('item-1'));
    expect(onDone).toHaveBeenCalledWith('deleted');
  });

  it('offers Restore for an archived item', async () => {
    api.usage.mockResolvedValue(usage({ archived: true }));
    const onDone = renderDialog();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(api.restore).toHaveBeenCalledWith('item-1'));
    expect(onDone).toHaveBeenCalledWith('restored');
  });
});
