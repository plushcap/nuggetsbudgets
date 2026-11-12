import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route, useParams } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import BudgetPage from '../BudgetPage';

/**
 * A savings goal on the Budget page opens the goal's page, /goals/<uuid>/view. It
 * linked to /goals/<uuid>, which no route matches, so a click on it showed an
 * empty page. App.tsx routes /goals/:uuid/view to GoalAnalysisPage.
 */

const GOAL_UUID = '0190a6f2-7c1e-7b3a-9f00-000000000042';
const period = vi.hoisted(() => ({
  id: 1, uuid: 'period-1', name: '2026-1', month: 'January', year: 2026, month_number: 1,
  start_date: '2026-01-01', end_date: '2026-01-31', status: 'active',
}));
const goal = vi.hoisted(() => ({
  id: 7, uuid: 'bpi-7', budget_period_id: 1, budget_item_id: 3, starting: 0,
  calculated_budget: 100, calculated_actual: -40, calculated_transfers: 0, calculated_remaining: 60,
  budget_item_name: 'Emergency Fund', budget_item_uuid: '0190a6f2-7c1e-7b3a-9f00-000000000042', name: 'Emergency Fund',
  expense_type: 'Savings', priority: 'Essential', type: 'Goal', subtype: 'Goal', rollover: true,
  icon: 'PiggyBank', color: '#22c55e', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
  goal_target_amount: 1000, goal_target_date: '2026-12-31', status: 'active',
}));
const lists = vi.hoisted(() => ({ periods: [period], items: { success: true, data: [goal] }, empty: [] as never[] }));

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    ...actual,
    useBudgetPeriodsQuery: () => ({ data: lists.periods, isLoading: false, refetch: async () => ({ data: lists.periods }) }),
    useBudgetPeriodItemsQuery: () => ({ data: lists.items, isLoading: false, isError: false }),
    useAccountsQuery: () => ({ data: lists.empty }),
    useBudgetItemsQuery: () => ({ data: lists.empty }),
    useCreateBudgetPeriodMutation: mutation,
    useUpdateBudgetAmountMutation: mutation,
  };
});

const GoalPage = () => <p>Goal page for {useParams().uuid}</p>;

const renderBudget = () =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/budgets" element={<BudgetPage />} />
        <Route path="/goals/:uuid/view" element={<GoalPage />} />
      </Routes>
    </Theme>,
    { route: '/budgets?period=2026-01' }
  );

describe('BudgetPage goal links', () => {
  it("links each goal's name to its page, on a narrow screen and a wide one", async () => {
    renderBudget();
    const links = await screen.findAllByRole('link', { name: 'Emergency Fund' });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('href', `/goals/${GOAL_UUID}/view`);
  });

  it.each([0, 1])('opens the goal page from name link %i', async (index) => {
    renderBudget();
    const links = await screen.findAllByRole('link', { name: 'Emergency Fund' });
    await userEvent.click(links[index]);
    expect(await screen.findByText(`Goal page for ${GOAL_UUID}`)).toBeInTheDocument();
  });

  // The mobile card opened the goal from an onClick on the Card, which no keyboard
  // reaches. Its name link is stretched over the card instead (an ::after over the card,
  // which jsdom doesn't lay out), so the card opens the goal by following that link.
  it("opens the goal page from the goal's card, by the link stretched over it", async () => {
    renderBudget();
    const [mobileLink] = await screen.findAllByRole('link', { name: 'Emergency Fund' });
    const card = mobileLink.closest('.rt-Card') as HTMLElement;
    expect(card).not.toBeNull();
    expect(mobileLink).toHaveClass('after:absolute', 'after:inset-0');
    // A click on the card itself, off the link, does nothing of its own.
    await userEvent.click(card);
    expect(screen.queryByText(`Goal page for ${GOAL_UUID}`)).not.toBeInTheDocument();
    // The keyboard reaches the link and follows it.
    mobileLink.focus();
    await userEvent.keyboard('{Enter}');
    expect(await screen.findByText(`Goal page for ${GOAL_UUID}`)).toBeInTheDocument();
  });
});
