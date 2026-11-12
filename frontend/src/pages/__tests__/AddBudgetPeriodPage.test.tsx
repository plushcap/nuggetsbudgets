import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AddBudgetPeriodPage from '../AddBudgetPeriodPage';

const mutateAsync = vi.fn().mockResolvedValue({ budget_items_created: 0, transactions_associated: 0 });
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return { ...actual, useCreateManagedBudgetPeriodMutation: () => ({ mutateAsync, isPending: false }) };
});
const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><AddBudgetPeriodPage /></Theme>);

describe('AddBudgetPeriodPage (react-hook-form)', () => {
  beforeEach(() => { mutateAsync.mockClear(); navigate.mockClear(); });

  it('submits the default [year, month] tuple', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /create budget period/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg).toEqual([new Date().getFullYear(), new Date().getMonth() + 1]);
    expect(navigate).toHaveBeenCalledWith('/settings/budget-periods');
  });
});
