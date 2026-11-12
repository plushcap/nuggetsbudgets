import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AcceptInvitationPage from '../AcceptInvitationPage';

const api = vi.hoisted(() => ({ inspect: vi.fn(), accept: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return {
    ...actual,
    inspectInvitation: (token: string) => api.inspect(token),
    acceptInvitation: (token: string) => api.accept(token),
  };
});
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { email: 'me@example.com' } }) }));

const token = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde';
const organization = { uuid: 'org-1', name: 'The Smiths' };
const preview = {
  organization,
  email: 'me@example.com',
  isAdmin: false,
  expiresAt: '2026-11-03T10:00:00.000Z',
  invitedBy: { firstName: 'Pat', lastName: 'Smith' },
  alreadyMember: false,
};
const renderPage = () => renderWithProviders(<Theme><AcceptInvitationPage /></Theme>, { route: '/invitations/accept' });

describe('AcceptInvitationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.history.replaceState(null, '', `/invitations/accept#${token}`);
  });

  it('names the organization, joins only when asked, and takes the token out of the address bar', async () => {
    api.inspect.mockResolvedValue(preview);
    api.accept.mockResolvedValue({ organization, isAdmin: false });
    renderPage();

    expect(await screen.findByRole('heading', { name: 'Join The Smiths?' })).toBeInTheDocument();
    expect(screen.getByText('Pat Smith invited you to join The Smiths as a member.')).toBeInTheDocument();
    expect(api.inspect).toHaveBeenCalledWith(token);
    expect(api.accept).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');

    // Once accepted, the invitation can't be looked at again; the page doesn't ask.
    api.inspect.mockRejectedValue(new Error('HTTP 404'));
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByRole('heading', { name: 'You’ve joined The Smiths' })).toBeInTheDocument();
    expect(api.accept).toHaveBeenCalledWith(token);
    expect(screen.getByText('A ledger admin can now add you to the organization’s ledgers.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
    expect(api.inspect).toHaveBeenCalledTimes(1);
  });

  it('says what an admin invitation gives, and still works after a reload or with ?token=', async () => {
    api.inspect.mockResolvedValue({ ...preview, isAdmin: true, invitedBy: null });
    window.history.replaceState(null, '', `/invitations/accept?token=${token}`);
    renderPage();
    expect(
      await screen.findByText(
        'You’re invited to join The Smiths as an admin. Admins manage the organization, its members and all of its ledgers.'
      )
    ).toBeInTheDocument();
    expect(api.inspect).toHaveBeenCalledWith(token);
    expect(window.location.search).toBe('');
    expect((window.history.state as { invitationToken?: string }).invitationToken).toBe(token);
  });

  it("shows the server's reason, and who is signed in, when the invitation can't be used", async () => {
    api.inspect.mockRejectedValue(
      Object.assign(new Error('HTTP 404'), {
        response: { data: { error: 'This invitation can’t be used. It may have expired.', code: 'INVITATION_INVALID' } },
      })
    );
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This invitation can’t be used' })).toBeInTheDocument();
    expect(screen.getByText('This invitation can’t be used. It may have expired.')).toBeInTheDocument();
    expect(screen.getByText('You’re signed in as me@example.com.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });

  it('refuses a link that is cut short without asking the server', async () => {
    window.history.replaceState(null, '', '/invitations/accept#short');
    renderPage();
    expect(await screen.findByRole('heading', { name: 'This invitation link doesn’t work' })).toBeInTheDocument();
    expect(api.inspect).not.toHaveBeenCalled();
  });
});
