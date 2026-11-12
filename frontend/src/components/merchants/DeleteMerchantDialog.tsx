import React from 'react';
import { Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { AlertTriangle, Trash2 } from 'lucide-react';
import type { Merchant } from '../../services/api';
import MerchantChoiceSelect from './MerchantChoiceSelect';

interface DeleteMerchantDialogProps {
  merchant: Merchant;
  /** The merchants it may be replaced with (the others on the page). */
  merchants: Merchant[];
  replacementMerchant: string | null;
  onReplacementChange: (uuid: string | null) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Asks before deleting a merchant, offering one to move what uses it to. */
const DeleteMerchantDialog: React.FC<DeleteMerchantDialogProps> = ({
  merchant,
  merchants,
  replacementMerchant,
  onReplacementChange,
  onConfirm,
  onCancel,
}) => (
  <Dialog.Root open={true} onOpenChange={(open) => !open && onCancel()}>
    <Dialog.Content maxWidth="500px">
      <Dialog.Title>
        <Flex align="center" gap="2">
          <AlertTriangle size={20} className="text-[var(--red-11)]" />
          Delete Merchant
        </Flex>
      </Dialog.Title>

      <Dialog.Description size="2" mb="4" color="gray">
        <Flex direction="column" gap="3">
          <Text>
            Are you sure you want to delete <strong>{merchant.name}</strong>? This action cannot be undone.
          </Text>
          {merchants.length > 0 && (
            <Text size="2" color="orange" highContrast>
              ⚠️ If this merchant is used in transactions or budget items, you should select a replacement merchant below.
            </Text>
          )}
        </Flex>
      </Dialog.Description>

      <Flex direction="column" gap="4">
        {merchants.length > 0 && (
          <Flex direction="column" gap="2">
            <MerchantChoiceSelect
              id="replacement-merchant"
              label="Replace with (optional):"
              value={replacementMerchant}
              onChange={onReplacementChange}
              merchants={merchants}
              placeholder="Select replacement merchant..."
              noneLabel="-- No replacement --"
            />
            <Text size="1" color="gray">
              Transactions and budget items will be reassigned to this merchant.
            </Text>
          </Flex>
        )}

        <Flex gap="3" justify="end">
          <Dialog.Close>
            <Button variant="soft" color="gray" size="3">
              Cancel
            </Button>
          </Dialog.Close>
          <Button onClick={onConfirm} color="red" size="3">
            <Trash2 size={16} />
            Delete Merchant
          </Button>
        </Flex>
      </Flex>
    </Dialog.Content>
  </Dialog.Root>
);

export default DeleteMerchantDialog;
