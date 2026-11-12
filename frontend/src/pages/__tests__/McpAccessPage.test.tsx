import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import McpAccessPage from '../McpAccessPage';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('react-hot-toast', () => ({ toast, default: toast }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    tenants: [{ uuid: 'ledger-1', name: 'Household', organizationName: 'Family' }],
    activeTenant: { uuid: 'ledger-1', name: 'Household' },
  }),
}));

const api = vi.hoisted(() => ({
  getMcpTokens: vi.fn(),
  mintMcpToken: vi.fn(),
  reauthenticateWithPassword: vi.fn(),
  reauthenticateWithPasskey: vi.fn(),
  getUserPasskeys: vi.fn(),
  isPasskeySupported: vi.fn(),
}));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    getMcpTokens: () => api.getMcpTokens(),
    mintMcpToken: (request: unknown) => api.mintMcpToken(request),
    reauthenticateWithPassword: (password: string) => api.reauthenticateWithPassword(password),
    reauthenticateWithPasskey: () => api.reauthenticateWithPasskey(),
    getUserPasskeys: () => api.getUserPasskeys(),
    isPasskeySupported: () => api.isPasskeySupported(),
  };
});

/** An API error the way base.ts's handleResponse builds one for a 403. */
function apiError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, response: { data: { error: message, code } } });
}

const minted = {
  token: 'eyJ.minted.token',
  uuid: 'token-1',
  jti: 'jti-1',
  label: 'claude-desktop',
  audience: 'mcp',
  scope: 'read',
  tenantUuid: 'ledger-1',
  createdAt: '2026-10-27T00:00:00.000Z',
  expiresAt: '2027-10-27T00:00:00.000Z',
};

const renderPage = () => renderWithProviders(<Theme><McpAccessPage /></Theme>, { route: '/settings/mcp' });

async function startCreating() {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('No active tokens');
  await user.click(screen.getAllByRole('button', { name: /New Token/ })[0]);
  await user.click(await screen.findByRole('button', { name: 'Create token' }));
  return user;
}

describe('McpAccessPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getMcpTokens.mockResolvedValue([]);
    api.getUserPasskeys.mockResolvedValue([]);
    api.isPasskeySupported.mockReturnValue(false);
    api.reauthenticateWithPassword.mockResolvedValue({ reauthenticated: true, validForSeconds: 300 });
  });

  // Its text held —-style escapes, which JSX text shows as they are.
  it('shows its punctuation, not escape sequences', async () => {
    let answer: (tokens: unknown[]) => void = () => {};
    api.getMcpTokens.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    renderPage();
    expect(await screen.findByText('Loading tokens…')).toBeInTheDocument();
    answer([]);
    expect(await screen.findByText('Click “New Token” to mint one for your AI agent or another MCP client.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\\u[0-9a-f]{4}/i);
  });

  it('asks for the password when the server wants a fresh confirmation, then creates the token', async () => {
    api.mintMcpToken
      .mockRejectedValueOnce(apiError(403, 'REAUTH_REQUIRED', 'Confirm your password or passkey to continue'))
      .mockResolvedValueOnce(minted);
    const user = await startCreating();

    const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
    expect(api.mintMcpToken).toHaveBeenCalledTimes(1);
    expect(within(prompt).queryByRole('button', { name: /Use passkey/ })).not.toBeInTheDocument();
    await user.type(within(prompt).getByLabelText('Password'), 'S3cret!pass');
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByRole('dialog', { name: 'Your new token' })).toBeInTheDocument();
    expect(api.reauthenticateWithPassword).toHaveBeenCalledWith('S3cret!pass');
    expect(api.mintMcpToken).toHaveBeenCalledTimes(2);
    // Defaults: read-only, one year, the active ledger.
    expect(api.mintMcpToken).toHaveBeenLastCalledWith({
      label: 'my-ai-agent',
      tenantUuid: 'ledger-1',
      scope: 'read',
      expiresIn: '365d',
    });
    expect(screen.queryByRole('dialog', { name: /Confirm it’s you/ })).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows a wrong password in the prompt and does not retry until it is confirmed', async () => {
    api.mintMcpToken.mockRejectedValueOnce(apiError(403, 'REAUTH_REQUIRED', 'Confirm')).mockResolvedValueOnce(minted);
    api.reauthenticateWithPassword
      .mockRejectedValueOnce(apiError(403, 'REAUTH_FAILED', 'That password is not correct'))
      .mockResolvedValueOnce({ reauthenticated: true, validForSeconds: 300 });
    const user = await startCreating();

    const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
    await user.type(within(prompt).getByLabelText('Password'), 'wrong');
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    expect(await within(prompt).findByRole('alert')).toHaveTextContent('That password is not correct');
    expect(api.mintMcpToken).toHaveBeenCalledTimes(1);

    await user.clear(within(prompt).getByLabelText('Password'));
    await user.type(within(prompt).getByLabelText('Password'), 'right');
    await user.click(within(prompt).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('dialog', { name: 'Your new token' })).toBeInTheDocument();
    expect(api.mintMcpToken).toHaveBeenCalledTimes(2);
  });

  it('creates nothing and shows no error when the prompt is cancelled', async () => {
    api.mintMcpToken.mockRejectedValue(apiError(403, 'REAUTH_REQUIRED', 'Confirm'));
    const user = await startCreating();

    const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
    await user.click(within(prompt).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Confirm it’s you/ })).not.toBeInTheDocument());
    expect(api.mintMcpToken).toHaveBeenCalledTimes(1);
    expect(api.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Your new token' })).not.toBeInTheDocument();
  });

  it('offers the user’s passkey when the browser supports one, and retries after it', async () => {
    api.isPasskeySupported.mockReturnValue(true);
    api.getUserPasskeys.mockResolvedValue([{ id: 'cred-1', deviceName: 'Laptop', createdAt: '2026-01-01T00:00:00Z' }]);
    api.reauthenticateWithPasskey.mockResolvedValue({ reauthenticated: true, validForSeconds: 300 });
    api.mintMcpToken.mockRejectedValueOnce(apiError(403, 'REAUTH_REQUIRED', 'Confirm')).mockResolvedValueOnce(minted);
    const user = await startCreating();

    const prompt = await screen.findByRole('dialog', { name: /Confirm it’s you/ });
    await user.click(await within(prompt).findByRole('button', { name: /Use passkey/ }));
    expect(await screen.findByRole('dialog', { name: 'Your new token' })).toBeInTheDocument();
    expect(api.reauthenticateWithPasskey).toHaveBeenCalledTimes(1);
    expect(api.reauthenticateWithPassword).not.toHaveBeenCalled();
    expect(api.mintMcpToken).toHaveBeenCalledTimes(2);
  });

  it('reports other errors without asking to confirm', async () => {
    api.mintMcpToken.mockRejectedValue(apiError(403, 'TENANT_FORBIDDEN', 'You do not have access to that ledger'));
    await startCreating();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('You do not have access to that ledger'));
    expect(screen.queryByRole('dialog', { name: /Confirm it’s you/ })).not.toBeInTheDocument();
  });

  it('shows each token’s access', async () => {
    api.getMcpTokens.mockResolvedValue([
      { ...minted, uuid: 'a', label: 'reader', scope: 'read', tenantName: 'Household', lastUsedAt: null },
      { ...minted, uuid: 'b', label: 'writer', scope: 'read_write', tenantName: 'Household', lastUsedAt: null },
    ]);
    renderPage();
    const reader = (await screen.findByText('reader')).closest('tr')!;
    const writer = screen.getByText('writer').closest('tr')!;
    expect(within(reader as HTMLElement).getByText('Read only')).toBeInTheDocument();
    expect(within(writer as HTMLElement).getByText('Read and write')).toBeInTheDocument();
  });
});
