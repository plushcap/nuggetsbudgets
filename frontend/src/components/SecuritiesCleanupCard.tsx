import React from 'react';
import { Card, Flex, Text, Button, Badge } from '@radix-ui/themes';
import { Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import ConfirmationDialog from './ConfirmationDialog';
import { useConfirmation } from '../hooks/useConfirmation';
import { useUnusedPassThroughQuery, useDeleteUnusedPassThroughMutation } from '../hooks/queries/investments';
import { logger } from '../utils/logger';

/**
 * Bulk-remove pass-through (fund) securities in the current ledger that were
 * imported but are unused — not held in any position and not an underlying of
 * another fund. Held securities and individual positions are never affected.
 */
const SecuritiesCleanupCard: React.FC = () => {
  const confirmation = useConfirmation();
  const { data, isLoading } = useUnusedPassThroughQuery();
  const del = useDeleteUnusedPassThroughMutation();
  const count = data?.count ?? 0;

  const handleDelete = async () => {
    const confirmed = await confirmation.confirmAsync({
      title: 'Remove unused funds',
      message:
        `This permanently removes ${count} pass-through (fund) securit${count === 1 ? 'y' : 'ies'} in this ledger that ` +
        "aren't held in any position and aren't part of another fund, along with their prices and saved classifications. " +
        "This can't be undone.",
      confirmText: `Remove ${count}`,
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await del.mutateAsync();
      toast.success(`Removed ${res.deleted} unused fund${res.deleted === 1 ? '' : 's'}`);
    } catch (err) {
      logger.error({ err }, 'Failed to remove unused pass-through securities');
      toast.error('Failed to remove unused funds');
    }
  };

  return (
    <>
      <Card>
        <Flex direction="column" gap="3" p="2">
          <Text size="3" weight="bold">Clean up imported funds</Text>
          <Text size="2" color="gray">
            Bulk-remove pass-through (fund) securities in this ledger that were imported but aren&apos;t
            actually held in any position and aren&apos;t an underlying of another fund. Your positions and
            any held securities are never touched.
          </Text>
          {isLoading ? (
            <Text size="2" color="gray">Checking…</Text>
          ) : (
            <Flex align="center" justify="between" wrap="wrap" gap="3">
              <Flex align="center" gap="2" wrap="wrap">
                <Badge highContrast color={count > 0 ? 'amber' : 'green'} variant="soft" radius="full">{count} removable</Badge>
                {data?.samples?.length ? (
                  <Text size="1" color="gray">
                    e.g. {data.samples.slice(0, 8).map((s) => s.ticker).join(', ')}{count > 8 ? '…' : ''}
                  </Text>
                ) : null}
              </Flex>
              <Button color="red" variant="soft" disabled={count === 0 || del.isPending} loading={del.isPending} onClick={handleDelete}>
                <Trash2 size={16} /> Remove unused funds
              </Button>
            </Flex>
          )}
        </Flex>
      </Card>
      <ConfirmationDialog {...confirmation.dialogProps} />
    </>
  );
};

export default SecuritiesCleanupCard;
