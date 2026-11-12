import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Settings, RefreshCw, CheckCircle,
  Clock, Database, AlertCircle,
  Zap, History as HistoryIcon, Landmark
} from 'lucide-react';
import { Box, Card, Flex, Grid, Text, Button, TextField, Select, Callout, Switch } from '@radix-ui/themes';
import toast from 'react-hot-toast';
import { IMPORT_SETTING_KEYS } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { syncFailureMessage, syncOutcomeNotice } from '../utils/importSyncMessages';
import { useAuth } from '../contexts/AuthContext';
import { startImportScheduler, stopImportScheduler } from '../services/api';
import {
  useImportSettingsQuery,
  useImportStatusQuery,
  useImportUsersQuery,
  useUpdateImportSettingsMutation,
  useRunManualSyncMutation,
  useTestImportConnectionMutation,
} from '../hooks/queries';
import NuggetSpinner from '../components/NuggetSpinner';
import PageLoader from '../components/PageLoader';
import SettingsPageHeader from '../components/SettingsPageHeader';
import OrgSimpleFinConnectionCard from '../components/OrgSimpleFinConnectionCard';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';
import { EMPTY_LIST } from '../utils/emptyList';
import type { ImportSettingDefinition } from '../services/api';
import { personName } from '../utils/personName';

/** The settings being edited: the server's, and any changed here that it didn't list (only a value). */
type ImportSettings = Record<string, Partial<ImportSettingDefinition> & { value: string | null }>;

const ImportSettingsPage: React.FC = () => {
  // Any member of the ledger may open this page: its status, Sync Now and the sync
  // history are member routes. The SimpleFin connection is the organization's,
  // so only its admins (and deployment admins) see and manage it.
  const { orgRole, isDeploymentAdmin, activeOrganization } = useAuth();
  const canManage = orgRole === 'admin' || isDeploymentAdmin;
  const orgUuid = activeOrganization?.uuid;

  // Editable local copy of settings, seeded from the settings query below.

  const settingsQuery = useImportSettingsQuery();
  // An editable copy of the saved settings, taken again each time they load.
  const [settings, setSettings] = useSeededState<ImportSettings | null>(
    (current) => settingsQuery.data?.settings ?? current ?? null,
    [settingsQuery.data],
  );
  const statusQuery = useImportStatusQuery();
  // The ledger's import user is picked from the people with access to the ledger.
  const usersQuery = useImportUsersQuery({ enabled: canManage });

  const status = statusQuery.data ?? null;
  const users = usersQuery.data?.users ?? EMPTY_LIST;
  // Enabled in settings but no timer armed: the failure mode that looks like
  // "the job just isn't running" and logs nothing.
  const schedulerStalled = !!status?.scheduler?.enabled && !status?.scheduler?.running;
  const settingsLoading = settingsQuery.isLoading;
  const statusLoading = statusQuery.isLoading;

  const updateSettingsMutation = useUpdateImportSettingsMutation();
  const runManualSyncMutation = useRunManualSyncMutation();
  const testConnectionMutation = useTestImportConnectionMutation();
  const saving = updateSettingsMutation.isPending;
  const syncing = runManualSyncMutation.isPending;
  const testingConnection = testConnectionMutation.isPending;

  // Scheduler control states
  const [schedulerActionLoading, setSchedulerActionLoading] = useState(false);

  // Reload all data (both settings and status) via the React Query cache.
  const reloadAllData = async () => {
    await Promise.all([settingsQuery.refetch(), statusQuery.refetch()]);
  };

  // Second phase - reload just the connection status
  const loadStatusData = async () => {
    await statusQuery.refetch();
  };

  const handleSettingChange = (key: string, value: string) => {
    if (settings) {
      setSettings({
        ...settings,
        [key]: {
          ...settings[key],
          value
        }
      });
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;

    try {
      // Only the editable keys that changed: the server rejects any other key (such as
      // IMPORT_PROVIDER), and an untouched value is left as stored.
      const saved: Partial<Record<string, ImportSettingDefinition>> = settingsQuery.data?.settings ?? {};
      const settingsToSave = IMPORT_SETTING_KEYS.reduce((acc, key) => {
        const value = settings[key]?.value;
        if (value !== undefined && value !== saved[key]?.value) acc[key] = value ?? '';
        return acc;
      }, {} as Record<string, string>);

      await updateSettingsMutation.mutateAsync(settingsToSave);

      toast.success('Settings saved successfully');
      await reloadAllData(); // Reload data and status
    } catch (error) {
      logger.error({ err: error }, 'Failed to save import settings');
      toast.error(error instanceof Error ? error.message : 'Failed to save settings');
    }
  };

  const handleManualSync = async () => {
    try {
      const result = await runManualSyncMutation.mutateAsync([]);
      // A partial sync says what wasn't saved, rather than "completed successfully".
      const notice = syncOutcomeNotice(result, 'Manual sync completed successfully');
      if (notice.tone === 'success') toast.success(notice.text);
      else if (notice.tone === 'warning') toast(notice.text, { duration: 8000 });
      else toast.error(notice.text);
      await loadStatusData(); // Reload just the status
    } catch (error) {
      logger.error({ err: error }, 'Failed to run manual sync');
      // e.g. 409: a sync of this Ledger is already running.
      const message = syncFailureMessage(error, 'Manual sync failed');
      if (message) toast.error(message);
    }
  };

  const handleTestSync = async () => {
    try {
      const response = await testConnectionMutation.mutateAsync();

      if (response.success) {
        const preview = response.preview;
        toast.success(
          `Connection test successful! Found ${preview.accountCount} accounts with ${preview.accounts.reduce((sum, acc) => sum + acc.transactionCount, 0)} transactions.`
        );
      } else {
        toast.error('Connection test failed');
      }
    } catch (error) {
      logger.error({ err: error }, 'Failed to test SimpleFin connection');
      toast.error('Connection test failed');
    }
  };

  // Toggle automatic import.
  //
  // The start/stop endpoints persist `import_enabled` themselves, so this no
  // longer stages a local settings change that a separate Save had to commit.
  // That split is what let the stored setting say 'false' while the scheduler
  // looked enabled: every scheduled run then returned early inside
  // runAutomaticSync, writing neither a sync-log row nor an error.
  const handleToggleAutomaticImport = async (isEnabling: boolean) => {
    try {
      setSchedulerActionLoading(true);

      const response = isEnabling
        ? await startImportScheduler()
        : await stopImportScheduler();

      if (response.success) {
        toast.success(
          isEnabling
            ? 'Automatic import enabled and scheduler started'
            : 'Automatic import disabled and scheduler stopped'
        );
      } else {
        toast.error(`Failed to ${isEnabling ? 'start' : 'stop'} the scheduler`);
      }

      // Re-read both settings and status so the switch reflects what was stored.
      await reloadAllData();
    } catch (error) {
      logger.error({ err: error }, 'Failed to toggle automatic import');
      toast.error('Failed to update automatic import');
    } finally {
      setSchedulerActionLoading(false);
    }
  };


  // Only show full page loader if we don't have settings yet
  if (settingsLoading && !settings) {
    return (
      <PageContainer width="form">
        <PageLoader label="Loading import settings..." />
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Bank Import Settings"
        subtitle="Configure automatic syncing of bank data from SimpleFin"
        icon={<Database size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath="/settings"
      />

      {/* Organization-wide SimpleFin connection — the primary connection
          shared by accounts across all the org's ledgers. Its admins manage it; a
          member (sent here by an account's Reconnect pill) is told who does. */}
      {canManage && orgUuid && (
        <Box mb="6">
          <OrgSimpleFinConnectionCard orgUuid={orgUuid} />
        </Box>
      )}
      {!canManage && (
        <Callout.Root color="gray" mb="6">
          <Callout.Icon>
            <Landmark size={16} />
          </Callout.Icon>
          <Callout.Text>
            The bank connection is the organization&apos;s, so an organization admin connects it, and
            reconnects it when the bank asks. Ask one of its admins.
          </Callout.Text>
        </Callout.Root>
      )}

      {/* Connection Status Card */}
      <Card mb="6">
        <Flex direction="column" gap="6">
          <Flex direction={{ initial: 'column', sm: 'row' }} justify="between" align={{ sm: 'center' }} gap="3">
            <Flex align="center" gap="2">
              <Zap size={20} className="text-[var(--accent-11)]" />
              <Text size="5" weight="bold">Connection Status</Text>
            </Flex>

            {/* POST /api/import/test-sync is the organization admins'. */}
            {canManage && (
              <Button
                onClick={handleTestSync}
                loading={testingConnection}
                disabled={statusLoading}
                size="3"
              >
                <CheckCircle size={16} />
                Test Connection
              </Button>
            )}
          </Flex>

          {statusLoading ? (
            <Flex direction="column" align="center" py="4" gap="2">
              <NuggetSpinner size={32} />
              <Text color="gray">Checking connection status...</Text>
            </Flex>
          ) : (
            <>
              <Grid columns={{ initial: '1', md: '3' }} gap="4">
                <Flex align="center" gap="3">
                  <Box
                    width="12px"
                    height="12px"
                    className={`rounded-full ${status?.configured ? 'bg-[var(--green-9)]' : 'bg-[var(--red-9)]'}`}
                  />
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Configuration</Text>
                    <Text size="2" color="gray">
                      {status?.configured ? 'Access URL configured' : 'Access URL missing'}
                    </Text>
                  </Flex>
                </Flex>

                <Flex align="center" gap="3">
                  <Box
                    width="12px"
                    height="12px"
                    className={`rounded-full ${status?.connected ? 'bg-[var(--green-9)]' : 'bg-[var(--red-9)]'}`}
                  />
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Connection</Text>
                    <Text size="2" color="gray">
                      {status?.connected ? 'Connected to SimpleFin' : 'Connection failed'}
                    </Text>
                  </Flex>
                </Flex>

                <Flex align="center" gap="3">
                  <Box
                    width="12px"
                    height="12px"
                    className={`rounded-full ${
                      schedulerStalled
                        ? 'bg-[var(--red-9)]'
                        : status?.scheduler?.running ? 'bg-[var(--green-9)]' : 'bg-[var(--gray-8)]'
                    }`}
                  />
                  <Flex direction="column" gap="1">
                    <Text weight="medium">Scheduler</Text>
                    <Text size="2" color="gray">
                      {status?.scheduler?.running
                        ? 'Running'
                        : status?.scheduler?.enabled ? 'Not scheduled' : 'Stopped'}
                    </Text>
                  </Flex>
                </Flex>
              </Grid>

              {/* Enabled but nothing armed means no import will ever run, and
                  nothing is logged when it silently doesn't. Say so. */}
              {schedulerStalled && (
                <Callout.Root color="red">
                  <Callout.Icon>
                    <AlertCircle size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    Automatic import is on for this Ledger, but the import scheduler isn&apos;t running, so
                    nothing will import.
                    {canManage
                      ? ' Toggle it off and back on to start the scheduler.'
                      : ' An organization admin can turn it off and back on to start the scheduler.'}
                  </Callout.Text>
                </Callout.Root>
              )}

              {status?.scheduler?.nextSyncTime && (
                <Callout.Root>
                  <Callout.Icon>
                    <Clock size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    Next automatic sync: {new Date(status.scheduler.nextSyncTime).toLocaleString()}
                  </Callout.Text>
                </Callout.Root>
              )}

              {status?.scheduler?.lastAutomaticSync && (
                <Callout.Root>
                  <Callout.Icon>
                    <HistoryIcon size={16} />
                  </Callout.Icon>
                  <Callout.Text>
                    Last automatic sync: {new Date(status.scheduler.lastAutomaticSync).toLocaleString()}
                  </Callout.Text>
                </Callout.Root>
              )}
            </>
          )}
        </Flex>
      </Card>

      {/* Settings Form: this Ledger's own schedule and import settings, which the
          organization's admins set. */}
      {canManage && (
      <Card mb="6">
        <Flex direction="column" gap="6">
          <Flex align="center" gap="2">
            <Settings size={20} className="text-[var(--accent-11)]" />
            <Text size="5" weight="bold">Import Configuration</Text>
          </Flex>

          {settings && (
            <Flex direction="column" gap="6">
              {/* Enable Import */}
              <Flex justify="between" align="center">
                <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%">
                  <Text weight="medium">Enable Automatic Import</Text>
                  <Text size="2" color="gray">
                    {settings.import_enabled?.description}
                  </Text>
                </Flex>
                {schedulerActionLoading ? (
                  <NuggetSpinner size={24} />
                ) : (
                  <Switch
                    size="3"
                    color="green"
                    checked={settings.import_enabled?.value === 'true'}
                    onCheckedChange={handleToggleAutomaticImport}
                    disabled={schedulerActionLoading}
                    aria-label="Enable automatic import"
                  />
                )}
              </Flex>

              {/* Sync Time */}
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="import-sync-time" size="2" weight="medium">Sync Time (24-hour format)</Text>
                <TextField.Root
                  id="import-sync-time"
                  type="time"
                  value={settings.import_sync_time?.value || '02:00'}
                  onChange={(e) => handleSettingChange('import_sync_time', e.target.value)}
                  size="3"
                />
                <Text size="1" color="gray">
                  {settings.import_sync_time?.description}
                </Text>
              </Flex>

              {/* Sync Frequency */}
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="import-sync-frequency" size="2" weight="medium">Sync Frequency</Text>
                <Select.Root
                  value={settings.import_sync_frequency?.value || 'daily'}
                  onValueChange={(value) => handleSettingChange('import_sync_frequency', value)}
                  size="3"
                >
                  <Select.Trigger id="import-sync-frequency" />
                  <Select.Content>
                    <Select.Item value="daily">Daily</Select.Item>
                    <Select.Item value="weekly">Weekly</Select.Item>
                  </Select.Content>
                </Select.Root>
                <Text size="1" color="gray">
                  {settings.import_sync_frequency?.description}
                </Text>
              </Flex>

              {/* Import History Days */}
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="import-history-days" size="2" weight="medium">Import History (Days)</Text>
                <TextField.Root
                  id="import-history-days"
                  type="number"
                  min="1"
                  max="180"
                  value={settings.import_days_back?.value || ''}
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value === '' || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 180)) {
                      handleSettingChange('import_days_back', value);
                    }
                  }}
                  placeholder="60"
                  size="3"
                />
                <Text size="1" color="gray">
                  {settings.import_days_back?.description || 'Number of days of transaction history to import (e.g., 30 for last 30 days). Leave empty to import all available history.'}
                </Text>
                <Text size="1" color="gray">
                  Valid range: 1-180 days. Leave empty to import all the history the bank has.
                </Text>
              </Flex>

              {/* Manual Sync */}
              <Flex justify="between" align="center">
                <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%">
                  <Text weight="medium">Allow Manual Sync</Text>
                  <Text size="2" color="gray">
                    {settings.import_manual_sync_enabled?.description}
                  </Text>
                </Flex>
                <Switch
                  size="3"
                  color="green"
                  checked={settings.import_manual_sync_enabled?.value === 'true'}
                  onCheckedChange={() => handleSettingChange('import_manual_sync_enabled', settings.import_manual_sync_enabled?.value === 'true' ? 'false' : 'true')}
                  aria-label="Allow manual sync"
                />
              </Flex>

              {/* Import User */}
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="import-user" size="2" weight="medium">Import User</Text>
                <Select.Root
                  value={settings.import_user_id?.value || 'null'}
                  onValueChange={(value) => handleSettingChange('import_user_id', value === 'null' ? '' : value)}
                  size="3"
                >
                  <Select.Trigger id="import-user" placeholder="Select a user for import operations" />
                  <Select.Content>
                    <Select.Item value="null">Select a user for import operations</Select.Item>
                    {users.map(user => (
                      <Select.Item key={user.id} value={user.id.toString()}>
                        {personName(user, user.email)} ({user.email})
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <Text size="1" color="gray">
                  {settings.import_user_id?.description}
                </Text>
                {(!settings.import_user_id?.value || settings.import_user_id.value === '') && (
                  <Callout.Root highContrast color="amber" size="1">
                    <Callout.Icon>
                      <AlertCircle size={16} />
                    </Callout.Icon>
                    <Callout.Text>
                      Budget period auto-creation is disabled until an import user is selected
                    </Callout.Text>
                  </Callout.Root>
                )}
              </Flex>
            </Flex>
          )}

          <Flex justify="end" mt="4">
            <Button
              onClick={handleSaveSettings}
              loading={saving}
              size="3"
            >
              <CheckCircle size={16} />
              Save Settings
            </Button>
          </Flex>
        </Flex>
      </Card>
      )}

      {/* Manual Sync Card */}
      {settings?.import_manual_sync_enabled?.value === 'true' && (
        <Card mb="6">
          <Flex direction="column" gap="4">
            <Flex align="center" gap="2" wrap="wrap">
              <RefreshCw size={20} className="text-[var(--green-12)]" />
              <Text size="5" weight="bold">Manual Sync</Text>
              {statusLoading && (
                <Flex align="center" gap="1">
                  <RefreshCw size={12} className="animate-spin text-[var(--gray-11)]" />
                  <Text size="2" color="gray">Checking status...</Text>
                </Flex>
              )}
            </Flex>

            <Text color="gray">
              Manually sync all accounts and transactions from your bank. This will import new transactions and update account balances.
            </Text>

            <Flex direction={{ initial: 'column', sm: 'row' }} gap="3">
              <Button
                onClick={handleManualSync}
                loading={syncing}
                disabled={statusLoading || !status?.connected}
                size="3"
                color="green"
              >
                <Database size={16} />
                Sync Now
              </Button>

              <Button
                asChild
                variant="soft"
                color="gray"
                size="3"
              >
                <Link to="/import/sync-history">
                  <HistoryIcon size={16} />
                  View Sync History
                </Link>
              </Button>
            </Flex>
          </Flex>
        </Card>
      )}

      {/* SimpleFin Accounts Card: GET /api/import/simplefin-accounts is the organization admins'. */}
      {canManage && status?.connected && (
        <Card mb="6">
          <Flex direction="column" gap="4">
            <Flex align="center" gap="2">
              <Landmark size={20} className="text-[var(--accent-11)]" />
              <Text size="5" weight="bold">SimpleFin Accounts</Text>
            </Flex>

            <Text color="gray">
              View all accounts from SimpleFin, check connection status, and verify account mappings to Nuggets.
            </Text>

            <Flex direction={{ initial: 'column', sm: 'row' }} gap="3">
              <Button
                asChild
                size="3"
              >
                <Link to="/import/simplefin-accounts">
                  <Landmark size={16} />
                  View SimpleFin Accounts
                </Link>
              </Button>
            </Flex>
          </Flex>
        </Card>
      )}
    </PageContainer>
  );
};

export default ImportSettingsPage;
