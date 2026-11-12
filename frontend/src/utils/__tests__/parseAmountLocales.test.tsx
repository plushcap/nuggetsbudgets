import { describe, it, expect, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MONEY_LOCALES, formatMoney, ledgerCurrencies, setFormatMoneyDefaults } from '@nuggets/shared';
import { parseAmount } from '../parseAmount';
import CurrencyInput from '../../components/CurrencyInput';

/**
 * The amount box reads back what it and the pages write, in every locale a ledger can choose
 * (MONEY_LOCALES): en-IN and hi-IN group lakhs and crores (12,34,567.89), which it refused.
 * Each amount, positive and negative, as the box shows it and as the pages show it with the
 * sign or code of any currency a ledger can take (`12,30 $ US`, `1 234,50 kr`, `UK£12.30`),
 * is read as that amount under the ledger's locale; a locale reads more than the general rules,
 * never differently, and refuses what they refuse.
 */
const AMOUNTS = [1234567.89, 100000, 1234.5, 12.3, 0.05];
const CURRENCIES = ledgerCurrencies();

/** What the amount box shows for `value` in `locale` (CurrencyInput's own format). */
const boxText = (value: number, locale: string) => value.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

afterEach(() => setFormatMoneyDefaults({}));

describe('amounts written in each offered locale read back', () => {
  it.each([...MONEY_LOCALES])('%s', (locale) => {
    const wrong: string[] = [];
    for (const magnitude of AMOUNTS) {
      for (const value of [magnitude, -magnitude]) {
        const texts = [boxText(value, locale), ...CURRENCIES.map((currency) => formatMoney(value, { currency, locale }))];
        for (const text of texts) {
          const read = parseAmount(text, true, 2, locale);
          if (read.value !== value) wrong.push(`${JSON.stringify(text)} read ${JSON.stringify(read)}, not ${value}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });
});

/** Read the same under every locale: the general rules' readings. */
const READ: Array<[string, number]> = [
  ['1,234', 1234], ['1.234,56', 1234.56], ['1,234.56', 1234.56], ['1 234 567,89', 1234567.89],
  ['1\u2019234\u2019567.89', 1234567.89], ['1.234.567,89', 1234567.89], ['12,5', 12.5], ['-$5', -5], ['(1,234.56)', -1234.56],
  ['USD 1,234.56', 1234.56], ['1.234,56 eur', 1234.56], ['US$12', 12], ['CHF 12.-', 12], ['12-', -12],
];
/** Refused under every locale, as the general rules refuse them (their misreadings). */
const REFUSED = [
  '1/2', '50%', '1+2', '1-2', '12€50', '50¢', '12 34', '1 2345', '1e2', '1.5k', '2M', '12abc', 'twelve', 'USD12EUR3',
  '1,234.56 dollars', '1.5 MLN', '5 MIL', '12.5 PCT', '12 ABC', 'XYZ 12', 'USD', 'US$', '12.00 CR', '12.00 DR', 'CR 12',
  'Mex$12', 'XX$12', 'ok$5', '12.345', '1.234', "12'5", '0,005',
];
/** What only en-IN and hi-IN read (their lakhs and crores), and every other locale refuses. */
const INDIAN: Array<[string, number]> = [['12,34,567.89', 1234567.89], ['1,00,000.00', 100000], ['₹12,34,567.89', 1234567.89], ['-1,00,000', -100000]];

describe('a locale reads more than the general rules, never differently', () => {
  it.each([...MONEY_LOCALES])('%s', (locale) => {
    const wrong: string[] = [];
    for (const [text, value] of READ) {
      if (parseAmount(text).value !== value) wrong.push(`general rules: ${text}`);
      const read = parseAmount(text, true, 2, locale).value;
      if (read !== value) wrong.push(`${JSON.stringify(text)} read ${read}, not ${value}`);
    }
    for (const text of REFUSED) {
      if (!parseAmount(text).invalid) wrong.push(`general rules take ${text}`);
      if (!parseAmount(text, true, 2, locale).invalid) wrong.push(`${JSON.stringify(text)} read ${parseAmount(text, true, 2, locale).value}`);
    }
    const indian = locale === 'en-IN' || locale === 'hi-IN';
    for (const [text, value] of INDIAN) {
      const read = parseAmount(text, true, 2, locale);
      if (indian ? read.value !== value : !read.invalid) wrong.push(`${JSON.stringify(text)} read ${JSON.stringify(read)}`);
    }
    expect(wrong).toEqual([]);
  });
});

function Box({ onValue }: { onValue: (value: number | null) => void }) {
  const [value, setValue] = useState<number | null>(null);
  return (
    <>
      <label htmlFor="box">Amount</label>
      <CurrencyInput id="box" allowNegative value={value} onChange={(next) => { onValue(next); setValue(next); }} />
    </>
  );
}

describe('the amount box, under each offered locale', () => {
  it.each([...MONEY_LOCALES])('%s: typed and pasted, the box text and the page text', async (locale) => {
    setFormatMoneyDefaults({ currency: 'EUR', locale });
    const user = userEvent.setup();
    for (const [how, text, value] of [
      ['typed', boxText(-1234567.89, locale), -1234567.89],
      ['pasted', formatMoney(100000, { currency: 'EUR', locale }), 100000],
    ] as const) {
      let last: number | null = null;
      const { unmount } = render(<Box onValue={(v) => { last = v; }} />);
      const box = screen.getByRole('textbox', { name: 'Amount' });
      await user.click(box);
      if (how === 'typed') await user.keyboard(text.replace(/[{[]/g, '$&$&'));
      else await user.paste(text);
      await user.tab();
      expect({ how, text, value: last }).toEqual({ how, text, value });
      // And it shows the amount back the ledger's way, which reads as the same amount.
      expect(parseAmount((box as HTMLInputElement).value, true, 2, locale).value).toBe(value);
      unmount();
    }
  });
});
