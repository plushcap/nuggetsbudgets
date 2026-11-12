import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

// Shared spies/mocks referenced by the hoisted vi.mock factories below.
const { getBalancesMock, mockPool, mockClient } = vi.hoisted(() => ({
  getBalancesMock: vi.fn(),
  mockClient: { query: vi.fn(), release: vi.fn() },
  mockPool: { connect: vi.fn(), query: vi.fn() },
}));

// AccountBalanceService.getBalances is a spy: the current progress must not call it per
// account, or at all, as its balances come from the one progress query.
vi.mock('../../services/AccountBalanceService.js', () => ({
  accountBalanceService: { getBalances: getBalancesMock },
}));

// GoalService reads via the request transaction (getDb()). In this unit test getDb() is
// backed by the mocked pool, so the SQL-string mocks below apply.
vi.mock('../../db/withTenant.js', () => ({
  getDb: () => new Kysely({ dialect: new PostgresDialect({ pool: mockPool as unknown as Pool }) }),
}));

import { GoalService } from '../../services/GoalService.js';

describe('GoalService.calculateCurrentProgress (batching)', () => {
  let service: GoalService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new GoalService();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  it("reads every account's balance and every envelope's in ONE query, as of today", async () => {
    mockClient.query.mockResolvedValue({
      rows: [{ snapshot_date: '2026-11-04', total_from_accounts: '175.00', total_from_budget_items: '25.50', total_progress: '200.50' }],
    });

    const result = await service.calculateCurrentProgress(7);

    // No N+1: one statement for the whole goal, which takes its accounts' balances from
    // account_balances_as_of and its envelopes' from the budget functions, at app_today().
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    const [text, params] = mockClient.query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain('account_balances_as_of');
    expect(text).toContain('calculate_remaining_for_period_item');
    expect(text).toContain('SELECT app_today()');
    // The goal, and no linksAsOf: each point takes its own day's links.
    expect(params).toEqual([null, 7, 7]);
    expect(getBalancesMock).not.toHaveBeenCalled();

    expect(result).toEqual({ totalFromAccounts: 175, totalFromBudgetItems: 25.5, totalProgress: 200.5 });
    expect(mockClient.release).toHaveBeenCalled();
  });

  it('answers 0 for a goal with nothing linked', async () => {
    mockClient.query.mockResolvedValue({
      rows: [{ snapshot_date: '2026-11-04', total_from_accounts: '0.00', total_from_budget_items: '0.00', total_progress: '0.00' }],
    });

    const result = await service.calculateCurrentProgress(1);

    expect(getBalancesMock).not.toHaveBeenCalled();
    expect(result).toEqual({ totalFromAccounts: 0, totalFromBudgetItems: 0, totalProgress: 0 });
    expect(mockClient.release).toHaveBeenCalled();
  });
});

describe('GoalService.progressAt', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockPool.connect.mockResolvedValue(mockClient);
  });

  it('asks for every date in one query, and for none sends no query', async () => {
    mockClient.query.mockResolvedValue({ rows: [] });
    const service = new GoalService();

    expect(await service.progressAt(3, [])).toEqual([]);
    expect(mockClient.query).not.toHaveBeenCalled();

    await service.progressAt(3, ['2026-09-30', '2026-10-31', '2026-11-04']);
    expect(mockClient.query).toHaveBeenCalledTimes(1);
    const [text, params] = mockClient.query.mock.calls[0] as [string, unknown[]];
    expect(text).toContain('unnest($1::date[])');
    expect(params).toEqual([['2026-09-30', '2026-10-31', '2026-11-04'], null, 3, 3]);

    // With linksAsOf, every point takes that day's links and hiding (the growth rate).
    await service.progressAt(3, ['2026-09-30', '2026-11-04'], { linksAsOf: '2026-11-04' });
    expect((mockClient.query.mock.calls[1] as [string, unknown[]])[1]).toEqual([['2026-09-30', '2026-11-04'], '2026-11-04', 3, 3]);
  });
});
