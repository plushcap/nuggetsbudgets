import { describe, it, expect } from 'vitest';
import { spinoffActionSchema } from '@nuggets/shared';
import { buyEventSchema } from '@nuggets/shared';
import { decimalPlaces, decimalTextProblem, decimalUnits, percentToFraction, unitsText } from '../decimalText';

describe('percentToFraction', () => {
  it('moves the decimal point two places, in the text', () => {
    expect(percentToFraction('14.3')).toBe('0.143');
    expect(percentToFraction('33.3')).toBe('0.333');
    expect(percentToFraction('20')).toBe('0.2');
    expect(percentToFraction('100')).toBe('1');
    expect(percentToFraction('0.5')).toBe('0.005');
    expect(percentToFraction('.5')).toBe('0.005');
    expect(percentToFraction('5.')).toBe('0.05');
    expect(percentToFraction('0')).toBe('0');
    expect(percentToFraction('007.50')).toBe('0.075');
    expect(percentToFraction(' 12.3456 ')).toBe('0.123456');
    expect(percentToFraction('12345.6')).toBe('123.456');
  });

  it('is null for text that is not a plain decimal of zero or more', () => {
    for (const text of ['', ' ', '.', '-1', '+1', '1e2', '1.2.3', 'abc', '1,5']) expect(percentToFraction(text), text).toBeNull();
  });

  it('gives every two-decimal percentage from 0 to 100 as a fraction the API takes (2,760 of them failed as floats)', () => {
    let floatsRefused = 0;
    for (let hundredths = 0; hundredths <= 10_000; hundredths += 1) {
      const percent = (hundredths / 100).toFixed(2);
      const fraction = percentToFraction(percent);
      expect(fraction, percent).not.toBeNull();
      expect(Number(fraction), percent).toBeCloseTo(hundredths / 10_000, 12);
      const body = { source_security_uuid: '0190a0b0-0000-7000-8000-000000000001', new_security_uuid: '0190a0b0-0000-7000-8000-000000000002', action_date: '2026-01-01', share_ratio: 1 };
      expect(spinoffActionSchema.safeParse({ ...body, allocation_fraction: fraction }).success, percent).toBe(true);
      if (!spinoffActionSchema.safeParse({ ...body, allocation_fraction: Number(percent) / 100 }).success) floatsRefused += 1;
    }
    expect(floatsRefused).toBe(2760);
  });
});

describe('decimalPlaces', () => {
  it('counts the places after the point, trailing zeros not counted', () => {
    expect(decimalPlaces('0.1430')).toBe(3);
    expect(decimalPlaces('12')).toBe(0);
    expect(decimalPlaces('12.')).toBe(0);
    expect(decimalPlaces('0.1433333')).toBe(7);
  });
});

describe('decimalTextProblem', () => {
  it('takes a plain decimal above zero with at most the places given', () => {
    for (const text of ['12', '12.5', '0.000001', ' 3 ', '.5', '5.', '123456789012.123456']) expect(decimalTextProblem(text, 6), text).toBeNull();
  });

  it('refuses what a number field takes but the API does not, saying why', () => {
    // A type="number" field takes 1e2; the API reads decimals exactly and refuses it.
    expect(decimalTextProblem('1e2', 6)).toBe('Enter a plain number, like 12.5, without an exponent or a sign.');
    expect(buyEventSchema.shape.shares.safeParse('1e2').success).toBe(false);
    for (const text of ['1E-3', '-5', '+5', '0x10', '1.2.3', 'ten', '.']) expect(decimalTextProblem(text, 6), text).toMatch(/plain number/);
    expect(decimalTextProblem('', 6)).toBe('Enter a number.');
    expect(decimalTextProblem('1.0000001', 6)).toBe('Enter at most 6 decimal places.');
    // Trailing zeros don't count.
    expect(decimalTextProblem('1.0000010', 6)).toBeNull();
    expect(decimalTextProblem('0', 6)).toBe('Enter a number above zero.');
    expect(decimalTextProblem('0.000', 6, { allowZero: true })).toBeNull();
  });
});

describe('decimalUnits and unitsText', () => {
  it('read and write plain decimals exactly, in units', () => {
    expect(decimalUnits('12.5', 6)).toBe(12_500_000n);
    expect(decimalUnits('0.1', 6)! + decimalUnits('0.2', 6)!).toBe(decimalUnits('0.3', 6)); // not 0.30000000000000004
    expect(decimalUnits('123456789012.123456', 6)).toBe(123_456_789_012_123_456n);
    expect(decimalUnits('1.0000001', 6)).toBeNull();
    expect(decimalUnits('1e2', 6)).toBeNull();
    expect(decimalUnits('', 6)).toBeNull();
    expect(unitsText(12_500_000n, 6)).toBe('12.5');
    expect(unitsText(300_000n, 6)).toBe('0.3');
    expect(unitsText(0n, 6)).toBe('0');
    expect(unitsText(123_456_789_012_123_456n, 6)).toBe('123456789012.123456');
  });
});
