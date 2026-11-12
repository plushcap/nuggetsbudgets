import { describe, it, expect, afterEach, vi } from 'vitest';
import { mockApi } from '../../../test/apiServer';
import { rebuildNetWorthHistory } from '../networth';

describe('rebuildNetWorthHistory', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the whole history and sends no range the route would ignore', async () => {
    const result = { message: 'Rebuilt', snapshots_created: 3, earliest_date: '2026-01-01', latest_date: '2026-01-03', total_days: 3 };
    const api = mockApi({ 'POST /net-worth/rebuild': result });
    await expect(rebuildNetWorthHistory()).resolves.toEqual(result);
    const [call] = api.calls('POST /net-worth/rebuild');
    expect(call.body).toBeUndefined();
    expect(api.unhandled).toEqual([]);
  });
});
