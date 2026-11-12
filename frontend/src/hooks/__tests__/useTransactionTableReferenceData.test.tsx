import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useTransactionTableReferenceData } from '../useTransactionTableReferenceData';
import { getBudgetItems, getBudgetPeriods, getTags, getUsers, type BudgetItem, type BudgetPeriod, type Tag, type User } from '../../services/api';

vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, getBudgetPeriods: vi.fn(), getUsers: vi.fn(), getBudgetItems: vi.fn(), getTags: vi.fn() };
});

const periods = [{ id: 3, name: 'October 2026' }] as unknown as BudgetPeriod[];
const users = [{ id: 7, first_name: 'Alice' }] as unknown as User[];
const items = [{ id: 5, name: 'Groceries' }] as unknown as BudgetItem[];
const tags = [
  { id: 1, name: 'Groceries', is_active: true },
  { id: 2, name: 'Old', is_active: false },
] as unknown as Tag[];

function setup(passed: { budgetPeriods: BudgetPeriod[]; users: User[]; budgetItems: BudgetItem[] }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useTransactionTableReferenceData(passed), { wrapper }).result;
}

describe('useTransactionTableReferenceData', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTags).mockResolvedValue(tags);
  });

  it("uses the page's lists without fetching them, and offers only the active tags", async () => {
    const data = setup({ budgetPeriods: periods, users, budgetItems: items });
    await waitFor(() => expect(data.current.allTags).toHaveLength(2));
    expect(data.current).toMatchObject({ budgetPeriods: periods, users, budgetItems: items });
    expect(data.current.activeTags.map((t) => t.name)).toStrictEqual(['Groceries']);
    expect(getBudgetPeriods).not.toHaveBeenCalled();
    expect(getUsers).not.toHaveBeenCalled();
    expect(getBudgetItems).not.toHaveBeenCalled();
  });
});
