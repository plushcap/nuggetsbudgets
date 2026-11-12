import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../../test/renderWithProviders';
import { useAccountTransactionsQuery } from '../accounts';
import { transaction, transactionsPage } from '../../../test/fixtures';

/** Answers held until a test releases them, by the request's account and page. */
const held = new Map<string, () => void>();
const answerKey = (account: string, page: number) => `${account}:${page}`;
const release = async (account: string, page: number) => {
  await waitFor(() => expect(held.has(answerKey(account, page))).toBe(true));
  await act(async () => held.get(answerKey(account, page))?.());
};

beforeEach(() => {
  held.clear();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const parts = url.pathname.split('/');
    const account = parts[parts.length - 2] ?? '';
    const page = Number(url.searchParams.get('page'));
    // A whole answer, as the register's schema checks it.
    const body = transactionsPage([transaction({ id: page, description: `${account}-tx-${page}` })], { page, limit: 25, total: 50 });
    return new Promise<Response>((resolve) => {
      held.set(answerKey(account, page), () =>
        resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const render = () => {
  const client = makeTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(
    ({ account, page }: { account: string; page: number }) => useAccountTransactionsQuery(account, { page, limit: 25 }),
    { wrapper, initialProps: { account: 'checking', page: 1 } },
  );
};
const shown = (data: { transactions: { description: string | null }[] } | undefined) => data?.transactions.map((t) => t.description);

// The account page kept its previous page up across accounts, so a route that moved to
// another account without remounting showed the last account's rows until the new one answered.
describe('useAccountTransactionsQuery placeholder', () => {
  it("keeps an account's previous page up while its next one loads", async () => {
    const { result, rerender } = render();
    await release('checking', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['checking-tx-1']));

    rerender({ account: 'checking', page: 2 });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(shown(result.current.data)).toEqual(['checking-tx-1']);
  });

  it("never shows another account's rows while an account loads", async () => {
    const { result, rerender } = render();
    await release('checking', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['checking-tx-1']));

    rerender({ account: 'savings', page: 1 });
    expect(result.current.data).toBeUndefined();
    await release('savings', 1);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['savings-tx-1']));
  });
});
