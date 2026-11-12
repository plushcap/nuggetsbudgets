import React, { useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, Flex, Text, Button, Box } from '@radix-ui/themes';
import toast from 'react-hot-toast';
import CurrencyInput from './CurrencyInput';
import { nullableAmountInput, refuseAmountPastColumn } from './forms/optionalAmount';
import FieldError, { fieldErrorProps } from './forms/FieldError';
import { useAdjustBalanceMutation } from '../hooks/queries';
import { textColorProps } from '../utils/textColor';
import { useFormReset } from '../hooks/useFormReset';
import { formatMoney } from '@nuggets/shared';

interface AdjustBalanceModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountUuid: string;
  accountName: string;
  /** The account's current (event-based) balance, in the same pre-signed convention. */
  /** null when the balance is unavailable; the server computes the delta either way. */
  currentBalance: number | null;
}

interface AdjustBalanceFormData {
  /** null until a balance is entered. */
  targetBalance: number | null;
}


const FIELD_ID = 'adjust-target-balance';

/** A new balance, entered, and (when the current one is known) different from it. */
export const adjustBalanceSchema = (currentBalance: number | null) =>
  z.object({
    // NaN is text the box can't read (nullableAmountInput): refused as no balance is.
    targetBalance: z
      .number({ error: 'Enter the balance the account should have.' })
      .nullable()
      .refine((target) => target !== null, 'Enter the balance the account should have.')
      .refine(
        (target) => target === null || currentBalance === null || Math.abs(target - currentBalance) >= 0.01,
        'That is the balance it has already.'
      )
      .superRefine(refuseAmountPastColumn),
  });

/**
 * Adjust an account's balance to a user-entered target. Shows the current balance
 * so the entered value is unambiguous for any account type, previews the delta,
 * and posts a single balance-adjustment transaction for the difference.
 *
 * react-hook-form with adjustBalanceSchema; the field starts empty each time the
 * dialog opens.
 */
const AdjustBalanceModal: React.FC<AdjustBalanceModalProps> = ({
  open,
  onOpenChange,
  accountUuid,
  accountName,
  currentBalance,
}) => {
  const adjust = useAdjustBalanceMutation();
  const schema = useMemo(() => adjustBalanceSchema(currentBalance), [currentBalance]);
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<AdjustBalanceFormData>({
    defaultValues: { targetBalance: null },
    resolver: zodResolver(schema) as never,
    shouldFocusError: false,
  });
  // The field starts empty each time the dialog opens.
  useFormReset(reset, { targetBalance: null }, [open]);
  const targetBalance = useWatch({ control, name: 'targetBalance' });

  const adjustment =
    targetBalance === null || Number.isNaN(targetBalance) || currentBalance === null
      ? null
      : Math.round((targetBalance - currentBalance) * 100) / 100;
  const noChange = adjustment !== null && Math.abs(adjustment) < 0.01;

  const onSubmit = async ({ targetBalance: target }: AdjustBalanceFormData) => {
    try {
      const result = await adjust.mutateAsync({ uuid: accountUuid, targetBalance: target as number });
      if (result.adjusted) {
        toast.success(`Balance adjusted to ${formatMoney(result.balance)}`);
      } else {
        toast(result.message ?? 'Balance already matches; no adjustment created.');
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not adjust balance');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="440px">
        <Dialog.Title>Adjust balance</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Enter the balance you want {accountName} to reflect. A single balance-adjustment
          transaction will be added for the difference.
        </Dialog.Description>

        <form onSubmit={handleSubmit(onSubmit, () => document.getElementById(FIELD_ID)?.focus())} noValidate>
          <Flex direction="column" gap="3">
            <Flex justify="between" align="center">
              <Text size="2" color="gray">Current balance</Text>
              <Text size="2" weight="medium" className="text-[var(--gray-12)]">{currentBalance === null ? 'Unavailable' : formatMoney(currentBalance)}</Text>
            </Flex>

            <Box>
              <Text as="label" size="2" weight="medium" htmlFor={FIELD_ID} className="text-[var(--gray-12)]">
                New balance
              </Text>
              <Box mt="1">
                <Controller
                  control={control}
                  name="targetBalance"
                  render={({ field }) => (
                    <CurrencyInput
                      id={FIELD_ID}
                      {...nullableAmountInput(field.value, field.onChange)}
                      onBlur={field.onBlur}
                      allowNegative
                      placeholder="0.00"
                      {...fieldErrorProps(FIELD_ID, errors.targetBalance)}
                    />
                  )}
                />
              </Box>
              <FieldError fieldId={FIELD_ID} message={errors.targetBalance?.message} />
            </Box>

            {adjustment !== null && (
              <Flex justify="between" align="center">
                <Text size="2" color="gray">Adjustment</Text>
                <Text size="2" weight="bold" {...textColorProps(noChange ? 'gray' : adjustment > 0 ? 'green' : 'red')}>
                  {noChange ? 'No change' : `${adjustment > 0 ? '+' : '-'}${formatMoney(Math.abs(adjustment))}`}
                </Text>
              </Flex>
            )}
          </Flex>

          <Flex gap="3" mt="4" justify="end">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray">Cancel</Button>
            </Dialog.Close>
            <Button type="submit" disabled={isSubmitting || adjust.isPending}>
              {adjust.isPending ? 'Adjusting…' : 'Adjust balance'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default AdjustBalanceModal;
