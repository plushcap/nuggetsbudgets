import React, { useState, useEffect, useId, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cloud, CloudOff, CheckCircle, Loader, ExternalLink, Settings } from 'lucide-react';
import { Card, Flex, Text, Button, Switch, Badge, Callout } from '@radix-ui/themes';
import toast from 'react-hot-toast';
import {
  startOneDriveAuth,
  disconnectOneDrive,
  updateOneDriveSettings,
  testOneDriveConnection,
} from '../services/api';
import { useOneDriveStatusQuery } from '../hooks/queries';
import { logger } from '../utils/logger';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from './ConfirmationDialog';
import OneDriveConfigForm from './OneDriveConfigForm';

const ONEDRIVE_FAILED = "OneDrive didn't connect. Check its settings and try again.";

interface OneDriveSyncProps {
  onUploadComplete?: () => void;
}

const OneDriveSync: React.FC<OneDriveSyncProps> = () => {
  const autoSyncId = useId();
  const { confirmAsync, dialogProps } = useConfirmation();
  const statusQuery = useOneDriveStatusQuery();
  const status = statusQuery.data ?? null;
  const loading = statusQuery.isLoading;
  const { refetch: refetchStatus } = statusQuery;
  const loadStatus = () => { void refetchStatus(); };
  const [actionLoading, setActionLoading] = useState(false);
  // Reveals the app-registration form after initial setup, so the encrypted
  // client id / secret / redirect URI can be edited (e.g. rotate the secret)
  // without first disconnecting — which only clears tokens, not the config.
  const [showConfig, setShowConfig] = useState(false);

  // The OAuth callback's result, when it came back in this page's URL. Its `message` is
  // never shown: anyone can craft a link with one, so the toast says something
  // fixed and the detail goes to the log. Only those two parameters leave the URL, through
  // the router, so its history state stays.
  const [searchParams, setSearchParams] = useSearchParams();
  const oneDriveResult = searchParams.get('onedrive');
  // StrictMode runs the effect twice before the URL changes: say it once.
  const handledResult = useRef<string | null>(null);
  useEffect(() => {
    if (oneDriveResult !== 'success' && oneDriveResult !== 'error') return;
    const key = searchParams.toString();
    if (handledResult.current === key) return;
    handledResult.current = key;
    if (oneDriveResult === 'success') {
      toast.success('OneDrive connected successfully!');
      void refetchStatus();
    } else {
      logger.warn({ detail: searchParams.get('message') }, 'OneDrive connection failed');
      toast.error(ONEDRIVE_FAILED);
    }
    const rest = new URLSearchParams(searchParams);
    rest.delete('onedrive');
    rest.delete('message');
    setSearchParams(rest, { replace: true });
  }, [oneDriveResult, searchParams, setSearchParams, refetchStatus]);

  // The sign-in popup's listener and poll, ended when the page goes too.
  const endPopupWatch = useRef<(() => void) | null>(null);
  useEffect(() => () => endPopupWatch.current?.(), []);

  const handleConnect = async () => {
    try {
      setActionLoading(true);
      const { authUrl } = await startOneDriveAuth();
      
      // Open OAuth flow in new window
      const width = 600;
      const height = 700;
      const left = (window.screen.width - width) / 2;
      const top = (window.screen.height - height) / 2;
      
      const authWindow = window.open(
        authUrl,
        'OneDrive Authorization',
        `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
      );

      if (!authWindow) {
        toast.error('Popup blocked. Please allow popups for this site.');
        setActionLoading(false);
        return;
      }

      let settled = false;

      endPopupWatch.current?.();
      function stopWatching() {
        window.removeEventListener('message', onMessage);
        clearInterval(pollTimer);
        endPopupWatch.current = null;
      }
      function cleanup() {
        stopWatching();
        setActionLoading(false);
      }

      // The callback popup posts its result back to this window, then closes
      // itself. Handle that here so the toast + status refresh happen on the
      // main page (not inside the popup).
      function onMessage(event: MessageEvent) {
        if (event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; status?: string; message?: string } | null;
        if (!data || data.type !== 'onedrive-auth') return;
        settled = true;
        try { authWindow!.close(); } catch { /* ignore */ }
        if (data.status === 'success') {
          toast.success('OneDrive connected successfully!');
          loadStatus();
        } else {
          logger.warn({ detail: data.message }, 'OneDrive connection failed');
          toast.error(ONEDRIVE_FAILED);
        }
        cleanup();
      }
      window.addEventListener('message', onMessage);

      // Backstop: if the popup is closed manually (or postMessage is blocked),
      // refresh status on close.
      const pollTimer = setInterval(() => {
        if (authWindow.closed) {
          cleanup();
          if (!settled) loadStatus();
        }
      }, 500);
      endPopupWatch.current = stopWatching;
    } catch (error) {
      logger.error({ err: error }, 'Failed to start OneDrive auth');
      toast.error('Failed to connect to OneDrive');
      setActionLoading(false);
    }
  };

  const handleDisconnect = async () => {
    const confirmed = await confirmAsync({
      title: 'Disconnect OneDrive',
      message: 'Are you sure you want to disconnect OneDrive? Automatic backup sync will be disabled. Your existing backups in OneDrive will not be deleted.',
      variant: 'warning',
      confirmText: 'Disconnect'
    });

    if (!confirmed) return;

    try {
      setActionLoading(true);
      await disconnectOneDrive();
      toast.success('OneDrive disconnected');
      await loadStatus();
    } catch (error) {
      logger.error({ err: error }, 'Failed to disconnect OneDrive');
      toast.error('Failed to disconnect OneDrive');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAutoSyncToggle = async (enabled: boolean) => {
    try {
      await updateOneDriveSettings(enabled);
      toast.success(enabled ? 'Auto-sync enabled' : 'Auto-sync disabled');
      await loadStatus();
    } catch (error) {
      logger.error({ err: error }, 'Failed to update auto-sync setting');
      toast.error('Failed to update setting');
    }
  };

  const handleTestConnection = async () => {
    try {
      setActionLoading(true);
      const result = await testOneDriveConnection();
      toast.success(result.message);
    } catch (error) {
      logger.error({ err: error }, 'Failed to test OneDrive connection');
      toast.error('Connection test failed');
    } finally {
      setActionLoading(false);
    }
  };

  if (loading) {
    return (
      <Card className="p-6">
        <Flex align="center" gap="2">
          <Loader size={20} className="animate-spin" />
          <Text>Loading OneDrive status...</Text>
        </Flex>
      </Card>
    );
  }

  // OneDrive app registration not configured yet — show the settings form so it
  // can be entered in-app (stored encrypted in the DB) rather than via env vars.
  if (!status?.configured) {
    return (
      <Card className="p-6">
        <Flex direction="column" gap="4">
          <Flex align="center" gap="2">
            <CloudOff size={24} className="text-[var(--gray-11)]" />
            <Text size="4" weight="bold" color="gray" highContrast>
              Cloud Storage Sync
            </Text>
          </Flex>
          <OneDriveConfigForm onSaved={loadStatus} />
        </Flex>
      </Card>
    );
  }

  // OneDrive configured but not connected
  if (!status?.connected) {
    return (
      <Card className="p-6">
        <Flex direction="column" gap="4">
          <Flex align="center" gap="2">
            <Cloud size={24} className="text-[var(--accent-11)]" />
            <Text size="4" weight="bold" color="gray" highContrast>
              Cloud Storage Sync
            </Text>
            <Badge color="gray">Not Connected</Badge>
          </Flex>

          <Text color="gray">
            Automatically sync your database backups to Microsoft OneDrive for secure off-site storage.
          </Text>

          <Callout.Root color="blue">
            <Callout.Text>
              <strong>What happens when you connect:</strong>
              <br />
              • All existing backups will be uploaded to OneDrive
              <br />
              • New backups will sync automatically
              <br />
              • Files stored in /Backups/Nuggets/ folder
            </Callout.Text>
          </Callout.Root>

          <Flex gap="3">
            <Button
              onClick={handleConnect}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <>
                  <Loader size={16} className="animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <ExternalLink size={16} />
                  Connect to OneDrive
                </>
              )}
            </Button>
            <Button variant="soft" color="gray" onClick={() => setShowConfig((v) => !v)}>
              <Settings size={16} />
              {showConfig ? 'Hide app registration' : 'Edit app registration'}
            </Button>
          </Flex>

          {showConfig && (
            <OneDriveConfigForm onSaved={() => { setShowConfig(false); loadStatus(); }} />
          )}
        </Flex>
        <ConfirmationDialog {...dialogProps} />
      </Card>
    );
  }

  // OneDrive connected
  return (
    <Card className="p-6">
      <Flex direction="column" gap="4">
        {/* Header */}
        <Flex align="center" justify="between">
          <Flex align="center" gap="2">
            <Cloud size={24} className="text-[var(--green-12)]" />
            <Text size="4" weight="bold" color="gray" highContrast>
              Cloud Storage Sync
            </Text>
            <Badge highContrast color="green">
              <CheckCircle size={12} />
              Connected
            </Badge>
          </Flex>
        </Flex>

        {/* Connection Info */}
        <Flex direction="column" gap="2">
          {status.email && (
            <Text size="2" color="gray">
              Account: <strong>{status.email}</strong>
            </Text>
          )}
          <Text size="2" color="gray">
            Folder: <strong>{status.folderPath}</strong>
          </Text>
        </Flex>

        {/* Auto-Sync Toggle */}
        <Flex
          align="center"
          justify="between"
          p="3"
          className="bg-[var(--gray-2)] border border-[var(--gray-4)] rounded-[var(--radius-4)]"
        >
          <Flex direction="column" gap="1">
            <Text id={`${autoSyncId}-label`} weight="medium" color="gray" highContrast>
              Automatic Backup Sync
            </Text>
            <Text id={`${autoSyncId}-hint`} size="2" color="gray">
              Upload new backups to OneDrive automatically
            </Text>
          </Flex>
          <Switch
            aria-labelledby={`${autoSyncId}-label`}
            aria-describedby={`${autoSyncId}-hint`}
            checked={status.autoSyncEnabled}
            onCheckedChange={handleAutoSyncToggle}
          />
        </Flex>

        {/* Actions */}
        <Flex gap="3" wrap="wrap">
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={actionLoading}
          >
            Test Connection
          </Button>
          <Button
            variant="outline"
            color="gray"
            onClick={() => setShowConfig((v) => !v)}
            disabled={actionLoading}
          >
            <Settings size={16} />
            {showConfig ? 'Hide app registration' : 'Edit app registration'}
          </Button>
          <Button
            variant="outline"
            color="red"
            onClick={handleDisconnect}
            disabled={actionLoading}
          >
            <CloudOff size={16} />
            Disconnect
          </Button>
        </Flex>

        {showConfig && (
          <OneDriveConfigForm onSaved={() => { setShowConfig(false); loadStatus(); }} />
        )}
      </Flex>
      <ConfirmationDialog {...dialogProps} />
    </Card>
  );
};

export default OneDriveSync;
