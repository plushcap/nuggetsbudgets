import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import { UNREADABLE_AMOUNT_MESSAGE } from '../../components/forms/optionalAmount';
import EditGoalPage from '../EditGoalPage';

const updateGoal = vi.fn().mockResolvedValue({});
const goal = {
  uuid: 'goal-1',
  name: 'Vacation',
  description: 'trip',
  target_amount: 5000,
  target_date: '2027-01-01T00:00:00.000Z',
  estimated_monthly_contribution: 200,
  status: 'active',
  image_path: null,
  associated_accounts: [],
  associated_budget_items: [],
  current_progress: 1000,
};

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  const noop = () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  return {
    ...actual,
    useGoalQuery: () => ({ data: { goal }, isLoading: false }),
    useAccountsQuery: () => ({ data: [] }),
    useBudgetItemsQuery: () => ({ data: [] }),
    useUpdateGoalMutation: () => ({ mutateAsync: updateGoal, isPending: false }),
    useUploadGoalImageMutation: noop,
    useDeleteGoalImageMutation: noop,
    useAssociateAccountWithGoalMutation: noop,
    useRemoveAccountFromGoalMutation: noop,
    useAssociateBudgetItemWithGoalMutation: noop,
    useRemoveBudgetItemFromGoalMutation: noop,
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate, useParams: () => ({ uuid: 'goal-1' }) };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><EditGoalPage /></Theme>);

describe('EditGoalPage (react-hook-form)', () => {
  beforeEach(() => { updateGoal.mockClear(); navigate.mockClear(); });

  it('seeds the form from the loaded goal and saves edits', async () => {
    renderPage();
    const nameInput = await screen.findByDisplayValue('Vacation');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Big Vacation');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
    const arg = updateGoal.mock.calls[0][0];
    expect(arg.uuid).toBe('goal-1');
    expect(arg.data.name).toBe('Big Vacation');
    expect(arg.data.target_amount).toBe(5000);
    expect(navigate).toHaveBeenCalledWith('/goals');
  });

  it('refuses a monthly contribution it can\'t read, beside the field, and sends nothing', async () => {
    renderPage();
    await screen.findByDisplayValue('Vacation');
    const box = screen.getByLabelText(/estimated monthly contribution/i);
    await userEvent.clear(box);
    await userEvent.type(box, '2oo');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    expect(await screen.findByText(UNREADABLE_AMOUNT_MESSAGE)).toBeInTheDocument();
    await waitFor(() => expect(box).toHaveFocus());
    expect(updateGoal).not.toHaveBeenCalled();

    await userEvent.clear(box);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateGoal).toHaveBeenCalledTimes(1));
  });
});
