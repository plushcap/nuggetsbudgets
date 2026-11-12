import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  MONEY_LOCALES,
  ledgerCurrencies,
  supportedMoneyLocale,
  currencyCodeProblem,
  currencySymbol,
  formatMoney,
  formatMoneyDefaults,
  moneyLocaleProblem,
  setFormatMoneyDefaults,
} from '@nuggets/shared';
import { formatCurrency } from '../currency';

// The one money formatter (@nuggets/shared formatMoney). Intl separates a currency
// from its number with a no-break space in some locales: compare with spaces normalized.
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, ' ');

describe('formatMoney', () => {
  it('formats numbers and the NUMERIC strings pg returns, USD in en-US by default', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50');
    expect(formatMoney('1234.5')).toBe('$1,234.50');
    expect(formatMoney('-12.30')).toBe('-$12.30');
    expect(formatMoney(' 7 ')).toBe('$7.00');
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('never shows a negative zero', () => {
    expect(formatMoney(-0)).toBe('$0.00');
    expect(formatMoney(-0.004)).toBe('$0.00');
    expect(formatMoney('-0.00')).toBe('$0.00');
    expect(formatMoney(-0.004, { negative: 'parentheses' })).toBe('$0.00');
  });

  it('shows an amount that is not a number as the fallback, never as zero', () => {
    for (const bad of [null, undefined, '', 'abc', '1,234.50', '1e3', NaN, Infinity]) {
      expect(formatMoney(bad as never)).toBe('—');
    }
    expect(formatMoney(null, { fallback: 'Unavailable' })).toBe('Unavailable');
  });

  it('takes the currency and locale', () => {
    expect(plain(formatMoney(1234.5, { currency: 'EUR', locale: 'de-DE' }))).toBe('1.234,50 €');
    expect(formatMoney(1234.5, { currency: 'GBP', locale: 'en-GB' })).toBe('£1,234.50');
    expect(plain(formatMoney(-1234.5, { currency: 'EUR', locale: 'fr-FR' }))).toBe('-1 234,50 €');
  });

  it("rounds to the currency's minor unit", () => {
    expect(formatMoney(1234.56, { currency: 'JPY', locale: 'ja-JP' })).toMatch(/^[￥¥]1,235$/);
    expect(formatMoney(-0.4, { currency: 'JPY', locale: 'ja-JP' })).toMatch(/^[￥¥]0$/);
    expect(formatMoney(2.345)).toBe('$2.35');
  });

  it('rounds half a cent as the decimal it is, not as its float', () => {
    expect(formatMoney(1.005)).toBe('$1.01');
    expect(formatMoney('1.005')).toBe('$1.01');
    expect(formatMoney(1.255)).toBe('$1.26');
    expect(formatMoney('-1.005')).toBe('-$1.01');
    expect(formatMoney('-1.005', { negative: 'parentheses' })).toBe('($1.01)');
    expect(formatMoney('12345678901234.565')).toBe('$12,345,678,901,234.57');
  });

  it('replaces only the setting Intl does not know with its default', () => {
    expect(formatMoney(5, { currency: 'US' })).toBe('$5.00');
    expect(formatMoney(5, { locale: 'not a locale!' })).toBe('$5.00');
    expect(formatMoney(-5, { currency: 'EUR', locale: 'not a locale!' })).toBe('-€5.00');
    expect(plain(formatMoney(-5, { currency: 'EURO', locale: 'de-DE' }))).toBe('-5,00 $');
    // An unset setting read from JSON is null.
    expect(formatMoney(5, { locale: null, currency: null })).toBe('$5.00');
    expect(formatMoney(-5, { locale: null, currency: 'EUR' })).toBe('-€5.00');
    // Never the host's locale (Intl takes 42, [] or '' as "the default locale").
    for (const locale of [42, [], {}, true, ''] as never[]) expect(formatMoney(5, { locale })).toBe('$5.00');
    expect(formatMoney(5, { currency: '' })).toBe('$5.00');
  });

  it('keeps the locale\'s spacing inside parentheses', () => {
    expect(plain(formatMoney(-5, { currency: 'CHF', locale: 'de-CH', negative: 'parentheses' }))).toBe(
      `(${plain(formatMoney(5, { currency: 'CHF', locale: 'de-CH' }))})`
    );
  });

  // Intl decides the sign once the amount is rounded (signDisplay 'negative' / 'exceptZero',
  // Intl.NumberFormat v3, which every supported browser has).
  it('signs an amount as it is once rounded, in every style', () => {
    // Half a cent rounds away from zero, so it keeps its sign; less than half is zero.
    expect(formatMoney('-0.005')).toBe('-$0.01');
    expect(formatMoney('-0.005', { negative: 'parentheses' })).toBe('($0.01)');
    expect(formatMoney('-0.0049')).toBe('$0.00');
    expect(formatMoney('-0.0049', { negative: 'parentheses' })).toBe('$0.00');
    expect(formatMoney('-0')).toBe('$0.00');
    // A plus only on an amount that is positive once rounded.
    expect(formatMoney(0.004, { plusSign: true })).toBe('$0.00');
    expect(formatMoney('-0.004', { plusSign: true })).toBe('$0.00');
    expect(formatMoney(-0, { plusSign: true, negative: 'parentheses' })).toBe('$0.00');
    expect(formatMoney('0.005', { plusSign: true })).toBe('+$0.01');
    expect(formatMoney('-0.005', { plusSign: true })).toBe('-$0.01');
    expect(formatMoney(0.4, { plusSign: true, wholeUnits: true })).toBe('$0');
    expect(formatMoney(-0.5, { wholeUnits: true })).toBe('-$1');
    expect(formatMoney(-0.5, { wholeUnits: true, negative: 'parentheses' })).toBe('($1)');
    // The text's own sign: '+5' is positive, and shows its plus only when asked.
    expect(formatMoney('+5')).toBe('$5.00');
    expect(formatMoney('+5', { plusSign: true })).toBe('+$5.00');
    expect(formatMoney('-.5', { negative: 'parentheses' })).toBe('($0.50)');
    // A positive amount in accounting style still takes the plus it was asked for.
    expect(formatMoney(5, { plusSign: true, negative: 'parentheses' })).toBe('+$5.00');
    expect(formatMoney('-5', { plusSign: true, negative: 'parentheses' })).toBe('($5.00)');
  });

  it('signs with the locale\'s own minus and plus, and keeps its spacing in parentheses', () => {
    // fa-IR's minus is U+2212, with direction marks around it.
    expect(formatMoney(-5, { currency: 'EUR', locale: 'fa-IR' })).toContain('−');
    expect(formatMoney(-5, { currency: 'EUR', locale: 'fa-IR' })).toBe(
      new Intl.NumberFormat('fa-IR', { style: 'currency', currency: 'EUR' }).format(-5)
    );
    expect(plain(formatMoney(-5, { currency: 'EUR', locale: 'nl-NL' }))).toBe('€ -5,00');
    expect(plain(formatMoney(5, { currency: 'EUR', locale: 'nl-NL', plusSign: true }))).toBe('€ +5,00');
    expect(plain(formatMoney(-5, { currency: 'EUR', locale: 'nl-NL', negative: 'parentheses', plusSign: true }))).toBe(
      '(€ 5,00)'
    );
    expect(plain(formatMoney(-5, { currency: 'CHF', locale: 'de-CH', plusSign: true, negative: 'parentheses' }))).toBe(
      `(${plain(formatMoney(5, { currency: 'CHF', locale: 'de-CH' }))})`
    );
    // A bad locale falls back alone with a plus sign too, keeping the currency.
    expect(formatMoney(5, { currency: 'EUR', locale: 'not a locale!', plusSign: true })).toBe('+€5.00');
  });

  it('shows negatives in parentheses, a plus on changes, or whole units, when asked', () => {
    expect(formatMoney(-5, { negative: 'parentheses' })).toBe('($5.00)');
    expect(formatMoney(5, { plusSign: true })).toBe('+$5.00');
    expect(formatMoney(0, { plusSign: true })).toBe('$0.00');
    expect(formatMoney(-5, { plusSign: true })).toBe('-$5.00');
    expect(formatMoney(1234.56, { wholeUnits: true })).toBe('$1,235');
    expect(formatMoney(-0.4, { wholeUnits: true })).toBe('$0');
    expect(formatMoney(-5, { plusSign: true, negative: 'parentheses' })).toBe('($5.00)');
    expect(plain(formatMoney(-5, { currency: 'EUR', locale: 'de-DE', negative: 'parentheses' }))).toBe('(5,00 €)');
  });

  // A chart's axis: GoalAnalysisPage wrote its own `$${(v / 1000).toFixed(0)}k`, which
  // showed $0k for 250, $-2k for a debt and $1500k for a million and a half.
  it('shows the compact form when asked, in whole units, signed as it is once rounded', () => {
    expect(formatMoney(0, { compact: true })).toBe('$0');
    expect(formatMoney(250, { compact: true })).toBe('$250');
    expect(formatMoney(1234, { compact: true })).toBe('$1.2K');
    expect(formatMoney('12345.67', { compact: true })).toBe('$12K');
    expect(formatMoney(999.5, { compact: true })).toBe('$1K');
    expect(formatMoney(1_500_000, { compact: true })).toBe('$1.5M');
    expect(formatMoney(-2500, { compact: true })).toBe('-$2.5K');
    expect(formatMoney(-2500, { compact: true, negative: 'parentheses' })).toBe('($2.5K)');
    // Rounded once, by Intl: whole units first made 1,249.99 1,250 and so "$1.3K".
    expect(formatMoney(1249.99, { compact: true })).toBe('$1.2K');
    expect(formatMoney(1_249_999.6, { compact: true })).toBe('$1.2M');
    expect(formatMoney(-2549.5, { compact: true })).toBe('-$2.5K');
    // Under a unit it is whole: no $0.4, and no -$0.
    expect(formatMoney(0.4, { compact: true })).toBe('$0');
    expect(formatMoney(-0.4, { compact: true })).toBe('$0');
    expect(formatMoney(-0.4, { compact: true, negative: 'parentheses' })).toBe('$0');
    expect(formatMoney(-0.5, { compact: true })).toBe('-$1');
    expect(formatMoney(2500, { compact: true, plusSign: true })).toBe('+$2.5K');
    // It overrides wholeUnits, and an amount that isn't one is still the fallback.
    expect(formatMoney(1234, { compact: true, wholeUnits: true })).toBe('$1.2K');
    expect(formatMoney(null, { compact: true })).toBe('—');
    // The suffix is the locale's own: en-GB's is "K" in Node 22's ICU and "k" in Node 26's.
    expect(formatMoney(1234, { compact: true, currency: 'GBP', locale: 'en-GB' })).toMatch(/^£1\.2[Kk]$/);
  });

  it("matches the existing formatCurrency in its accounting style (what a migration keeps)", () => {
    for (const amount of [0, 1, -1, 1234.56, -98765.43, 0.1 + 0.2]) {
      expect(formatMoney(amount, { negative: 'parentheses' })).toBe(formatCurrency(amount));
    }
  });

  it('is what formatCurrency shows: no negative zero, half a cent as the decimal it is', () => {
    // Its own Intl copy showed ($0.00) for -0.004 and rounded 1.005 by its float, to $1.00.
    expect(formatCurrency(-0.004)).toBe('$0.00');
    expect(formatCurrency(-1.005)).toBe('($1.01)');
    expect(formatCurrency(-1234.5)).toBe('($1,234.50)');
  });
});

// A ledger's currency and locale (General Settings): the SPA makes its ledger's the defaults.
describe("formatMoney's defaults", () => {
  afterEach(() => setFormatMoneyDefaults({}));

  it('are USD in en-US until a ledger sets its own', () => {
    expect(formatMoneyDefaults()).toEqual({ currency: 'USD', locale: 'en-US' });
    expect(currencySymbol()).toBe('$');
  });

  it("follow the ledger's setting, and a call's own options still win", () => {
    setFormatMoneyDefaults({ currency: 'EUR', locale: 'de-DE' });
    expect(plain(formatMoney(-1234.5))).toBe('-1.234,50 €');
    expect(plain(formatMoney(1234.5, { negative: 'parentheses' }))).toBe('1.234,50 €');
    expect(formatMoney(1234.5, { currency: 'USD', locale: 'en-US' })).toBe('$1,234.50');
    expect(currencySymbol()).toBe('€');
    setFormatMoneyDefaults({ currency: 'GBP' });
    expect(formatMoneyDefaults()).toEqual({ currency: 'GBP', locale: 'en-US' });
    expect(formatMoney(5)).toBe('£5.00');
  });

  it('take an unset (null or empty) setting as the default, never the host locale', () => {
    setFormatMoneyDefaults({ currency: null, locale: '' });
    expect(formatMoney(1)).toBe('$1.00');
  });
});

describe('ledger money settings', () => {
  it('take an ISO 4217 code Intl knows, in capitals, with two decimal places', () => {
    for (const good of ['USD', 'EUR', 'GBP', 'CHF', 'CAD', 'AUD', 'INR']) expect(currencyCodeProblem(good), good).toBeNull();
    for (const bad of ['eur', 'XYZ', 'EURO', '', 'US', 5, null]) {
      expect(currencyCodeProblem(bad), String(bad)).toBe('Choose a currency by its ISO 4217 code, such as USD or EUR.');
    }
    // Amounts are kept to the cent: whole yen or won, and thousandths of a dinar, can't be.
    expect(currencyCodeProblem('JPY')).toBe('JPY has no decimal places, and amounts here are kept to two (cents). Choose a currency with two, such as USD or EUR.');
    expect(currencyCodeProblem('KRW')).toMatch(/^KRW has no decimal places/);
    expect(currencyCodeProblem('KWD')).toBe('KWD has 3 decimal places, and amounts here are kept to two (cents). Choose a currency with two, such as USD or EUR.');
    expect(currencyCodeProblem('XDR')).toBe("XDR isn't money amounts can be kept in. Choose a currency such as USD or EUR.");
  });

  it('offer only the currencies they take, each with two decimal places', () => {
    const offered = ledgerCurrencies();
    expect(offered).toEqual(expect.arrayContaining(['USD', 'EUR', 'GBP', 'CHF', 'INR']));
    for (const code of ['JPY', 'KRW', 'KWD', 'BHD', 'CLP', 'ISK', 'XDR']) expect(offered, code).not.toContain(code);
    for (const code of offered) {
      expect(new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits, code).toBe(2);
    }
  });

  it('take only a locale from the list, as it is spelled there', () => {
    expect(moneyLocaleProblem('en-US')).toBeNull();
    expect(moneyLocaleProblem('de-CH')).toBeNull();
    // is-IS: Chrome's ICU has no Icelandic, so it isn't offered, nor taken.
    for (const bad of ['is-IS', 'en_us', 'en-us', 'xx', 'not a locale', '', 7, null, 'a'.repeat(65)]) {
      expect(moneyLocaleProblem(bad), String(bad)).toBe('Choose a number format from the list, such as en-US or de-DE.');
    }
  });

  it('offer only locales they take and Intl formats in, each once', () => {
    expect(new Set(MONEY_LOCALES).size).toBe(MONEY_LOCALES.length);
    for (const locale of MONEY_LOCALES) {
      expect(moneyLocaleProblem(locale), locale).toBeNull();
      expect(Intl.NumberFormat.supportedLocalesOf([locale]), locale).toEqual([locale]);
    }
  });
});

// A browser that lacks a ledger's locale (Chrome has no is-IS) would format in its viewer's own
// language, so two members saw one ledger's amounts written two ways.
describe('a locale this browser lacks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setFormatMoneyDefaults({});
  });

  it('shows amounts as en-US does, the same for every viewer', () => {
    const real = Intl.NumberFormat.supportedLocalesOf.bind(Intl.NumberFormat);
    vi.spyOn(Intl.NumberFormat, 'supportedLocalesOf').mockImplementation(((locales?: string | readonly string[], options?: Intl.NumberFormatOptions) =>
      ([] as string[]).concat(locales ?? []).includes('kk-KZ') ? [] : real(locales as string[], options)) as typeof Intl.NumberFormat.supportedLocalesOf);
    expect(supportedMoneyLocale('kk-KZ')).toBe('en-US');
    expect(supportedMoneyLocale('de-DE')).toBe('de-DE');
    expect(formatMoney(-1234.5, { currency: 'EUR', locale: 'kk-KZ' })).toBe('-€1,234.50');
    setFormatMoneyDefaults({ currency: 'EUR', locale: 'kk-KZ' });
    expect(formatMoney(5)).toBe('€5.00');
    expect(currencySymbol()).toBe('€');
  });

  it('takes a malformed locale as en-US too', () => {
    expect(supportedMoneyLocale('xx-??')).toBe('en-US');
  });
});
