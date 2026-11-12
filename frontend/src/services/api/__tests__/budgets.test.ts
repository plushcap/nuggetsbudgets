import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryStringError } from '@nuggets/shared';
import { getBudgetEventHistory, getBudgetItemActivity, getBudgetItemTransactions, getBudgetPeriodItems, transferBetweenBudgetItems } from '../budgets';
import { AnswerContractError } from '../parseAnswer';
import { uuidFor } from '../../../test/fixtures';

const PERIOD = uuidFor(2, 1);
const ITEM = uuidFor(4, 1);
const BUDGET_ITEM = uuidFor(3, 1);

const stubFetch = (body: unknown) => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const urlOf = (fetchMock: ReturnType<typeof stubFetch>) => new URL((fetchMock.mock.calls[0] as unknown as [string])[0], 'http://localhost');

afterEach(() => {
  vi.unstubAllGlobals();
});

// A budget period and a period item are named by their uuids in URLs; the numeric
// paths answer 404.
describe('budget-period URLs', () => {
  it("transfers within the period named by its uuid, the items' ids in the body", async () => {
    const fetchMock = stubFetch({ success: true, message: 'Moved', transferUuid: uuidFor(15, 1), fromItem: 'A', toItem: 'B', amount: 12.5 });
    await transferBetweenBudgetItems(PERIOD, 3, 4, 12.5, 'Top up');
    expect(urlOf(fetchMock).pathname).toBe(`/api/budget-periods/${PERIOD}/transfer`);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ fromBudgetPeriodItemId: 3, toBudgetPeriodItemId: 4, amount: 12.5, description: 'Top up' });
  });

  it("reads a period item's activity and transactions by its uuid", async () => {
    let fetchMock = stubFetch([]);
    await getBudgetItemActivity(ITEM);
    expect(urlOf(fetchMock).pathname).toBe(`/api/budget-periods/items/${ITEM}/budget-activity`);
    fetchMock = stubFetch([]);
    await getBudgetItemTransactions(ITEM);
    expect(urlOf(fetchMock).pathname).toBe(`/api/budget-periods/items/${ITEM}/transactions`);
  });
});

describe('getBudgetEventHistory', () => {
  // It sent budgetItemUuid/periodUuid, which the server ignored, so the
  // bill page's history was every item's latest events (shown as none).
  it("asks for one item's events by the query parameters the server reads, and reads the amounts as numbers", async () => {
    const event = {
      eventId: 1, timestamp: '2026-10-01T12:00:00.000Z', budgetItemName: 'Rent', periodName: 'October 2026', eventType: 'budget_update',
      transactionType: 'add', amount: 25, description: 'Initial budget for Rent', userName: 'Pat Doe',
    };
    const fetchMock = stubFetch({ success: true, data: [event] });

    const res = await getBudgetEventHistory(BUDGET_ITEM, PERIOD, 20);

    expect(urlOf(fetchMock).searchParams.toString()).toBe(`budget_item_uuid=${BUDGET_ITEM}&period_uuid=${PERIOD}&limit=20`);
    expect(res.data).toEqual([event]);
  });

  // The query is the route's own schema's, so what it would refuse goes nowhere.
  it('refuses, before any request, a uuid the route would refuse', async () => {
    const fetchMock = stubFetch({ success: true, data: [] });
    await expect(getBudgetEventHistory('not-a-uuid')).rejects.toThrow(new QueryStringError('budget_item_uuid must be a uuid'));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Every answer is read with its shared schema; in the tests a field it doesn't
// name throws, naming the answer.
describe('budget answers', () => {
  it("reads one item's period row by the item's uuid, and refuses an answer with a field the schema doesn't name", async () => {
    const fetchMock = stubFetch({ success: true, data: [], message: 'not in the schema' });
    await expect(getBudgetPeriodItems(PERIOD, BUDGET_ITEM)).rejects.toThrow(AnswerContractError);
    expect(urlOf(fetchMock).search).toBe(`?budget_item_uuid=${BUDGET_ITEM}`);
  });
});
