import { describe, it, expect, vi } from 'vitest';
import { useEffect, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePaginatedTransactionsQuery } from '../transactions';
import { resetLedgerData } from '../invalidation';
import { getPaginatedTransactionsWithFilters } from '../../../services/api';

vi.mock('../../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/api')>();
  return { ...actual, getPaginatedTransactionsWithFilters: vi.fn() };
});

// A server that answers with the ledger active when a request arrives, when the test says.
let activeLedger = 'L1';
type Pending = { page: number; ledger: string; resolve: (value: unknown) => void };
const pending: Pending[] = [];
const answer = (p: Pending) => p.resolve({ transactions: [{ description: `${p.ledger} page ${p.page}` }] });

let setPage: (page: number) => void = () => {};
function TransactionsList() {
  const [page, setPageState] = useState(1);
  useEffect(() => {
    setPage = setPageState;
  }, []);
  const { data } = usePaginatedTransactionsQuery(page, 30);
  const rows = (data as { transactions?: Array<{ description: string }> } | undefined)?.transactions;
  return <div>{rows?.[0]?.description ?? 'loading…'}</div>;
}

describe('a ledger switch during a page change', () => {
  it("shows the loader, not the old ledger's page, until the new ledger answers", async () => {
    vi.mocked(getPaginatedTransactionsWithFilters).mockImplementation(
      ((page = 1) => new Promise((resolve) => pending.push({ page, ledger: activeLedger, resolve }))) as never,
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><TransactionsList /></QueryClientProvider>);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => answer(pending.shift()!));
    expect(await screen.findByText('L1 page 1')).toBeInTheDocument();

    // Within one ledger, the next page keeps page 1 up while it loads.
    act(() => setPage(2));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText('L1 page 1')).toBeInTheDocument();
    pending.shift(); // the old ledger's request, cancelled by the switch

    // The switch lands while page 2 is loading.
    activeLedger = 'L2';
    await act(async () => { void resetLedgerData(client); });
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText('loading…')).toBeInTheDocument();

    act(() => answer(pending.shift()!));
    expect(await screen.findByText('L2 page 2')).toBeInTheDocument();
  });
});
