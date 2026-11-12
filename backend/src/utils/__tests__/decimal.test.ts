import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  DECIMAL_TEXT, DECIMAL_TEXT_MAX_LENGTH, budgetItemCreateSchema, budgetItemMatchingRuleCreateSchema, decimalInput, goalCreateSchema,
  isMoneyRangeMessage, moneyInput, readDecimal, trimTrailingZeros,
} from '@nuggets/shared';
import {
  SHARES, PER_SHARE, CENTS, WHOLE,
  assertFits, divRound, numericUnits, requestCents, requestUnits, rescale, unitsToNumber, unitsToText,
} from '../decimal.js';
import { ControlPlaneError } from '../../services/controlPlaneErrors.js';

/** The texts z.coerce.number() read as a number though none is one. */
const NOT_DECIMALS: unknown[] = ['1e2', '0x10', '', '  ', true, false, null, '12,50', '1_000', 'Infinity', NaN, Infinity, '+', '-', '.', {}, []];

describe('readDecimal (shared)', () => {
  it('reads text digit by digit and a number as the decimal it prints as', () => {
    expect(readDecimal('12.5', 4, 12)).toEqual({ units: 125000n });
    expect(readDecimal(12.5, 4, 12)).toEqual({ units: 125000n });
    expect(readDecimal(' -0.0001 ', 4, 12)).toEqual({ units: -1n });
    expect(readDecimal('.5', 6, 18)).toEqual({ units: 500000n });
    expect(readDecimal('5.', 6, 18)).toEqual({ units: 5000000n });
    expect(readDecimal('0012.340000', 2, 12)).toEqual({ units: 1234n }); // zeros either side don't count
    expect(readDecimal('-0', 6, 18)).toEqual({ units: 0n });
    // 18 digits, which no double holds: exact here.
    expect(readDecimal('123456789012.123456', 6, 18)).toEqual({ units: 123456789012123456n });
  });

  it('refuses more decimals than the scale, rather than rounding', () => {
    expect(readDecimal('12.3400000000000001', 2, 12)).toEqual({ problem: 'scale' });
    expect(readDecimal('1.0000001', 6, 18)).toEqual({ problem: 'scale' });
    expect(readDecimal(0.1 + 0.2, 6, 18)).toEqual({ problem: 'scale' }); // 0.30000000000000004
    // String() writes these with an exponent ("1e-7", "-1.5e-7"); they are read as the decimal they are.
    expect(readDecimal(1e-7, 6, 18)).toEqual({ problem: 'scale' });
    expect(readDecimal(-1.5e-7, 8, 18)).toEqual({ units: -15n });
    expect(readDecimal(1.25e-7, 9, 18)).toEqual({ units: 125n });
    expect(readDecimal('1.5', 0, 18)).toEqual({ problem: 'scale' });
  });

  it('refuses more whole digits than the column has room for', () => {
    expect(readDecimal('999999999999.999999', 6, 18)).toEqual({ units: 999999999999999999n });
    expect(readDecimal('1000000000000', 6, 18)).toEqual({ problem: 'range' });
    expect(readDecimal('-100000000', 4, 12)).toEqual({ problem: 'range' });
    expect(readDecimal(1e21, 6, 18)).toEqual({ problem: 'range' });
    expect(readDecimal('1000', 6, 9)).toEqual({ problem: 'range' }); // a weight: 999.999999 at most
  });

  it('refuses what isn\'t a decimal number', () => {
    for (const value of NOT_DECIMALS) expect(readDecimal(value, 6, 18), JSON.stringify(value)).toEqual({ problem: 'format' });
  });
});

describe('decimalInput (shared)', () => {
  const shares = decimalInput(6, 'shares must be a number', { precision: 18 });
  const messageOf = (value: unknown) => {
    const result = shares.safeParse(value);
    return result.success ? undefined : result.error.issues.map((i) => i.message);
  };

  it('passes a number or decimal text on as it came (text trimmed)', () => {
    expect(shares.parse(12.5)).toBe(12.5);
    expect(shares.parse(' 7.500000 ')).toBe('7.500000');
    expect(shares.parse('123456789012.123456')).toBe('123456789012.123456');
  });

  it('refuses each text z.coerce.number() read as a number, with one message', () => {
    for (const value of ['1e2', '0x10', '', true]) expect(messageOf(value), JSON.stringify(value)).toEqual(['shares must be a number']);
  });

  it('says what is wrong with an exact number the column can\'t hold', () => {
    expect(messageOf('12.3400000000000001')).toEqual(['shares must be a number with at most 6 decimal places']);
    expect(messageOf('1000000000000')).toEqual(['shares must be a number between -999,999,999,999.999999 and 999,999,999,999.999999']);
    expect(decimalInput(0, 'volume must be a whole number').safeParse('10.5').error?.issues[0].message).toBe('volume must be a whole number');
  });

  it('stops at its own message, before a refinement after it', () => {
    const positive = shares.refine((v) => Number(v) > 0, 'shares must be greater than zero');
    expect(positive.safeParse('').error?.issues.map((i) => i.message)).toEqual(['shares must be a number']);
    expect(positive.safeParse('0').error?.issues.map((i) => i.message)).toEqual(['shares must be greater than zero']);
    expect(z.object({ s: positive.optional() }).parse({})).toEqual({});
  });
});

describe('long decimal text (shared)', () => {
  const MB = 1_000_000;
  /** Texts a megabyte long that the old patterns took time quadratic in to refuse ("0." + "0" × 150,000 + "1" took seconds). */
  const LONG = ['0.' + '0'.repeat(MB) + '1', '0'.repeat(MB) + 'x', '0'.repeat(MB), '1.' + '0'.repeat(MB), ' '.repeat(10) + '9'.repeat(MB)];
  const elapsed = (run: () => unknown) => {
    const start = performance.now();
    run();
    return performance.now() - start;
  };
  /**
   * What the old patterns did took seconds on a sixth of this text, quadratic in its length, so
   * a bound of half a second still catches one coming back, while a busy machine (the suites run
   * in parallel) no longer trips it: 50 ms failed at 67 ms with the frontend suite alongside.
   */
  const LIMIT_MS = 500;

  it('refuses text longer than DECIMAL_TEXT_MAX_LENGTH, in a few milliseconds even a megabyte of it', () => {
    const shares = decimalInput(6, 'shares must be a number', { precision: 18 });
    const fees = moneyInput('fees must be a number');
    for (const text of LONG) {
      const label = `${JSON.stringify(text.slice(0, 12))}… (${text.length})`;
      expect(elapsed(() => expect(readDecimal(text, 6, 18), label).toEqual({ problem: 'format' })), label).toBeLessThan(LIMIT_MS);
      expect(elapsed(() => expect(shares.safeParse(text).error?.issues.map((i) => i.message), label).toEqual(['shares must be a number'])), label).toBeLessThan(LIMIT_MS);
      expect(elapsed(() => expect(fees.safeParse(text).error?.issues.map((i) => i.message), label).toEqual(['fees must be a number'])), label).toBeLessThan(LIMIT_MS);
      expect(elapsed(() => DECIMAL_TEXT.test(text)), label).toBeLessThan(LIMIT_MS);
    }
  });

  // A JSON number had no bound in moneyInput (fees of 1e12 passed the schema the forms
  // check with); now neither form passes what DECIMAL(12,2) can't hold.
  it('bounds money to what DECIMAL(12,2) holds, as a number and as text', () => {
    const fees = moneyInput('fees must be a number');
    const range = 'fees must be between -9,999,999,999.99 and 9,999,999,999.99';
    for (const value of [1e12, 1e10, -1e10, '10000000000', '-10000000000.00', '12345678901.5']) {
      expect(fees.safeParse(value).error?.issues.map((i) => i.message), String(value)).toEqual([range]);
    }
    for (const value of [9999999999.99, -9999999999.99, '9999999999.99', '-9999999999.99', '000000000012.50', 0, '0.5']) {
      expect(fees.safeParse(value).success, String(value)).toBe(true);
    }
  });

  // Past the column, a field got the range twice (moneyInput's check, then the
  // field's own decimal check), or the range and its sign ("greater than 0"). One message per
  // field now, which a form knows by isMoneyRangeMessage to say it for people instead.
  it('refuses money past the column with one message per field, which isMoneyRangeMessage knows', () => {
    const messagesAt = (schema: z.ZodType, body: object, field: string) =>
      schema.safeParse(body).error?.issues.filter((issue) => issue.path[0] === field).map((issue) => issue.message);
    const range = 'between -9,999,999,999.99 and 9,999,999,999.99';
    expect(messagesAt(budgetItemCreateSchema, { name: 'Gas', default_budget_amount: 99999999999 }, 'default_budget_amount'))
      .toEqual([`default_budget_amount must be ${range}`]);
    expect(messagesAt(goalCreateSchema, { name: 'Trip', target_amount: -1e10 }, 'target_amount')).toEqual([`Target amount must be ${range}`]);
    expect(messagesAt(budgetItemMatchingRuleCreateSchema, { budget_item_id: 1, method: 'contains', matching_text: 'GAS', amount_max: '10000000000' }, 'amount_max'))
      .toEqual([`amount_max must be ${range}`]);
    for (const message of [`default_budget_amount must be ${range}`, `Give an amount ${range}.`, `fees must be a number ${range}`]) {
      expect(isMoneyRangeMessage(message), message).toBe(true);
    }
    for (const message of ['shares must be a number between -999,999,999,999.999999 and 999,999,999,999.999999', 'Target amount must be greater than 0', 'fees must be a number', `${range}`]) {
      expect(isMoneyRangeMessage(message), message).toBe(false);
    }
  });

  it('takes text up to that length, zeros either side included', () => {
    const atMost = '1.' + '0'.repeat(DECIMAL_TEXT_MAX_LENGTH - 2);
    expect(atMost).toHaveLength(DECIMAL_TEXT_MAX_LENGTH);
    expect(readDecimal(atMost, 6, 18)).toEqual({ units: 1_000000n });
    expect(readDecimal(`${atMost}0`, 6, 18)).toEqual({ problem: 'format' });
    expect(readDecimal('0'.repeat(DECIMAL_TEXT_MAX_LENGTH - 1) + '7', 0, 18)).toEqual({ units: 7n });
    expect(moneyInput('m').parse(atMost)).toBe(atMost);
    expect(moneyInput('m').safeParse(`${atMost}0`).success).toBe(false);
    // Trimmed first, as before: padding around a short value doesn't count.
    expect(readDecimal(`${' '.repeat(100)}1.5${' '.repeat(100)}`, 6, 18)).toEqual({ units: 1_500000n });
    // A number String() writes with an exponent is written out, however long that is.
    expect(readDecimal(5e-324, 6, 18)).toEqual({ problem: 'scale' });
    expect(readDecimal(1.5e-20, 21, 40)).toEqual({ units: 15n });
  });

  it('trimTrailingZeros strips what /0+$/ did', () => {
    for (const text of ['', '0', '000', '10', '100', '0100', '1', '01', '1000000', '0a0', '5000', '050']) {
      expect(trimTrailingZeros(text), JSON.stringify(text)).toBe(text.replace(/0+$/, ''));
    }
  });

  it('DECIMAL_TEXT accepts exactly what its quadratic form did', () => {
    const OLD = /^[+-]?(\d+\.?\d*|\.\d+)$/;
    // Every text of up to 6 characters over an alphabet that exercises each part of the pattern.
    const alphabet = ['+', '-', '0', '7', '.', 'e', 'x', ' '];
    let texts = [''];
    let checked = 0;
    for (let length = 0; length <= 6; length += 1) {
      for (const text of texts) {
        checked += 1;
        if (DECIMAL_TEXT.test(text) !== OLD.test(text)) expect.unreachable(`${JSON.stringify(text)}: ${OLD.test(text)} before`);
      }
      texts = texts.flatMap((text) => alphabet.map((c) => text + c));
    }
    expect(checked).toBe(299593);
    for (const text of ['12.34', '-5', '+.5', '12.', '0', '007.50']) expect(DECIMAL_TEXT.test(text), text).toBe(true);
    for (const text of ['', '.', '+', '-.', '1.2.3', '1e2', ' 1', '1 ', '0x10']) expect(DECIMAL_TEXT.test(text), text).toBe(false);
  });
});

describe('fixed-point arithmetic (utils/decimal.ts)', () => {
  it('divRound rounds half away from zero, as Postgres ROUND does', () => {
    expect(divRound(5n, 2n)).toBe(3n);
    expect(divRound(-5n, 2n)).toBe(-3n);
    expect(divRound(5n, -2n)).toBe(-3n);
    expect(divRound(4n, 3n)).toBe(1n);
    expect(divRound(-4n, 3n)).toBe(-1n);
    expect(divRound(0n, 7n)).toBe(0n);
    expect(() => divRound(1n, 0n)).toThrow(RangeError);
    // 90 shares × $1.2345 = $111.105 exactly (a float product is 111.10499999999999).
    expect(divRound(90_000000n * 1_2345n, 10n ** 8n)).toBe(111_11n);
  });

  it('rescale adds places exactly and removes them by rounding', () => {
    expect(rescale(1234n, 2, 6)).toBe(12340000n);
    expect(rescale(12345n, 4, 2)).toBe(123n);
    expect(rescale(12350n, 4, 2)).toBe(124n);
    expect(rescale(-12350n, 4, 2)).toBe(-124n);
  });

  it('unitsToText writes exact text; unitsToNumber the nearest double', () => {
    expect(unitsToText(125000n, 4)).toBe('12.5000');
    expect(unitsToText(-1n, 4)).toBe('-0.0001');
    expect(unitsToText(0n, 2)).toBe('0.00');
    expect(unitsToText(123456789012123456n, 6)).toBe('123456789012.123456');
    expect(unitsToText(-42n, 0)).toBe('-42');
    expect(unitsToNumber(-4567n, 2)).toBe(-45.67);
  });

  it('numericUnits reads what pg returns, exactly at the column\'s scale', () => {
    expect(numericUnits('100.000000', SHARES.scale)).toBe(100_000000n);
    expect(numericUnits('26.6667', PER_SHARE.scale)).toBe(26_6667n);
    expect(numericUnits('-0.01', CENTS.scale)).toBe(-1n);
    // A wider value (a computed NUMERIC) is rounded to the scale asked for.
    expect(numericUnits('26.66666666666666666667', PER_SHARE.scale)).toBe(26_6667n);
    expect(() => numericUnits('NaN', 2)).toThrow(RangeError);
  });

  it('requestUnits answers what a column can\'t hold with a 400 naming the field', () => {
    expect(requestUnits('0.000001', 'shares', SHARES)).toBe(1n);
    for (const [value, message] of [
      ['0.0000001', 'shares must be a number with at most 6 decimal places'],
      ['1e2', 'shares must be a number'],
      ['1000000000000', 'shares must be a number between -999,999,999,999.999999 and 999,999,999,999.999999'],
    ] as const) {
      try {
        requestUnits(value, 'shares', SHARES);
        expect.unreachable(value);
      } catch (err) {
        expect(err).toBeInstanceOf(ControlPlaneError);
        expect(err).toMatchObject({ status: 400, code: 'INVALID_NUMBER', message });
      }
    }
    expect(requestUnits(9007199254740991, 'volume', WHOLE)).toBe(9007199254740991n);
  });

  it('requestCents reads money as readCents does, as a bigint of cents', () => {
    expect(requestCents('12.34', 'fees')).toBe(1234n);
    expect(requestCents(0, 'fees')).toBe(0n);
    expect(() => requestCents('12.345', 'fees')).toThrow(/fees must be a number with at most 2 decimal places/);
    expect(() => requestCents('10000000000', 'fees')).toThrow(/fees must be between/);
  });

  it('assertFits refuses a result larger than its column, with a 400', () => {
    expect(() => assertFits(999_999_999_999n, CENTS, 'The total')).not.toThrow();
    expect(() => assertFits(1_000_000_000_000n, CENTS, 'The total')).toThrow(/The total is larger than can be stored \(at most 9,999,999,999.99\)/);
    expect(() => assertFits(-(10n ** 18n), SHARES, 'The shares')).toThrow(ControlPlaneError);
  });
});
