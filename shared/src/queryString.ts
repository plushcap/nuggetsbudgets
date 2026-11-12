import type { z } from 'zod';

/** A value for a query string: text, or a number or boolean written as text. */
export type QueryValue = string | number | boolean | null | undefined;

/**
 * The keys `T` names: a loose schema's index signature (`[key: string]: unknown`) is left out,
 * so a key the schema doesn't name is a type error for a loose schema too.
 */
type NamedKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : symbol extends K ? never : K]: T[K];
};

/** The values a query string is built from: the keys the route's query schema names. */
export type QueryValues<S extends z.ZodType> = {
  [K in NamedKeys<z.output<S>>]?: QueryValue;
};

const NUL = String.fromCharCode(0);

/**
 * What the API answers for a NUL character in a field's text, before any route reads it (the
 * backend's nulText middleware): `field` as the middleware names it.
 */
export const nulTextMessage = (field: string): string => `${field} can't contain a NUL character (\\u0000)`;

/** A query the route would refuse, found before the request is made: its message is the route's. */
export class QueryStringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryStringError';
  }
}

/**
 * The query string for a request whose route reads its query with `schema`, the route's own
 * schema from this package. It has its leading `?`, or is '' when nothing is set.
 *
 * - **Values:** each field that is set (not `undefined`, `null` or `''`) is written once, as
 *   text: a boolean as `true`/`false`, a number as its digits. A route's query reads each value
 *   once (`queryTextFilter`: a value sent twice is a list, which no filter takes).
 * - **Check:** the result is checked with `schema` itself, so a value the route would refuse
 *   throws a {@link QueryStringError} here, with the route's own message, and no request goes.
 *   A NUL character in a value is refused first, with what the API answers before any route
 *   ({@link nulTextMessage}, naming the field the middleware's walk finds).
 *   A key the schema doesn't name is a type error, for a loose schema too (its index
 *   signature is left out of {@link QueryValues}).
 */
export function queryString<S extends z.ZodType>(schema: S, values: QueryValues<S>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values as Record<string, QueryValue>)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  // As the middleware walks the query: a key with a NUL first (the first), else a value's (the last).
  const entries = [...params];
  const withNul = entries.find(([key]) => key.includes(NUL)) ?? entries.filter(([, value]) => value.includes(NUL)).pop();
  if (withNul) throw new QueryStringError(nulTextMessage(withNul[0].replaceAll(NUL, '\\u0000')));
  const checked = schema.safeParse(Object.fromEntries(params));
  if (!checked.success) {
    throw new QueryStringError(checked.error.issues[0]?.message ?? 'The query is not valid.');
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}
