/**
 * Parsing an API answer with its `@nuggets/shared` response schema.
 *
 * The schemas name every field a route answers and read NUMERIC columns as numbers, so a
 * parsed answer is what the page's types say. When an answer doesn't match (a field the
 * schema refuses, or one it doesn't name and would drop), development and the tests throw,
 * naming the answer and the fields, so the drift is fixed where it starts. A production
 * build logs it and carries on: each row and field that matches is read (amounts as
 * numbers), and only what doesn't is kept as it came, so one odd row doesn't turn a whole
 * list's amounts back into text.
 */
import { z } from 'zod';
import { droppedKeys } from '@nuggets/shared';
import { logger } from '../../utils/logger';

/** As much of `raw` as `schema` reads: the rows and fields that match, read; the rest as they came. */
export function salvage(schema: z.ZodType, raw: unknown): unknown {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  if ((schema instanceof z.ZodOptional || schema instanceof z.ZodNullable) && raw !== undefined && raw !== null) {
    return salvage(schema.unwrap() as z.ZodType, raw);
  }
  if (schema instanceof z.ZodArray && Array.isArray(raw)) return raw.map((row) => salvage(schema.element as z.ZodType, row));
  // A record (the Sankey's `_drilldown`, by tag uuid): each entry read on its own, so one odd
  // entry doesn't leave every other one as it came. Its keys are kept as sent.
  if (schema instanceof z.ZodRecord && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const valueSchema = schema.valueType as z.ZodType;
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, salvage(valueSchema, value)]));
  }
  if (schema instanceof z.ZodObject && raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const shape = schema.shape as Record<string, z.ZodType>;
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>).map(([key, value]) => [key, Object.prototype.hasOwnProperty.call(shape, key) ? salvage(shape[key]!, value) : value]),
    );
  }
  return raw;
}

/** An answer that doesn't match its shared schema (thrown in development and tests only). */
export class AnswerContractError extends Error {
  constructor(readonly answer: string, readonly problems: string[]) {
    super(`The ${answer} answer doesn't match its @nuggets/shared schema: ${problems.join('; ')}`);
    this.name = 'AnswerContractError';
  }
}

/** Whether a mismatch throws: in development (`vite`) and the tests, not in a production build. */
export function answersFailLoudly(env: { DEV?: boolean; MODE?: string } = import.meta.env): boolean {
  return env.DEV === true || env.MODE === 'test';
}

/**
 * `raw` read with `schema`. `answer` names it in the error ('account', 'transactions page').
 * In development and tests a mismatch throws AnswerContractError; in production it is logged
 * (the paths and messages, never the values) and as much of `raw` as matches is read (salvage).
 */
export function parseAnswer<S extends z.ZodType>(schema: S, raw: unknown, answer: string, loud = answersFailLoudly()): z.output<S> {
  const result = schema.safeParse(raw);
  const problems = result.success
    ? droppedKeys(raw, result.data).slice(0, 20).map((path) => `${path} is not in the schema`)
    : result.error.issues.slice(0, 20).map((issue) => `${issue.path.join('.') || '(answer)'}: ${issue.message}`);
  if (problems.length === 0 && result.success) return result.data;
  if (loud) throw new AnswerContractError(answer, problems);
  logger.warn({ answer, problems }, 'API answer does not match its shared schema');
  return (result.success ? result.data : salvage(schema, raw)) as z.output<S>;
}
