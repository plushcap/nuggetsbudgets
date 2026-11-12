import React from 'react';
import { Card, Flex, Box, Grid, Text, Button, TextField, Heading } from '@radix-ui/themes';
import { Wallet, Save } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAuth } from '../contexts/AuthContext';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageLoader from '../components/PageLoader';
import MembershipManager from '../components/MembershipManager';
import AddLedgerMemberForm from '../components/AddLedgerMemberForm';
import RadixMerchantSelector from '../components/RadixMerchantSelector';
import {
  useCurrentTenantQuery,
  useTenantMembersQuery,
  useRenameTenantMutation,
  useAddTenantMemberMutation,
  useSetTenantMemberAdminMutation,
  useSetTenantMemberFlagsMutation,
  useRemoveTenantMemberMutation,
  useSetBalanceAdjustmentMerchantMutation,
} from '../hooks/queries/tenants';
import { useMerchantsQuery } from '../hooks/queries/referenceData';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';

/**
 * Tenant-admin management of the ACTIVE tenant (the UI's ledger): rename + members. Any
 * member can view; editing requires a tenant admin (tenantRole === 'admin'). Members are added
 * from the ledger's organization.
 */
const TenantSettingsPage: React.FC = () => {
  const { user, activeTenant, tenantRole, orgRole, isDeploymentAdmin } = useAuth();
  const canManage = tenantRole === 'admin';
  // Global account flags (lock / no-sign-in) live on the users row, so editing
  // them is reserved for org admins and deployment admins (not tenant-only admins).
  const canManageUserFlags = isDeploymentAdmin || orgRole === 'admin';

  const { data: tenant, isLoading } = useCurrentTenantQuery({ enabled: !!activeTenant });
  const { data: members = [], isLoading: membersLoading } = useTenantMembersQuery({ enabled: !!activeTenant });

  const renameMutation = useRenameTenantMutation();
  const addMember = useAddTenantMemberMutation();
  const setAdmin = useSetTenantMemberAdminMutation();
  const setFlags = useSetTenantMemberFlagsMutation();
  const removeMember = useRemoveTenantMemberMutation();
  const setMerchant = useSetBalanceAdjustmentMerchantMutation();
  const { data: merchants = [] } = useMerchantsQuery({ lite: true }, { enabled: !!activeTenant });

  // The name field, set to the ledger's name each time that loads or changes.
  const [name, setName] = useSeededState<string>((current) => tenant?.name || current || '', [tenant?.name]);

  // The selector is keyed by merchant name; we persist by uuid. Kept in sync
  // with the server value.
  const [merchantName, setMerchantName] = useSeededState<string>(
    () => tenant?.balanceAdjustmentMerchant?.name ?? '',
    [tenant?.balanceAdjustmentMerchant?.name],
  );

  if (!activeTenant) {
    return (
      <PageContainer>
        <SettingsPageHeader title="Ledger" icon={<Wallet size={20} className="text-[var(--accent-11)]" />} backPath="/settings" />
        <Card>
          <Flex direction="column" align="center" gap="2" py="9">
            <Text size="4" weight="bold" className="text-[var(--gray-12)]">No ledger selected</Text>
            <Text size="2" color="gray">Choose a ledger from the switcher to manage it.</Text>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  if (isLoading) {
    return (
      <PageContainer>
        <PageLoader label="Loading ledger…" />
      </PageContainer>
    );
  }

  const handleRename = async () => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === tenant?.name) return;
    try {
      await renameMutation.mutateAsync(trimmed);
      toast.success('Ledger renamed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not rename ledger');
    }
  };

  const saveMerchant = async (merchantUuid: string | null) => {
    try {
      await setMerchant.mutateAsync(merchantUuid);
      toast.success(
        merchantUuid ? 'Balance adjustment merchant updated' : 'Balance adjustment merchant cleared'
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not update merchant');
    }
  };

  const memberCount = tenant?.memberCount ?? members.length;

  return (
    <PageContainer>
      <SettingsPageHeader
        title="Ledger"
        subtitle={
          tenant ? `${tenant.organization.name} · ${memberCount} member${memberCount === 1 ? '' : 's'}` : undefined
        }
        icon={<Wallet size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings"
      />

      {/* The ledger's two settings side by side on a wide screen, so neither field runs the page's width. */}
      <Grid columns={{ initial: '1', md: '2' }} gap="6" mb="6">
        <Card>
          <Flex direction="column" gap="3">
            <Heading size="3" id="ledger-name-heading">Ledger name</Heading>
            {canManage ? (
              <Flex direction={{ initial: 'column', sm: 'row' }} gap="3" align={{ sm: 'center' }}>
                <Box flexGrow="1">
                  <TextField.Root
                    aria-labelledby="ledger-name-heading"
                    size="3"
                    value={name}
                    maxLength={100}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Box>
                <Button
                  size="3"
                  onClick={handleRename}
                  disabled={renameMutation.isPending || !name.trim() || name.trim() === tenant?.name}
                >
                  <Save size={16} />
                  Save
                </Button>
              </Flex>
            ) : (
              <Text size="3" className="text-[var(--gray-12)]">{tenant?.name}</Text>
            )}
          </Flex>
        </Card>

        <Card>
          <Flex direction="column" gap="3">
            <Box>
              <Heading size="3" id="balance-adjustment-merchant-heading">Balance adjustment merchant</Heading>
              <Text size="2" color="gray">
                Assigned to balance-adjustment transactions — both the manual “Adjust Balance” action and
                the SimpleFin auto-rebalance. Optional.
              </Text>
            </Box>
            {canManage ? (
              <Flex direction={{ initial: 'column', sm: 'row' }} gap="2" align={{ sm: 'center' }}>
                <Box flexGrow="1">
                  <RadixMerchantSelector
                    aria-labelledby="balance-adjustment-merchant-heading"
                    value={merchantName}
                    onChange={setMerchantName}
                    onSelectMerchant={(m) => {
                      if (m) {
                        setMerchantName(m.name);
                        void saveMerchant(m.uuid);
                      }
                    }}
                    merchants={merchants}
                    placeholder="Search merchants…"
                    size="3"
                    disabled={setMerchant.isPending}
                  />
                </Box>
                {merchantName && (
                  <Button
                    variant="soft"
                    color="gray"
                    size="3"
                    onClick={() => {
                      setMerchantName('');
                      void saveMerchant(null);
                    }}
                    disabled={setMerchant.isPending}
                  >
                    Clear
                  </Button>
                )}
              </Flex>
            ) : (
              <Text size="3" className="text-[var(--gray-12)]">
                {tenant?.balanceAdjustmentMerchant?.name ?? 'None'}
              </Text>
            )}
          </Flex>
        </Card>
      </Grid>

      <Heading size="4" mb="3">Members</Heading>
      <MembershipManager
        members={members}
        loading={membersLoading}
        canManage={canManage}
        currentUserUuid={user?.uuid}
        entityLabel="ledger"
        addControl={
          <AddLedgerMemberForm
            organizationName={activeTenant.organizationName}
            canInvite={isDeploymentAdmin || orgRole === 'admin'}
            onAdd={async (email, isAdmin) => {
              await addMember.mutateAsync({ email, isAdmin });
            }}
          />
        }
        onToggleAdmin={async (m, isAdmin) => {
          await setAdmin.mutateAsync({ uuid: m.uuid, isAdmin });
        }}
        onRemoveMember={async (m) => {
          await removeMember.mutateAsync(m.uuid);
        }}
        canManageUserFlags={canManageUserFlags}
        onToggleLocked={async (m, locked) => {
          await setFlags.mutateAsync({ uuid: m.uuid, flags: { isLocked: locked } });
        }}
        onToggleLoginDisabled={async (m, disabled) => {
          await setFlags.mutateAsync({ uuid: m.uuid, flags: { loginDisabled: disabled } });
        }}
      />
    </PageContainer>
  );
};

export default TenantSettingsPage;
