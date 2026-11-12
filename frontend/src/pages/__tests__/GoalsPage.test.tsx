import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import GoalsPage from '../GoalsPage';
import { pinTimeZone } from '../../test/timeZone';

const baseGoal = {
  name: 'Emergency fund',
  description: null,
  target_amount: 1500,
  // Far off, so "Days Left" never shows 0, which the stray-"0" check would match.
  target_date: '2099-12-15',
  status: 'active',
  image_path: null,
  current_progress: 0,
};
let goals: Array<Record<string, unknown>> = [];

vi.mock('../../hooks/queries/goals', () => ({
  useGoalsQuery: () => ({ data: { goals }, isLoading: false }),
}));

const renderPage = () => renderWithProviders(<Theme><GoalsPage /></Theme>);

describe('GoalsPage goal card', () => {
  it('shows nothing for a monthly contribution of 0 (not a stray "0")', async () => {
    goals = [{ ...baseGoal, uuid: 'g-0', estimated_monthly_contribution: 0 }];
    renderPage();
    await screen.findByText('Emergency fund');
    expect(screen.queryByText(/^Monthly:/)).toBeNull();
    expect(screen.queryByText('0', { exact: true })).toBeNull();
  });

  it('shows the monthly contribution when there is one', async () => {
    goals = [{ ...baseGoal, uuid: 'g-1', estimated_monthly_contribution: 125 }];
    renderPage();
    expect(await screen.findByText(/Monthly: \$125\.00/)).toBeTruthy();
  });
});

const daysLeft = () => screen.getByText('Days Left').nextElementSibling?.textContent;

// A goal's target_date is a calendar day. The API has sent it both as
// 'YYYY-MM-DD' and as an ISO instant at UTC midnight.
describe('GoalsPage target date in Los Angeles, 9 pm on Oct 27', () => {
  pinTimeZone('America/Los_Angeles', '2026-10-27T21:00:00-07:00');

  it.each(['2026-12-31', '2026-12-31T00:00:00.000Z'])('shows %s as Dec 31, with 65 days left', async (target_date) => {
    goals = [{ ...baseGoal, uuid: 'g-la', target_date }];
    renderPage();
    expect(await screen.findByText('Dec 31, 2026')).toBeInTheDocument();
    expect(daysLeft()).toBe('65');
  });

  it('is due, not overdue, on its target day', async () => {
    goals = [{ ...baseGoal, uuid: 'g-today', target_date: '2026-10-27' }];
    renderPage();
    expect(await screen.findByText('Oct 27, 2026')).toBeInTheDocument();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(daysLeft()).toBe('0');
  });
});

describe('GoalsPage target date in Kiritimati (UTC+14), 8 am on Oct 28', () => {
  pinTimeZone('Pacific/Kiritimati', '2026-10-28T08:00:00+14:00');

  it('counts 64 days to Dec 31', async () => {
    goals = [{ ...baseGoal, uuid: 'g-ki', target_date: '2026-12-31' }];
    renderPage();
    expect(await screen.findByText('Dec 31, 2026')).toBeInTheDocument();
    expect(daysLeft()).toBe('64');
  });
});
