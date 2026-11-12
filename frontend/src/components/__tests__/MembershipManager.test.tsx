import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Theme } from '@radix-ui/themes';
import toast from 'react-hot-toast';
import type { MemberDto } from '@nuggets/shared';
import { renderWithProviders } from '../../test/renderWithProviders';
import { apiErrorFrom } from '../../services/api/base';
import MembershipManager from '../MembershipManager';

vi.mock('react-hot-toast', () => {
  const toast = { success: vi.fn(), error: vi.fn() };
  return { default: toast, toast };
});

const member: MemberDto = {
  uuid: 'membership-1',
  isAdmin: false,
  createdAt: '2026-10-27T10:00:00.000Z',
  user: { uuid: 'user-1', email: 'pat@example.com', firstName: 'Pat', lastName: 'Smith', profileImage: null, isLocked: false, loginDisabled: false },
};

const renderManager = (onRemoveMember: (m: MemberDto) => Promise<void>) =>
  renderWithProviders(
    <Theme>
      <MembershipManager
        members={[member]}
        loading={false}
        canManage
        entityLabel="organization"
        onToggleAdmin={vi.fn()}
        onRemoveMember={onRemoveMember}
      />
    </Theme>
  );

async function removePat() {
  const user = userEvent.setup();
  await user.click(screen.getAllByRole('button', { name: 'Remove Pat Smith' })[0]);
  await user.click(await screen.findByRole('button', { name: 'Remove' }));
}

describe('MembershipManager', () => {
  beforeEach(() => vi.clearAllMocks());

  // Removing the only admin of one of the organization's ledgers is refused: the
  // toast says why, as the server put it, in Ledger wording.
  it("shows the server's reason when a removal is refused", async () => {
    const reason = 'This member is the only admin of the tenant "Household" in this organization. Make someone else an admin of it first.';
    const refusal = apiErrorFrom(new Response(null, { status: 409 }), { error: reason, message: reason, code: 'LAST_ADMIN', tenants: [] });
    renderManager(vi.fn().mockRejectedValue(refusal));
    await removePat();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'This member is the only admin of the ledger "Household" in this organization. Make someone else an admin of it first.'
      )
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("doesn't show the text of an error that isn't the server's answer", async () => {
    renderManager(vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'uuid')")));
    await removePat();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Something went wrong'));
  });
});
