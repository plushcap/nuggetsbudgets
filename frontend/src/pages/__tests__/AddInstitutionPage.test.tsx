import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AddInstitutionPage from '../AddInstitutionPage';

const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('../../hooks/queries/referenceData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries/referenceData')>();
  return { ...actual, useCreateInstitutionMutation: () => ({ mutateAsync, isPending: false }) };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><AddInstitutionPage /></Theme>);

describe('AddInstitutionPage (react-hook-form)', () => {
  beforeEach(() => { mutateAsync.mockClear(); navigate.mockClear(); });

  it('disables the create button until a name is entered', async () => {
    renderPage();
    expect(screen.getAllByRole('button', { name: /create institution/i })[0]).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText(/Example Bank/i), 'My Bank');
    expect(screen.getAllByRole('button', { name: /create institution/i })[0]).toBeEnabled();
  });

  it('submits the name + notes', async () => {
    renderPage();
    await userEvent.type(screen.getByPlaceholderText(/Example Bank/i), 'My Bank');
    await userEvent.type(screen.getByPlaceholderText(/Optional notes/i), 'a note');
    await userEvent.click(screen.getAllByRole('button', { name: /create institution/i })[0]);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync).toHaveBeenCalledWith({ name: 'My Bank', notes: 'a note' });
    expect(navigate).toHaveBeenCalledWith('/settings/institutions');
  });
});
