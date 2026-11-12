import { describe, it, expect } from 'vitest';
import { transactionPageQuerySchema } from '@nuggets/shared';
import { callTool, makeFetchStub } from './harness.js';

/**
 * The classification inbox's query: list_tasks asks GET /api/transactions/paginated
 * only for what that route's own query schema reads, and a value it would refuse is refused
 * before any request goes.
 */
describe('list_tasks query', () => {
  const declared = new Set(Object.keys(transactionPageQuerySchema.shape));

  it.each([
    [{ assignedTo: 3, includeUnassigned: true, page: 2, limit: 10 }],
    [{ assignedTo: 3 }],
    [{}],
  ])('asks only for keys the route reads, which it accepts (%j)', async (args) => {
    const { calls, fetchImpl } = makeFetchStub({ transactions: [], pagination: {} });
    const result = await callTool(fetchImpl, 'list_tasks', args);
    expect(result.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    const query = Object.fromEntries(new URL(calls[0]!.url).searchParams);
    expect(Object.keys(query).filter((key) => !declared.has(key))).toEqual([]);
    expect(transactionPageQuerySchema.safeParse(query).success).toBe(true);
  });

  it('refuses a value the route would refuse, before asking', async () => {
    const { calls, fetchImpl } = makeFetchStub({});
    // The tool's own input schema stops this; called without it, the route's schema does.
    const result = await callTool(fetchImpl, 'list_tasks', { assignedTo: 'not-a-number' });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
