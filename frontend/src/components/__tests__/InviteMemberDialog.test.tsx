import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import { toast } from 'react-hot-toast';
import { renderWithProviders } from '../../test/renderWithProviders';
import InviteMemberDialog from '../InviteMemberDialog';

const api = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('../../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/api')>();
  return { ...actual, createOrgInvitation: (uuid: string, input: unknown) => api.create(uuid, input) };
});
vi.mock('react-hot-toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const token = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde';
const created = {
  token,
  invitation: {
    uuid: 'invitation-1',
    email: 'person@example.com',
    isAdmin: true,
    status: 'pending',
    createdAt: '2026-10-27T10:00:00.000Z',
    expiresAt: '2026-11-03T10:00:00.000Z',
    invitedBy: { firstName: 'Pat', lastName: 'Admin' },
  },
};

const renderDialog = () => renderWithProviders(<Theme><InviteMemberDialog orgUuid="org-1" orgName="The Smiths" /></Theme>);

describe('InviteMemberDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.create.mockResolvedValue(created);
  });

  it('invites an address and shows the one-time link to copy', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByRole('heading', { name: 'Invite someone to The Smiths' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email address'), '  Person@Example.com ');
    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));

    await waitFor(() => expect(api.create).toHaveBeenCalledWith('org-1', { email: 'person@example.com', isAdmin: true }));
    expect(await screen.findByRole('heading', { name: 'Share the invitation' })).toBeInTheDocument();
    const link = `${window.location.origin}/invitations/accept#${token}`;
    expect(screen.getByLabelText('Invitation link')).toHaveValue(link);
    expect(screen.getByText(/Send this link to person@example\.com/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy link' }));
    expect(writeText).toHaveBeenCalledWith(link);
    expect(toast.success).toHaveBeenCalledWith('Invitation link copied');

    // Closing forgets the link; opening again starts a new invitation.
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    expect(await screen.findByLabelText('Email address')).toHaveValue('');
    expect(screen.queryByLabelText('Invitation link')).not.toBeInTheDocument();
  });

  it('ties the address error to the field', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Invite member' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create invitation' }));
    const email = screen.getByRole('textbox', { name: 'Email address' });
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(email.getAttribute('aria-describedby')).toBe('invite-email-error');
    expect(email).toHaveAccessibleDescription(/.+/);
  });

  it('asks for a valid address before inviting', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await user.type(await screen.findByLabelText('Email address'), 'not-an-address');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    expect(await screen.findByText('Valid email is required')).toBeInTheDocument();
    expect(api.create).not.toHaveBeenCalled();
  });

  it("shows the server's reason when the invitation can't be created", async () => {
    const user = userEvent.setup();
    api.create.mockRejectedValue(new Error('Organization admin required.'));
    renderDialog();
    await user.click(screen.getByRole('button', { name: 'Invite member' }));
    await user.type(await screen.findByLabelText('Email address'), 'person@example.com');
    await user.click(screen.getByRole('button', { name: 'Create invitation' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Organization admin required.'));
    expect(screen.queryByLabelText('Invitation link')).not.toBeInTheDocument();
  });
});
