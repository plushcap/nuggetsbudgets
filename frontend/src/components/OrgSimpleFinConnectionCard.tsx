import React, { useState, useId } from 'react';
import { Card, Flex, Box, Text, Button, TextField, Heading, Badge, Link } from '@radix-ui/themes';
import { Landmark, Link2, Link2Off } from 'lucide-react';
import toast from 'react-hot-toast';
import ConfirmationDialog from './ConfirmationDialog';
import { useConfirmation } from '../hooks/useConfirmation';
import {
  useOrgSimpleFinConnectionQuery,
  useSaveOrgSimpleFinConnectionMutation,
  useDeleteOrgSimpleFinConnectionMutation,
} from '../hooks/queries/organizations';
import type { SimpleFinConnectionStatus } from '@nuggets/shared';

const statusColor = (s: SimpleFinConnectionStatus): 'green' | 'amber' | 'red' =>
  s === 'active' ? 'green' : s === 'error' ? 'red' : 'amber';

/**
 * Org-admin management of the organization's single SimpleFin bank connection.
 * The paid connection is shared by accounts across all the org's
 * ledgers. The access credential never reaches the client — only status/metadata.
 */
const OrgSimpleFinConnectionCard: React.FC<{ orgUuid: string }> = ({ orgUuid }) => {
  const fieldId = useId();
  const confirmation = useConfirmation();
  const { data: connection, isLoading } = useOrgSimpleFinConnectionQuery(orgUuid);
  const save = useSaveOrgSimpleFinConnectionMutation();
  const remove = useDeleteOrgSimpleFinConnectionMutation();

  const [setupToken, setSetupToken] = useState('');

  const handleConnect = async () => {
    const token = setupToken.trim();
    if (!token) {
      toast.error('Paste a SimpleFin setup token');
      return;
    }
    try {
      await save.mutateAsync({ uuid: orgUuid, input: { setupToken: token } });
      toast.success('SimpleFin connection saved');
      setSetupToken('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save SimpleFin connection');
    }
  };

  const handleDisconnect = async () => {
    const confirmed = await confirmation.confirmAsync({
      title: 'Disconnect SimpleFin',
      message:
        'This removes the organization’s SimpleFin connection and unlinks every account mapped to it across all ledgers. You can reconnect later with a new setup token.',
      confirmText: 'Disconnect',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await remove.mutateAsync(orgUuid);
      toast.success('SimpleFin connection removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove SimpleFin connection');
    }
  };

  return (
    <>
      <Heading size="4" mb="3">Bank connection (SimpleFin)</Heading>
      <Card mb="6">
        <Flex direction="column" gap="3">
          <Flex align="center" justify="between">
            <Flex align="center" gap="2">
              <Landmark size={16} className="text-[var(--accent-11)]" />
              <Text size="2" weight="medium">Organization-wide connection</Text>
            </Flex>
            {connection && (
              <Badge color={statusColor(connection.status)} variant="soft" radius="full">
                {connection.status}
              </Badge>
            )}
          </Flex>

          <Text size="2" color="gray">
            One paid SimpleFin connection is shared by accounts across all of this organization&apos;s
            ledgers. Map each ledger&apos;s accounts to it from that ledger&apos;s bank-import settings.
          </Text>

          {isLoading ? (
            <Text size="2" color="gray">Loading connection…</Text>
          ) : connection ? (
            <Box>
              <Flex direction="column" gap="1" mb="3">
                <Text size="2" color="gray">
                  {connection.mappedAccountCount} account{connection.mappedAccountCount === 1 ? '' : 's'} mapped
                  across the organization&apos;s ledgers
                </Text>
                <Text size="2" color="gray">
                  Last synced:{' '}
                  {connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleString() : 'never'}
                </Text>
              </Flex>
              <Button color="red" variant="soft" onClick={handleDisconnect} disabled={remove.isPending}>
                <Link2Off size={16} />
                Disconnect
              </Button>
            </Box>
          ) : (
            <Box>
              <Text as="label" htmlFor={`${fieldId}-setup-token`} size="2" weight="medium" mb="1" style={{ display: 'block' }}>
                SimpleFin setup token
              </Text>
              <Flex direction={{ initial: 'column', sm: 'row' }} gap="3" align={{ sm: 'center' }}>
                <Box flexGrow="1">
                  <TextField.Root
                    id={`${fieldId}-setup-token`}
                    size="3"
                    placeholder="Paste the setup token from your SimpleFin app"
                    value={setupToken}
                    onChange={(e) => setSetupToken(e.target.value)}
                  />
                </Box>
                <Button size="3" onClick={handleConnect} disabled={save.isPending || !setupToken.trim()}>
                  <Link2 size={16} />
                  Connect
                </Button>
              </Flex>
              <Text as="div" size="1" color="gray" mt="2">
                Get a setup token from{' '}
                <Link href="https://bridge.simplefin.org" target="_blank" rel="noreferrer">
                  bridge.simplefin.org
                </Link>
                . It&apos;s exchanged server-side and stored encrypted — the token and access URL never leave the server.
              </Text>
            </Box>
          )}
        </Flex>
      </Card>
      <ConfirmationDialog {...confirmation.dialogProps} />
    </>
  );
};

export default OrgSimpleFinConnectionCard;
