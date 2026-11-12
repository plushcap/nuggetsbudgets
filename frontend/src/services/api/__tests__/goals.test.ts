import { describe, it, expect, vi, afterEach } from 'vitest';
import { removeAccountFromGoal, removeBudgetItemFromGoal } from '../goals';

// A goal's linked account or envelope is named by its uuid in the unlink URL; the
// numeric paths answer 404.
describe('goal unlink URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ message: 'ok' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const sent = (fetchMock: ReturnType<typeof stubFetch>) => {
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return { path: new URL(url, 'http://localhost').pathname, method: init.method };
  };

  it('unlinks an account by its uuid', async () => {
    const fetchMock = stubFetch();
    await removeAccountFromGoal('goal-uuid', 'account-uuid');
    expect(sent(fetchMock)).toEqual({ path: '/api/goals/goal-uuid/accounts/account-uuid', method: 'DELETE' });
  });

  it('unlinks an envelope by its uuid', async () => {
    const fetchMock = stubFetch();
    await removeBudgetItemFromGoal('goal-uuid', 'item-uuid');
    expect(sent(fetchMock)).toEqual({ path: '/api/goals/goal-uuid/budget-items/item-uuid', method: 'DELETE' });
  });
});
