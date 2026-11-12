import React, { useState } from 'react';
import { AlertTriangle, Fingerprint, ShieldCheck } from 'lucide-react';
import { Button, Callout, Dialog, Flex, Separator, Text, TextField } from '@radix-ui/themes';
import {
  isPasskeySupported,
  reauthenticateWithPassword,
  reauthenticateWithPasskey,
} from '../services/api';
import { useUserPasskeysQuery } from '../hooks/queries';
import type { ReauthDialogProps } from '../hooks/useReauth';
import { logger } from '../utils/logger';

/** The server's own wording for a refused confirmation, else the error's message. */
function messageOf(err: unknown, fallback: string): string {
  const data = (err as { response?: { data?: { error?: unknown } } } | null)?.response?.data;
  if (typeof data?.error === 'string' && data.error) return data.error;
  if (err instanceof Error && err.name === 'NotAllowedError') return 'The passkey check was cancelled.';
  return err instanceof Error && err.message ? err.message : fallback;
}

/**
 * Asks the signed-in user to confirm their password (or one of their passkeys) before an
 * action the server only allows right after a confirmation. Driven by `useReauth`.
 */
const ReauthDialog: React.FC<ReauthDialogProps> = ({ open, onConfirmed, onCancel }) => {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const passkeySupported = isPasskeySupported();
  const passkeysQuery = useUserPasskeysQuery({
    enabled: open && passkeySupported,
    meta: { suppressErrorToast: true },
  });
  const canUsePasskey = passkeySupported && (passkeysQuery.data?.length ?? 0) > 0;

  // Closing clears the dialog (adjusted while rendering, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setPassword('');
      setError(null);
      setBusy(false);
    }
  }

  const confirmWith = async (check: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await check();
      setPassword('');
      onConfirmed();
    } catch (err) {
      logger.warn({ err }, 'Re-authentication failed');
      setError(messageOf(err, fallback));
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    void confirmWith(() => reauthenticateWithPassword(password), 'That password could not be confirmed.');
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && !busy && onCancel()}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>
          <Flex align="center" gap="2">
            <ShieldCheck size={20} className="text-[var(--accent-11)]" aria-hidden />
            Confirm it’s you
          </Flex>
        </Dialog.Title>
        <Dialog.Description size="2" mb="4">
          For your security, confirm your password before continuing. You won’t be asked
          again for a few minutes.
        </Dialog.Description>

        <form onSubmit={submitPassword}>
          <Flex direction="column" gap="2">
            <Text as="label" size="2" weight="medium" htmlFor="reauth-password">
              Password
            </Text>
            <TextField.Root
              id="reauth-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Flex>

          {error && (
            <Callout.Root color="red" size="1" mt="3" role="alert">
              <Callout.Icon>
                <AlertTriangle size={16} />
              </Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          <Flex gap="3" mt="4" justify="end">
            <Button type="button" variant="soft" color="gray" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={!password || busy} loading={busy}>
              Confirm
            </Button>
          </Flex>
        </form>

        {canUsePasskey && (
          <>
            <Separator size="4" my="4" />
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">Or confirm with one of your passkeys.</Text>
              <Button
                type="button"
                variant="outline"
                onClick={() => void confirmWith(reauthenticateWithPasskey, 'The passkey check failed.')}
                disabled={busy}
              >
                <Fingerprint size={16} aria-hidden />
                Use passkey
              </Button>
            </Flex>
          </>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default ReauthDialog;
