import { it, expect, vi, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { formatMoney, setFormatMoneyDefaults } from '@nuggets/shared';
import LedgerMoneyFormat from '../LedgerMoneyFormat';
import { resetLedgerData } from '../../hooks/queries/invalidation';

/**
 * A ledger switch while the new ledger's settings load: its amounts showed in the old ledger's
 * currency until they answered ("B: 99,00 €" for a USD ledger after a EUR one), for seconds
 * when the request failed and React Query retried. Its pages now wait for its settings.
 */
const state = vi.hoisted(() => ({
  ledger: 'A' as 'A' | 'B',
  release: undefined as undefined | (() => void),
  failB: false,
}));

const settings = (currency: string, locale: string) => [
  { setting_key: 'application_timezone', setting_value: 'UTC', setting_type: 'string', description: '' },
  { setting_key: 'application_currency', setting_value: currency, setting_type: 'string', description: '' },
  { setting_key: 'application_locale', setting_value: locale, setting_type: 'string', description: '' },
];

vi.mock('../../hooks/queries/settings', async () => {
  const rq = await vi.importActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
  return {
    useGeneralSettingsQuery: () =>
      rq.useQuery({
        queryKey: ['settings', 'general'],
        queryFn: () =>
          state.ledger === 'A'
            ? Promise.resolve(settings('EUR', 'de-DE'))
            : new Promise((resolve, reject) => {
                state.release = () => (state.failB ? reject(new Error('down')) : resolve(settings('USD', 'en-US')));
              }),
      }),
  };
});

/** What every amount on the page reads, as long as it is on screen. */
const seen: string[] = [];
function Page() {
  const { data } = useQuery({ queryKey: ['accounts', 'balance'], queryFn: () => Promise.resolve(state.ledger === 'A' ? 1234.5 : 99) });
  const text = data === undefined ? 'loading' : `${state.ledger}: ${formatMoney(data)}`;
  seen.push(text.replace(/[\u00a0\u202f]/g, ' '));
  return <p data-testid="amount">{text}</p>;
}

const plain = (s: string | null | undefined) => (s ?? '').replace(/[\u00a0\u202f]/g, ' ');

afterEach(() => {
  setFormatMoneyDefaults({});
  state.ledger = 'A';
  state.failB = false;
  seen.length = 0;
});

const switchToB = async (qc: QueryClient) => {
  await waitFor(() => expect(plain(screen.getByTestId('amount').textContent)).toBe('A: 1.234,50 €'));
  state.ledger = 'B';
  await act(async () => {
    void resetLedgerData(qc);
    await new Promise((r) => setTimeout(r, 20));
  });
};

it("never shows a ledger's amounts in the last ledger's format: its pages wait for its settings", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><LedgerMoneyFormat><Page /></LedgerMoneyFormat></QueryClientProvider>);
  await switchToB(qc);
  // B's settings haven't answered: a loader, and no amount of B's.
  expect(screen.queryByTestId('amount')).not.toBeInTheDocument();
  expect(screen.getByText('Loading…')).toBeInTheDocument();
  await act(async () => state.release?.());
  await waitFor(() => expect(screen.getByTestId('amount').textContent).toBe('B: $99.00'));
  expect(seen.filter((text) => text.startsWith('B:'))).toEqual(seen.filter((text) => text.startsWith('B:')).map(() => 'B: $99.00'));
  expect(seen).not.toContain('B: 99,00 €');
});

it("says so when the new ledger's settings fail, and shows none of its amounts", async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={qc}><LedgerMoneyFormat><Page /></LedgerMoneyFormat></QueryClientProvider>);
  state.failB = true;
  await switchToB(qc);
  await act(async () => state.release?.());
  expect(await screen.findByRole('heading', { name: "This ledger didn't load" })).toBeInTheDocument();
  expect(screen.queryByTestId('amount')).not.toBeInTheDocument();
  expect(seen.some((text) => text.startsWith('B:'))).toBe(false);
});
