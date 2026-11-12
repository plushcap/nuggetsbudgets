import { describe, it, expect, vi } from 'vitest';

vi.hoisted(() => {
  process.env.LOG_LEVEL ??= 'silent';
});

import express from 'express';
import request from 'supertest';
import { holdingEventsQuery, queryString, QueryStringError, unusedSecuritiesQuery } from '@nuggets/shared';
import { refuseNulText } from '../middleware/nulText.js';

/**
 * A NUL character in a query is answered by the nulText middleware before any route;
 * shared's queryString refuses it before the request with exactly that answer's message, for
 * whichever field holds it (it threw the investments schema's own words, which
 * no route ever answers).
 */

const app = express();
app.use(refuseNulText);
app.get('/x', (_req, res) => res.json({ ok: true }));

/** What queryString refuses `values` with, and what the API answers the same query. */
async function both(schema: Parameters<typeof queryString>[0], values: Record<string, string>) {
  let refused: string | undefined;
  try {
    queryString(schema, values);
  } catch (err) {
    if (!(err instanceof QueryStringError)) throw err;
    refused = err.message;
  }
  const answer = await request(app).get('/x').query(values);
  return { refused, answered: answer.status === 400 ? answer.body.message : `HTTP ${answer.status}` };
}

describe('queryString and the API refuse a NUL the same way', () => {
  it('names the field, in the words the API answers', async () => {
    const { refused, answered } = await both(unusedSecuritiesQuery, { search: 'a\u0000b' });
    expect(refused).toBe("search can't contain a NUL character (\\u0000)");
    expect(refused).toBe(answered);
  });

  it('names the field the API names when several hold one', async () => {
    for (const values of [
      { event_type: 'buy\u0000', start_date: '2025-01-01\u0000' },
      { start_date: '\u0000', event_type: 'x\u0000y' },
      { event_type: '\u0000', page: '2' },
    ]) {
      const { refused, answered } = await both(holdingEventsQuery, values);
      expect(refused, JSON.stringify(values)).toBeDefined();
      expect(refused, JSON.stringify(values)).toBe(answered);
    }
  });
});
