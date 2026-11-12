import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi } from '../../test/apiServer';
import GoalsPage from '../GoalsPage';
import GoalAnalysisPage from '../GoalAnalysisPage';
import EditGoalPage from '../EditGoalPage';
import userEvent from '@testing-library/user-event';

/**
 * A goal made through the budget item routes has no target or date. The goal
 * answers' strict schemas refused it, so these pages threw in development, and they divided by a
 * missing target. Each answer here is the one the API sends for such a goal, read through the
 * frontend's parse: the pages say it has none, with no NaN.
 */

// The charts need a laid-out DOM.
vi.mock('@nivo/pie', () => ({ ResponsivePie: () => null }));
vi.mock('@nivo/line', () => ({ ResponsiveLine: () => null }));

const UUID = '01a1c68a-a00f-72ab-a7ac-89232efa7f74';
const row = {
  id: 457, uuid: UUID, name: 'Made as an item', description: null, target_amount: null, target_date: null,
  estimated_monthly_contribution: '0.00', image_path: null, status: 'active',
  created_at: '2026-11-10T17:38:56.134Z', updated_at: '2026-11-10T17:38:56.134Z',
};
const listed = {
  ...row, account_count: '0', budget_item_count: '0', current_progress: 0,
  progress_percentage: null, remaining_amount: null, projected_completion_date: null,
};
const one = {
  ...row, current_progress: 0, total_from_accounts: 0, total_from_budget_items: 0, progress_percentage: null, remaining_amount: null,
  associated_accounts: [], associated_budget_items: [],
  progress_history: [{ snapshot_date: '2026-11-10', total_from_accounts: '0.00', total_from_budget_items: '0.00', total_progress: '0.00' }],
  projection: {
    currentProgress: 0, targetAmount: null, remainingAmount: null, pastPerformanceMonths: null, plannedContributionMonths: null,
    pastPerformanceDate: null, plannedContributionDate: null,
  },
};

afterEach(() => vi.unstubAllGlobals());

describe('a goal with no target or date', () => {
  it('is listed on the Goals page as having none', async () => {
    const api = mockApi({ 'GET /goals': { goals: [listed] } });
    renderWithProviders(<Theme><GoalsPage /></Theme>);
    expect(await screen.findByText('Made as an item')).toBeInTheDocument();
    expect(screen.getByText('No target')).toBeInTheDocument();
    expect(screen.getAllByText('None')).toHaveLength(2); // the target, and the target date
    expect(screen.queryByText('Days Left')).toBeNull();
    expect(screen.queryByText('Overdue')).toBeNull();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    expect(api.unhandled).toEqual([]);
  });

  it('is shown on its analysis page as having none', async () => {
    mockApi({
      [`GET /goals/:uuid`]: { goal: one },
      'GET /goals/:uuid/balance-history': { history: [] },
      'GET /goals/:uuid/account-balance-history': { accounts: [] },
    });
    renderWithProviders(
      <Theme><Routes><Route path="/goals/:uuid/view" element={<GoalAnalysisPage />} /></Routes></Theme>,
      { route: `/goals/${UUID}/view` },
    );
    expect(await screen.findByText('No target')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    expect(screen.getAllByText('None').length).toBeGreaterThanOrEqual(3); // target, remaining, date
  });

  it('opens on its edit page as having none, and asks for a target before it saves', async () => {
    const api = mockApi({
      [`GET /goals/:uuid`]: { goal: one },
      'GET /accounts': { accounts: [] },
      'GET /budgets/items': [],
    });
    renderWithProviders(
      <Theme><Routes><Route path="/goals/:uuid/edit" element={<EditGoalPage />} /></Routes></Theme>,
      { route: `/goals/${UUID}/edit` },
    );
    expect(await screen.findByText('No target')).toBeInTheDocument();
    expect(screen.getAllByText('None')).toHaveLength(2); // the target, and what is left
    expect(document.body.textContent).not.toMatch(/NaN|Infinity/);
    await userEvent.click(screen.getByRole('button', { name: /save|update/i }));
    expect(api.calls('PUT /goals/:uuid')).toHaveLength(0);
  });
});
