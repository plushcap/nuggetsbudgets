import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseAmount } from '../parseAmount';

const value = (raw: string, allowNegative = true) => parseAmount(raw, allowNegative).value;
const refused = (raw: string) => parseAmount(raw).invalid;

describe('parseAmount', () => {
  it('reads US amounts, with or without a currency sign and thousands separators', () => {
    expect(value('$1,234.56')).toBe(1234.56);
    expect(value('1234.5')).toBe(1234.5);
    expect(value('1,234')).toBe(1234);
    expect(value('1,234,567.89')).toBe(1234567.89);
    expect(value(' 12 ')).toBe(12);
  });

  it('reads European amounts, where the comma is the decimal separator', () => {
    // The old reader dropped the comma: 1.23456, then cut to 1.23.
    expect(value('1.234,56')).toBe(1234.56);
    expect(value('1 234,56 €')).toBe(1234.56);
    expect(value('12,5')).toBe(12.5);
    expect(value('1234,56')).toBe(1234.56);
    expect(value('1.234.567')).toBe(1234567);
  });

  it('refuses what it would otherwise have to guess at or cut down', () => {
    expect(refused('1.234')).toBe(true); // US 1.234 (three decimals) or European 1234?
    expect(refused('12.345')).toBe(true); // was cut to 12.34
    expect(refused('1.234,567')).toBe(true);
    expect(refused('1,2345')).toBe(true);
    expect(refused('1,234,56')).toBe(true);
    expect(refused('1,23.45')).toBe(true);
    expect(refused('1.2.3')).toBe(true);
    expect(value('12.345')).toBeNull();
  });

  it('refuses thousands groups after a leading zero, which are three decimals written another way', () => {
    // "0,005" was read as 5, so typing it moved $5.00.
    expect(refused('0,005')).toBe(true);
    expect(refused('0.005')).toBe(true);
    expect(refused('0,005.00')).toBe(true);
    expect(refused('0.005,00')).toBe(true);
    expect(refused('012,345')).toBe(true);
    expect(value('0,05')).toBe(0.05);
    expect(value('1,005')).toBe(1005);
    expect(value('1.005,00')).toBe(1005);
  });

  it('reads negatives, a leading minus or accounting parentheses, unless they are not allowed', () => {
    expect(value('-12.50')).toBe(-12.5);
    expect(value('(1,234.56)')).toBe(-1234.56);
    expect(value('-$5')).toBe(-5);
    // Where none is taken, a negative is refused; it was read as its magnitude, so
    // a pasted -42.50 or (12) was 42.50 or 12.
    for (const text of ['-5', '12-', '(12)', '-$5', '(1,234.56)', '- 5', '-0.01']) {
      expect(parseAmount(text, false), text).toEqual({ value: null, invalid: true });
      expect(parseAmount(text, false, 4), text).toEqual({ value: null, invalid: true });
    }
    // Zero has no sign, and a sign alone is an amount being typed.
    expect(parseAmount('-0', false)).toEqual({ value: 0, invalid: false });
    expect(parseAmount('(0.00)', false)).toEqual({ value: 0, invalid: false });
    expect(parseAmount('-', false)).toEqual({ value: null, invalid: false });
    expect(parseAmount('(', false)).toEqual({ value: null, invalid: false });
    expect(parseAmount('+5', false)).toEqual({ value: 5, invalid: false });
    expect(parseAmount('12,-', false)).toEqual({ value: 12, invalid: false });
  });

  it('refuses other marks rather than drop them, with either decimal separator', () => {
    // Each was dropped: "1/2" read as 12, "50%" as 50, "1+2" as 12 and "1-2" as -12.
    for (const text of ['1/2', '50%', '1+2', '1-2', '12+', '--12', '-12-', '+12-', '1,234.56%', '1.234,56%', '1,234.56/2', '1.234,56 /2',
      "12'5", '1*2', '#' + '12', '12=', '(12', '12)', '-(12)', '1(2)3', '–12', '1_000']) {
      expect(parseAmount(text), text).toEqual({ value: null, invalid: true });
      expect(parseAmount(text, false, 4), text).toEqual({ value: null, invalid: true });
    }
  });

  it('still reads a sign before the number, a minus after it, and spaces or invisible marks inside it', () => {
    expect(value('+12.50')).toBe(12.5);
    expect(value('+1,234.56')).toBe(1234.56);
    expect(value('+1.234,56')).toBe(1234.56);
    expect(value('1,234.56-')).toBe(-1234.56);
    expect(value('1.234,56-')).toBe(-1234.56);
    expect(value('$-5')).toBe(-5);
    expect(value('- $ 1,234.56')).toBe(-1234.56);
    // A sign before the parentheses' currency sign used to read as positive.
    expect(value('$(12.00)')).toBe(-12);
    expect(value('€ (1.234,56)')).toBe(-1234.56);
    expect(value('1 234,56')).toBe(1234.56); // a narrow no-break space groups thousands
    expect(value('1 234.56')).toBe(1234.56);
    expect(value('‎$1,234.56​')).toBe(1234.56); // a direction mark and a zero-width space
    expect(value('‎USD 12')).toBe(12);
    expect(value('12-', false)).toBeNull(); // a negative, where none is taken
    // A sign or a parenthesis alone is an amount being typed.
    expect(parseAmount('+')).toEqual({ value: null, invalid: false });
    expect(parseAmount('(')).toEqual({ value: null, invalid: false });
  });

  // Each of these was misread.
  it('reads a separator and a dash after the number as the whole amount, not a negative', () => {
    expect(value('12,-')).toBe(12);
    expect(value('EUR 49,-')).toBe(49);
    expect(value('CHF 12.-')).toBe(12);
    expect(value('1.234,-')).toBe(1234);
    expect(value('1,234.-')).toBe(1234);
    expect(value('12,- €')).toBe(12);
    expect(value('-12,-')).toBe(-12);
    expect(value('(12,-)')).toBe(-12);
    // A dash alone after the digits is still a negative.
    expect(value('12-')).toBe(-12);
    expect(parseAmount('12,--')).toEqual({ value: null, invalid: true });
  });

  it('refuses a currency sign inside the number, and a cent sign', () => {
    for (const text of ['12€50', '12£50', '12 € 50', '1,234$56', '50¢', '¢50', '12.50 ¢', '50￠']) {
      expect(parseAmount(text), text).toEqual({ value: null, invalid: true });
    }
    expect(value('12,50 €')).toBe(12.5);
    expect(value('€ 12,50')).toBe(12.5);
  });

  // An apostrophe was dropped wherever it stood, so `1'234.50` read by luck and `12'5`
  // read as 125.
  it('reads a Swiss apostrophe only as a thousands group', () => {
    expect(value("1'234.50")).toBe(1234.5);
    expect(value('CHF 1’234.50')).toBe(1234.5);
    expect(value("1'234'567.89")).toBe(1234567.89);
    expect(value("CHF 12'345.-")).toBe(12345);
    expect(value("-1'234.50")).toBe(-1234.5);
    expect(parseAmount("1'234.5678", false, 4).value).toBe(1234.5678);
    for (const text of ["12'5", "1'2345", "1234'567", "0'500", "'12", "12'", "1''234", "1'234.5'6", "1 234'567", "12.5'0"]) {
      expect(parseAmount(text), text).toEqual({ value: null, invalid: true });
    }
  });

  it('reads a space between digits only as a thousands group', () => {
    expect(value('100 200')).toBe(100200);
    expect(value('1 234,56')).toBe(1234.56);
    expect(value('1 234 567.89')).toBe(1234567.89);
    expect(value('12 345,67')).toBe(12345.67);
    expect(value('1 234')).toBe(1234);
    for (const text of ['12 34', '12\t34', '12\r\n34', '12\n345', '12  345', '1234 567', '0 500', '1 2345', '12, 50', '12. 50', '1 234 ,56', '1.234 567']) {
      expect(parseAmount(text), JSON.stringify(text)).toEqual({ value: null, invalid: true });
    }
  });

  it('refuses text with letters in it rather than drop them', () => {
    // Each letter used to be dropped: 1e2 was 12, 1.5k 1.5, a typed o for a zero vanished.
    for (const text of ['1e2', '1E2', '1e+2', '1.5k', '2M', '1o0', '12abc', 'abc', 'twelve', 'USD12EUR3', '1,234.56 dollars']) {
      expect(parseAmount(text), text).toEqual({ value: null, invalid: true });
      expect(parseAmount(text, false, 4), text).toEqual({ value: null, invalid: true });
    }
  });

  it('still reads a currency sign or a three-letter currency code at either end', () => {
    expect(value('$1,234.56')).toBe(1234.56);
    expect(value('1 234,56 €')).toBe(1234.56);
    expect(value('£12')).toBe(12);
    expect(value('USD 1,234.56')).toBe(1234.56);
    expect(value('1.234,56 EUR')).toBe(1234.56);
    expect(value('12.50USD')).toBe(12.5);
    expect(value('USD (1,234.56)')).toBe(-1234.56);
    expect(value('-$5')).toBe(-5);
    expect(value('-5 USD', false)).toBeNull(); // a negative, where none is taken
  });

  // Any three capitals went, so "1.5 MLN" read 1.5 (the 1.5k bug again), and
  // a lower-case code was refused.
  it('reads an ISO 4217 code in any case, and no other three letters', () => {
    expect(value('12.50 eur')).toBe(12.5);
    expect(value('usd 12')).toBe(12);
    expect(value('12 usd')).toBe(12);
    expect(value('Chf 1.234,50')).toBe(1234.5);
    expect(value('1 234,56 SEK')).toBe(1234.56);
    for (const text of ['1.5 MLN', '5 MIL', '12.5 PCT', '12 ABC', 'XYZ 12', '1.5 mln']) {
      expect(parseAmount(text), text).toEqual({ value: null, invalid: true });
    }
  });

  it('reads a dollar prefix, and a sign or parentheses outside the code', () => {
    expect(value('US$12')).toBe(12);
    expect(value('CA$ 1,234.56')).toBe(1234.56);
    expect(value('A$5')).toBe(5);
    expect(value('NZ$5.50')).toBe(5.5);
    expect(value('HK$ 100')).toBe(100);
    expect(value('R$ 1.234,56')).toBe(1234.56);
    expect(value('C$7')).toBe(7);
    expect(value('AU$7')).toBe(7);
    expect(value('S$7')).toBe(7);
    expect(value('NT$700')).toBe(700);
    expect(value('MX$70')).toBe(70);
    expect(value('us$12')).toBe(12);
    expect(value('-USD 12')).toBe(-12);
    expect(value('(USD 1,234.56)')).toBe(-1234.56);
    expect(value('(1,234.56 USD)')).toBe(-1234.56);
    expect(value('-US$12')).toBe(-12);
    expect(value('+EUR 3')).toBe(3);
    expect(value('-USD 12', false)).toBeNull(); // a negative, where none is taken
    // A minus sign as statements typeset it.
    expect(value('\u221212.50')).toBe(-12.5);
    expect(value('\u2212USD 12')).toBe(-12);
  });

  it('refuses a code with no number, two codes, and CR or DR, whose meaning would be lost', () => {
    // Letters before a $ that aren't a known prefix (any one or two went).
    for (const text of ['USD', 'usd', '(USD)', '-EUR', 'US$', 'USD 12 EUR', 'US$ 12 USD', '12.00 CR', '12.00 DR', '12.00CR', 'CR 12', 'Mex$12', '5k$', 'XX$12', 'ok$5', 'k$5', 'O$5']) {
      expect(parseAmount(text), text).toEqual({ value: null, invalid: true });
    }
  });

  it('treats an empty box, or a number still being typed, as no amount yet / that number', () => {
    expect(parseAmount('')).toEqual({ value: null, invalid: false });
    expect(parseAmount('-')).toEqual({ value: null, invalid: false });
    expect(parseAmount('.')).toEqual({ value: null, invalid: false });
    expect(value('12.')).toBe(12);
    expect(value('12,')).toBe(12);
    expect(value('.5')).toBe(0.5);
  });
});

describe('parseAmount with 4 decimals, for a price or an amount per share', () => {
  const price = (raw: string) => parseAmount(raw, false, 4);

  it('reads up to four decimals, the US way and the European way', () => {
    // With two decimals each of these was refused: a price of $12.3456 couldn't be entered.
    expect(price('12.3456').value).toBe(12.3456);
    expect(price('$1,234.5678').value).toBe(1234.5678);
    expect(price('1.234,5678').value).toBe(1234.5678);
    expect(price('1 234,5678 €').value).toBe(1234.5678);
    expect(price('1,2345').value).toBe(1.2345);
    expect(price('0.0001').value).toBe(0.0001);
    expect(price('12.5').value).toBe(12.5);
    expect(price('1,234,567.89').value).toBe(1234567.89);
    expect(price('1.234.567').value).toBe(1234567);
  });

  it('still refuses what could be read two ways, or would be cut down', () => {
    // A lone separator before three digits, after digits that could open a thousands
    // group: US 1.234 (three decimals) or European 1234?
    expect(price('1.234')).toEqual({ value: null, invalid: true });
    expect(price('12,345')).toEqual({ value: null, invalid: true });
    expect(price('999.999')).toEqual({ value: null, invalid: true });
    // Written so only one reading is left, they're read.
    expect(price('1.2340').value).toBe(1.234);
    expect(price('1,234.00').value).toBe(1234);
    expect(price('1.234,00').value).toBe(1234);
    // Digits that can't open a group: decimals.
    expect(price('0.125').value).toBe(0.125);
    expect(price('1234,567').value).toBe(1234.567);
    // Five decimals, and malformed groups, are refused, not cut.
    expect(price('12.34567').invalid).toBe(true);
    expect(price('1.234,56789').invalid).toBe(true);
    expect(price('1,234,56').invalid).toBe(true);
    expect(price('1,23.45').invalid).toBe(true);
    expect(price('1.2.3').invalid).toBe(true);
  });

  it('leaves two decimals as they were', () => {
    // The default: what every other field reads is unchanged.
    expect(parseAmount('1,234').value).toBe(1234);
    expect(parseAmount('1,2345').invalid).toBe(true);
    expect(parseAmount('12.345').invalid).toBe(true);
    expect(parseAmount('0.125').invalid).toBe(true);
  });
});

describe('parseAmount where the browser lists no currencies', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('still reads the common codes, and no other three letters', async () => {
    vi.spyOn(Intl as unknown as { supportedValuesOf: (key: string) => string[] }, 'supportedValuesOf').mockImplementation(() => {
      throw new RangeError('not supported');
    });
    vi.resetModules();
    const { parseAmount: fresh } = await import('../parseAmount');
    expect(fresh('USD 12').value).toBe(12);
    expect(fresh('12,50 eur').value).toBe(12.5);
    expect(fresh('1.5 MLN')).toEqual({ value: null, invalid: true });
    expect(fresh('12 XOF')).toEqual({ value: null, invalid: true });
  });
});
