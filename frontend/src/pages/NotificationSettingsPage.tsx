import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { NOTIFICATION_SETTING_KEYS, notificationStatus, type NotificationSettingsMap } from '@nuggets/shared';
import {
  Mail, Bell, Send, Eye, Zap, CheckCircle, XCircle, RefreshCw, Clock, List, Trash2, Shield
} from 'lucide-react';
import { Card, Flex, Text, Button, TextField, Badge, Callout, Table, Tooltip, Grid, Box, ScrollArea } from '@radix-ui/themes';
import { logger } from '../utils/logger';
import { useAuth } from '../contexts/AuthContext';
import {
  useNotificationStatusQuery,
  useNotificationSettingsQuery,
  useNotificationHistoryQuery,
  useUpdateNotificationSettingsMutation,
  useNotificationSchedulerMutation,
  useClearNotificationHistoryMutation,
  useSendTestNotificationMutation,
} from '../hooks/queries';
import SettingsPageHeader from '../components/SettingsPageHeader';
import NuggetSpinner from '../components/NuggetSpinner';
import ConfirmationDialog from '../components/ConfirmationDialog';
import { useConfirmation } from '../hooks/useConfirmation';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';
import { EMPTY_LIST } from '../utils/emptyList';

/** The settings being edited: the server's, and any changed here that it didn't list (only a value). */
type NotificationSettings = Record<string, Partial<NotificationSettingsMap[string]> & { value: string | null }>;

const NotificationSettingsPage: React.FC = () => {
  // SMTP, the scheduler and the test email are deployment-wide: the API refuses
  // anyone but a deployment admin, so don't ask it for anyone else.
  const { isDeploymentAdmin, activeTenant } = useAuth();
  // The history is the active ledger's (/api/notifications/history): with none chosen, a
  // deployment admin still sets up email, and the page leaves the history out.
  const hasLedger = !!activeTenant;
  // Editable settings copy (seeded from the query below).
  // SMTP password is write-only: never fetched, only sent when the user types a new one.
  const [smtpPassword, setSmtpPassword] = useState('');
  const [testRecipient, setTestRecipient] = useState('');
  const [testTemplateType, setTestTemplateType] = useState<'transaction-review' | 'budget-overspending'>('transaction-review');
  const [historyPage, setHistoryPage] = useState(1);

  const statusQuery = useNotificationStatusQuery({ enabled: isDeploymentAdmin });
  const status = statusQuery.data ?? null;
  const statusLoading = statusQuery.isLoading;
  const settingsQuery = useNotificationSettingsQuery({ enabled: isDeploymentAdmin });
  // An editable copy of the saved settings, taken again each time they load.
  const [settings, setSettings] = useSeededState<NotificationSettings | null>(
    (current) => settingsQuery.data?.settings ?? current ?? null,
    [settingsQuery.data],
  );
  const settingsLoading = settingsQuery.isLoading;
  const historyQuery = useNotificationHistoryQuery(historyPage, { enabled: isDeploymentAdmin && hasLedger });
  const history = historyQuery.data?.notifications ?? EMPTY_LIST;
  const historyTotalPages = historyQuery.data?.pagination.totalPages ?? 1;
  const historyLoading = historyQuery.isLoading;

  const updateSettingsMutation = useUpdateNotificationSettingsMutation();
  const schedulerMutation = useNotificationSchedulerMutation();
  const clearHistoryMutation = useClearNotificationHistoryMutation();
  const sendTestMutation = useSendTestNotificationMutation();
  const saving = updateSettingsMutation.isPending;
  const schedulerActionLoading = schedulerMutation.isPending;
  const deletingHistory = clearHistoryMutation.isPending;
  const sendingTest = sendTestMutation.isPending;

  const { confirmAsync, dialogProps } = useConfirmation();

  const deleteHistory = async () => {
    const confirmed = await confirmAsync({
      title: 'Clear notification history',
      message: 'Are you sure you want to delete all notification history? This action cannot be undone.',
      variant: 'danger',
      confirmText: 'Clear All',
    });
    if (!confirmed) {
      return;
    }
    try {
      const data = await clearHistoryMutation.mutateAsync();
      toast.success(data.message || 'Notification history cleared successfully');
      setHistoryPage(1);
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete notification history');
      toast.error('Failed to delete notification history');
    }
  };

  const handleSaveSettings = async () => {
    if (!settings) return;

    try {
      // Only the editable keys that changed: the server rejects any other key (such as
      // the scheduler's last-run times), and an untouched value is left as stored.
      const saved = settingsQuery.data?.settings ?? {};
      const settingsToUpdate: Record<string, string> = {};
      for (const key of NOTIFICATION_SETTING_KEYS) {
        const value = settings[key]?.value;
        if (value !== undefined && value !== saved[key]?.value) settingsToUpdate[key] = value ?? '';
      }

      // Only send the SMTP password when the user actually entered a new one;
      // an empty field leaves the stored password untouched.
      if (smtpPassword.trim() !== '') {
        settingsToUpdate.notification_smtp_password = smtpPassword;
      }

      await updateSettingsMutation.mutateAsync(settingsToUpdate);
      setSmtpPassword('');
      toast.success('Settings saved successfully');
    } catch (error) {
      logger.error({ err: error }, 'Failed to save notification settings');
      toast.error(error instanceof Error ? error.message : 'Failed to save settings');
    }
  };

  const handleSchedulerAction = async (action: 'start' | 'stop' | 'restart') => {
    try {
      await schedulerMutation.mutateAsync(action);
      toast.success(`Notification scheduler ${action}ed successfully`);
    } catch (error) {
      logger.error({ err: error, action }, 'Failed to perform scheduler action');
      toast.error(`Failed to ${action} scheduler`);
    }
  };

  const handleSendTest = async () => {
    if (!testRecipient) {
      toast.error('Please enter a recipient email address');
      return;
    }

    try {
      await sendTestMutation.mutateAsync({ recipient: testRecipient, templateType: testTemplateType });
      toast.success(`Test email sent to ${testRecipient}`);
      setTestRecipient('');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      logger.error({ err: error }, 'Failed to send test email');
      toast.error(message || 'Failed to send test email');
    }
  };

  const handlePreviewTemplate = (templateType: string) => {
    // Session cookie will be sent automatically
    window.open(
      `/api/admin/notifications/preview/${encodeURIComponent(templateType)}`,
      '_blank'
    );
  };

  const handleUpdateSettingValue = (key: string, value: string) => {
    if (!settings) return;

    setSettings({
      ...settings,
      [key]: {
        ...settings[key],
        value
      }
    });
  };

  if (!isDeploymentAdmin) {
    return (
      <PageContainer width="form">
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Shield size={64} className="text-[var(--red-11)]" />
            <Flex direction="column" align="center" gap="2">
              <Text size="6" weight="bold">Access Denied</Text>
              <Text size="2" color="gray">You need deployment admin privileges to manage email notifications.</Text>
            </Flex>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  if (statusLoading || settingsLoading) {
    return (
      <PageContainer width="form">
        <Flex direction="column" align="center" justify="center" minHeight="400px" gap="4">
          <NuggetSpinner size={32} />
          <Text color="gray">Loading notification settings...</Text>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Email Notifications"
        subtitle="Configure email notifications and SMTP settings"
        icon={<Mail size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--blue-3)]"
        backPath="/settings"
      />

      {/* Scheduler Status */}
      <Card mb="5">
        <Flex direction="column" gap="6">
          <Flex align="center" gap="2">
            <Zap size={20} className="text-[var(--accent-11)]" />
            <Text size="5" weight="bold">Notification System Status</Text>
          </Flex>

          {status && (
            <Flex direction="column" gap="4">
              {/* System Status */}
              <Flex align="center" justify="between">
                <Text weight="medium">System Status:</Text>
                <Badge highContrast color={status.scheduler.running ? 'green' : 'gray'}>
                  {status.scheduler.running ? 'Running' : 'Stopped'}
                </Badge>
              </Flex>

              <Flex align="center" justify="between">
                <Text weight="medium">Configuration:</Text>
                <Badge highContrast color={status.configured ? 'blue' : 'orange'}>
                  {status.configured ? 'Configured' : 'Not Configured'}
                </Badge>
              </Flex>

              {/* Queue Statistics */}
              <Box pt="4" className="border-t border-[var(--gray-6)]">
                <Text size="3" weight="bold" mb="3" as="div">Queue Statistics</Text>
                <Grid columns={{ initial: '2', md: '4' }} gap="4">
                  <Box className="rounded-[var(--radius-4)] bg-[var(--gray-2)]" p="3" style={{ textAlign: 'center' }}>
                    <Text size="6" weight="bold" as="div" color="yellow" highContrast>{status.queue.pending}</Text>
                    <Text size="2" color="gray">Pending</Text>
                  </Box>
                  <Box className="rounded-[var(--radius-4)] bg-[var(--gray-2)]" p="3" style={{ textAlign: 'center' }}>
                    <Text size="6" weight="bold" as="div" className="text-[var(--accent-11)]">{status.queue.processing}</Text>
                    <Text size="2" color="gray">Processing</Text>
                  </Box>
                  <Box className="rounded-[var(--radius-4)] bg-[var(--gray-2)]" p="3" style={{ textAlign: 'center' }}>
                    <Text size="6" weight="bold" as="div" color="green" highContrast>{status.queue.sent}</Text>
                    <Text size="2" color="gray">Sent</Text>
                  </Box>
                  <Box className="rounded-[var(--radius-4)] bg-[var(--gray-2)]" p="3" style={{ textAlign: 'center' }}>
                    <Text size="6" weight="bold" as="div" color="red">{status.queue.failed}</Text>
                    <Text size="2" color="gray">Failed</Text>
                  </Box>
                </Grid>
              </Box>

              {/* Scheduler Controls */}
              <Flex gap="2" pt="4" className="border-t border-[var(--gray-6)]">
                <Button
                  onClick={() => handleSchedulerAction('start')}
                  disabled={status.scheduler.running || schedulerActionLoading}
                  variant="soft"
                  color="green"
                >
                  <CheckCircle size={16} />
                  Start
                </Button>
                <Button
                  onClick={() => handleSchedulerAction('stop')}
                  disabled={!status.scheduler.running || schedulerActionLoading}
                  variant="soft"
                  color="red"
                >
                  <XCircle size={16} />
                  Stop
                </Button>
                <Button
                  onClick={() => handleSchedulerAction('restart')}
                  disabled={schedulerActionLoading}
                  variant="soft"
                  color="blue"
                >
                  <RefreshCw size={16} />
                  Restart
                </Button>
              </Flex>
            </Flex>
          )}
        </Flex>
      </Card>

      {/* SMTP Configuration */}
      <Card mb="5">
        <Flex direction="column" gap="6">
          <Flex align="center" gap="2">
            <Mail size={20} className="text-[var(--accent-11)]" />
            <Text size="5" weight="bold">SMTP Configuration</Text>
          </Flex>

          {settings && (
            <Flex direction="column" gap="4">
              <Callout.Root color="blue" size="1">
                <Callout.Icon>
                  <Bell size={16} />
                </Callout.Icon>
                <Callout.Text>
                  Configure your SMTP server settings to enable email notifications. The SMTP password is encrypted at rest before it is stored, and is never shown again after you save it.
                </Callout.Text>
              </Callout.Root>

              <Flex direction="column" gap="4">
                <Box>
                  <Text as="label" htmlFor="notification-smtp-host" size="2" weight="bold" mb="2" className="block">SMTP Host</Text>
                  <TextField.Root
                    id="notification-smtp-host"
                    value={settings.notification_smtp_host?.value || ''}
                    onChange={(e) => handleUpdateSettingValue('notification_smtp_host', e.target.value)}
                    placeholder="smtp.example.com"
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    {settings.notification_smtp_host?.description}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" htmlFor="notification-smtp-port" size="2" weight="bold" mb="2" className="block">SMTP Port</Text>
                  <TextField.Root
                    id="notification-smtp-port"
                    type="number"
                    value={settings.notification_smtp_port?.value || ''}
                    onChange={(e) => handleUpdateSettingValue('notification_smtp_port', e.target.value)}
                    placeholder="587"
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    {settings.notification_smtp_port?.description}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" htmlFor="notification-smtp-username" size="2" weight="bold" mb="2" className="block">SMTP Username</Text>
                  <TextField.Root
                    id="notification-smtp-username"
                    value={settings.notification_smtp_username?.value || ''}
                    onChange={(e) => handleUpdateSettingValue('notification_smtp_username', e.target.value)}
                    placeholder="you@example.com"
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    {settings.notification_smtp_username?.description}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" htmlFor="notification-smtp-password" size="2" weight="bold" mb="2" className="block">SMTP Password</Text>
                  <TextField.Root
                    id="notification-smtp-password"
                    type="password"
                    value={smtpPassword}
                    onChange={(e) => setSmtpPassword(e.target.value)}
                    placeholder={settingsQuery.data?.passwordConfigured ? '•••••••• (leave blank to keep current)' : 'Enter SMTP password'}
                    autoComplete="new-password"
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    Encrypted before storage. Leave blank to keep the existing password.
                    {settingsQuery.data?.passwordConfigured ? ' A password is currently set.' : ' No password is set yet.'}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" htmlFor="notification-from-email-address" size="2" weight="bold" mb="2" className="block">From Email Address</Text>
                  <TextField.Root
                    id="notification-from-email-address"
                    type="email"
                    value={settings.notification_email_from_address?.value || ''}
                    onChange={(e) => handleUpdateSettingValue('notification_email_from_address', e.target.value)}
                    placeholder="notifications@yourdomain.com"
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    {settings.notification_email_from_address?.description}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" htmlFor="notification-from-name" size="2" weight="bold" mb="2" className="block">From Name</Text>
                  <TextField.Root
                    id="notification-from-name"
                    value={settings.notification_email_from_name?.value || ''}
                    onChange={(e) => handleUpdateSettingValue('notification_email_from_name', e.target.value)}
                    placeholder="Nuggets Financial Tracker"
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    {settings.notification_email_from_name?.description}
                  </Text>
                </Box>

                <Box>
                  <Text as="label" htmlFor="notification-logo-url-optional" size="2" weight="bold" mb="2" className="block">Logo URL (Optional)</Text>
                  <TextField.Root
                    id="notification-logo-url-optional"
                    value={settings.notification_logo_url?.value || ''}
                    onChange={(e) => handleUpdateSettingValue('notification_logo_url', e.target.value)}
                    placeholder="https://..."
                  />
                  <Text size="1" color="gray" mt="1" as="div">
                    {settings.notification_logo_url?.description}
                  </Text>
                </Box>
              </Flex>

              <Button
                onClick={handleSaveSettings}
                disabled={saving}
                loading={saving}
                style={{ alignSelf: 'flex-start' }}
              >
                Save Settings
              </Button>
            </Flex>
          )}
        </Flex>
      </Card>

      {/* Test Email */}
      <Card mb="5">
        <Flex direction="column" gap="6">
          <Flex align="center" gap="2">
            <Send size={20} className="text-[var(--accent-11)]" />
            <Text size="5" weight="bold">Send Test Email</Text>
          </Flex>

          <Flex direction="column" gap="4">
            <Box>
              <Text as="label" htmlFor="notification-recipient-email" size="2" weight="bold" mb="2" className="block">Recipient Email</Text>
              <TextField.Root
                id="notification-recipient-email"
                type="email"
                value={testRecipient}
                onChange={(e) => setTestRecipient(e.target.value)}
                placeholder="test@example.com"
              />
            </Box>

            <Box>
              <Text size="2" weight="bold" mb="2" as="div">Template Type</Text>
              <Flex gap="2">
                <Button
                  variant={testTemplateType === 'transaction-review' ? 'solid' : 'soft'}
                  onClick={() => setTestTemplateType('transaction-review')}
                  size="2"
                >
                  Transaction Review
                </Button>
                <Button
                  variant={testTemplateType === 'budget-overspending' ? 'solid' : 'soft'}
                  onClick={() => setTestTemplateType('budget-overspending')}
                  size="2"
                >
                  Budget Alert
                </Button>
              </Flex>
            </Box>

            <Flex gap="2">
              <Button
                onClick={handleSendTest}
                disabled={sendingTest || !testRecipient}
                loading={sendingTest}
              >
                <Send size={16} />
                Send Test Email
              </Button>
              <Button
                variant="soft"
                onClick={() => handlePreviewTemplate(testTemplateType)}
              >
                <Eye size={16} />
                Preview in Browser
              </Button>
            </Flex>
          </Flex>
        </Flex>
      </Card>

      {/* Notification History: the active ledger's */}
      {hasLedger && (
      <Card>
        <Flex direction="column" gap="6">
          <Flex align="center" justify="between">
            <Flex align="center" gap="2">
              <List size={20} className="text-[var(--accent-11)]" />
              <Text size="5" weight="bold">Recent Notifications</Text>
            </Flex>
            <Flex gap="2">
              <Button
                variant="soft"
                size="1"
                onClick={() => historyQuery.refetch()}
                disabled={historyLoading}
              >
                <RefreshCw size={12} />
                Refresh
              </Button>
              <Button
                variant="soft"
                color="red"
                size="1"
                onClick={deleteHistory}
                disabled={deletingHistory || historyLoading}
                loading={deletingHistory}
              >
                <Trash2 size={12} />
                Clear All
              </Button>
            </Flex>
          </Flex>

          {historyLoading ? (
            <Flex direction="column" align="center" py="6" gap="2">
              <NuggetSpinner size={24} />
              <Text color="gray">Loading history...</Text>
            </Flex>
          ) : history.length === 0 ? (
            <Flex direction="column" align="center" py="6" gap="2">
              <Clock size={32} className="text-[var(--gray-11)]" />
              <Text color="gray">No notifications sent yet</Text>
            </Flex>
          ) : (
            <>
              <ScrollArea scrollbars="horizontal">
                <Table.Root variant="surface">
                  <Table.Header>
                    <Table.Row>
                      <Table.ColumnHeaderCell>User</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Date</Table.ColumnHeaderCell>
                      <Table.ColumnHeaderCell>Retries</Table.ColumnHeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {history.map((item) => (
                      <Table.Row key={item.id}>
                        <Table.Cell>
                          <Flex direction="column">
                            <Text size="2" weight="medium" as="div">{item.user_name || item.user_email}</Text>
                            <Text size="1" color="gray">{item.user_email}</Text>
                          </Flex>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge variant="soft" color="blue">
                            {item.notification_type.replace('-', ' ')}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell>
                          <Badge highContrast
                            color={
                              item.status === notificationStatus.enum.sent ? 'green' :
                              item.status === notificationStatus.enum.failed ? 'red' :
                              item.status === notificationStatus.enum.processing ? 'blue' :
                              'gray'
                            }
                          >
                            {item.status}
                          </Badge>
                          {/* Why it hasn't gone: waiting for email to be set up, or why it failed. */}
                          {item.error_message && (item.status === notificationStatus.enum.pending || item.status === notificationStatus.enum.failed) && (
                            <Box maxWidth="280px" mt="1">
                              <Text as="p" size="1" color="gray">{item.error_message}</Text>
                            </Box>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <Tooltip content={new Date(item.created_at).toLocaleString()}>
                            <Text size="2" color="gray">
                              {new Date(item.created_at).toLocaleDateString()}
                            </Text>
                          </Tooltip>
                        </Table.Cell>
                        <Table.Cell>
                          <Text size="2">{item.retry_count}</Text>
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </ScrollArea>

              {/* Pagination */}
              {historyTotalPages > 1 && (
                <Flex align="center" justify="center" gap="2">
                  <Button
                    variant="soft"
                    size="1"
                    onClick={() => setHistoryPage(p => p - 1)}
                    disabled={historyPage === 1 || historyLoading}
                  >
                    Previous
                  </Button>
                  <Text size="2" color="gray">
                    Page {historyPage} of {historyTotalPages}
                  </Text>
                  <Button
                    variant="soft"
                    size="1"
                    onClick={() => setHistoryPage(p => p + 1)}
                    disabled={historyPage === historyTotalPages || historyLoading}
                  >
                    Next
                  </Button>
                </Flex>
              )}
            </>
          )}
        </Flex>
      </Card>
      )}

      <ConfirmationDialog {...dialogProps} />
    </PageContainer>
  );
};

export default NotificationSettingsPage;
