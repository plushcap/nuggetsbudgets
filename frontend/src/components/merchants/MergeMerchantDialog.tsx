import React from 'react';
import { Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { Check, Merge, X } from 'lucide-react';
import type { Merchant } from '../../services/api';
import MerchantChoiceSelect from './MerchantChoiceSelect';

interface MergeMerchantDialogProps {
  sourceMerchant: Merchant;
  /** The merchants it may be merged into (the others on the page). */
  merchants: Merchant[];
  targetMerchant: string | null;
  onTargetChange: (uuid: string | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** One side of the merge picture: a marked tile, the merchant's name, and what happens to it. */
const MergeSide: React.FC<{ tile: string; icon: React.ReactNode; name: string; fate: React.ReactNode }> = ({
  tile,
  icon,
  name,
  fate,
}) => (
  <Flex align="center" gap="2">
    <Flex align="center" justify="center" width="32px" height="32px" className={`${tile} rounded-[var(--radius-2)]`}>
      {icon}
    </Flex>
    <Flex direction="column" flexGrow="1">
      <Text size="2" weight="bold" color="gray" highContrast>
        {name}
      </Text>
      {fate}
    </Flex>
  </Flex>
);

/** Asks before merging a merchant into another, which keeps its transactions, items and rules. */
const MergeMerchantDialog: React.FC<MergeMerchantDialogProps> = ({
  sourceMerchant,
  merchants,
  targetMerchant,
  onTargetChange,
  onConfirm,
  onCancel,
}) => {
  const targetName = (targetMerchant && merchants.find((m) => m.uuid === targetMerchant)?.name) || 'Select below...';
  return (
    <Dialog.Root open={true} onOpenChange={(open) => !open && onCancel()}>
      <Dialog.Content maxWidth="500px">
        <Dialog.Title>
          <Flex align="center" gap="2">
            <Merge size={20} className="text-[var(--orange-12)]" />
            Merge Merchants
          </Flex>
        </Dialog.Title>

        <Dialog.Description size="2" mb="4" color="gray">
          <Flex direction="column" gap="3">
            <Text>You are about to merge two merchants:</Text>

            {/* What goes where */}
            <Flex
              direction="column"
              gap="2"
              p="3"
              className="bg-[var(--gray-3)] border border-[var(--gray-4)] rounded-[var(--radius-3)]"
            >
              <MergeSide
                tile="bg-[var(--red-3)] border-2 border-[var(--red-7)]"
                icon={<X size={16} className="text-[var(--red-11)]" />}
                name={sourceMerchant.name}
                fate={<Text size="1" color="red">Will be deleted (source)</Text>}
              />
              <Flex justify="center">
                <Text size="1" weight="bold" color="gray">
                  ↓ Merge into ↓
                </Text>
              </Flex>
              <MergeSide
                tile="bg-[var(--green-3)] border-2 border-[var(--green-7)]"
                icon={<Check size={16} className="text-[var(--green-12)]" />}
                name={targetName}
                fate={<Text size="1" color="green" highContrast>Will remain (target)</Text>}
              />
            </Flex>

            <Text size="2" color="gray">
              All transactions, budget items, and matching rules from <strong>{sourceMerchant.name}</strong> will be transferred to the target merchant, and <strong>{sourceMerchant.name}</strong> will be permanently deleted.
            </Text>
          </Flex>
        </Dialog.Description>

        <Flex direction="column" gap="4">
          <Flex direction="column" gap="2">
            <MerchantChoiceSelect
              id="merge-target-merchant"
              label="Select target merchant (will keep):"
              value={targetMerchant}
              onChange={onTargetChange}
              merchants={merchants}
              placeholder="Choose which merchant to keep..."
              noneLabel="-- Select target merchant --"
            />
          </Flex>

          <Flex gap="3" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray" size="3">
                Cancel
              </Button>
            </Dialog.Close>
            <Button onClick={onConfirm} disabled={!targetMerchant} color="orange" size="3">
              <Merge size={16} />
              Merge Merchants
            </Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default MergeMerchantDialog;
