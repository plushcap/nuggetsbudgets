import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import toast from 'react-hot-toast';
import { renderWithProviders } from '../../test/renderWithProviders';
import { handleResponse } from '../../services/api/base';
import AddUserPage from '../AddUserPage';

const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return {
    ...actual,
    useCreateUserMutation: () => ({ mutateAsync, isPending: false }),
    usePasswordPolicy: () => ({ minLength: 12, maxBytes: 72, requireComplexity: false }),
  };
});
const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigate };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const renderPage = () => renderWithProviders(<Theme><AddUserPage /></Theme>);

describe('AddUserPage (react-hook-form)', () => {
  beforeEach(() => { mutateAsync.mockClear(); navigate.mockClear(); });

  it('blocks submit and shows shared-schema validation on an empty form', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    expect(await screen.findByText(/first name is required/i)).toBeInTheDocument();
    expect(screen.getByText(/valid email is required/i)).toBeInTheDocument();
    expect(screen.getByText(/at least 12 characters long/i)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('ties each message to its field, so a screen reader reads it there', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    const firstName = screen.getByRole('textbox', { name: 'First Name *' });
    await waitFor(() => expect(firstName).toHaveAttribute('aria-invalid', 'true'));
    expect(firstName).toHaveAccessibleDescription(/first name is required/i);
    expect(screen.getByRole('textbox', { name: 'Email Address *' })).toHaveAccessibleDescription(/valid email is required/i);
    // The password's hint gives way to its error.
    expect(screen.getByLabelText('Password *')).toHaveAccessibleDescription(/at least 12 characters long/i);
  });

  it('submits the user fields on a valid fill', async () => {
    renderPage();
    // Each field is found by its label.
    await userEvent.type(screen.getByLabelText(/First Name/), 'John');
    await userEvent.type(screen.getByLabelText(/Last Name/), 'Doe');
    await userEvent.type(screen.getByLabelText(/Email Address/), 'John@Example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'tall green marmot 42');
    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const arg = mutateAsync.mock.calls[0][0];
    expect(arg.first_name).toBe('John');
    expect(arg.email).toBe('john@example.com'); // lowercased by schema
    expect(arg.password).toBe('tall green marmot 42');
    expect(navigate).toHaveBeenCalledWith('/settings/users');
  });

  // The page read `response.data.error` itself, so it showed "Validation failed"
  // instead of the reason in `message`, and the backend's "tenant" wording.
  it("toasts the server's reason, in Ledger wording, when the user can't be created", async () => {
    const refused = await handleResponse(
      new Response(
        JSON.stringify({ error: 'Validation failed', code: 'VALIDATION_ERROR', message: 'That person is already a member of this tenant.' }),
        { status: 400 }
      )
    ).catch((error: unknown) => error);
    mutateAsync.mockRejectedValueOnce(refused);
    renderPage();
    await userEvent.type(screen.getByLabelText(/First Name/), 'John');
    await userEvent.type(screen.getByLabelText(/Last Name/), 'Doe');
    await userEvent.type(screen.getByLabelText(/Email Address/), 'john@example.com');
    await userEvent.type(screen.getByLabelText(/Password/), 'tall green marmot 42');
    await userEvent.click(screen.getByRole('button', { name: /create user/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('That person is already a member of this ledger.'));
    expect(navigate).not.toHaveBeenCalled();
  });
});
