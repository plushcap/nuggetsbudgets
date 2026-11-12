import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../../test/renderWithProviders';
import { useBudgetItemTransactionsPage } from '../detailSummaries';
import { transaction } from '../../../test/fixtures';

/** GET /api/transactions/paginated, answering `total` transactions in all. */
let total = 0;
const pagesAsked: number[] = [];

beforeEach(() => {
  pagesAsked.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const page = Number(url.searchParams.get('page'));
    const limit = Number(url.searchParams.get('limit'));
    pagesAsked.push(page);
    const count = Math.max(0, Math.min(limit, total - (page - 1) * limit));
    const transactions = Array.from({ length: count }, (_, i) => transaction({ id: (page - 1) * limit + i + 1, amount: '-1.00' }));
    const body = { transactions, pagination: { total, totalPages: Math.ceil(total / limit), page, limit } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
});
afterEach(() => vi.unstubAllGlobals());

// The edit pages' history sidebars said "Page 3 of 2" with nothing in it after
// the item's transactions were moved or deleted while a later page was open.
describe('useBudgetItemTransactionsPage', () => {
  it('goes back to the last page when the list shrinks under the page shown', async () => {
    total = 45; // three pages of 20
    const client = makeTestQueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useBudgetItemTransactionsPage('item-1', 20), { wrapper });
    await waitFor(() => expect(result.current.total).toBe(45));

    act(() => result.current.setPage(3));
    await waitFor(() => expect(result.current.transactions).toHaveLength(5));

    total = 30; // fifteen moved to another item: two pages now
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(result.current.page).toBe(2));
    await waitFor(() => expect(result.current.transactions).toHaveLength(10));
    expect(pagesAsked[pagesAsked.length - 1]).toBe(2);
  });
});
