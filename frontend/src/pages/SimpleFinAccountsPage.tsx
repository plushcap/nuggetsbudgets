import React, { useState } from 'react';
import {
  Landmark, RefreshCw, CheckCircle, AlertTriangle, XCircle, AlertCircle, Table as TableIcon
} from 'lucide-react';
import { Badge, Box, Button, Callout, Card, Flex, ScrollArea, Table, Text } from '@radix-ui/themes';
import { useSimpleFinAccountsQuery } from '../hooks/queries';
import { useAuth } from '../contexts/AuthContext';
import SettingsPageHeader from '../components/SettingsPageHeader';
import SimpleFinAccountDetailDialog from '../components/SimpleFinAccountDetailDialog';
import PageContainer from '../components/PageContainer';

type StatusColor = 'green' | 'amber' | 'red' | 'gray';

const SimpleFinAccountsPage: React.FC = () => {
  // The organization's SimpleFin connection covers every ledger in it, so only its
  // admins may list its bank accounts.
  const { orgRole, isDeploymentAdmin } = useAuth();
  const canView = orgRole === 'admin' || isDeploymentAdmin;
  // Inline error UI below, so suppress the global error toast.
  const accountsQuery = useSimpleFinAccountsQuery({ enabled: canView, meta: { suppressErrorToast: true } });
  const accounts = accountsQuery.data?.accounts ?? [];
  const errors = accountsQuery.data?.errors ?? [];
  const loading = accountsQuery.isLoading;
  const fetchError = accountsQuery.isError
    ? ((accountsQuery.error as Error)?.message || 'Failed to load SimpleFin accounts')
    : null;
  const fetchAccounts = () => { void accountsQuery.refetch(); };

  // Live, read-only drill-down modal (research; not stored).
  const [detailAccount, setDetailAccount] = useState<{ id: string; name: string } | null>(null);

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'Connected': return <CheckCircle size={16} className="text-[var(--green-12)]" />;
      case 'Stale': return <AlertTriangle size={16} className="text-[var(--amber-12)]" />;
      case 'Disconnected': return <XCircle size={16} className="text-[var(--red-11)]" />;
      default: return <AlertCircle size={16} className="text-[var(--gray-11)]" />;
    }
  };

  const getStatusColor = (status: string): StatusColor => {
    switch (status) {
      case 'Connected': return 'green';
      case 'Stale': return 'amber';
      case 'Disconnected': return 'red';
      default: return 'gray';
    }
  };

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '—';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (!canView) {
    return (
      <PageContainer>
        <SettingsPageHeader
          title="SimpleFin Accounts"
          subtitle="View all accounts from SimpleFin with connection status and Nuggets mappings"
          icon={<Landmark size={20} className="text-[var(--accent-11)]" />}
          iconBackground="bg-[var(--accent-3)]"
          backPath="/settings"
        />
        <Card>
          <Text as="p" size="2" color="gray">
            The bank accounts on your organization&apos;s SimpleFin connection belong to all of its
            ledgers, so only an organization admin can see them here.
          </Text>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <SettingsPageHeader
        title="SimpleFin Accounts"
        subtitle="View all accounts from SimpleFin with connection status and Nuggets mappings"
        icon={<Landmark size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings/import-settings"
        primaryAction={{
          label: 'Refresh',
          onClick: fetchAccounts,
          icon: <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />,
          disabled: loading,
          loading: loading,
        }}
      />

      {/* SimpleFin Errors */}
      {errors.length > 0 && (
        <Callout.Root highContrast color="amber" mb="5">
          <Callout.Icon>
            <AlertTriangle size={20} />
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="2">
              <Text weight="bold">SimpleFin Connection Issues</Text>
              {errors.map((err, i) => (
                <Text key={i}>
                  {err.msg}
                  {err.code ? <Text size="1" color="gray"> ({err.code})</Text> : null}
                </Text>
              ))}
            </Flex>
          </Callout.Text>
        </Callout.Root>
      )}

      {/* Fetch Error */}
      {fetchError && (
        <Callout.Root color="red" mb="5">
          <Callout.Icon>
            <XCircle size={20} />
          </Callout.Icon>
          <Callout.Text>{fetchError}</Callout.Text>
        </Callout.Root>
      )}

      {/* Content Area */}
      <Card>
        {loading ? (
          <Flex align="center" justify="center" py="8" gap="2">
            <RefreshCw size={24} className="animate-spin text-[var(--accent-11)]" />
            <Text className="text-[var(--gray-11)]">Loading SimpleFin accounts...</Text>
          </Flex>
        ) : accounts.length === 0 && !fetchError ? (
          <Flex direction="column" align="center" py="9" gap="2">
            <Landmark size={64} className="mb-2 opacity-50" />
            <Text size="4" weight="medium">No Accounts Found</Text>
            <Text className="text-[var(--gray-11)]">No accounts were returned from SimpleFin. Check your connection settings.</Text>
          </Flex>
        ) : (
          <>
            {/* Stats */}
            <Flex wrap="wrap" align="center" gap={{ initial: '3', md: '4' }} mb="4">
              <Text size="2" className="whitespace-nowrap text-[var(--gray-11)]">Total: {accounts.length}</Text>
              <Text size="2" className="whitespace-nowrap" color="green" highContrast>
                Connected: {accounts.filter(a => a.status === 'Connected').length}
              </Text>
              <Text size="2" className="whitespace-nowrap" color="amber" highContrast>
                Stale: {accounts.filter(a => a.status === 'Stale').length}
              </Text>
              <Text size="2" className="whitespace-nowrap" color="red">
                Disconnected: {accounts.filter(a => a.status === 'Disconnected').length}
              </Text>
              <Text size="2" className="whitespace-nowrap text-[var(--accent-11)]">
                Mapped: {accounts.filter(a => a.nuggets_account_name).length}
              </Text>
            </Flex>

            {/* Desktop Table */}
            <Box display={{ initial: 'none', sm: 'block' }}>
              <ScrollArea scrollbars="horizontal">
                <Table.Root variant="surface">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>SimpleFin Account ID</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>SimpleFin Name</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Nuggets Account</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Last Transaction</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Detail</Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {accounts.map((account) => (
                      <Table.Row key={account.simplefin_account_id}>
                        <Table.Cell>
                          <Text size="1" className="font-mono" title={account.simplefin_account_id}>
                            {account.simplefin_account_id.length > 30
                              ? `${account.simplefin_account_id.substring(0, 30)}...`
                              : account.simplefin_account_id}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Box>
                            <Text weight="medium">{account.simplefin_name}</Text>
                            {account.simplefin_org && (
                              <Text ml="1" className="text-[var(--gray-11)]">({account.simplefin_org})</Text>
                            )}
                          </Box>
                        </Table.Cell>
                        <Table.Cell>
                          {account.nuggets_account_name ? (
                            <Text weight="medium" className="text-[var(--accent-11)]">{account.nuggets_account_name}</Text>
                          ) : (
                            <Text className="italic text-[var(--gray-11)]">Not mapped</Text>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <Badge color={getStatusColor(account.status)} variant="soft">
                            {getStatusIcon(account.status)}
                            {account.status}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <Text className="text-[var(--gray-11)]">
                            {formatDate(account.last_transaction_date)}
                          </Text>
                        </Table.Cell>
                        <Table.Cell>
                          <Button
                            type="button"
                            variant="soft"
                            size="1"
                            onClick={() => setDetailAccount({ id: account.simplefin_account_id, name: account.simplefin_name })}
                          >
                            <TableIcon size={12} />
                            Show detail
                          </Button>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </ScrollArea>
            </Box>

            {/* Mobile Card Layout */}
            <Flex direction="column" gap="3" display={{ sm: 'none' }}>
              {accounts.map((account) => (
                <Card key={account.simplefin_account_id} className="[--card-background-color:var(--gray-2)]">
                  <Flex direction="column" gap="2">
                    <Flex align="center" justify="between">
                      <Text weight="medium">{account.simplefin_name}</Text>
                      <Badge color={getStatusColor(account.status)} variant="soft">
                        {getStatusIcon(account.status)}
                        {account.status}
                      </Badge>
                    </Flex>
                    {account.simplefin_org && (
                      <Text size="1" className="text-[var(--gray-11)]">{account.simplefin_org}</Text>
                    )}
                    <Text size="1" className="font-mono break-all text-[var(--gray-11)]">
                      {account.simplefin_account_id}
                    </Text>
                    <Flex align="center" justify="between" pt="1" className="border-t border-[var(--gray-4)]">
                      <Box>
                        <Text size="2" className="text-[var(--gray-11)]">Nuggets: </Text>
                        {account.nuggets_account_name ? (
                          <Text size="2" weight="medium" className="text-[var(--accent-11)]">{account.nuggets_account_name}</Text>
                        ) : (
                          <Text size="2" className="italic text-[var(--gray-11)]">Not mapped</Text>
                        )}
                      </Box>
                      <Text size="1" className="text-[var(--gray-11)]">
                        {formatDate(account.last_transaction_date)}
                      </Text>
                    </Flex>
                    <Button
                      type="button"
                      variant="soft"
                      size="1"
                      onClick={() => setDetailAccount({ id: account.simplefin_account_id, name: account.simplefin_name })}
                    >
                      <TableIcon size={12} />
                      Show detail
                    </Button>
                  </Flex>
                </Card>
              ))}
            </Flex>
          </>
        )}
      </Card>

      <SimpleFinAccountDetailDialog
        accountId={detailAccount?.id ?? null}
        accountName={detailAccount?.name ?? ''}
        open={detailAccount !== null}
        onOpenChange={(open) => { if (!open) setDetailAccount(null); }}
      />
    </PageContainer>
  );
};

export default SimpleFinAccountsPage;
