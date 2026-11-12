import React from 'react';
import { toast } from 'react-hot-toast';
import { Button, Callout, Dialog, Flex, RadioCards, Text } from '@radix-ui/themes';
import { useBudgetItemUsageQuery, useUpdateBudgetItemMutation } from '../../hooks/queries';
import { formatCurrency } from '../../utils/currency';
import { useSeededState } from '../../hooks/useSeededState';
import { RolloverLockedNote } from '../budget/RolloverLockedNote';

type Kind = 'Monthly' | 'Envelope';

interface ConvertToExpenseDialogProps {
  open: boolean;
  onClose: () => void;
  item: { uuid: string; name: string; rollover: boolean };
}

/**
 * Turn a bill back into an ordinary expense, monthly or an envelope. It keeps
 * its name, transactions and budget history; it leaves the Bills page and the
 * forecast, and its open due dates ahead are dropped.
 */
const ConvertToExpenseDialog: React.FC<ConvertToExpenseDialogProps> = ({ open, onClose, item }) => {
  const update = useUpdateBudgetItemMutation();
  const current: Kind = item.rollover ? 'Envelope' : 'Monthly';
  // Opening starts from the item's kind (adjusted while rendering, not in an effect).
  const [kind, setKind] = useSeededState<Kind>((chosen) => (open ? current : (chosen ?? current)), [open, current]);
  // Its usage: its balance, and whether its history fixes its rolling over.
  const usage = useBudgetItemUsageQuery(open ? item.uuid : null);

  // Only an empty envelope can become monthly; the server refuses it too.
  const balance = usage.data?.balance ?? 0;
  const holdsMoney = item.rollover && kind === 'Monthly' && balance !== 0;
  const rolloverLocked = usage.data?.history_before_current_period === true && (kind === 'Envelope') !== item.rollover;
  const blocked = holdsMoney || rolloverLocked;

  const convert = async () => {
    try {
      await update.mutateAsync({
        uuid: item.uuid,
        data: { isbill: false, recurring_payment: false, type: kind, rollover: kind === 'Envelope' },
      });
      toast.success(`${item.name} is now ${kind === 'Envelope' ? 'an envelope' : 'a monthly'} expense`);
      onClose();
    } catch (error) {
      toast.error((error instanceof Error && error.message) || 'Couldn’t convert it to an expense');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Convert to an expense</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          {item.name} keeps its transactions and budget history, and leaves the Bills page and the forecast. Its unpaid due dates ahead are dropped. Unsaved changes on this page aren’t kept.
        </Dialog.Description>
        <Flex direction="column" gap="3">
          <RadioCards.Root value={kind} onValueChange={(value) => setKind(value as Kind)} columns="1" aria-label="Kind of expense">
            <RadioCards.Item value="Monthly">
              <Flex direction="column">
                <Text weight="medium">Monthly</Text>
                <Text size="2" color="gray">Budgeted and spent within each month.</Text>
              </Flex>
            </RadioCards.Item>
            <RadioCards.Item value="Envelope">
              <Flex direction="column">
                <Text weight="medium">Envelope</Text>
                <Text size="2" color="gray">
                  Saves up across months{item.rollover ? '; it keeps its balance' : '; it starts with what’s left this month'}.
                </Text>
              </Flex>
            </RadioCards.Item>
          </RadioCards.Root>
          {rolloverLocked && <RolloverLockedNote name={item.name} />}
          {holdsMoney && !rolloverLocked && (
            <Callout.Root highContrast color="amber">
              <Callout.Text>
                It holds {formatCurrency(balance)}. Transfer that to another budget item from the Budget page first, or keep it an envelope.
              </Callout.Text>
            </Callout.Root>
          )}
          <Flex justify="end" gap="2" mt="2">
            <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
            <Button onClick={convert} loading={update.isPending} disabled={blocked || usage.isLoading}>Convert</Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default ConvertToExpenseDialog;
