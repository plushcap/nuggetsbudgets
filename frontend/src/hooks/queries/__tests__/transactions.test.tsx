import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../../test/renderWithProviders';
import { usePaginatedTransactionsQuery } from '../transactions';
import { transaction } from '../../../test/fixtures';

/** Answers held until a test releases them, by the request's merchant and page. */
const held = new Map<string, () => void>();
const answerKey = (merchant: string | null, page: number) => `${merchant}:${page}`;
const release = async (merchant: string, page: number) => {
  await waitFor(() => expect(held.has(answerKey(merchant, page))).toBe(true));
  await act(async () => held.get(answerKey(merchant, page))!());
};

beforeEach(() => {
  held.clear();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const merchant = url.searchParams.get('merchant_uuid');
    const page = Number(url.searchParams.get('page'));
    const body = {
      // A row as the API sends it (the page is parsed with the shared schema); its description names it.
      transactions: [transaction({ id: page, description: `${merchant}-tx-${page}`, amount: '-1.00' })],
      pagination: { total: 50, totalPages: 2, page, limit: 25 },
    };
    return new Promise<Response>((resolve) => {
      held.set(answerKey(merchant, page), () =>
        resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const render = () => {
  const client = makeTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(
    ({ merchant, page }: { merchant: string; page: number }) => usePaginatedTransactionsQuery(page, 25, { merchant_uuid: merchant }),
    { wrapper, initialProps: { merchant: 'cafe', page: 1 } },
  );
};
const shown = (data: { transactions: { description: string | null }[] } | undefined) => data?.transactions.map((t) => t.description);

// The previous page stood in while a new key loaded, whatever had changed, so
// a detail page whose route moved to another merchant (or budget item) without remounting
// showed the last one's rows and total until the new one answered.
describe('usePaginatedTransactionsQuery placeholder', () => {
  it("keeps a merchant's previous page up while its next one loads", async () => {
    const { result, rerender } = render();
    await release('cafe', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['cafe-tx-1']));

    rerender({ merchant: 'cafe', page: 2 });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(shown(result.current.data)).toEqual(['cafe-tx-1']);
    await release('cafe', 2);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['cafe-tx-2']));
  });

  it("never shows another merchant's rows while a merchant loads", async () => {
    const { result, rerender } = render();
    await release('cafe', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['cafe-tx-1']));

    rerender({ merchant: 'garage', page: 1 });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
    await release('garage', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['garage-tx-1']));
  });

  it("drops a placeholder already shown when the merchant changes", async () => {
    const { result, rerender } = render();
    await release('cafe', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['cafe-tx-1']));

    rerender({ merchant: 'cafe', page: 2 }); // page 2 in flight, page 1 standing in
    expect(shown(result.current.data)).toEqual(['cafe-tx-1']);
    rerender({ merchant: 'garage', page: 1 });
    expect(result.current.data).toBeUndefined();
  });
});
