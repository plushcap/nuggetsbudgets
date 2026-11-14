import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../../test/renderWithProviders';
import { useTagTransactionsQuery } from '../referenceData';
import { transaction } from '../../../test/fixtures';

/** Answers held until a test releases them, by the request's tag and offset. */
const held = new Map<string, () => void>();
const answerKey = (tag: string, offset: number) => `${tag}:${offset}`;
const release = async (tag: string, offset: number) => {
  await waitFor(() => expect(held.has(answerKey(tag, offset))).toBe(true));
  await act(async () => held.get(answerKey(tag, offset))?.());
};

beforeEach(() => {
  held.clear();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const parts = url.pathname.split('/');
    const tag = parts[parts.length - 2] ?? '';
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const body = { transactions: [transaction({ id: offset + 1, description: `${tag}-from-${offset}` })], total: 300, limit, offset };
    return new Promise<Response>((resolve) => {
      held.set(answerKey(tag, offset), () =>
        resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })));
    });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const render = () => {
  const client = makeTestQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(
    ({ tag, limit, offset }: { tag: string; limit: number; offset: number }) => useTagTransactionsQuery(tag, { limit, offset }),
    { wrapper, initialProps: { tag: 'holiday', limit: 50, offset: 0 } },
  );
};
const shown = (data: { transactions: { description: string | null }[] } | undefined) => data?.transactions.map((t) => t.description);

// The tag page's table and footer went while the next page loaded (no placeholder), so the
// footer's controls lost focus on every page or size change.
describe('useTagTransactionsQuery placeholder', () => {
  it("keeps a tag's previous page up while its next one, or one of another size, loads", async () => {
    const { result, rerender } = render();
    await release('holiday', 0);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['holiday-from-0']));

    rerender({ tag: 'holiday', limit: 50, offset: 50 });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(shown(result.current.data)).toEqual(['holiday-from-0']);
    await release('holiday', 50);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['holiday-from-50']));

    rerender({ tag: 'holiday', limit: 100, offset: 0 });
    expect(result.current.isPlaceholderData).toBe(true);
    expect(shown(result.current.data)).toEqual(['holiday-from-50']);
  });

  it("never shows another tag's rows while a tag loads", async () => {
    const { result, rerender } = render();
    await release('holiday', 0);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['holiday-from-0']));

    rerender({ tag: 'groceries', limit: 50, offset: 0 });
    expect(result.current.data).toBeUndefined();
    await release('groceries', 0);
    await waitFor(() => expect(shown(result.current.data)).toEqual(['groceries-from-0']));
  });
});
