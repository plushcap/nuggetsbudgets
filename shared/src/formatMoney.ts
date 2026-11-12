/**
 * One way to show an amount of money, for the pages, the MCP tools and
 * the emails, in place of the local `formatCurrency` / `usd` helpers that each hard-code
 * 'en-US' and 'USD'. The currency and locale are arguments: a ledger's own are its General
 * Settings (`application_currency`, `application_locale`), USD in en-US until it sets them.
 * The backend passes the ledger's to each call (readTenantMoneyFormat); the SPA, which shows
 * one ledger at a time, makes its ledger's the defaults (setFormatMoneyDefaults).
 *
 * It takes a number or the NUMERIC string `pg` returns ('-12.50'), rounds to the
 * currency's minor unit, and never shows a negative zero. An amount that isn't a number
 * (null, '', 'abc', NaN) shows as `fallback`, never as $0.00: a missing balance must not
 * read as an empty one.
 */

import { DECIMAL_TEXT } from './primitives.js';

export interface FormatMoneyOptions {
  /**
   * ISO 4217 code. Default formatMoneyDefaults()'s, 'USD' unless the SPA set its ledger's (also
   * when null or empty, as an unset setting reads from JSON).
   */
  currency?: string | null | undefined;
  /** BCP 47 locale. Default formatMoneyDefaults()'s, 'en-US' unless set (also when null or empty; never the host's locale). */
  locale?: string | null | undefined;
  /**
   * How a negative amount shows: 'sign' (-$1.00, the locale's minus) or 'parentheses'
   * ($1.00 in parentheses, accounting style). Default 'sign'.
   */
  negative?: 'sign' | 'parentheses';
  /** Show + on a positive amount (for changes: +$5.00). Default false. */
  plusSign?: boolean;
  /** Drop the minor unit ($1,235). Default false. */
  wholeUnits?: boolean;
  /**
   * The locale's short compact form, for a chart's axis: $950, $1.2K, $12K, $3.4M (two
   * significant digits at most, and whole units below 1,000). It overrides `wholeUnits`.
   * Default false.
   */
  compact?: boolean;
  /** What an amount that isn't a number shows as. Default '—'. */
  fallback?: string;
}

export const DEFAULT_CURRENCY = 'USD';
export const DEFAULT_LOCALE = 'en-US';

/** How a ledger shows money: its currency (ISO 4217) and locale (BCP 47). */
export interface MoneyFormat {
  currency: string;
  locale: string;
}

/** The value of a currency or locale setting, or undefined when it means the default (unset, null, empty, not text). */
const settingOrDefault = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

let defaults: MoneyFormat = { currency: DEFAULT_CURRENCY, locale: DEFAULT_LOCALE };

/**
 * Make `format` what formatMoney (and currencySymbol) use when a call names no currency or
 * locale; an unset one is the default's, USD or en-US. For a client that shows one ledger at
 * a time: the SPA sets its ledger's (LedgerMoneyFormat). A server serves every ledger at once
 * and never calls it: it passes each ledger's own to each call (the backend's ESLint refuses
 * an import of it).
 */
export function setFormatMoneyDefaults(format: { currency?: string | null | undefined; locale?: string | null | undefined }): void {
  defaults = {
    currency: settingOrDefault(format.currency) ?? DEFAULT_CURRENCY,
    locale: settingOrDefault(format.locale) ?? DEFAULT_LOCALE,
  };
}

/** What formatMoney uses when a call names no currency or locale. */
export function formatMoneyDefaults(): Readonly<MoneyFormat> {
  return defaults;
}

/** The decimal places a ledger's amounts have: the database keeps money as DECIMAL(12,2). */
export const MONEY_MINOR_DIGITS = 2;

/** Codes Intl knows that are a fund or a unit of account, not money a household keeps (ISO 4217's X codes). */
const NOT_HOUSEHOLD_MONEY = new Set(['XDR', 'XSU', 'XUA', 'XAU', 'XAG', 'XPD', 'XPT', 'XBA', 'XBB', 'XBC', 'XBD', 'XTS', 'XXX']);

/** The decimal places `code` has in Intl (its ISO 4217 minor unit: 2 for USD, 0 for JPY, 3 for KWD). */
function minorDigits(code: string): number {
  return new Intl.NumberFormat(DEFAULT_LOCALE, { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits ?? MONEY_MINOR_DIGITS;
}

/**
 * Why `code` can't be a ledger's currency, or null. A ledger's currency is an ISO 4217 code
 * this runtime's Intl knows, in capitals ('EUR'), with two decimal places, as the ledger
 * keeps its amounts (DECIMAL(12,2), whole cents): JPY's whole yen or KWD's thousandths would
 * be shown and stored wrongly. Intl formats any three letters ('XYZ 1.00'), so a code is
 * checked against its list, not by formatting with it. The message is written for people.
 */
export function currencyCodeProblem(code: unknown): string | null {
  if (typeof code !== 'string' || !/^[A-Z]{3}$/.test(code) || !Intl.supportedValuesOf('currency').includes(code)) {
    return 'Choose a currency by its ISO 4217 code, such as USD or EUR.';
  }
  if (NOT_HOUSEHOLD_MONEY.has(code)) return `${code} isn't money amounts can be kept in. Choose a currency such as USD or EUR.`;
  const digits = minorDigits(code);
  if (digits !== MONEY_MINOR_DIGITS) {
    return `${code} has ${digits === 0 ? 'no decimal places' : `${digits} decimal places`}, and amounts here are kept to two (cents). Choose a currency with two, such as USD or EUR.`;
  }
  return null;
}

/**
 * The currencies a ledger can take (currencyCodeProblem), in code order: those this runtime's
 * Intl knows that have two decimal places and are money.
 */
export function ledgerCurrencies(): string[] {
  return Intl.supportedValuesOf('currency').filter((code) => currencyCodeProblem(code) === null);
}

/**
 * Locales a ledger can choose for its money: each is formatted the way people there write
 * amounts (1,234.56; 1.234,56; 1 234,56; 1'234.56; 12,34,567.89), and each is one every
 * browser the app supports formats numbers in (Chrome 111, Firefox 128 and Safari 16.4:
 * Firefox and Safari carry every CLDR locale, Chrome's smaller ICU leaves some out, Icelandic
 * among them, so is-IS isn't offered). The server takes only these (moneyLocaleProblem), so
 * every member's browser writes a ledger's amounts the same way.
 */
export const MONEY_LOCALES = [
  'en-US', 'en-CA', 'en-GB', 'en-AU', 'en-NZ', 'en-IE', 'en-IN', 'en-SG', 'en-ZA',
  'fr-FR', 'fr-CA', 'fr-BE', 'fr-CH', 'de-DE', 'de-AT', 'de-CH', 'it-IT', 'it-CH',
  'es-ES', 'es-MX', 'es-AR', 'es-CO', 'es-US', 'pt-PT', 'pt-BR', 'nl-NL', 'nl-BE',
  'sv-SE', 'nb-NO', 'da-DK', 'fi-FI', 'pl-PL', 'cs-CZ', 'hu-HU', 'ro-RO',
  'el-GR', 'tr-TR', 'uk-UA', 'he-IL', 'ar-AE', 'hi-IN', 'th-TH', 'ja-JP', 'ko-KR',
  'zh-CN', 'zh-HK', 'zh-TW',
] as const;

/** Why `tag` can't be a ledger's locale, or null: one of MONEY_LOCALES, spelled as it is there. */
export function moneyLocaleProblem(tag: unknown): string | null {
  if (typeof tag === 'string' && (MONEY_LOCALES as readonly string[]).includes(tag)) return null;
  return 'Choose a number format from the list, such as en-US or de-DE.';
}

const localeSupport = new Map<string, boolean>();

/**
 * `locale` where this runtime formats numbers in it, else DEFAULT_LOCALE. Intl doesn't refuse
 * a locale it lacks: it uses the viewer's own language instead, so one ledger's amounts would
 * read differently from one member's browser to another's. en-US is the same for everyone.
 */
export function supportedMoneyLocale(locale: string): string {
  let supported = localeSupport.get(locale);
  if (supported === undefined) {
    try {
      supported = Intl.NumberFormat.supportedLocalesOf([locale]).length === 1;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      supported = false;
    }
    localeSupport.set(locale, supported);
  }
  return supported ? locale : DEFAULT_LOCALE;
}

/**
 * How Intl signs the amount, once rounded to the currency's minor unit: 'negative' signs
 * only an amount that is still negative (-0.004 is $0.00, never -$0.00), 'exceptZero' also
 * puts + on a positive one. Intl takes a string amount as the exact decimal it is ('1.005'
 * is $1.01). Both are Intl.NumberFormat v3 (ES2023: Chrome 106, Firefox 116, Safari 15.4),
 * which every browser the app supports has (Chrome 111, Firefox 128, Safari 16.4:
 * `build.target` in frontend/vite.config.ts), and so does Node 26.
 */
type SignDisplay = 'negative' | 'exceptZero';

/** How many digits: the currency's minor unit, whole units, or the compact form. */
type Digits = 'minor' | 'whole' | 'compact';

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * Intl's own digits for each. Compact notation, with no digit options, rounds to two
 * significant digits and drops the minor unit (ECMA-402 SetNumberFormatDigitOptions), and it
 * keeps the sign display, so -0.4 is $0 there too.
 */
const DIGIT_OPTIONS: Record<Digits, Intl.NumberFormatOptions> = {
  minor: {},
  whole: { minimumFractionDigits: 0, maximumFractionDigits: 0 },
  compact: { notation: 'compact', compactDisplay: 'short' },
};

function formatterFor(locale: string, currency: string, digits: Digits, sign: SignDisplay): Intl.NumberFormat {
  const key = `${locale}|${currency}|${digits}|${sign}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      // TypeScript's ES2022 lib doesn't list 'negative'.
      signDisplay: sign as Intl.NumberFormatOptions['signDisplay'],
      ...DIGIT_OPTIONS[digits],
    });
    formatters.set(key, formatter);
  }
  return formatter;
}

/**
 * The formatter for these settings. A currency or locale Intl doesn't know ('US',
 * 'xx-??') is replaced by its default alone, so a bad locale keeps a good currency and the
 * other way round: a bad household setting must not break every page, nor show euros as
 * dollars.
 */
function safeFormatterFor(setting: string, currency: string, digits: Digits, sign: SignDisplay): Intl.NumberFormat {
  // A locale this runtime lacks would be the viewer's language: en-US instead, the same for everyone.
  const locale = supportedMoneyLocale(setting);
  const attempts: Array<[string, string]> = [
    [locale, currency],
    [DEFAULT_LOCALE, currency],
    [locale, DEFAULT_CURRENCY],
    [DEFAULT_LOCALE, DEFAULT_CURRENCY],
  ];
  for (const [l, c] of attempts) {
    try {
      return formatterFor(l, c, digits, sign);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err; // an unknown code
    }
  }
  return formatterFor(DEFAULT_LOCALE, DEFAULT_CURRENCY, digits, sign);
}

interface Amount {
  /** As Intl reads it: a number, or the decimal text. */
  value: number | string;
  /** Below zero before rounding (it may round to zero). */
  negative: boolean;
  magnitude: number | string;
}

/** The amount, or undefined when it isn't one. */
function toAmount(amount: number | string | null | undefined): Amount | undefined {
  if (typeof amount === 'number') {
    return Number.isFinite(amount) ? { value: amount, negative: amount < 0, magnitude: Math.abs(amount) } : undefined;
  }
  if (typeof amount !== 'string') return undefined;
  // The same decimal text moneyInput (primitives.ts) takes in a request.
  const text = amount.trim();
  if (!DECIMAL_TEXT.test(text)) return undefined;
  const signed = text[0] === '-' || text[0] === '+';
  return { value: text, negative: text[0] === '-', magnitude: signed ? text.slice(1) : text };
}

/** The amount rounded to whole units, half away from zero. */
function wholeAmount(amount: Amount): Amount {
  const n = Number(amount.value);
  const rounded = Math.sign(n) * Math.round(Math.abs(n)) || 0;
  return { value: rounded, negative: rounded < 0, magnitude: Math.abs(rounded) };
}

// TypeScript's ES2022 lib types format() and formatToParts() as taking a number only.
type Formattable = (value: number | string) => string;
type FormattableParts = (value: number | string) => Intl.NumberFormatPart[];

export function formatMoney(amount: number | string | null | undefined, options: FormatMoneyOptions = {}): string {
  // Anything but a non-empty string means the default: Intl reads a number, an object or
  // '' as "the host's locale", which would differ from server to browser.
  const currency = settingOrDefault(options.currency) ?? defaults.currency;
  const locale = settingOrDefault(options.locale) ?? defaults.locale;
  const {
    negative = 'sign',
    plusSign = false,
    wholeUnits = false,
    compact = false,
    fallback = '—',
  } = options;
  const parsed = toAmount(amount);
  if (parsed === undefined) return fallback;
  // Compact keeps two significant figures, so under 1 it would show a fraction ($0.4):
  // whole units first, half away from zero as Intl rounds (-0.4 is $0, never -$0). Only
  // below 1,000: above it Intl rounds to its two figures itself, and a whole-unit rounding
  // first would round twice (1,249.99 would show as $1.3K).
  const value = compact && Math.abs(Number(parsed.value)) < 999.5 ? wholeAmount(parsed) : parsed;

  const digits: Digits = compact ? 'compact' : wholeUnits ? 'whole' : 'minor';
  const formatter = safeFormatterFor(locale, currency, digits, plusSign ? 'exceptZero' : 'negative');
  if (negative === 'parentheses' && value.negative) {
    // Still negative once rounded: Intl shows its minus sign.
    const parts = (formatter.formatToParts as FormattableParts)(value.value);
    if (parts.some((part) => part.type === 'minusSign')) {
      // The locale's own unsigned amount, spacing and all (CHF 5.00, not CHF5.00).
      const unsigned = plusSign ? safeFormatterFor(locale, currency, digits, 'negative') : formatter;
      return `(${(unsigned.format as Formattable)(value.magnitude)})`;
    }
  }
  return (formatter.format as Formattable)(value.value);
}

const signsOf = new Map<string, string[]>();

/**
 * Every sign `locale` writes a currency in, for each currency Intl knows, as its symbol or its
 * narrow symbol (`$`, `US$`, `$ US`, `€`, `kr`, `CHF`), each once, longest first: what an amount
 * box reads back from a page's amount (parseAmount). Empty where Intl can't say.
 */
export function currencySigns(locale: string): string[] {
  const cached = signsOf.get(locale);
  if (cached) return cached;
  const signs = new Set<string>();
  try {
    for (const currency of Intl.supportedValuesOf('currency')) {
      for (const currencyDisplay of ['symbol', 'narrowSymbol'] as const) {
        const sign = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay })
          .formatToParts(1)
          .find((part) => part.type === 'currency')
          ?.value.trim();
        if (sign) signs.add(sign);
      }
    }
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
  }
  const out = [...signs].sort((a, b) => b.length - a.length);
  signsOf.set(locale, out);
  return out;
}

/**
 * The sign the currency shows in its locale ('$', '€', 'CHF', '¥'), for an amount box's
 * slot: its narrow symbol where the locale has one, else what formatMoney shows.
 */
export function currencySymbol(options: Pick<FormatMoneyOptions, 'currency' | 'locale'> = {}): string {
  const currency = settingOrDefault(options.currency) ?? defaults.currency;
  const locale = supportedMoneyLocale(settingOrDefault(options.locale) ?? defaults.locale);
  for (const [l, c] of [[locale, currency], [DEFAULT_LOCALE, currency], [locale, DEFAULT_CURRENCY]] as const) {
    try {
      const parts = new Intl.NumberFormat(l, { style: 'currency', currency: c, currencyDisplay: 'narrowSymbol' }).formatToParts(0);
      const symbol = parts.find((part) => part.type === 'currency')?.value;
      if (symbol) return symbol;
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
    }
  }
  return '$';
}
