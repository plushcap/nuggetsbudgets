import { describe, it, expect } from 'vitest';
import {
  toCents, readCents, fitsAmount, invalidAmountAnswer, centsToAmount, centsToNumber, numericToCents, MAX_AMOUNT_CENTS,
} from '../money.js';
import { DECIMAL_TEXT_MAX_LENGTH } from '@nuggets/shared';

describe('money', () => {
  it('reads numbers and decimal strings as exact cents', () => {
    expect(toCents(45.67)).toBe(4567);
    expect(toCents(-45.67)).toBe(-4567);
    expect(toCents('-45.67')).toBe(-4567);
    expect(toCents('45.670')).toBe(4567);
    expect(toCents(' 12 ')).toBe(1200);
    expect(toCents('12.')).toBe(1200);
    expect(toCents('.5')).toBe(50);
    expect(toCents('+3.10')).toBe(310);
    expect(toCents('-0.00')).toBe(0);
    expect(Object.is(toCents(-0), 0)).toBe(true);
    // Amounts whose x100 isn't a whole number as a float still read exactly.
    expect(19.99 * 100).not.toBe(1999);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0.29)).toBe(29);
    expect(toCents(1000.01)).toBe(100001);
  });

  it('refuses more than 2 decimals rather than rounding them', () => {
    expect(toCents(33.333)).toBeNull();
    expect(toCents('33.333')).toBeNull();
    expect(toCents(0.1 + 0.2)).toBeNull(); // 0.30000000000000004
    expect(toCents(1e-7)).toBeNull();
  });

  it('refuses what is not an amount or does not fit DECIMAL(12,2)', () => {
    for (const bad of [null, undefined, '', ' ', '.', '-', 'abc', '1,000.00', '1e2', NaN, Infinity, true, {}, []]) {
      expect(toCents(bad)).toBeNull();
    }
    expect(toCents('9999999999.99')).toBe(MAX_AMOUNT_CENTS);
    expect(toCents('-9999999999.99')).toBe(-MAX_AMOUNT_CENTS);
    expect(toCents('10000000000.00')).toBeNull();
    expect(toCents(1e21)).toBeNull();
  });

  it('refuses text longer than DECIMAL_TEXT_MAX_LENGTH unread, in a few milliseconds even a megabyte of it', () => {
    // "0." + "0" × n + "1": /0+$/ took time quadratic in n to strip the zeros (n = 150,000 took seconds).
    for (const text of ['0.' + '0'.repeat(1_000_000) + '1', '1.' + '0'.repeat(1_000_000), '0'.repeat(1_000_000) + '5']) {
      const start = performance.now();
      expect(readCents(text)).toEqual({ problem: 'format' });
      expect(performance.now() - start).toBeLessThan(50);
    }
    const atMost = '12.' + '0'.repeat(DECIMAL_TEXT_MAX_LENGTH - 3);
    expect(readCents(atMost)).toEqual({ cents: 1200 });
    expect(readCents(`${atMost}0`)).toEqual({ problem: 'format' });
    expect(readCents(`${' '.repeat(100)}12.34 `)).toEqual({ cents: 1234 });
  });

  it('says whether a refused value is not an amount or too large for one', () => {
    for (const bad of [null, 'abc', '1e2', '0x10', 12.345, '12.3400000000000001', 1e-7, NaN, Infinity]) {
      expect(readCents(bad), String(bad)).toEqual({ problem: 'format' });
    }
    for (const big of [1e10, -1e10, 1e21, '10000000000', '-10000000000.00', '12345678901.5']) {
      expect(readCents(big), String(big)).toEqual({ problem: 'range' });
    }
    expect(readCents('9999999999.99')).toEqual({ cents: MAX_AMOUNT_CENTS });
    expect(readCents(-9999999999.99)).toEqual({ cents: -MAX_AMOUNT_CENTS });
    expect(fitsAmount(MAX_AMOUNT_CENTS)).toBe(true);
    expect(fitsAmount(-MAX_AMOUNT_CENTS - 1)).toBe(false);
    expect(invalidAmountAnswer('amount', 'range')).toEqual({
      error: 'amount must be between -9,999,999,999.99 and 9,999,999,999.99',
      code: 'INVALID_AMOUNT',
    });
    expect(invalidAmountAnswer('amount', 'format')).toEqual({
      error: 'amount must be a number with at most 2 decimal places',
      code: 'INVALID_AMOUNT',
    });
  });

  it('adds exactly where floats drift', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(centsToNumber((toCents(0.1) as number) + (toCents(0.2) as number))).toBe(0.3);
    // The issue's example: three -33.33 splits are 1 cent off -100.00, which the old
    // float tolerance of 0.01 couldn't decide reliably (the gap is 0.010000000000005).
    expect(Math.abs(-33.33 * 3 + 100)).toBeGreaterThan(0.01);
    expect([-33.33, -33.33, -33.33].reduce((s, v) => s + (toCents(v) as number), 0)).toBe(-9999);
    let float = 0;
    let cents = 0;
    for (let i = 0; i < 100_000; i++) {
      float += 19.99;
      cents += toCents(19.99) as number;
    }
    expect(float).not.toBe(1999000);
    expect(centsToNumber(cents)).toBe(1999000);
  });

  it('writes cents back as an exact decimal string', () => {
    expect(centsToAmount(4567)).toBe('45.67');
    expect(centsToAmount(-4567)).toBe('-45.67');
    expect(centsToAmount(5)).toBe('0.05');
    expect(centsToAmount(-5)).toBe('-0.05');
    expect(centsToAmount(0)).toBe('0.00');
    expect(centsToAmount(-0)).toBe('0.00');
    expect(centsToAmount(MAX_AMOUNT_CENTS)).toBe('9999999999.99');
    expect(centsToNumber(-9999)).toBe(-99.99);
  });

  it('reads a database sum, larger than one column holds, in cents', () => {
    expect(numericToCents('123456789012.34')).toBe(12345678901234);
    expect(numericToCents('-0.10')).toBe(-10);
    expect(numericToCents(null)).toBe(0);
  });
});
