import { Request, Response, NextFunction } from 'express';
import type { ZodError, ZodType } from 'zod';
import { createLogger, pathOnly } from '../utils/logger.js';
import { answerMalformedId, hasMalformedId } from './routeParams.js';

const logger = createLogger({ service: 'Validation' });

/**
 * Body-validation middleware backed by a shared Zod schema (@nuggets/shared).
 *
 * On success, replaces `req.body` with the parsed value — so defaults are
 * applied and FormData strings are coerced (booleans, numbers) before the
 * handler runs. On failure, responds 400 with structured field errors.
 *
 * This is the single entry point that retires per-route hand validation as
 * entities adopt their shared schema.
 *
 * `codes` keeps the refusal codes a route answered before it took a schema: the
 * answer's `code` is the one named for the field of its first error (`{ scope:
 * 'INVALID_SCOPE' }`), else VALIDATION_ERROR.
 */
export interface ValidateBodyOptions {
  codes?: Readonly<Record<string, string>>;
}

export function validateBody<T>(schema: ZodType<T>, options: ValidateBodyOptions = {}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    // A path that names nothing gets the 404 it would get from the handler (it runs
    // after the route's guards, like this check).
    if (hasMalformedId(res)) {
      answerMalformedId(res);
      return;
    }
    const result = schema.safeParse(req.body);
    if (!result.success) {
      answerInvalid(req, res, result.error, 'body', options.codes);
      return;
    }
    req.body = result.data;
    next();
  };
}

/** The query each request's validateQuery parsed, with the schema it parsed it with. */
const parsedQueries = new WeakMap<Request, { schema: ZodType; value: unknown }>();

/**
 * Query-string validation backed by a Zod schema, the counterpart of {@link validateBody}.
 * A query value arrives as a string (or an array of them, `?a=1&a=2`), so build the
 * schema from the query primitives in @nuggets/shared (`queryInt`, `queryPage`,
 * `queryBoolean`, `queryUuid`, `queryCalendarDay`, `queryEnum`, `emptyAsUndefined`), which
 * read text and take an empty value (`?offset=`) as not given; `z.coerce.number()` alone
 * reads it as 0.
 *
 * On success the handler reads the parsed value (defaults applied, numbers coerced) with
 * {@link parsedQuery}, typed, or as `req.query`: it replaces the request's own property,
 * which works on Express 5, where `req.query` is a getter. On failure it answers 400
 * VALIDATION_ERROR with each field's error, as validateBody does.
 */
export function validateQuery<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (hasMalformedId(res)) {
      answerMalformedId(res);
      return;
    }
    const result = schema.safeParse(req.query);
    if (!result.success) {
      answerInvalid(req, res, result.error, 'query');
      return;
    }
    parsedQueries.set(req, { schema, value: result.data });
    Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true, enumerable: true });
    next();
  };
}

/**
 * The query string `validateQuery(schema)` parsed for this request, typed as the schema's
 * output:
 *
 *   router.get('/', validateQuery(securityListQuery), tenantHandler(async (req, res) => {
 *     const { page, limit, account } = parsedQuery(req, securityListQuery);
 *
 * Pass the schema the route mounted. A request that schema didn't parse (the route mounts
 * another, or none) throws: a bug, answered 500, which the route's tests catch.
 */
export function parsedQuery<T>(req: Request, schema: ZodType<T>): T {
  const parsed = parsedQueries.get(req);
  if (parsed?.schema !== schema) {
    throw new Error(`parsedQuery: ${req.method} ${pathOnly(req.originalUrl)} did not validate its query with this schema`);
  }
  return parsed.value as T;
}

/**
 * Answer 400 with a failed body parse's field errors, as {@link validateBody} does. For a
 * handler whose schema depends on stored data, so it validates the body itself.
 */
export function answerInvalidBody(req: Request, res: Response, error: ZodError): void {
  answerInvalid(req, res, error, 'body');
}

function answerInvalid(
  req: Request,
  res: Response,
  error: ZodError,
  part: 'body' | 'query',
  codes: Readonly<Record<string, string>> = {}
): void {
  const details = error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));
  const field = String(error.issues[0]?.path[0] ?? '');
  const code = Object.prototype.hasOwnProperty.call(codes, field) ? codes[field] : 'VALIDATION_ERROR';
  // The field names and Zod's messages only: never the values (a query can hold a search).
  logger.warn({ details, url: pathOnly(req.originalUrl) }, `Request ${part} validation failed`);
  res.status(400).json({
    error: 'Validation failed',
    code,
    // Surface the first issue's message at the top level so callers that
    // read `message` (UI, older tests) get a human-readable reason.
    message: details[0]?.message ?? 'Validation failed',
    details,
  });
}
