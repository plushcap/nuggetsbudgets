/**
 * Reads an amount of money as typed or pasted.
 *
 * People paste amounts from bank sites, spreadsheets and emails, written the US way
 * (`$1,234.56`) or the European way (`1.234,56`, `1 234,56 €`). The old reader dropped
 * every comma, so `1.234,56` became `1.23456` and then `1.23`, without a word. This one
 * works out which mark is the decimal separator, and when it can't tell, or the number
 * has more than two decimals, it says the text isn't an amount rather than guess.
 *
 * Letters: an ISO 4217 currency code at either end, in any case (`USD 1,234.56`,
 * `1.234,56 eur`), or a known dollar prefix (`US$`, `CA$`, `C$`, `A$`, `AU$`, `NZ$`, `HK$`,
 * `S$`, `NT$`, `MX$`, `R$`) goes, as a currency sign does; a sign or accounting parentheses may stand
 * outside it (`-USD 12`, `(USD 1,234.56)`). Any other letter makes the text unreadable rather
 * than being dropped: `1e2` was read as 12, `1.5k` as 1.5, and an `o` typed for a zero
 * vanished. So do three letters that aren't a currency (`1.5 MLN`, `5 MIL`, `12.5 PCT`: any
 * three capitals used to go), a code with no number, and `CR`/`DR`, whose meaning would be
 * lost.
 *
 * Other marks make it unreadable too: `1/2` was read as 12, `50%` as 50, `1+2` as 12 and
 * `1-2` as -12. A sign stands before the number (`-12`, `+12`), or a minus after it (`12-`); a
 * separator and a dash after it (`12,-`, `CHF 12.-`) is the whole amount. A currency sign
 * stands outside the number (`12€50` was 1250), and a cent sign is refused (`50¢` was $50). A
 * space between digits only groups thousands (`1 234,56`): `12 34` and `12\t34` are refused.
 * So does an apostrophe, the Swiss way (`1'234.50`, `CHF 1’234.50`): `12'5` is refused.
 *
 * Rules, after dropping currency signs, the code and spaces:
 * - both `.` and `,`: the last one is the decimal separator; the other must group
 *   thousands (three digits after each);
 * - only commas: one comma followed by one or two digits at the end is a decimal comma
 *   (`12,5`, `1234,56`); otherwise each comma must be followed by three digits
 *   (`1,234,567`), a thousands separator;
 * - only dots: one dot is the decimal point (`12.50`); several must group thousands
 *   (`1.234.567`);
 * - at most two decimals: `12.345` and `1.234` (US 1.234, or European 1234?) are
 *   refused, not cut to `12.34` / `1.23`;
 * - a trailing separator (`12.`, `12,`) is a number being typed.
 *
 * A leading or trailing `-`, or accounting parentheses `(1,234.56)`, make it negative; where no
 * negative is taken (`allowNegative` false), a negative is refused (it was read as
 * its magnitude, so a pasted `-42.50` or `(12)` was 42.50 or 12).
 *
 * Under a ledger's locale (`locale`, the one its pages write amounts in), it also reads what
 * that locale writes: its grouping where it isn't thousands (en-IN and hi-IN group lakhs and
 * crores, `12,34,567.89`, `1,00,000.00`), and the currency signs with letters it writes for any
 * currency (`12,30 $ US`, `1 234,50 kr`, `UK£12.30`), at either end, as a currency code is.
 *
 * A price or an amount per share keeps 4 decimals: `decimals` 4. The rules hold, and
 * one more: a lone separator before exactly three digits, after one to three that could be a
 * thousands group (`1.234`, `12,345`), could be either reading, so it is refused; written
 * `1.2340`, `1,234.00` or `1.234,00` it can't be. `0.125` and `1234,567` can only be decimals.
 */

import { currencySigns } from '@nuggets/shared';

export interface ParsedAmount {
  /** The amount, or null for an empty box or text that isn't an amount. */
  value: number | null;
  /** True when there is text but it can't be read as an amount. */
  invalid: boolean;
}

const THOUSANDS_GROUP = /^\d{3}$/;

/** Intl.supportedValuesOf (ES2022), which the build's ES2020 library doesn't declare. */
type IntlWithSupportedValues = { supportedValuesOf?: (key: 'currency') => string[] };

/** The codes the browser knows as ISO 4217 currencies, upper case; a few common ones if it can't say. */
function currencyCodes(): ReadonlySet<string> {
  try {
    const codes = (Intl as IntlWithSupportedValues).supportedValuesOf?.('currency') ?? [];
    if (codes.length > 0) return new Set(codes.map((code) => code.toUpperCase()));
  } catch {
    // An engine without Intl.supportedValuesOf: the codes people paste most.
  }
  return new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'CNY', 'HKD', 'SGD', 'SEK', 'NOK', 'DKK', 'MXN', 'BRL', 'INR', 'ZAR']);
}
let knownCodes: ReadonlySet<string> | undefined;
const isCurrencyCode = (letters: string): boolean => (knownCodes ??= currencyCodes()).has(letters.toUpperCase());

/**
 * Three letters at the start or the end, not part of a longer word: a currency code if
 * isCurrencyCode says so. (No lookbehind for the end, which older Safari can't parse: the
 * character before is kept.)
 */
const LEADING_LETTERS = /^([A-Za-z]{3})(?!\p{L})/u;
const TRAILING_LETTERS = /(^|[^\p{L}])([A-Za-z]{3})$/u;
/**
 * A dollar sign's prefix at the start, in any case: one of the dollars people write that way
 * (US$, CA$ or C$, A$ or AU$, NZ$, HK$, S$, NT$, MX$, and Brazil's R$). Any other letters
 * before a `$` are unreadable, as other letters are: "XX$12" and "ok$5" were 12 and 5.
 */
const DOLLAR_PREFIX = /^(?:US|CA|C|AU|A|NZ|HK|S|NT|MX|R)(?=\$)/i;
const LETTER = /\p{L}/u;
/** Format characters (Unicode Cf): zero-width spaces and joiners, direction marks, a soft hyphen. */
export const INVISIBLE = /\p{Cf}/gu;
/** A space that may group thousands: a plain one, or a no-break, figure, thin or narrow no-break one. */
const GROUP_SPACE = /[ \u00a0\u2007\u2009\u202f]/u;
/** Runs of digits with one group space between each: `1 234 567`. */
const SPACED_DIGITS = /\d+(?:[ \u00a0\u2007\u2009\u202f]\d+)+/gu;
/** An apostrophe that may group thousands (Swiss): the typewriter one or the typographic one. */
const APOSTROPHE = /['\u2019]/u;
/** Runs of digits with one apostrophe between each: `1'234'567`. */
const APOSTROPHE_DIGITS = /\d+(?:['\u2019]\d+)+/gu;
/** A cent sign (and its full-width form). */
const CENT_SIGN = /[¢￠]/u;

/** What a locale writes that the general rules don't read: its grouping, and its signs with letters. */
interface LocaleReading {
  /** Digits in each group before the last (thousands) one: 3 mostly, 2 in en-IN and hi-IN. */
  secondary: number;
  /** The currency signs it writes that have letters (`$ US`, `kr`, `UK£`), longest first. */
  lettered: string[];
}
const readings = new Map<string, LocaleReading | null>();

/** How `locale` writes amounts, or null for one this engine can't say (the general rules then). */
function readingOf(locale: string): LocaleReading | null {
  let reading = readings.get(locale);
  if (reading !== undefined) return reading;
  try {
    // The sizes of the integer's groups, from the right: 1,23,45,67,890 is 2 then 3.
    const groups = new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(1234567890).filter((part) => part.type === 'integer');
    const secondary = groups.length >= 3 ? groups[groups.length - 2]?.value.length ?? 3 : 3;
    // The signs it writes with letters (`$ US`, `kr`); a sign without them goes as any \p{Sc} does.
    const lettered = currencySigns(locale).filter((sign) => LETTER.test(sign) && !/\d/.test(sign));
    reading = { secondary, lettered };
  } catch {
    reading = null;
  }
  readings.set(locale, reading);
  return reading;
}

/** `outer` without one of `signs` at its start or its end (not part of a longer word), or null. */
function withoutLetteredSign(outer: string, signs: readonly string[]): string | null {
  for (const sign of signs) {
    if (outer.startsWith(sign) && !LETTER.test(outer.charAt(sign.length))) return outer.slice(sign.length);
    if (outer.endsWith(sign) && !LETTER.test(outer.charAt(outer.length - sign.length - 1))) return outer.slice(0, outer.length - sign.length);
  }
  return null;
}

/**
 * `text` without its currency code or dollar prefix (one, at either end), and whether it had
 * one; an outer sign or parentheses are kept, outside it. With a locale's lettered signs, one of
 * those goes too.
 */
function withoutCurrency(text: string, lettered: readonly string[] = []): { text: string; code: boolean } {
  let outer = text;
  let open = '';
  let close = '';
  if (/^\(.*\)$/.test(outer)) {
    open = '(';
    close = ')';
    outer = outer.slice(1, -1).trim();
  }
  const sign = /^[-+]/.exec(outer)?.[0] ?? '';
  outer = outer.slice(sign.length).trim();
  const leading = LEADING_LETTERS.exec(outer)?.[1];
  let inner: string | null = withoutLetteredSign(outer, lettered);
  if (inner !== null) {
    // A sign of the locale's own, with letters: `12,30 $ US`.
  } else if (leading && isCurrencyCode(leading)) {
    inner = outer.slice(3);
  } else if (DOLLAR_PREFIX.test(outer)) {
    inner = outer.replace(DOLLAR_PREFIX, '');
  } else {
    const trailing = TRAILING_LETTERS.exec(outer)?.[2];
    if (trailing && isCurrencyCode(trailing)) inner = outer.slice(0, outer.length - 3);
  }
  if (inner === null) return { text, code: false };
  return { text: `${open}${sign}${inner.trim()}${close}`, code: true };
}

/** Digits that could open a thousands-grouped number: one to three, the first not a zero. */
const LEADING_GROUP = /^[1-9]\d{0,2}$/;

/**
 * Joins integer groups split by a thousands separator, or null if they aren't groups of three
 * after a leading group without a leading zero: `0,005` is three decimals, not 5. With a
 * locale whose groups before the thousands are another size (`secondary` 2, en-IN), its own
 * grouping reads too: `12,34,567` is 1234567.
 */
const joinGroups = (groups: string[], secondary = 3): string | null => {
  const [first, ...rest] = groups;
  if (first === undefined) return null;
  if (rest.length === 0) return first;
  if (!/^[1-9]/.test(first)) return null;
  if (LEADING_GROUP.test(first) && rest.every((g) => THOUSANDS_GROUP.test(g))) return groups.join('');
  if (secondary === 3) return null;
  // The locale's: the last group three digits, the others and the first `secondary` at most.
  const last = rest[rest.length - 1] ?? '';
  const middle = rest.slice(0, -1);
  const own = new RegExp(`^\\d{${secondary}}$`);
  if (first.length > secondary || !THOUSANDS_GROUP.test(last) || !middle.every((g) => own.test(g))) return null;
  return groups.join('');
};

export function parseAmount(raw: string, allowNegative = true, maxDecimals = 2, locale?: string): ParsedAmount {
  const reading = locale ? readingOf(locale) : null;
  const secondary = reading?.secondary ?? 3;
  // A minus sign (U+2212, as typeset statements write it) is a minus, not a character to drop.
  // Invisible marks (a zero-width space, a direction mark) that a page's text can carry go.
  const currency = withoutCurrency(raw.replace(INVISIBLE, '').trim().replace(/\u2212/g, '-'), reading?.lettered);
  let text = currency.text;
  if (LETTER.test(text)) return { value: null, invalid: true };
  // A code alone isn't an amount being typed.
  if (currency.code && !/\d/.test(text)) return { value: null, invalid: true };
  // A cent sign makes the amount a hundredth of what it reads: `50¢` was $50.
  if (CENT_SIGN.test(text)) return { value: null, invalid: true };
  // A currency sign stands before the number or after it, not inside it: `12€50` was 1250.
  if (/[\d.,]\s*\p{Sc}+\s*[\d.,]/u.test(text)) return { value: null, invalid: true };
  // A space between digits groups thousands (`1 234,56`, `100 200`): one before each three
  // digits, after one to three. Any other space between digits or separators (`12 34`,
  // `12\t34`, `12, 50`) is between two numbers: it was dropped, and they read as one.
  let grouped = true;
  text = text.replace(SPACED_DIGITS, (run) => {
    const joined = joinGroups(run.split(GROUP_SPACE), secondary);
    if (joined === null) grouped = false;
    return joined ?? run;
  });
  if (!grouped || /[\d.,]\s+[\d.,]/u.test(text)) return { value: null, invalid: true };
  // An apostrophe groups thousands the same way (Swiss: `1'234.50`, `CHF 1’234.50`, the
  // typographic one too). Any other apostrophe (`12'5`, `'12`) isn't an amount's: it was
  // dropped, so `12'5` read as 125.
  text = text.replace(APOSTROPHE_DIGITS, (run) => {
    const joined = joinGroups(run.split(APOSTROPHE), secondary);
    if (joined === null) grouped = false;
    return joined ?? run;
  });
  if (!grouped || APOSTROPHE.test(text)) return { value: null, invalid: true };
  // Currency signs and the spaces around the number go.
  text = text.replace(/[\p{Sc}\s]/gu, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  } else if (text === '(') {
    // An opening parenthesis alone is a negative being typed, as a lone minus is.
    text = '';
  }
  // A separator and a dash after the digits is the whole amount (German and Swiss prices:
  // `12,-`, `EUR 49,-`, `CHF 12.-`, `1.234,-`), not a negative. A dash alone after them is.
  if (/\d[.,]-$/.test(text)) text = text.slice(0, -1);
  // What is left is digits and separators, with at most a sign: a `-` or `+` before them, or a
  // `-` after them, as some statements write one. Anything else isn't an amount: it was
  // dropped, so `1/2` read as 12, `50%` as 50 and `1-2` as -12.
  const signed = /^([-+]?)([0-9.,]*)(-?)$/.exec(text);
  if (!signed) return { value: null, invalid: true };
  const [, before = '', number = '', after = ''] = signed;
  if (before !== '' && after !== '') return { value: null, invalid: true };
  if (before === '-' || after === '-') negative = true;
  text = number;

  if (text === '' || text === '.' || text === ',') return { value: null, invalid: false };
  if (!/\d/.test(text)) return { value: null, invalid: true };

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  let integer: string | null;
  let decimals = '';

  if (lastDot !== -1 && lastComma !== -1) {
    const decimalMark = lastDot > lastComma ? '.' : ',';
    const groupMark = decimalMark === '.' ? ',' : '.';
    const at = text.lastIndexOf(decimalMark);
    const head = text.slice(0, at);
    decimals = text.slice(at + 1);
    if (head.includes(decimalMark) || decimals.includes(groupMark)) return { value: null, invalid: true };
    integer = joinGroups(head.split(groupMark), secondary);
  } else if (lastComma !== -1 || lastDot !== -1) {
    const mark = lastComma !== -1 ? ',' : '.';
    const parts = text.split(mark);
    // split gives one part at least: these defaults never apply.
    const first = parts[0] ?? '';
    const last = parts[parts.length - 1] ?? '';
    // With three or more decimals allowed, `1.234` / `12,345` is a thousands group or three
    // decimals: refused rather than guessed. With two, a comma there groups thousands and a
    // dot makes three decimals, which is refused below.
    const decimalsBeyondGroup = maxDecimals >= 3 && parts.length === 2;
    if (decimalsBeyondGroup && last.length === 3 && LEADING_GROUP.test(first)) return { value: null, invalid: true };
    if (parts.length === 2 && (mark === '.' || last.length <= 2 || decimalsBeyondGroup)) {
      // One mark: a decimal point, or a decimal comma before one or two digits.
      integer = first;
      decimals = last;
    } else {
      integer = joinGroups(parts, secondary);
    }
  } else {
    integer = text;
  }

  if (integer === null || !/^\d*$/.test(integer) || !/^\d*$/.test(decimals)) return { value: null, invalid: true };
  if (decimals.length > maxDecimals) return { value: null, invalid: true };
  const value = Number(`${integer || '0'}.${decimals || '0'}`);
  if (!Number.isFinite(value)) return { value: null, invalid: true };
  if (negative && value !== 0 && !allowNegative) return { value: null, invalid: true };
  return { value: negative && value !== 0 ? -value : value, invalid: false };
}
