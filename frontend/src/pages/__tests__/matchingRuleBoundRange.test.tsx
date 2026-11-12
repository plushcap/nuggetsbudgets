import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { mockApi } from '../../test/apiServer';
import { budgetItem, matchingRule, savedMatchingRule, uuidFor } from '../../test/fixtures';
import BudgetMatchingRulesPage from '../BudgetMatchingRulesPage';

/**
 * A bound past DECIMAL(12,2) was refused beside its box as "amount_max must be
 * between -9,999,999,999.99 and 9,999,999,999.99": the body's key, and a minus bound for a box
 * that takes no negatives.
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

const RULE = uuidFor(9, 1);
const rule = matchingRule({ id: 9, uuid: RULE, matching_text: 'GAS', budget_item_name: 'Shopping' });
const PUT = 'PUT /budgets/item-matching-rules/:uuid';

describe('a matching rule bound past what can be stored', () => {
  it('is refused beside its box, once, in words for people, and not sent', async () => {
    const api = mockApi({
      'GET /budgets/item-matching-rules': [rule],
      'GET /budgets/items': [budgetItem({ id: 5, name: 'Shopping' })],
      'GET /merchants': [],
      [PUT]: savedMatchingRule(rule),
    });
    renderWithProviders(<Theme><BudgetMatchingRulesPage /></Theme>, { route: `/${RULE}/edit` });
    const user = userEvent.setup();
    const max = await screen.findByRole('textbox', { name: 'Maximum Amount' });
    await user.type(max, '99999999999');
    await user.click(screen.getAllByRole('button', { name: /save changes/i })[0]!);

    await waitFor(() => expect(max).toHaveAttribute('aria-invalid', 'true'));
    expect(max).toHaveAccessibleDescription('Enter an amount up to 9,999,999,999.99.');
    expect(screen.getAllByText('Enter an amount up to 9,999,999,999.99.')).toHaveLength(1);
    expect(screen.queryByText(/amount_max/)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Minimum Amount' })).not.toHaveAttribute('aria-invalid');
    expect(api.calls(PUT)).toHaveLength(0);
  });
});
