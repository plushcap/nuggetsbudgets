import { describe, it, expect } from 'vitest';
import { asId } from '../tenantReferences.js';

/**
 * asId reads an id from a body or a form field: a positive `integer`, as a number or as its
 * plain decimal digits. `Number()` read '0x3', '3e0', '0b11' and '0o3' as 3, so text
 * that isn't an id named a row.
 */
describe('asId', () => {
  it('reads a positive integer, as a number or its digits (spaces around them allowed)', () => {
    expect([asId(3), asId('3'), asId(' 3 '), asId('007'), asId(2147483647), asId('2147483647')]).toEqual([3, 3, 3, 7, 2147483647, 2147483647]);
  });

  it.each([
    ['0x3'], ['3e0'], ['0b11'], ['0o3'], ['3.0'], ['+3'], ['-3'], ['3 4'], [''], ['   '], ['abc'], ['Infinity'],
    ['2147483648'], ['99999999999'],
  ])('refuses the text %j', (text) => {
    expect(asId(text)).toBeNull();
  });

  it.each([[0], [-1], [1.5], [2147483648], [Number.NaN], [null], [undefined], [true], [[3]], [{ id: 3 }]])('refuses %j', (value) => {
    expect(asId(value)).toBeNull();
  });
});
