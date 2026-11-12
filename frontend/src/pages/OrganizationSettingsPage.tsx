import React, { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Card, Flex, Box, Text, Button, TextField, Heading, Badge, Table, Dialog } from '@radix-ui/themes';
import { Building2, Save, Plus, Shield, Wallet } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageLoader from '../components/PageLoader';
import MembershipManager from '../components/MembershipManager';
import InviteMemberDialog from '../components/InviteMemberDialog';
import PendingInvitations from '../components/PendingInvitations';
import {
  useOrganizationQuery,
  useOrgMembersQuery,
  useUpdateOrganizationMutation,
  useCreateOrgBudgetMutation,
  useAddOrgMemberMutation,
  useSetOrgMemberAdminMutation,
  useSetOrgMemberFlagsMutation,
  useRemoveOrgMemberMutation,
} from '../hooks/queries/organizations';
import type { TenantStatus } from '@nuggets/shared';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';

const statusColor = (s: TenantStatus): 'green' | 'amber' | 'red' =>
  s === 'active' ? 'green' : s === 'suspended' ? 'amber' : 'red';

/**
 * Manage one organization: rename, its ledgers (+ create), and members. Targets the
 * org from the /settings/organizations/:uuid route (deployment-console drill-in) or,
 * with no param, the active ledger's organization. Gated to that org's admins /
 * deployment admins. People join by invitation; only a deployment admin can
 * add an existing user directly.
 */
const OrganizationSettingsPage: React.FC = () => {
  const { user, activeOrganization, orgRole, isDeploymentAdmin, organizations } = useAuth();
  // A specific org when opened via the console (/settings/organizations/:uuid),
  // else the active ledger's organization.
  const { uuid: routeUuid } = useParams();
  const orgUuid = routeUuid ?? activeOrganization?.uuid;
  // Deployment admins may manage any org; an org admin the active ledger's, or one the
  // address names that they administer (the membership summary has their role in each),
  // as the server allows. The backend re-authorizes every request regardless.
  const canManage =
    isDeploymentAdmin ||
    (!!orgUuid && orgUuid === activeOrganization?.uuid && orgRole === 'admin') ||
    (!!routeUuid && organizations.some((org) => org.uuid === routeUuid && org.role === 'admin'));

  const { data: org, isLoading } = useOrganizationQuery(canManage ? orgUuid : undefined);
  const { data: members = [], isLoading: membersLoading } = useOrgMembersQuery(canManage ? orgUuid : undefined);

  const updateOrg = useUpdateOrganizationMutation();
  const createBudget = useCreateOrgBudgetMutation();
  const addMember = useAddOrgMemberMutation();
  const setAdmin = useSetOrgMemberAdminMutation();
  const setFlags = useSetOrgMemberFlagsMutation();
  const removeMember = useRemoveOrgMemberMutation();

  // The name field, set to the organization's name each time that loads or changes.
  const [name, setName] = useSeededState<string>((current) => org?.name || current || '', [org?.name]);

  const [createOpen, setCreateOpen] = useState(false);
  const [budgetName, setBudgetName] = useState('');

  if (!canManage) {
    return (
      <PageContainer>
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Shield size={64} className="text-[var(--red-11)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="6" weight="bold">Access Denied</Text>
              <Text size="2" color="gray">You need organization admin privileges to manage the organization.</Text>
            </Flex>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  if (!orgUuid) {
    return (
      <PageContainer>
        <SettingsPageHeader title="Organization" icon={<Building2 size={20} className="text-[var(--accent-11)]" />} backPath="/settings" />
        <Card>
          <Flex direction="column" align="center" gap="2" py="9">
            <Text size="4" weight="bold" className="text-[var(--gray-12)]">No organization selected</Text>
            <Text size="2" color="gray">Choose a ledger from the switcher to manage its organization.</Text>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  if (isLoading) {
    return (
      <PageContainer>
        <PageLoader label="Loading organization…" />
      </PageContainer>
    );
  }

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === org?.name) return;
    try {
      await updateOrg.mutateAsync({ uuid: orgUuid, body: { name: trimmed } });
      toast.success('Organization renamed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename organization');
    }
  };

  const handleCreateBudget = async () => {
    const trimmed = budgetName.trim();
    if (!trimmed) {
      toast.error('Enter a ledger name');
      return;
    }
    try {
      await createBudget.mutateAsync({ uuid: orgUuid, name: trimmed });
      toast.success('Ledger created');
      setBudgetName('');
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create ledger');
    }
  };

  return (
    <PageContainer>
      <SettingsPageHeader
        title="Organization"
        subtitle={org ? `${org.tenants.length} ledger${org.tenants.length === 1 ? '' : 's'} · ${org.memberCount} member${org.memberCount === 1 ? '' : 's'}` : undefined}
        icon={<Building2 size={20} className="text-[var(--accent-11)]" />}
        backPath={routeUuid ? '/settings/organizations' : '/settings'}
      />

      <Card mb="6">
        <Flex direction="column" gap="3">
          <Flex align="center" justify="between">
            <Heading size="3" id="organization-name-heading">Organization name</Heading>
            {org && <Badge color={statusColor(org.status)} variant="soft" radius="full">{org.status}</Badge>}
          </Flex>
          <Flex direction={{ initial: 'column', sm: 'row' }} gap="3" align={{ sm: 'center' }}>
            <Box flexGrow="1">
              <TextField.Root
                aria-labelledby="organization-name-heading"
                size="3"
                value={name}
                maxLength={100}
                onChange={(e) => setName(e.target.value)}
              />
            </Box>
            <Button size="3" onClick={handleRename} disabled={updateOrg.isPending || !name.trim() || name.trim() === org?.name}>
              <Save size={16} />
              Save
            </Button>
          </Flex>
        </Flex>
      </Card>

      <Flex align="center" justify="between" mb="3">
        <Heading size="4">Ledgers</Heading>
        <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
          <Dialog.Trigger>
            <Button>
              <Plus size={16} />
              New ledger
            </Button>
          </Dialog.Trigger>
          <Dialog.Content maxWidth="420px">
            <Dialog.Title>Create ledger</Dialog.Title>
            <Dialog.Description size="2" mb="4" color="gray">
              A new ledger starts empty — set up its accounts and categories after switching to it.
            </Dialog.Description>
            <Box mb="4">
              <Text as="label" htmlFor="organization-name" size="2" weight="medium" mb="1" style={{ display: 'block' }}>Name</Text>
              <TextField.Root
                id="organization-name"
                size="3"
                placeholder="e.g. Household Ledger"
                value={budgetName}
                maxLength={100}
                onChange={(e) => setBudgetName(e.target.value)}
              />
            </Box>
            <Flex gap="3" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">Cancel</Button>
              </Dialog.Close>
              <Button onClick={handleCreateBudget} disabled={createBudget.isPending || !budgetName.trim()}>
                Create ledger
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
      </Flex>

      <Card mb="6">
        {org && org.tenants.length > 0 ? (
          <Table.Root size="2">
            <Table.Header>
              <Table.Row>
                <Table.ColumnHeaderCell>Ledger</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                <Table.ColumnHeaderCell>Members</Table.ColumnHeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {org.tenants.map((t) => (
                <Table.Row key={t.uuid}>
                  <Table.Cell>
                    <Flex align="center" gap="2">
                      <Wallet size={16} className="text-[var(--gray-11)]" />
                      <Text size="2" weight="medium">{t.name}</Text>
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Badge color={statusColor(t.status)} variant="soft" radius="full">{t.status}</Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Text size="2" color="gray">{t.memberCount}</Text>
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Root>
        ) : (
          <Flex direction="column" align="center" gap="2" py="6">
            <Text size="2" color="gray">No ledgers in this organization yet.</Text>
          </Flex>
        )}
      </Card>

      <Flex align="center" justify="between" gap="3" mb="3">
        <Heading size="4">Organization members</Heading>
        <InviteMemberDialog orgUuid={orgUuid} orgName={org?.name} />
      </Flex>
      <MembershipManager
        members={members}
        loading={membersLoading}
        canManage={canManage}
        currentUserUuid={user?.uuid}
        entityLabel="organization"
        onAddMember={
          isDeploymentAdmin
            ? async (email, isAdmin) => {
                await addMember.mutateAsync({ uuid: orgUuid, input: { email, isAdmin } });
              }
            : undefined
        }
        addMemberHint="As a deployment admin you can add an existing user directly, without an invitation."
        onToggleAdmin={async (m, isAdmin) => {
          await setAdmin.mutateAsync({ uuid: orgUuid, memberUuid: m.uuid, isAdmin });
        }}
        onRemoveMember={async (m) => {
          await removeMember.mutateAsync({ uuid: orgUuid, memberUuid: m.uuid });
        }}
        canManageUserFlags={canManage}
        onToggleLocked={async (m, locked) => {
          await setFlags.mutateAsync({ uuid: orgUuid, memberUuid: m.uuid, flags: { isLocked: locked } });
        }}
        onToggleLoginDisabled={async (m, disabled) => {
          await setFlags.mutateAsync({ uuid: orgUuid, memberUuid: m.uuid, flags: { loginDisabled: disabled } });
        }}
      />

      <Heading size="4" mt="6" mb="3">Open invitations</Heading>
      <PendingInvitations orgUuid={orgUuid} />
    </PageContainer>
  );
};

export default OrganizationSettingsPage;
