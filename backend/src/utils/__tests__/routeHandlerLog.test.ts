import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// What the route wrapper hands to answerError for its log line on a failure: field names,
// never the values a query or body holds (a search, a payee, an amount; CLAUDE.md, Logging).
const logged: unknown[] = [];
vi.mock('../apiError.js', () => ({
  answerError: (_err: unknown, res: express.Response, log: unknown) => {
    logged.push(log);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  },
}));

const { asyncHandler } = await import('../routeHandler.js');

describe('route wrapper failure log', () => {
  it("names a failed request's query and body fields, never their values", async () => {
    const app = express();
    app.use(express.json());
    app.post('/api/things/:uuid', asyncHandler(async () => {
      throw new Error('boom');
    }));

    await request(app)
      .post('/api/things/0192f0c4-0000-7000-8000-000000000000?search=PAYEE-SECRET&page=2')
      .send({ amount: 'AMOUNT-SECRET', notes: 'NOTES-SECRET' })
      .expect(500);

    expect(logged).toHaveLength(1);
    const line = JSON.stringify(logged[0]);
    for (const secret of ['PAYEE-SECRET', 'AMOUNT-SECRET', 'NOTES-SECRET']) expect(line).not.toContain(secret);
    expect(logged[0]).toEqual(expect.objectContaining({
      queryKeys: ['search', 'page'],
      body: ['amount', 'notes'],
    }));
  });
});
