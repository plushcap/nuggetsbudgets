import React from 'react';
import { Dialog, Flex } from '@radix-ui/themes';
import { ArrowLeftRight } from 'lucide-react';
import type { Account, BudgetPeriod } from '../../services/api';
import TransferForm, { type TransferFormData } from './TransferForm';

interface TransferModalProps {
  open: boolean;
  onClose: () => void;
  accounts: Account[];
  budgetPeriods: BudgetPeriod[];
  initialValues?: Partial<TransferFormData>;
  onSuccess?: () => void;
}

/**
 * Dialog wrapper around TransferForm. Rendering the form only while `open`
 * (combined with Radix unmounting closed content) ensures it remounts with fresh
 * `initialValues` each time it's opened for a different account.
 */
const TransferModal: React.FC<TransferModalProps> = ({
  open,
  onClose,
  accounts,
  budgetPeriods,
  initialValues,
  onSuccess,
}) => {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth="500px" maxHeight="90vh">
        <Dialog.Title>
          <Flex align="center" gap="2">
            <ArrowLeftRight size={20} />
            Transfer Money
          </Flex>
        </Dialog.Title>
        <Dialog.Description size="2" mb="4">
          Move money between accounts without leaving this page.
        </Dialog.Description>

        {open && (
          <TransferForm
            accounts={accounts}
            budgetPeriods={budgetPeriods}
            initialValues={initialValues}
            onSuccess={() => {
              onSuccess?.();
              onClose();
            }}
            onCancel={onClose}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default TransferModal;
