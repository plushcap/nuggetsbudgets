import React, { useEffect, useState } from 'react';
import { Flex, Text, Button, TextField, Callout } from '@radix-ui/themes';
import { Settings } from 'lucide-react';
import toast from 'react-hot-toast';
import { getOneDriveConfig, saveOneDriveConfig } from '../services/api';
import { logger } from '../utils/logger';

interface OneDriveConfigFormProps {
  /** Called after a successful save so the parent can refresh OneDrive status. */
  onSaved?: () => void;
}

/**
 * Admin form for the OneDrive (Microsoft/Azure) app registration. The client id
 * and secret are stored encrypted in the DB (system_settings) via the backend;
 * the secret is write-only and never returned once saved. Replaces the old
 * "OneDrive is configured via environment variables" flow.
 */
const OneDriveConfigForm: React.FC<OneDriveConfigFormProps> = ({ onSaved }) => {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [secretSet, setSecretSet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const cfg = await getOneDriveConfig();
        if (!active) return;
        setClientId(cfg.clientId || '');
        setRedirectUri(cfg.redirectUri || `${window.location.origin}/api/onedrive/callback`);
        setSecretSet(cfg.clientSecretSet);
      } catch (error) {
        logger.error({ err: error }, 'Failed to load OneDrive config');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSave = async () => {
    if (!clientId.trim() || !redirectUri.trim()) {
      toast.error('Client ID and Redirect URI are required');
      return;
    }
    if (!secretSet && !clientSecret.trim()) {
      toast.error('Client Secret is required');
      return;
    }
    try {
      setSaving(true);
      await saveOneDriveConfig({
        clientId: clientId.trim(),
        redirectUri: redirectUri.trim(),
        clientSecret: clientSecret.trim() || undefined,
      });
      toast.success('OneDrive settings saved');
      setClientSecret('');
      setSecretSet(true);
      onSaved?.();
    } catch (error) {
      logger.error({ err: error }, 'Failed to save OneDrive config');
      toast.error('Failed to save OneDrive settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" gap="2">
        <Settings size={16} className="text-[var(--gray-11)]" />
        <Text size="3" weight="bold" color="gray" highContrast>
          OneDrive app registration
        </Text>
      </Flex>

      <Callout.Root color="gray">
        <Callout.Text>
          Enter your Microsoft (Azure) app registration so this server can connect to
          OneDrive. The client ID and secret are stored encrypted; the secret is never
          shown again after saving.
        </Callout.Text>
      </Callout.Root>

      <Flex direction="column" gap="1">
        <Text as="label" htmlFor="onedrive-client-id" size="2" color="gray">
          Client ID
        </Text>
        <TextField.Root
          id="onedrive-client-id"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder="00000000-0000-0000-0000-000000000000"
          disabled={loading || saving}
        />
      </Flex>

      <Flex direction="column" gap="1">
        <Text as="label" htmlFor="onedrive-client-secret" size="2" color="gray">
          Client Secret
        </Text>
        <TextField.Root
          id="onedrive-client-secret"
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={secretSet ? '•••••••• (configured — leave blank to keep)' : 'Client secret value'}
          disabled={loading || saving}
        />
      </Flex>

      <Flex direction="column" gap="1">
        <Text as="label" htmlFor="onedrive-redirect-uri" size="2" color="gray">
          Redirect URI
        </Text>
        <TextField.Root
          id="onedrive-redirect-uri"
          value={redirectUri}
          onChange={(e) => setRedirectUri(e.target.value)}
          placeholder="https://app.example.com/api/onedrive/callback"
          disabled={loading || saving}
        />
      </Flex>

      <Flex>
        <Button onClick={handleSave} disabled={loading || saving}>
          {saving ? 'Saving…' : 'Save OneDrive settings'}
        </Button>
      </Flex>
    </Flex>
  );
};

export default OneDriveConfigForm;
