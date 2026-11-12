import { describe, it, expect, vi, expectTypeOf } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});
import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import {
  BUDGET_EXPENSE_TYPES,
  QUERY_MAX_PAGE,
  emptyAsUndefined,
  queryBoolean,
  queryCalendarDay,
  queryEnum,
  queryInt,
  queryPage,
  queryUuid,
} from '@nuggets/shared';
import { parsedQuery, validateQuery } from '../middleware/validate.js';
import { boundedQueryInt, pageParams } from '../utils/pagination.js';

// The query-string primitives in @nuggets/shared, and a route reading a
// shared query schema through validateQuery, typed.

const UUID = '00000000-0000-7000-8000-000000000000';

/** The parsed value, or the issues' messages by field. */
const parse = <T>(schema: z.ZodType<T>, value: unknown) => {
  const result = z.object({ x: schema }).safeParse(value === undefined ? {} : { x: value });
  return result.success ? { value: result.data.x } : { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
};

describe('emptyAsUndefined', () => {
  it('reads an empty value as not given, and passes anything else to the schema', () => {
    const schema = emptyAsUndefined(z.coerce.number());
    expect(parse(schema, '')).toEqual({ value: undefined });
    expect(parse(schema, undefined)).toEqual({ value: undefined });
    expect(parse(schema, '0')).toEqual({ value: 0 });
    expect(parse(schema, 'x')).toHaveProperty('issues');
  });
});

describe('queryInt', () => {
  describe('with a default: read as utils/pagination.ts reads a page size', () => {
    const schema = queryInt({ min: 1, max: 200, default: 20 });
    // Every kind of value a query can hold, read both ways.
    const values: unknown[] = [undefined, '', '0', '1', '20', '200', '201', '1000000', '-5', 'abc', '12abc', '2.9', ' 7', '1e3', ['3', '4'], '99999999999999999999'];
    it.each(values.map((v) => [JSON.stringify(v), v]))('%s answers as pagination.ts does', (_label, value) => {
      expect(parse(schema, value)).toEqual({ value: boundedQueryInt(value, { fallback: 20, min: 1, max: 200 }) });
    });

    it('never refuses', () => {
      for (const value of values) expect(parse(schema, value)).toHaveProperty('value');
    });
  });

  describe('without one: a filter, refused unless it is a whole number in range', () => {
    const schema = queryInt({ min: 1, max: 10 });

    it('reads a whole number in range, and not given as undefined', () => {
      expect(parse(schema, '1')).toEqual({ value: 1 });
      expect(parse(schema, '10')).toEqual({ value: 10 });
      expect(parse(schema, '007')).toEqual({ value: 7 });
      expect(parse(schema, '')).toEqual({ value: undefined });
      expect(parse(schema, undefined)).toEqual({ value: undefined });
    });

    it('refuses anything else, saying what it takes', () => {
      for (const value of ['0', '11', '-1', '2.5', 'abc', '12abc', ' 3', '1e1', '0x5', ['1', '2'], '9'.repeat(40)]) {
        expect(parse(schema, value), JSON.stringify(value)).toEqual({ issues: ['x: x must be a whole number from 1 to 10.'] });
      }
    });

    it('takes a sign when it may be below 0, and its own message', () => {
      const signed = queryInt({ min: -5, max: 5, message: 'offset must be from -5 to 5' });
      expect(parse(signed, '-5')).toEqual({ value: -5 });
      expect(parse(signed, '-6')).toEqual({ issues: ['x: offset must be from -5 to 5'] });
    });

    it('reads -0 as 0, not negative zero', () => {
      const signed = queryInt({ min: -5, max: 5 });
      const read = parse(signed, '-0') as { value: number };
      expect(Object.is(read.value, 0)).toBe(true);
    });
  });
});

describe('queryPage', () => {
  const schema = z.object(queryPage({ defaultLimit: 20, maxLimit: 200 }));
  it.each([
    [{}],
    [{ page: '3', limit: '50' }],
    [{ page: '0', limit: '0' }],
    [{ page: '', limit: '' }],
    [{ page: 'x', limit: '-1' }],
    [{ page: String(QUERY_MAX_PAGE + 1), limit: '500' }],
  ])('%j reads as pageParams does', (query) => {
    const { page, limit } = pageParams(query, { defaultLimit: 20, maxLimit: 200 });
    expect(schema.parse(query)).toEqual({ page, limit });
  });
});

describe('queryBoolean', () => {
  it('reads true and false; not given is undefined, or the default', () => {
    expect(parse(queryBoolean(), 'true')).toEqual({ value: true });
    expect(parse(queryBoolean(), 'false')).toEqual({ value: false });
    expect(parse(queryBoolean(), '')).toEqual({ value: undefined });
    expect(parse(queryBoolean({ default: false }), undefined)).toEqual({ value: false });
    expect(parse(queryBoolean({ default: true }), '')).toEqual({ value: true });
    expect(parse(queryBoolean({ default: true }), 'false')).toEqual({ value: false });
  });

  it('refuses anything else', () => {
    for (const value of ['1', 'yes', 'TRUE', ['true', 'false']]) {
      // The message names the field.
      expect(parse(queryBoolean({ default: false }), value)).toEqual({ issues: ['x: x must be true or false.'] });
    }
  });
});

describe('queryUuid', () => {
  it('reads a uuid, refuses anything else', () => {
    expect(parse(queryUuid(), UUID)).toEqual({ value: UUID });
    expect(parse(queryUuid(), '')).toEqual({ value: undefined });
    expect(parse(queryUuid(), 'not-a-uuid')).toEqual({ issues: ['x: x must be a uuid.'] });
    expect(parse(queryUuid({ message: 'account must be a uuid' }), [UUID, UUID])).toEqual({ issues: ['x: account must be a uuid'] });
  });
});

describe('queryCalendarDay', () => {
  it('reads a real day from 1800 to 2999, as calendarDay does in a body', () => {
    expect(parse(queryCalendarDay(), '2026-02-28')).toEqual({ value: '2026-02-28' });
    expect(parse(queryCalendarDay(), '')).toEqual({ value: undefined });
    for (const value of ['2026-02-30', '0001-01-01', '2026-1-1', '2026-02-28T00:00:00Z']) {
      expect(parse(queryCalendarDay(), value)).toEqual({ issues: ['x: x must be a real date, as YYYY-MM-DD, from 1800 to 2999.'] });
    }
    expect(parse(queryCalendarDay({ message: 'start_date must be a date' }), '2026-13-01')).toEqual({ issues: ['x: start_date must be a date'] });
  });
});

describe('queryEnum', () => {
  it('reads one of the list; not given is undefined, or the default; anything else is refused', () => {
    expect(parse(queryEnum(BUDGET_EXPENSE_TYPES), 'Income')).toEqual({ value: 'Income' });
    expect(parse(queryEnum(BUDGET_EXPENSE_TYPES), '')).toEqual({ value: undefined });
    expect(parse(queryEnum(['a', 'b'], { default: 'b' }), undefined)).toEqual({ value: 'b' });
    expect(parse(queryEnum(['a', 'b']), 'c')).toEqual({ issues: ['x: x must be one of: a, b.'] });
  });
});

describe('a route reading a shared query schema through validateQuery', () => {
  const listQuery = z.object({
    ...queryPage({ defaultLimit: 25, maxLimit: 100 }),
    account: queryUuid(),
    from: queryCalendarDay(),
    archived: queryBoolean({ default: false }),
    kind: queryEnum(['income', 'expense']),
  });

  const app = express();
  app.get('/items', validateQuery(listQuery), (req, res) => {
    const query = parsedQuery(req, listQuery);
    // Typed as the schema's output: no casts.
    expectTypeOf(query.page).toEqualTypeOf<number>();
    expectTypeOf(query.archived).toEqualTypeOf<boolean>();
    expectTypeOf(query.account).toEqualTypeOf<string | undefined>();
    expectTypeOf(query.kind).toEqualTypeOf<'income' | 'expense' | undefined>();
    res.json({ query, offset: (query.page - 1) * query.limit });
  });
  // A route that reads a schema its validateQuery didn't parse: a bug, answered 500.
  app.get('/wrong', validateQuery(z.object({})), (req, res) => {
    res.json(parsedQuery(req, listQuery));
  });
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: 'Internal server error' });
  });

  it('hands the handler the parsed values', async () => {
    const res = await request(app).get(`/items?page=2&limit=500&account=${UUID}&from=2026-03-01&archived=true&kind=income&extra=1`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      query: { page: 2, limit: 100, account: UUID, from: '2026-03-01', archived: true, kind: 'income' },
      offset: 100,
    });
  });

  it('applies the defaults and reads empty values as not given', async () => {
    const res = await request(app).get('/items?account=&from=&kind=');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ query: { page: 1, limit: 25, archived: false }, offset: 0 });
  });

  it('answers 400 VALIDATION_ERROR naming each bad field', async () => {
    const res = await request(app).get('/items?account=x&from=2026-02-30&archived=yes&kind=other');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.details.map((d: { field: string }) => d.field).sort()).toEqual(['account', 'archived', 'from', 'kind']);
  });

  it('refuses to read a query the route did not validate with that schema', async () => {
    expect((await request(app).get('/wrong')).status).toBe(500);
  });
});
