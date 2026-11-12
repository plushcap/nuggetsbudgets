import React, { useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { Card, Flex, Box, Text, Button, TextField, Badge, Table, IconButton, Dialog, DropdownMenu, Link } from '@radix-ui/themes';
import { Building2, Plus, Shield, MoreHorizontal, PauseCircle, PlayCircle, Trash2, Settings2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageLoader from '../components/PageLoader';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from '../components/ConfirmationDialog';
import {
  useAllOrganizationsQuery,
  useCreateOrganizationMutation,
  useUpdateOrganizationAdminMutation,
} from '../hooks/queries/organizations';
import type { OrganizationListItem, OrganizationStatus } from '@nuggets/shared';
import PageContainer from '../components/PageContainer';

const statusColor = (s: OrganizationStatus): 'green' | 'amber' | 'red' =>
  s === 'active' ? 'green' : s === 'suspended' ? 'amber' : 'red';

/**
 * Deployment-admin console: every organization in the deployment, with create
 * and suspend/restore/delete (soft) actions. Gated to deployment admins.
 */
const OrganizationsConsolePage: React.FC = () => {
  const { isDeploymentAdmin } = useAuth();
  const navigate = useNavigate();
  const { data: orgs = [], isLoading } = useAllOrganizationsQuery({ enabled: isDeploymentAdmin });
  const createOrg = useCreateOrganizationMutation();
  const updateOrg = useUpdateOrganizationAdminMutation();
  const { confirmAsync, dialogProps } = useConfirmation();

  const [createOpen, setCreateOpen] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [adminEmail, setAdminEmail] = useState('');

  if (!isDeploymentAdmin) {
    return (
      <PageContainer>
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Shield size={64} className="text-[var(--red-11)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="6" weight="bold">Access Denied</Text>
              <Text size="2" color="gray">You need deployment admin privileges to manage organizations.</Text>
            </Flex>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  if (isLoading) {
    return (
      <PageContainer>
        <PageLoader label="Loading organizations…" />
      </PageContainer>
    );
  }

  const handleCreate = async () => {
    const name = orgName.trim();
    if (!name) {
      toast.error('Enter an organization name');
      return;
    }
    try {
      await createOrg.mutateAsync({ name, adminEmail: adminEmail.trim() || undefined });
      toast.success('Organization created');
      setOrgName('');
      setAdminEmail('');
      setCreateOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create organization');
    }
  };

  const setStatus = async (org: OrganizationListItem, status: OrganizationStatus) => {
    try {
      await updateOrg.mutateAsync({ uuid: org.uuid, body: { status } });
      toast.success(
        status === 'active' ? 'Organization restored' : status === 'suspended' ? 'Organization suspended' : 'Organization deleted',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update organization');
    }
  };

  const confirmSuspend = async (org: OrganizationListItem) => {
    const ok = await confirmAsync({
      title: 'Suspend organization',
      message: `Suspend ${org.name}? Its ledgers become inaccessible to all members until restored.`,
      variant: 'warning',
      confirmText: 'Suspend',
      icon: <PauseCircle size={24} />,
    });
    if (ok) await setStatus(org, 'suspended');
  };

  const confirmDelete = async (org: OrganizationListItem) => {
    const ok = await confirmAsync({
      title: 'Delete organization',
      message: `Delete ${org.name}? It will be hidden and its ledgers become inaccessible.`,
      variant: 'danger',
      confirmText: 'Delete',
      icon: <Trash2 size={24} />,
      details: ['This is a soft delete (status = deleted)', 'Ledgers and their data are retained but hidden'],
    });
    if (ok) await setStatus(org, 'deleted');
  };

  const rowActions = (org: OrganizationListItem) => (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <IconButton variant="ghost" color="gray" aria-label={`Actions for ${org.name}`}>
          <MoreHorizontal size={16} />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item onSelect={() => navigate(`/settings/organizations/${org.uuid}`)}>
          <Settings2 size={16} />
          Manage ledgers & members
        </DropdownMenu.Item>
        <DropdownMenu.Separator />
        {org.status === 'active' ? (
          <DropdownMenu.Item onSelect={() => void confirmSuspend(org)}>
            <PauseCircle size={16} />
            Suspend
          </DropdownMenu.Item>
        ) : (
          <DropdownMenu.Item onSelect={() => void setStatus(org, 'active')}>
            <PlayCircle size={16} />
            Restore
          </DropdownMenu.Item>
        )}
        <DropdownMenu.Separator />
        <DropdownMenu.Item color="red" onSelect={() => void confirmDelete(org)}>
          <Trash2 size={16} />
          Delete
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );

  return (
    <PageContainer>
      <SettingsPageHeader
        title="Organizations"
        subtitle="Every organization in this deployment"
        icon={<Building2 size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings"
        primaryAction={{ label: 'New organization', onClick: () => setCreateOpen(true), icon: <Plus size={16} /> }}
      />

      <Dialog.Root open={createOpen} onOpenChange={setCreateOpen}>
        <Dialog.Content maxWidth="440px">
          <Dialog.Title>Create organization</Dialog.Title>
          <Dialog.Description size="2" mb="4" color="gray">
            Optionally name an existing user as the first org admin; otherwise that's you.
          </Dialog.Description>
          <Flex direction="column" gap="3" mb="4">
            <Box>
              <Text as="label" htmlFor="new-organization-name" size="2" weight="medium" mb="1" style={{ display: 'block' }}>Name</Text>
              <TextField.Root id="new-organization-name" size="3" placeholder="e.g. Smith Family" value={orgName} maxLength={100} onChange={(e) => setOrgName(e.target.value)} />
            </Box>
            <Box>
              <Text as="label" htmlFor="new-organization-admin-email" size="2" weight="medium" mb="1" style={{ display: 'block' }}>Admin email (optional)</Text>
              <TextField.Root id="new-organization-admin-email" size="3" type="email" placeholder="person@example.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} />
            </Box>
          </Flex>
          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">Cancel</Button>
            </Dialog.Close>
            <Button onClick={handleCreate} disabled={createOrg.isPending || !orgName.trim()}>
              Create
            </Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      {orgs.length === 0 ? (
        <Card>
          <Flex direction="column" align="center" gap="2" py="9">
            <Building2 size={48} className="text-[var(--gray-6)]" />
            <Text size="4" weight="bold" className="text-[var(--gray-12)]">No organizations</Text>
            <Text size="2" color="gray">Create one to get started.</Text>
          </Flex>
        </Card>
      ) : (
        <>
          {/* Mobile cards */}
          <Card className="block md:hidden">
            <Flex direction="column" gap="3">
              {orgs.map((org) => (
                <Card key={org.uuid} variant="surface">
                  <Flex align="center" justify="between" gap="3">
                    <Box minWidth="0">
                      <Text as="div" weight="bold" truncate className="text-[var(--gray-12)]">{org.name}</Text>
                      <Text as="div" size="2" color="gray">
                        {org.tenantCount} ledger{org.tenantCount === 1 ? '' : 's'} · {org.memberCount} member{org.memberCount === 1 ? '' : 's'}
                      </Text>
                    </Box>
                    <Flex align="center" gap="2">
                      <Badge color={statusColor(org.status)} variant="soft" radius="full">{org.status}</Badge>
                      {rowActions(org)}
                    </Flex>
                  </Flex>
                </Card>
              ))}
            </Flex>
          </Card>

          {/* Desktop table */}
          <Card className="hidden md:block">
            <Table.Root size="2">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Organization</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Ledgers</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Members</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell justify="end">Actions</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {orgs.map((org) => (
                  <Table.Row key={org.uuid}>
                    <Table.Cell>
                      <Flex align="center" gap="2">
                        <Building2 size={16} className="text-[var(--gray-11)]" />
                        <Link asChild size="2" weight="medium">
                          <RouterLink to={`/settings/organizations/${org.uuid}`}>{org.name}</RouterLink>
                        </Link>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge color={statusColor(org.status)} variant="soft" radius="full">{org.status}</Badge>
                    </Table.Cell>
                    <Table.Cell><Text size="2" color="gray">{org.tenantCount}</Text></Table.Cell>
                    <Table.Cell><Text size="2" color="gray">{org.memberCount}</Text></Table.Cell>
                    <Table.Cell justify="end">
                      <Flex justify="end">{rowActions(org)}</Flex>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Card>
        </>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default OrganizationsConsolePage;
