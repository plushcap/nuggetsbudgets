import React, { useEffect, useId } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import { Button, Callout, Dialog, Flex, Select, Text } from '@radix-ui/themes';
import FormSelectRoot from '../forms/FormSelectRoot';
import { useBudgetItemUsageQuery, useUpdateBudgetItemMutation } from '../../hooks/queries';
import { formatCurrency } from '../../utils/currency';
import CurrencyInput from '../CurrencyInput';
import { amountRangeProblem, nullableAmountInput } from '../forms/optionalAmount';
import RadixDatePicker from '../RadixDatePicker';
import FieldError, { fieldErrorProps, fieldErrorDescribedBy } from '../forms/FieldError';
import { RolloverLockedNote } from '../budget/RolloverLockedNote';

interface ConvertValues {
  amount: number | null;
  frequency: number;
  dueDate: string;
}

const frequencies = [
  [1, 'Monthly'],
  [2, 'Every 2 months'],
  [3, 'Quarterly (3 months)'],
  [6, 'Every 6 months'],
  [12, 'Yearly (12 months)'],
  [24, 'Every 2 years'],
] as const;

interface ConvertToBillDialogProps {
  open: boolean;
  onClose: () => void;
  /** `rollover`: it's an envelope now, so it can only become a monthly bill once empty. */
  item: { uuid: string; name: string; rollover?: boolean };
  /** Start from what the item has: an envelope's target amount and date, a monthly item's budget. */
  defaults: { amount?: number | null; dueDate?: string | null; frequency?: number };
}

/**
 * Turn an expense, monthly or envelope, into a bill: give it an amount, how
 * often it's due and its next due date. It keeps its name and history; a bill
 * due less often than monthly saves up as an envelope (an envelope keeps its
 * balance, a monthly item starts with what's left this month). From then on
 * it's tracked on the Bills page and in the forecast.
 */
const ConvertToBillDialog: React.FC<ConvertToBillDialogProps> = ({ open, onClose, item, defaults }) => {
  const fieldId = useId();
  const update = useUpdateBudgetItemMutation();
  // Its usage: its balance, and whether its history fixes its rolling over.
  const usage = useBudgetItemUsageQuery(open ? item.uuid : null);
  const { control, handleSubmit, reset, formState: { errors } } = useForm<ConvertValues>({
    defaultValues: { amount: null, frequency: 12, dueDate: '' },
  });

  useEffect(() => {
    if (open) reset({ amount: defaults.amount || null, frequency: defaults.frequency ?? 12, dueDate: defaults.dueDate ?? '' });
  }, [open, defaults.amount, defaults.dueDate, defaults.frequency, reset]);

  // A monthly bill doesn't roll over, and only an empty envelope can stop rolling over.
  const balance = usage.data?.balance ?? 0;
  const frequency = useWatch({ control, name: 'frequency' });
  const holdsMoney = !!item.rollover && frequency === 1 && balance !== 0;
  // A monthly bill doesn't roll over and a less frequent one does: a change of that its history fixes.
  const rolloverLocked = usage.data?.history_before_current_period === true && (frequency > 1) !== !!item.rollover;
  const blocked = holdsMoney || rolloverLocked;

  const onSubmit = async ({ amount, frequency, dueDate }: ConvertValues) => {
    try {
      await update.mutateAsync({
        uuid: item.uuid,
        data: {
          isbill: true,
          recurring_payment: true,
          recurring_payment_amount: amount ?? 0,
          recurring_payment_frequency: frequency,
          recurring_next_payment_date: dueDate,
          subtype: 'Fixed',
          // Monthly bills are paid from the month's budget; anything less frequent saves up.
          type: frequency === 1 ? 'Monthly' : 'Envelope',
          rollover: frequency > 1,
          rollover_target_amount: amount ?? 0,
        },
      });
      toast.success(`${item.name} is now a bill`);
      onClose();
    } catch (error) {
      toast.error((error instanceof Error && error.message) || 'Couldn’t convert it to a bill');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Content maxWidth="480px">
        <Dialog.Title>Convert to a bill</Dialog.Title>
        <Dialog.Description size="2" mb="4">
          {item.name} keeps its transactions and budget history, and shows on the Bills page and in the forecast. Unsaved changes on this page aren’t kept.
        </Dialog.Description>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="3">
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor="convert-amount" size="2" weight="medium">Bill amount</Text>
              <Controller
                control={control}
                name="amount"
                rules={{ validate: (value) => (value != null && value > 0 ? (amountRangeProblem(value) ?? true) : 'Give the bill’s amount.') }}
                render={({ field }) => <CurrencyInput id="convert-amount" {...nullableAmountInput(field.value, field.onChange)} {...fieldErrorProps('convert-amount', errors.amount)} />}
              />
              <FieldError fieldId="convert-amount" message={errors.amount?.message} />
            </Flex>
            <Flex direction="column" gap="1">
              <Text as="label" htmlFor={`${fieldId}-frequency`} size="2" weight="medium" id="convert-frequency-label">How often it’s due</Text>
              <Controller
                control={control}
                name="frequency"
                render={({ field }) => (
                  <FormSelectRoot value={String(field.value)} onValueChange={(value) => field.onChange(Number(value))}>
                    <Select.Trigger id={`${fieldId}-frequency`} aria-labelledby="convert-frequency-label" />
                    <Select.Content>
                      {frequencies.map(([months, label]) => (
                        <Select.Item key={months} value={String(months)}>{label}</Select.Item>
                      ))}
                    </Select.Content>
                  </FormSelectRoot>
                )}
              />
            </Flex>
            <Flex direction="column" gap="1">
              <Text as="div" id={`${fieldId}-next-due`} size="2" weight="medium">Next due date</Text>
              <Controller
                control={control}
                name="dueDate"
                rules={{ required: 'Give its next due date.' }}
                render={({ field }) => (
                  <RadixDatePicker
                    aria-labelledby={`${fieldId}-next-due`}
                    aria-describedby={fieldErrorDescribedBy(`${fieldId}-due-date`, errors.dueDate)}
                    value={field.value}
                    onChange={(value) => field.onChange(value || '')}
                  />
                )}
              />
              <FieldError fieldId={`${fieldId}-due-date`} message={errors.dueDate?.message} />
            </Flex>
            {rolloverLocked && <RolloverLockedNote name={item.name} />}
            {holdsMoney && !rolloverLocked && (
              <Callout.Root highContrast color="amber">
                <Callout.Text>
                  It holds {formatCurrency(balance)}. A monthly bill doesn’t save up, so transfer that to another budget item from the Budget page first, or pick a longer frequency.
                </Callout.Text>
              </Callout.Root>
            )}
            <Flex justify="end" gap="2" mt="2">
              <Dialog.Close><Button type="button" variant="soft" color="gray">Cancel</Button></Dialog.Close>
              <Button type="submit" loading={update.isPending} disabled={blocked || usage.isLoading}>Convert</Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default ConvertToBillDialog;
