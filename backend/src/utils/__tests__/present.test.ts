import { describe, expect, it } from 'vitest';
import { oneRow, present } from '../present.js';

describe('present', () => {
  it('passes a defined value through, falsy ones included', () => {
    expect(present(0, 'a count')).toBe(0);
    expect(present('', 'a name')).toBe('');
    expect(present(null, 'a nullable column')).toBeNull();
  });

  it('throws on undefined, naming what was expected', () => {
    expect(() => present(undefined, 'a day for each instant')).toThrow('Expected a day for each instant, found none');
  });
});

describe('oneRow', () => {
  it('answers the first row', () => {
    expect(oneRow([{ n: 3 }, { n: 4 }], 'count(*)')).toEqual({ n: 3 });
  });

  it('throws when the query answered no row, rather than read a field of undefined', () => {
    expect(() => oneRow<{ n: number }>([], 'count(*)')).toThrow('Expected a row from count(*), found none');
  });
});
