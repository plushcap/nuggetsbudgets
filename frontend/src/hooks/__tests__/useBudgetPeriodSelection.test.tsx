import { describe, it, expect, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { makeTestQueryClient } from '../../test/renderWithProviders';
import { mockApi } from '../../test/apiServer';
import { budgetPeriod, generalSetting } from '../../test/fixtures';
import { pinTimeZone } from '../../test/timeZone';
import type { BudgetPeriod } from '../../services/api';
import { todayIn, useBudgetPeriodSelection } from '../useBudgetPeriodSelection';

const october = budgetPeriod(2026, 10) as unknown as BudgetPeriod;
const november = budgetPeriod(2026, 11) as unknown as BudgetPeriod;

const setting = (value: string) => generalSetting({ setting_value: value, description: 'The household’s time zone' });

const render = (route: string) =>
  renderHook(() => useBudgetPeriodSelection([october, november], 'test-selected-period'), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={makeTestQueryClient()}>
        <MemoryRouter initialEntries={[route]}>{children}</MemoryRouter>
      </QueryClientProvider>
    ),
  });

// isCurrentMonth read the browser's month. At 11:30 pm on Oct 31 in Los Angeles it is
// already Nov 1 in UTC, the household's day (application_timezone UTC, or not set: the server's
// app_today() reads UTC): October isn't the household's month any more.
describe('useBudgetPeriodSelection: the household’s month', () => {
  pinTimeZone('America/Los_Angeles', '2026-11-01T06:30:00Z');
  afterEach(() => sessionStorage.clear());

  it("says the period shown is this month by the household's day, not the browser's", async () => {
    mockApi({ 'GET /settings/general': [setting('UTC')] });
    const { result } = render('/budgets?period=2026-10');
    await waitFor(() => expect(result.current.isCurrentMonth).toBe(false));
    expect(result.current.currentPeriod?.month_number).toBe(10);

    mockApi({ 'GET /settings/general': [setting('America/Los_Angeles')] });
    const there = render('/budgets?period=2026-10');
    await waitFor(() => expect(there.result.current.isCurrentMonth).toBe(true));
  });

  it("opens on the household's month when nothing names one", async () => {
    mockApi({ 'GET /settings/general': [] });
    const { result } = render('/budgets');
    await waitFor(() => expect(result.current.currentPeriod?.month_number).toBe(11));
    expect(result.current.isCurrentMonth).toBe(true);
  });
});

describe('todayIn', () => {
  it('reads the day in the zone named, and the browser’s for a zone it doesn’t know', () => {
    const now = new Date('2026-11-01T06:30:00Z');
    expect(todayIn('UTC', now)).toBe('2026-11-01');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-10-31');
    expect(todayIn('Pacific/Kiritimati', now)).toBe('2026-11-01');
    expect(todayIn('Not/AZone', now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
