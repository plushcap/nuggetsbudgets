import React from 'react';
import { toast } from 'react-hot-toast';
import { Badge, Box, Card, Flex, IconButton, Text } from '@radix-ui/themes';
import { Mail, XCircle } from 'lucide-react';
import type { InvitationDto } from '@nuggets/shared';
import { useOrgInvitationsQuery, useRevokeOrgInvitationMutation } from '../hooks/queries/organizations';
import { useConfirmation } from '../hooks/useConfirmation';
import ConfirmationDialog from './ConfirmationDialog';

const formatDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

const inviterName = (i: InvitationDto) =>
  i.invitedBy ? [i.invitedBy.firstName, i.invitedBy.lastName].filter(Boolean).join(' ') : null;

/**
 * An organization's invitations that haven't been accepted or revoked,
 * with a way to withdraw each. Expired ones stay listed until revoked or
 * replaced by inviting the address again.
 */
const PendingInvitations: React.FC<{ orgUuid: string }> = ({ orgUuid }) => {
  const { data: invitations = [], isLoading } = useOrgInvitationsQuery(orgUuid);
  const revoke = useRevokeOrgInvitationMutation();
  const { confirmAsync, dialogProps } = useConfirmation();

  const handleRevoke = async (invitation: InvitationDto) => {
    const confirmed = await confirmAsync({
      title: 'Withdraw invitation',
      message: `The link sent to ${invitation.email} will stop working.`,
      variant: 'danger',
      confirmText: 'Withdraw',
      cancelText: 'Cancel',
    });
    if (!confirmed) return;
    try {
      await revoke.mutateAsync({ uuid: orgUuid, invitationUuid: invitation.uuid });
      toast.success('Invitation withdrawn');
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Couldn’t withdraw the invitation');
    }
  };

  return (
    <Box>
      <Card>
        {isLoading ? (
          <Flex justify="center" py="4">
            <Text size="2" color="gray">Loading invitations…</Text>
          </Flex>
        ) : invitations.length === 0 ? (
          <Flex justify="center" py="4">
            <Text size="2" color="gray">No open invitations.</Text>
          </Flex>
        ) : (
          <Flex direction="column" gap="3">
            {invitations.map((invitation) => {
              const by = inviterName(invitation);
              return (
                <Flex key={invitation.uuid} align="center" justify="between" gap="3">
                  <Flex align="center" gap="2" minWidth="0">
                    <Mail size={16} className="text-[var(--gray-11)]" aria-hidden="true" />
                    <Box minWidth="0">
                      <Text as="div" size="2" weight="medium" truncate>{invitation.email}</Text>
                      <Text as="div" size="1" color="gray">
                        {invitation.status === 'expired'
                          ? `Expired ${formatDate(invitation.expiresAt)}`
                          : `Expires ${formatDate(invitation.expiresAt)}`}
                        {by ? ` · invited by ${by}` : ''}
                      </Text>
                    </Box>
                  </Flex>
                  <Flex align="center" gap="2">
                    {invitation.isAdmin && <Badge color="iris" variant="soft" radius="full">Admin</Badge>}
                    {invitation.status === 'expired' && <Badge highContrast color="amber" variant="soft" radius="full">Expired</Badge>}
                    <IconButton
                      color="red"
                      variant="ghost"
                      onClick={() => handleRevoke(invitation)}
                      aria-label={`Withdraw the invitation to ${invitation.email}`}
                    >
                      <XCircle size={16} />
                    </IconButton>
                  </Flex>
                </Flex>
              );
            })}
          </Flex>
        )}
      </Card>
      <ConfirmationDialog {...dialogProps} />
    </Box>
  );
};

export default PendingInvitations;
