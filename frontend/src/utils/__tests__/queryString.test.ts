import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { QueryStringError, queryBoolean, queryEnum, queryInt, queryString, queryUuid, sellTaxImpactQuery, transactionPageQuerySchema } from '@nuggets/shared';

// A route's own kind of query schema, built from the shared query primitives.
const listQuery = z.object({
  page: queryInt({ min: 1, max: 1000, default: 1 }),
  account_id: queryInt({ min: 1, max: 2147483647 }),
  include_hidden: queryBoolean(),
  bucket: queryEnum(['day', 'week', 'month'] as const),
  tag_uuid: queryUuid(),
  search: z.string().optional(),
});

describe('queryString', () => {
  it('writes each set value once, as text, in the order given', () => {
    expect(queryString(listQuery, { page: 2, account_id: 7, include_hidden: false, bucket: 'week' })).toBe(
      '?page=2&account_id=7&include_hidden=false&bucket=week'
    );
  });

  it("refuses, at compile time, a key the route's schema doesn't read", () => {
    // A type check only (type-check runs the tests' tsconfig): never called.
    // @ts-expect-error `limit` isn't a key of listQuery.
    const wrongKey = () => queryString(listQuery, { limit: 5 });
    expect(typeof wrongKey).toBe('function');
  });

  // A loose schema (the transaction lists' filters pass other keys) has an index
  // signature, which let any key through the type; only the keys it names are taken.
  it("refuses, at compile time, a key a loose schema doesn't name", () => {
    const looseQuery = z.looseObject({ page: queryInt({ min: 1, max: 1000, default: 1 }), search: z.string().optional() });
    expect(queryString(looseQuery, { page: 2, search: 'tea' })).toBe('?page=2&search=tea');
    // @ts-expect-error `limit` isn't a key looseQuery names.
    const wrongKey = () => queryString(looseQuery, { limit: 5 });
    expect(typeof wrongKey).toBe('function');
    // @ts-expect-error nor is `assigned_too` one of the real transaction page's.
    const typo = () => queryString(transactionPageQuerySchema, { assigned_too: 3 });
    expect(typeof typo).toBe('function');
  });

  it("leaves out what isn't set, and is empty when nothing is", () => {
    expect(queryString(listQuery, { page: undefined, search: '', account_id: null })).toBe('');
    expect(queryString(listQuery, {})).toBe('');
  });

  it('encodes text the way URLSearchParams does', () => {
    expect(queryString(listQuery, { search: 'Café & co =1' })).toBe('?search=Caf%C3%A9+%26+co+%3D1');
  });

  it("throws the route's own message for a value it would refuse, before any request", () => {
    expect(() => queryString(listQuery, { bucket: 'year' })).toThrow(QueryStringError);
    expect(() => queryString(listQuery, { bucket: 'year' })).toThrow('bucket must be one of: day, week, month.');
    expect(() => queryString(listQuery, { tag_uuid: 'not-a-uuid' })).toThrow('tag_uuid must be a uuid.');
    expect(() => queryString(listQuery, { account_id: 0 })).toThrow('account_id must be a whole number from 1 to 2147483647.');
  });

  it('refuses a NUL in any field as the API does, before any route reads it', () => {
    expect(() => queryString(listQuery, { search: 'a\u0000b' })).toThrow(new QueryStringError("search can't contain a NUL character (\\u0000)"));
    expect(() => queryString(listQuery, { search: '\u0000', bucket: 'year' })).toThrow("search can't contain a NUL character");
  });

  it('builds what a real route reads: sell-tax impact', () => {
    const account = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b';
    const security = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6c';
    const text = queryString(sellTaxImpactQuery, { account, security, shares: '12.5', method: 'fifo' });
    expect(text).toBe(`?account=${account}&security=${security}&shares=12.5&method=fifo`);
    // The route's schema reads back what was written.
    const read = sellTaxImpactQuery.parse(Object.fromEntries(new URLSearchParams(text)));
    expect(read).toMatchObject({ account, security, shares: 12.5, method: 'fifo' });
    expect(() => queryString(sellTaxImpactQuery, { account, security, shares: '-1' })).toThrow('shares must be a positive number');
  });
});
