import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { Button, Callout, Card, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { KeyRound } from 'lucide-react';
import { describePasswordPolicy, passwordProblem } from '@nuggets/shared';
import NuggetsLogo from '../components/NuggetsLogo';
import { useAuth } from '../contexts/AuthContext';
import { usePasswordPolicy } from '../hooks/queries';
import { changePassword } from '../services/api';
import { errorMessage } from '../utils/errors';
import PageContainer from '../components/PageContainer';

/**
 * Shown instead of the app to someone whose password an admin set: a new account, or a
 * reset. The server refuses their session everything but changing it (403
 * PASSWORD_CHANGE_REQUIRED). Changing it signs them out everywhere, as it always does, so
 * they then sign in with the password only they know.
 */
const ChangePasswordRequiredPage: React.FC = () => {
  const { user, forgetSession, logout } = useAuth();
  const passwordPolicy = usePasswordPolicy();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    const problem = passwordProblem(newPassword, passwordPolicy, { email: user?.email ?? null });
    if (problem) {
      toast.error(problem);
      return;
    }
    if (newPassword === currentPassword) {
      toast.error('Choose a password different from your current one');
      return;
    }

    setSaving(true);
    try {
      await changePassword({ currentPassword, newPassword });
      // The server ended this session with the others: sign in with the new password.
      toast.success('Password changed. Sign in with your new password.');
      forgetSession();
    } catch (error) {
      toast.error(errorMessage(error, 'Could not change your password'));
      setSaving(false);
    }
  };

  return (
    <Flex align="center" justify="center" className="bg-[var(--gray-2)]" minHeight="100vh" py="9">
      <PageContainer width="auth">
        <Card size="4">
          <form onSubmit={handleSubmit}>
            <Flex direction="column" gap="5">
              <Flex direction="column" align="center" gap="3">
                <NuggetsLogo size={64} />
                <Heading size="6" align="center">
                  Choose a new password
                </Heading>
                <Text size="2" color="gray" align="center">
                  An administrator set the password you signed in with. Replace it with one only you know to
                  continue.
                </Text>
              </Flex>

              <Callout.Root color="gray" variant="surface">
                <Callout.Icon>
                  <KeyRound size={16} />
                </Callout.Icon>
                <Callout.Text>{describePasswordPolicy(passwordPolicy)}</Callout.Text>
              </Callout.Root>

              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="required-current-password">
                  Current password
                </Text>
                <TextField.Root
                  id="required-current-password"
                  type="password"
                  autoComplete="current-password"
                  size="3"
                  required
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={saving}
                />
              </Flex>

              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="required-new-password">
                  New password
                </Text>
                <TextField.Root
                  id="required-new-password"
                  type="password"
                  autoComplete="new-password"
                  size="3"
                  required
                  minLength={passwordPolicy.minLength}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={saving}
                />
              </Flex>

              <Flex direction="column" gap="2">
                <Text as="label" size="2" weight="medium" htmlFor="required-confirm-password">
                  Confirm new password
                </Text>
                <TextField.Root
                  id="required-confirm-password"
                  type="password"
                  autoComplete="new-password"
                  size="3"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={saving}
                />
              </Flex>

              <Flex direction="column" gap="3">
                <Button type="submit" size="3" loading={saving} disabled={saving}>
                  Change password
                </Button>
                <Button type="button" size="3" variant="soft" color="gray" onClick={() => void logout()} disabled={saving}>
                  Sign out
                </Button>
              </Flex>
            </Flex>
          </form>
        </Card>
      </PageContainer>
    </Flex>
  );
};

export default ChangePasswordRequiredPage;
