import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi, type ApiRequest } from '../../test/apiServer';
import { budgetItem, matchingRule, savedMatchingRule, type MatchingRuleWire } from '../../test/fixtures';
import BudgetMatchingRulesPage from '../BudgetMatchingRulesPage';

/**
 * The rules lists answered active rules only, so a rule created or saved inactive
 * vanished, and the page's Inactive count was always 0. The lists answer every rule now; the
 * page says which is which in words, and switches a rule on or off from its menu.
 */

Object.assign(window.HTMLElement.prototype, {
  hasPointerCapture: () => false,
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
});
vi.mock('react-hot-toast', () => {
  const toast = Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() });
  return { default: toast, toast };
});
afterEach(() => vi.unstubAllGlobals());
const rule = (n: number, over: Partial<MatchingRuleWire>) => matchingRule({ id: n, ...over });

const PUT = 'PUT /budgets/item-matching-rules/:uuid';

describe('the rules list with an inactive rule', () => {
  const active = rule(1, {});
  const inactive = rule(2, { is_active: false, matching_text: 'REFUND', amount_min: '0.00' });
  const routes = () => ({
    'GET /budgets/item-matching-rules': [active, inactive],
    'GET /budgets/items': [budgetItem({ id: 5, name: 'Groceries' })],
    'GET /merchants': [],
    [PUT]: (req: ApiRequest) => savedMatchingRule(inactive, req.body as object),
  });

  it('counts and marks it in words, and switches it on with the whole rule', async () => {
    const api = mockApi(routes());
    renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route: '/' });
    const user = userEvent.setup();
    // The table row (the card shows the same on a phone).
    const row = (await screen.findAllByRole('row')).find((r) => within(r).queryByText('REFUND'))!;
    expect(within(row).getByText('Inactive')).toBeInTheDocument();
    const activeRow = screen.getAllByRole('row').find((r) => within(r).queryByText('TEXT1'))!;
    expect(within(activeRow).getByText('Active')).toBeInTheDocument();
    expect(screen.getByText(/^Inactive:/)).toHaveTextContent('Inactive: 1');
    expect(screen.getByText(/^Active:/)).toHaveTextContent('Active: 1');

    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Switch Rule On' }));
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].params.uuid).toBe(inactive.uuid);
    expect(api.calls(PUT)[0].body).toEqual({
      budget_item_id: 5, method: 'contains', matching_text: 'REFUND', merchant_id: null,
      amount_min: 0, amount_max: null, priority: 100, is_active: true, notes: null,
    });
  });

  it('offers to switch an active rule off', async () => {
    mockApi(routes());
    renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route: '/' });
    const user = userEvent.setup();
    const row = (await screen.findAllByRole('row')).find((r) => within(r).queryByText('TEXT1'))!;
    await user.click(within(row).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Switch Rule Off' })).toBeInTheDocument();
  });

  it('opens an inactive rule to edit it, and keeps it inactive when saved', async () => {
    const api = mockApi(routes());
    renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route: `/${inactive.uuid}/edit` });
    const user = userEvent.setup();
    expect(await screen.findByDisplayValue('REFUND')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /active/i })).not.toBeChecked();
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]);
    await waitFor(() => expect(api.calls(PUT)).toHaveLength(1));
    expect(api.calls(PUT)[0].body).toMatchObject({ is_active: false, amount_min: 0 });
  });
});
