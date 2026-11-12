import React, { useState, useMemo } from 'react';
import {
  Activity, RefreshCw, Search, CheckCircle, XCircle,
  AlertCircle, User, Calendar, Timer, HardDrive
} from 'lucide-react';
import { useImportSyncLogQuery } from '../hooks/queries/imports';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { Box, Card, ScrollArea, TextField, Flex, Text, Button, Table, Badge } from '@radix-ui/themes';
import PageContainer from '../components/PageContainer';

const BankImportSyncHistoryPage: React.FC = () => {
  // Sync Logs State
  const [syncSearchTerm, setSyncSearchTerm] = useState('');
  const { data, isLoading: loadingSyncLogs, refetch } = useImportSyncLogQuery(100, 0);
  const syncLogs = useMemo(() => data?.syncLogs ?? [], [data]);

  // Filter sync logs based on search term
  const filteredSyncLogs = useMemo(() => {
    if (!syncSearchTerm.trim()) return syncLogs;
    const term = syncSearchTerm.toLowerCase();
    return syncLogs.filter(log =>
      log.sync_type.toLowerCase().includes(term) ||
      log.sync_status.toLowerCase().includes(term) ||
      log.sync_trigger.toLowerCase().includes(term) ||
      log.import_provider.toLowerCase().includes(term) ||
      (log.error_message && log.error_message.toLowerCase().includes(term))
    );
  }, [syncLogs, syncSearchTerm]);

  // A sync's outcome (the sync log's own words, not a list's).
  const getSyncStatusIcon = (status: 'completed' | 'failed' | 'started' | 'partial' | (string & {})) => {
    switch (status) {
      case 'completed': return <CheckCircle size={16} className="text-[var(--green-12)]" />;
      case 'failed':    return <XCircle size={16} className="text-[var(--red-11)]" />;
      case 'started':   return <Activity size={16} className="animate-pulse text-[var(--accent-11)]" />;
      case 'partial':   return <AlertCircle size={16} className="text-[var(--yellow-12)]" />;
      default:          return <AlertCircle size={16} className="text-[var(--gray-11)]" />;
    }
  };

  const getSyncTriggerIcon = (trigger: string) => {
    switch (trigger) {
      case 'user':     return <User size={16} className="text-[var(--accent-11)]" />;
      case 'schedule': return <Calendar size={16} className="text-[var(--green-12)]" />;
      case 'api':      return <Activity size={16} className="text-[var(--purple-11)]" />;
      default:         return <Activity size={16} className="text-[var(--gray-11)]" />;
    }
  };

  const formatDuration = (startTime: string | null, endTime: string | null) => {
    if (!endTime) return 'In progress...';
    if (!startTime) return '';

    const start = new Date(startTime);
    const end = new Date(endTime);
    const duration = end.getTime() - start.getTime();

    if (duration < 1000) return `${duration}ms`;
    if (duration < 60000) return `${(duration / 1000).toFixed(1)}s`;
    return `${(duration / 60000).toFixed(1)}m`;
  };

  return (
    <PageContainer>
      {/* Header */}
      <SettingsPageHeader
        title="Bank Import Sync History"
        subtitle="View and monitor your bank import synchronization logs"
        icon={<Activity size={20} className="text-[var(--purple-11)]" />}
        iconBackground="bg-[var(--purple-3)]"
        backPath="/settings/import-settings"
        primaryAction={{
          label: 'Refresh',
          onClick: () => refetch(),
          icon: <RefreshCw size={16} className={loadingSyncLogs ? 'animate-spin' : ''} />,
          disabled: loadingSyncLogs,
          loading: loadingSyncLogs
        }}
      />

      {/* Search and Stats */}
      <Card mb="5">
        <Flex direction="column" gap="4">
          <TextField.Root
            aria-label="Search sync logs"
            placeholder="Search sync logs..."
            value={syncSearchTerm}
            onChange={(e) => setSyncSearchTerm(e.target.value)}
            size="3"
          >
            <TextField.Slot>
              <Search size={16} />
            </TextField.Slot>
          </TextField.Root>
          <Flex wrap="wrap" gap="3" align="center">
            <Text size="2" color="gray">Total: {syncLogs.length}</Text>
            {syncSearchTerm && (
              <Text size="2" color="gray">Filtered: {filteredSyncLogs.length}</Text>
            )}
            <Text size="2" color="green" highContrast>
              Completed: {syncLogs.filter(log => log.sync_status === 'completed').length}
            </Text>
            <Text size="2" color="red">
              Failed: {syncLogs.filter(log => log.sync_status === 'failed').length}
            </Text>
          </Flex>
        </Flex>
      </Card>

      {/* Content */}
      <Card>
        {loadingSyncLogs ? (
          <Flex align="center" justify="center" py="6" gap="2">
            <RefreshCw size={24} className="animate-spin text-[var(--accent-11)]" />
            <Text size="2" color="gray">Loading sync logs...</Text>
          </Flex>
        ) : filteredSyncLogs.length === 0 ? (
          <Flex direction="column" align="center" gap="3" py="8" className="text-center">
            <Activity size={64} className="opacity-50 text-[var(--gray-11)]" />
            <Text size="4" weight="medium" color="gray" highContrast>
              {syncSearchTerm ? 'No Matching Sync Logs' : 'No Sync History'}
            </Text>
            <Text size="2" color="gray">
              {syncSearchTerm
                ? 'Try adjusting your search terms to find sync logs.'
                : 'Sync operations will appear here when they are performed.'}
            </Text>
            {syncSearchTerm && (
              <Button onClick={() => setSyncSearchTerm('')} size="2">
                Clear Search
              </Button>
            )}
          </Flex>
        ) : (
          <>
            {/* Mobile Card View */}
            <Flex direction="column" gap="4" className="block md:hidden">
              {filteredSyncLogs.map((log) => (
                <Card key={log.uuid}>
                  <Flex direction="column" gap="3">
                    <Flex align="start" justify="between">
                      <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%" minWidth="0px">
                        <Flex align="center" gap="2">
                          {getSyncStatusIcon(log.sync_status)}
                          <Text size="2" weight="medium" className="capitalize">{log.sync_status}</Text>
                          <Text size="1" color="gray">•</Text>
                          <Text size="2" className="capitalize" color="gray">{log.sync_type}</Text>
                        </Flex>
                        <Flex align="center" gap="2">
                          {getSyncTriggerIcon(log.sync_trigger)}
                          <Text size="1" className="capitalize" color="gray">{log.sync_trigger}</Text>
                          <Text size="1" color="gray">•</Text>
                          <Timer size={12} className="text-[var(--gray-11)]" />
                          <Text size="1" color="gray">
                            {formatDuration(log.sync_start_time, log.sync_end_time)}
                          </Text>
                        </Flex>
                        <Flex align="center" gap="2">
                          <HardDrive size={12} className="text-[var(--gray-11)]" />
                          <Text size="1" className="capitalize" color="gray">{log.import_provider}</Text>
                          <Text size="1" color="gray">•</Text>
                          <Text size="1" color="gray">
                            {log.sync_start_time && new Date(log.sync_start_time).toLocaleDateString('en-US', {
                              month: 'short',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit'
                            })}
                          </Text>
                        </Flex>
                      </Flex>
                    </Flex>
                    <Flex wrap="wrap" gap="2">
                      {(log.accounts_synced ?? 0) > 0 && (
                        <Badge color="blue" variant="soft">{log.accounts_synced} accounts</Badge>
                      )}
                      {(log.transactions_imported ?? 0) > 0 && (
                        <Badge highContrast color="green" variant="soft">{log.transactions_imported} imported</Badge>
                      )}
                      {(log.transactions_updated ?? 0) > 0 && (
                        <Badge highContrast color="yellow" variant="soft">{log.transactions_updated} updated</Badge>
                      )}
                      {(log.balance_adjustments_created ?? 0) > 0 && (
                        <Badge color="purple" variant="soft">{log.balance_adjustments_created} adjustments</Badge>
                      )}
                    </Flex>
                    {log.error_message && (
                      <Card className="[--card-background-color:var(--red-3)]">
                        <Text size="1" color="red">
                          Error: {log.error_message}
                        </Text>
                      </Card>
                    )}
                  </Flex>
                </Card>
              ))}
            </Flex>

            {/* Desktop Table View */}
            <Box display={{ initial: 'none', sm: 'block' }}>
              <ScrollArea scrollbars="horizontal">
                <Table.Root>
                <Table.Header>
                  <Table.Row>
                    <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Trigger</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Duration</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Results</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Started</Table.ColumnHeaderCell>
                    <Table.ColumnHeaderCell>Provider</Table.ColumnHeaderCell>
                  </Table.Row>
                </Table.Header>
                <Table.Body>
                  {filteredSyncLogs.map((log) => (
                    <Table.Row key={log.uuid}>
                      <Table.Cell>
                        <Flex align="center" gap="2">
                          {getSyncStatusIcon(log.sync_status)}
                          <Text size="2" className="capitalize">{log.sync_status}</Text>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Text size="2" className="capitalize">{log.sync_type}</Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="2">
                          {getSyncTriggerIcon(log.sync_trigger)}
                          <Text size="2" className="capitalize">{log.sync_trigger}</Text>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="1">
                          <Timer size={12} className="text-[var(--gray-11)]" />
                          <Text size="2" color="gray">
                            {formatDuration(log.sync_start_time, log.sync_end_time)}
                          </Text>
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex direction="column" gap="1">
                          {(log.accounts_synced ?? 0) > 0 && (
                            <Text size="1" className="text-[var(--accent-11)]">{log.accounts_synced} accounts</Text>
                          )}
                          {(log.transactions_imported ?? 0) > 0 && (
                            <Text size="1" color="green" highContrast>{log.transactions_imported} imported</Text>
                          )}
                          {(log.transactions_updated ?? 0) > 0 && (
                            <Text size="1" color="yellow" highContrast>{log.transactions_updated} updated</Text>
                          )}
                          {(log.balance_adjustments_created ?? 0) > 0 && (
                            <Text size="1" color="purple">{log.balance_adjustments_created} adjustments</Text>
                          )}
                          {log.error_message && (
                            <Text size="1" color="red" className="max-w-xs truncate" title={log.error_message}>
                              Error: {log.error_message}
                            </Text>
                          )}
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Text size="2" color="gray">
                          {log.sync_start_time && new Date(log.sync_start_time).toLocaleDateString('en-US', {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit'
                          })}
                        </Text>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex align="center" gap="1">
                          <HardDrive size={12} className="text-[var(--gray-11)]" />
                          <Text size="2" className="capitalize" color="gray">{log.import_provider}</Text>
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
                </Table.Root>
              </ScrollArea>
            </Box>
          </>
        )}
      </Card>
    </PageContainer>
  );
};

export default BankImportSyncHistoryPage;
