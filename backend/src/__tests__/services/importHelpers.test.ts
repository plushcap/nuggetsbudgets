import { describe, it, expect } from 'vitest';
import { datingSecond, importIdOf, parseImportAmount, truncateChars } from '../../services/import/importFields.js';
import { pendingFitsPosted, type VanishedPending } from '../../services/import/pendingMatcher.js';
import type { SimplefinTransaction } from '../../services/import/types.js';

/**
 * The import's pure helpers, which had no tests of their own while they were private to
 * ImportService. The sync tests (importSync.db.test.ts) cover them end to end.
 */

describe("reading a SimpleFin transaction's fields", () => {
  it('takes an id as text, and refuses a transaction without one', () => {
    expect(importIdOf('TX-1')).toBe('TX-1');
    expect(importIdOf(42)).toBe('42');
    for (const bad of [undefined, null, '', '  ', Number.NaN, {}]) expect(() => importIdOf(bad)).toThrow(/without an id/);
  });

  it('reads a plain decimal amount in cents, and refuses anything else', () => {
    expect(parseImportAmount('-12.34')).toEqual({ text: '-12.34', cents: -1234 });
    expect(parseImportAmount(' 5 ')).toEqual({ text: '5', cents: 500 });
    expect(parseImportAmount(7.5)).toEqual({ text: '7.5', cents: 750 });
    expect(parseImportAmount('.5')).toEqual({ text: '.5', cents: 50 });
    for (const bad of ['', 'abc', '1,000.00', '1e3', null, Number.POSITIVE_INFINITY]) {
      expect(() => parseImportAmount(bad)).toThrow(/isn't a number/);
    }
    // Without the value, which is logged and may be an amount written another way.
    expect(() => parseImportAmount('1,000.00')).toThrow(/^SimpleFin sent an amount that isn't a number \(text of 8 characters\)$/);
    expect(() => parseImportAmount(null)).toThrow(/\(none\)$/);
    expect(() => parseImportAmount(Number.NaN)).toThrow(/\(not a finite number\)$/);
  });

  it('dates by transacted_at, else posted, and only by a second Postgres can date', () => {
    const tx = (fields: Partial<SimplefinTransaction>) => ({ id: 'x', amount: '1', description: 'd', posted: 0, ...fields }) as SimplefinTransaction;
    expect(datingSecond(tx({ posted: 1_700_000_000, transacted_at: 1_699_000_000 }))).toBe(1_699_000_000);
    expect(datingSecond(tx({ posted: 1_700_000_000 }))).toBe(1_700_000_000);
    // A numeric string counts; milliseconds are out of range, so posted is used instead.
    expect(datingSecond(tx({ posted: '1700000000' as unknown as number }))).toBe(1_700_000_000);
    expect(datingSecond(tx({ posted: 1_700_000_000, transacted_at: 1_700_000_000_000 }))).toBe(1_700_000_000);
    expect(datingSecond(tx({ posted: 'soon' as unknown as number }))).toBeNull();
  });

  it('cuts text by characters, never inside a surrogate pair', () => {
    expect(truncateChars('abc', 5)).toBe('abc');
    expect(truncateChars('😀😀😀', 2)).toBe('😀😀');
  });
});

describe('a posted transaction replacing a pending one under a new id', () => {
  const pending: VanishedPending = {
    id: 1, importTransactionId: 'P1', cents: -5000, date: '2026-10-10', payee: 'Corner Bistro', description: 'CORNER BISTRO 123', flaggedBefore: false,
  };
  const posted = (fields: Partial<SimplefinTransaction> = {}) =>
    ({ id: 'T1', amount: '-61.25', description: 'CORNER BISTRO 999', payee: 'Corner Bistro', posted: 0, ...fields }) as SimplefinTransaction;

  it('fits the same merchant within the window, the amount equal or within the tolerance (a tip)', () => {
    expect(pendingFitsPosted(pending, posted(), -6125, '2026-10-12')).toBe(true);
    expect(pendingFitsPosted(pending, posted(), -5000, '2026-10-15')).toBe(true);
    expect(pendingFitsPosted(pending, posted(), -5000, '2026-10-09')).toBe(true);
  });

  it('does not fit outside the days, the tolerance or the sign', () => {
    expect(pendingFitsPosted(pending, posted(), -5000, '2026-10-16')).toBe(false);
    expect(pendingFitsPosted(pending, posted(), -5000, '2026-10-08')).toBe(false);
    expect(pendingFitsPosted(pending, posted(), -6300, '2026-10-12')).toBe(false);
    expect(pendingFitsPosted(pending, posted(), 5000, '2026-10-12')).toBe(false);
    expect(pendingFitsPosted(pending, posted(), 0, '2026-10-12')).toBe(false);
  });

  it("never fits another merchant, even for the same amount; compares descriptions when a side has no payee", () => {
    expect(pendingFitsPosted(pending, posted({ payee: 'Example Fuel' }), -5000, '2026-10-12')).toBe(false);
    const noPayee = { ...pending, payee: null };
    expect(pendingFitsPosted(noPayee, posted({ description: 'corner-bistro 123' }), -5000, '2026-10-12')).toBe(true);
    expect(pendingFitsPosted(noPayee, posted(), -5000, '2026-10-12')).toBe(false);
  });
});
