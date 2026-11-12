import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { Routes, Route } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import OrganizationSettingsPage from '../OrganizationSettingsPage';

const org = vi.hoisted(() => ({ uuid: 'org-1', name: 'Family', status: 'active', tenants: [], memberCount: 2 }));
const orgQuery = vi.hoisted(() => vi.fn());
vi.mock('../../hooks/queries/organizations', () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    useOrganizationQuery: (uuid: string | undefined) => {
      orgQuery(uuid);
      return { data: uuid ? org : undefined, isLoading: false };
    },
    useOrgMembersQuery: () => ({ data: [], isLoading: false }),
    useUpdateOrganizationMutation: mutation,
    useCreateOrgBudgetMutation: mutation,
    useAddOrgMemberMutation: mutation,
    useSetOrgMemberAdminMutation: mutation,
    useSetOrgMemberFlagsMutation: mutation,
    useRemoveOrgMemberMutation: mutation,
  };
});
vi.mock('../../components/MembershipManager', () => ({ default: () => null }));
vi.mock('../../components/InviteMemberDialog', () => ({ default: () => null }));
vi.mock('../../components/PendingInvitations', () => ({ default: () => null }));

const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => auth.current }));

const renderAt = (route: string) =>
  renderWithProviders(
    <Theme>
      <Routes>
        <Route path="/settings/organizations/:uuid" element={<OrganizationSettingsPage />} />
      </Routes>
    </Theme>,
    { route }
  );

/**
 * /settings/organizations/:uuid answers to that organization's admins as well as the
 * deployment's (the server's uuid param handler), whichever ledger is active.
 */
describe('OrganizationSettingsPage by address', () => {
  beforeEach(() => orgQuery.mockClear());

  // The active ledger is in another organization, where they're a member.
  const elsewhere = (role: 'admin' | 'member') => ({
    user: { id: 1 },
    isDeploymentAdmin: false,
    activeOrganization: { uuid: 'org-2', name: 'Work' },
    orgRole: 'member',
    organizations: [
      { uuid: 'org-1', name: 'Family', status: 'active', role },
      { uuid: 'org-2', name: 'Work', status: 'active', role: 'member' },
    ],
  });

  it('lets an admin of the organization in the address manage it', async () => {
    auth.current = elsewhere('admin');
    renderAt('/settings/organizations/org-1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Organization' })).toBeInTheDocument();
    expect(screen.queryByText('Access Denied')).not.toBeInTheDocument();
    expect(orgQuery).toHaveBeenCalledWith('org-1');
  });

  it("refuses a member of it, and doesn't ask for it", () => {
    auth.current = elsewhere('member');
    renderAt('/settings/organizations/org-1');
    expect(screen.getByText('Access Denied')).toBeInTheDocument();
    expect(orgQuery).not.toHaveBeenCalledWith('org-1');
  });
});
