import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatMoney, setFormatMoneyDefaults } from '@nuggets/shared';
import LedgerMoneyFormat from '../LedgerMoneyFormat';
import CurrencyInput from '../CurrencyInput';

/**
 * The ledger's currency and locale (General Settings) are formatMoney's defaults on its
 * pages: every amount and every amount box's sign follow them, USD in en-US until set.
 */
const query = vi.hoisted(() => ({
  current: { data: undefined as unknown, isError: false, error: null as unknown, refetch: () => undefined as unknown, isFetching: false },
}));
vi.mock('../../hooks/queries/settings', () => ({ useGeneralSettingsQuery: () => query.current }));

const settings = (currency: string | null, locale: string | null) => [
  { setting_key: 'application_timezone', setting_value: 'Europe/Berlin', setting_type: 'string', description: '' },
  { setting_key: 'application_currency', setting_value: currency, setting_type: 'string', description: '' },
  { setting_key: 'application_locale', setting_value: locale, setting_type: 'string', description: '' },
];

/** Intl separates a currency from its number with a no-break space in some locales. */
const plain = (s: string | null) => (s ?? '').replace(/[\u00a0\u202f]/g, ' ');

/** A page that remembers something of its own, to tell a fresh one from the same one. */
function Page() {
  const [mounted] = useState(() => Math.random());
  return (
    <>
      <p data-testid="amount">{formatMoney(-1234.5)}</p>
      <p data-testid="mounted">{mounted}</p>
      <label htmlFor="amount-box">Amount</label>
      <CurrencyInput id="amount-box" value={12} onChange={() => {}} />
    </>
  );
}

describe('LedgerMoneyFormat', () => {
  afterEach(() => {
    setFormatMoneyDefaults({});
    query.current = { data: undefined, isError: false, error: null, refetch: () => undefined, isFetching: false };
  });

  it("shows the ledger's money in its currency and locale, signs included", () => {
    query.current = { ...query.current, data: settings('EUR', 'de-DE') };
    render(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>);
    expect(plain(screen.getByTestId('amount').textContent)).toBe('-1.234,50 €');
    expect(screen.getByText('€')).toBeInTheDocument();
    // The amount box writes it as the ledger does.
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('12,00');
  });

  it("reads an amount typed the ledger's way, and shows it back that way", async () => {
    query.current = { ...query.current, data: settings('EUR', 'de-DE') };
    const changes: Array<number | null> = [];
    function Box() {
      const [value, setValue] = useState<number | null>(null);
      return (
        <>
          <label htmlFor="typed">Typed</label>
          <CurrencyInput id="typed" value={value} onChange={(next) => { changes.push(next); setValue(next); }} />
        </>
      );
    }
    render(<LedgerMoneyFormat><Box /></LedgerMoneyFormat>);
    const box = screen.getByRole('textbox', { name: 'Typed' });
    await userEvent.type(box, '1.234,56');
    await userEvent.tab();
    expect(changes[changes.length - 1]).toBe(1234.56);
    expect(box).toHaveValue('1.234,56');
  });

  it("shows no page while the settings load, then USD in en-US for a ledger that has none", () => {
    setFormatMoneyDefaults({ currency: 'EUR', locale: 'de-DE' });
    const { rerender } = render(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>);
    expect(screen.queryByTestId('amount')).not.toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    // The last ledger's format is gone while nothing of this one shows.
    expect(formatMoney(1)).toBe('$1.00');
    query.current = { ...query.current, data: settings(null, null) };
    rerender(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>);
    expect(screen.getByTestId('amount').textContent).toBe('-$1,234.50');
    expect(screen.getByText('$')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('12.00');
  });

  it('draws the pages again when the format changes, and only then', () => {
    query.current = { ...query.current, data: settings('USD', 'en-US') };
    const { rerender } = render(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>);
    const first = screen.getByTestId('mounted').textContent;
    rerender(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>);
    expect(screen.getByTestId('mounted').textContent).toBe(first);

    // An admin saves another currency (or the ledger switches): the answer changes.
    query.current = { ...query.current, data: settings('GBP', 'en-GB') };
    act(() => rerender(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>));
    expect(screen.getByTestId('amount').textContent).toBe('-£1,234.50');
    expect(screen.getByTestId('mounted').textContent).not.toBe(first);
  });

  it("says so when the settings fail to load, rather than guess a currency, and tries again", async () => {
    setFormatMoneyDefaults({ currency: 'EUR', locale: 'de-DE' });
    const refetch = vi.fn();
    query.current = { ...query.current, data: undefined, isError: true, error: new Error('down'), refetch };
    render(<LedgerMoneyFormat><Page /></LedgerMoneyFormat>);
    expect(screen.queryByTestId('amount')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: "This ledger didn't load" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refetch).toHaveBeenCalled();
  });
});
