import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AdminSetupPage from '../AdminSetupPage';

const mutateAsync = vi.fn().mockResolvedValue({});
const setup = vi.hoisted(() => {
  const ok = { isLoading: false, isError: false, data: { setupComplete: false } } as Record<string, unknown>;
  return { ok, query: ok, refetch: vi.fn() };
});
// The policy GET /api/auth/password-policy answered with.
const policy = vi.hoisted(() => ({ current: { minLength: 12, maxBytes: 72, requireComplexity: false } }));
vi.mock('../../hooks/queries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../hooks/queries')>();
  return {
    ...actual,
    useSetupStatusQuery: () => setup.query,
    useSetupAdminMutation: () => ({ mutateAsync, isPending: false }),
    usePasswordPolicy: () => policy.current,
  };
});
vi.mock('react-hot-toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));
import toast from 'react-hot-toast';

const renderPage = () => renderWithProviders(<Theme><AdminSetupPage /></Theme>);

async function fillForm(password: string) {
  await userEvent.type(screen.getByLabelText(/setup token/i), 'abc123');
  await userEvent.type(screen.getByLabelText(/first name/i), 'Owner');
  await userEvent.type(screen.getByLabelText(/email address/i), 'owner@example.com');
  await userEvent.type(screen.getByLabelText(/^password/i), password);
  await userEvent.type(screen.getByLabelText(/confirm password/i), password);
  await userEvent.click(screen.getByRole('button', { name: /create admin account/i }));
}

describe('AdminSetupPage', () => {
  // A failed probe used to count as "not complete" and offer to set up a new admin.
  it("shows a retry, not the first-run form, when the server doesn't say whether setup ran", async () => {
    setup.query = { isLoading: false, isError: true, error: new Error('down'), data: undefined, isFetching: false, refetch: setup.refetch };
    renderPage();
    expect(screen.getByRole('heading', { name: "Can't reach Nuggets", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome to Nuggets' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(setup.refetch).toHaveBeenCalled();
    setup.query = setup.ok;
  });

  it('names the first-run page with one h1', () => {
    renderPage();
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['Welcome to Nuggets']);
  });

  beforeEach(() => {
    mutateAsync.mockClear();
    vi.mocked(toast.error).mockClear();
    policy.current = { minLength: 12, maxBytes: 72, requireComplexity: false };
  });

  // The page used to ask for 8 characters while the server wanted 12 and a symbol
  // from a short list, so a password the page accepted was refused.
  it("checks the password with the server's policy and its message, and shows the rule", async () => {
    policy.current = { minLength: 16, maxBytes: 72, requireComplexity: false };
    renderPage();
    expect(screen.getByText(/at least 16 characters/i)).toBeInTheDocument();
    await fillForm('sixteen chars ok!');
    expect(mutateAsync).toHaveBeenCalledTimes(1);

    mutateAsync.mockClear();
    await userEvent.clear(screen.getByLabelText(/^password/i));
    await userEvent.clear(screen.getByLabelText(/confirm password/i));
    await userEvent.type(screen.getByLabelText(/^password/i), 'only 15 letters');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'only 15 letters');
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }));
    // Beside the field, not in a toast: read first, then the rule.
    const password = screen.getByLabelText(/^password/i);
    await waitFor(() => expect(password).toHaveFocus());
    expect(password).toHaveAccessibleDescription(/^Password must be at least 16 characters long .*at least 16 characters/i);
    expect(toast.error).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  // Each problem beside its field, the first focused; nothing in a toast.
  it('says beside each field what is missing, and focuses the first', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/email address/i), 'not an address');
    await userEvent.type(screen.getByLabelText(/^password/i), 'sixteen chars ok!');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'sixteen chars ok?');
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }));

    const token = screen.getByLabelText(/setup token/i);
    await waitFor(() => expect(token).toHaveFocus());
    expect(token).toHaveAccessibleDescription(/^Setup token is required .*server log/);
    expect(screen.getByLabelText(/first name/i)).toHaveAccessibleDescription('First name is required');
    expect(screen.getByLabelText(/email address/i)).toHaveAccessibleDescription('Enter a valid email address');
    expect(screen.getByLabelText(/confirm password/i)).toHaveAccessibleDescription('Passwords do not match');
    expect(toast.error).not.toHaveBeenCalled();
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('takes a passphrase with no capitals, digits or symbols', async () => {
    renderPage();
    await fillForm('correct horse battery staple');
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  });

  it('asks for the setup token from the server log', () => {
    renderPage();
    const token = screen.getByLabelText(/setup token/i);
    expect(token).toBeRequired();
    expect(token).toHaveAccessibleDescription(/server log/i);
  });

  it('sends the setup token with the new admin', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/setup token/i), '  abc123  ');
    await userEvent.type(screen.getByLabelText(/first name/i), 'Owner');
    await userEvent.type(screen.getByLabelText(/email address/i), 'owner@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'Very-Strong-Passw0rd!x');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'Very-Strong-Passw0rd!x');
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0]).toEqual({
      setup_token: 'abc123',
      email: 'owner@example.com',
      password: 'Very-Strong-Passw0rd!x',
      first_name: 'Owner',
      last_name: '',
    });
  });

  it('does not submit without a setup token', async () => {
    renderPage();
    await userEvent.type(screen.getByLabelText(/first name/i), 'Owner');
    await userEvent.type(screen.getByLabelText(/email address/i), 'owner@example.com');
    await userEvent.type(screen.getByLabelText(/^password/i), 'Very-Strong-Passw0rd!x');
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'Very-Strong-Passw0rd!x');
    await userEvent.click(screen.getByRole('button', { name: /create admin account/i }));
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
