import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import CategoriesPage from '../CategoriesPage';

const createCategory = vi.fn().mockResolvedValue({});
const updateCategory = vi.fn().mockResolvedValue({});

// Stable reference so EditCategoryPage's seed effect (deps include the derived
// category) doesn't re-fire every render and loop.
const category = {
  id: 1,
  uuid: 'cat-1',
  name: 'Food',
  description: 'groceries',
  priority: 'Essential',
  notes: 'weekly',
  icon: 'Tag',
};
const categories = [category];

vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return {
    ...actual,
    useCategoriesQuery: () => ({ data: categories, isLoading: false }),
    useCreateCategoryMutation: () => ({ mutateAsync: createCategory, isPending: false }),
    useUpdateCategoryMutation: () => ({ mutateAsync: updateCategory, isPending: false }),
    useDeleteCategoryMutation: () => ({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false }),
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderAt = (route: string) =>
  renderWithProviders(<Theme><CategoriesPage /></Theme>, { route });

describe('CategoriesPage forms (react-hook-form)', () => {
  beforeEach(() => { createCategory.mockClear(); updateCategory.mockClear(); navigate.mockClear(); });

  it('creates a category from the add form', async () => {
    renderAt('/add');
    await userEvent.type(screen.getByPlaceholderText(/enter category name/i), 'Utilities');
    await userEvent.click(screen.getAllByRole('button', { name: /create category/i })[0]);
    await waitFor(() => expect(createCategory).toHaveBeenCalledTimes(1));
    expect(createCategory.mock.calls[0][0].name).toBe('Utilities');
    expect(navigate).toHaveBeenCalledWith('/categories');
  });

  it('opens a category from a link in its card and its row, which the keyboard reaches', async () => {
    renderAt('/');
    const links = await screen.findAllByRole('link', { name: 'Food' });
    expect(links).toHaveLength(2); // the mobile card and the desktop row
    for (const link of links) expect(link).toHaveAttribute('href', '/categories/cat-1/edit');
  });

  it('blocks the add form when the name is empty', async () => {
    renderAt('/add');
    await userEvent.click(screen.getAllByRole('button', { name: /create category/i })[0]);
    expect(await screen.findByText(/name and icon are required/i)).toBeInTheDocument();
    expect(createCategory).not.toHaveBeenCalled();
  });

  it('seeds the edit form from the loaded category and saves edits', async () => {
    renderAt('/cat-1/edit');
    const nameInput = await screen.findByDisplayValue('Food');
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, 'Dining');
    await userEvent.click(screen.getAllByRole('button', { name: /save changes/i })[0]);
    await waitFor(() => expect(updateCategory).toHaveBeenCalledTimes(1));
    const arg = updateCategory.mock.calls[0][0];
    expect(arg.uuid).toBe('cat-1');
    expect(arg.data.name).toBe('Dining');
    expect(navigate).toHaveBeenCalledWith('/categories');
  });
});
