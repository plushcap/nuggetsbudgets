import { afterEach, describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import GoalAnalysisPage from '../GoalAnalysisPage';

const GOAL_UUID = '0190a6f2-7c1e-7b3a-9f00-000000000042';
const goal = vi.hoisted(() => ({
  uuid: '0190a6f2-7c1e-7b3a-9f00-000000000042', name: 'House deposit', description: null, status: 'active',
  target_amount: 1000.3, total_from_accounts: 1000.1, target_date: '2027-06-30', estimated_monthly_contribution: 50,
  associated_accounts: [
    { uuid: 'a1', name: 'Coffee jar', subtype: 'Savings', calculated_balance: 0.1 },
    { uuid: 'a2', name: 'Tea jar', subtype: 'Savings', calculated_balance: 0.2 },
  ],
}));

// The goal's balance history, which a test sets.
const history = vi.hoisted(() => ({ points: [] as { date: string; balance: number }[] }));

vi.mock('../../hooks/queries', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/queries')>()),
  useGoalQuery: () => ({ data: { goal }, isLoading: false, isError: false }),
  useGoalBalanceHistoryQuery: () => ({ data: { history: history.points }, isFetching: false }),
  useGoalAccountBalanceHistoryQuery: () => ({ data: { accounts: [] }, isFetching: false }),
}));
// The charts need a laid-out DOM: list what they are given instead.
vi.mock('@nivo/pie', () => ({
  ResponsivePie: ({ data }: { data: { id: string; value: number }[] }) => (
    <ul>{data.map((d) => <li key={d.id} data-testid="slice" data-id={d.id} data-value={d.value} />)}</ul>
  ),
}));
vi.mock('@nivo/line', () => ({
  ResponsiveLine: ({ axisLeft }: { axisLeft: { tickValues: number[]; format: (value: number) => string } }) => (
    <ul>{axisLeft.tickValues.map((v) => <li key={v} data-testid="tick">{axisLeft.format(v)}</li>)}</ul>
  ),
}));

const renderPage = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/goals/:uuid/view" element={<GoalAnalysisPage />} />
      </Routes>
    </Theme>,
    { route: `/goals/${GOAL_UUID}/view` },
  );

const points = (...balances: number[]) => balances.map((balance, i) => ({ date: `2026-0${i + 1}-01`, balance }));

describe('GoalAnalysisPage', () => {
  afterEach(() => {
    history.points = [];
  });

  // `$${(v / 1000).toFixed(0)}k` showed $0k for 250, $-2k for a debt, $1500k for 1.5M.
  it("labels the balance axis in formatMoney's compact form", async () => {
    history.points = points(-2000, 250, 1_500_000);
    renderPage();
    const ticks = (await screen.findAllByTestId('tick')).map((el) => el.textContent);
    expect(ticks).toEqual(['-$200K', '$0', '$200K', '$400K', '$600K', '$800K', '$1M', '$1.2M', '$1.4M', '$1.6M']);
  });

  // On a narrow axis (every $20 from $1,000 to $1,200) the compact labels read
  // "$1K, $1K, $1K, $1.1K, ..."; the labels take the precision the step needs.
  it('labels a narrow axis so each tick reads as its own', async () => {
    history.points = points(1003, 1061, 1120, 1188);
    renderPage();
    const ticks = (await screen.findAllByTestId('tick')).map((el) => el.textContent);
    expect(ticks.slice(0, 4)).toEqual(['$1,000', '$1,020', '$1,040', '$1,060']);
    expect(ticks[ticks.length - 1]).toBe('$1,200');
    expect(new Set(ticks).size).toBe(ticks.length);
  });

  // A subtype's balances were a float sum (0.1 + 0.2 = 0.30000000000000004),
  // which the pie was given as its slice.
  it("adds a subtype's balances in whole cents", async () => {
    renderPage();
    const slices = await screen.findAllByTestId('slice');
    const savings = slices.filter((el) => el.dataset.id === 'Savings').map((el) => el.dataset.value);
    expect(savings).toEqual(['0.3']);
    expect(screen.getByText(/^\$0\.30 in 1 parts/)).toBeInTheDocument();
  });
});
