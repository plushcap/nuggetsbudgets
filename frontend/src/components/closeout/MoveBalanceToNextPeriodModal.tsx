import React from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { Dialog, Flex, Text, Button, Callout } from '@radix-ui/themes';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import CurrencyInput from '../CurrencyInput';
import { nullableAmountInput, refuseAmountPastColumn } from '../forms/optionalAmount';
import FieldError, { fieldErrorProps } from '../forms/FieldError';
import { moveBalanceToNextPeriod } from '../../services/api/closeout';
import { logger } from '../../utils/logger';
import { invalidateTransactionData } from '../../hooks/queries/invalidation';
import { useFormReset } from '../../hooks/useFormReset';
import { toCents } from '../../utils/currency';

const FIELD_ID = 'move-balance-amount';

/**
 * An amount to move: at least a cent, either way, counted in whole cents. As a float
 * test, `Math.abs(amount) >= 0.01`, a cent worked out as 8.03 - 8.02 (0.009999999999999787)
 * was refused as less than one.
 */
export const moveBalanceSchema = z.object({
  // NaN is text the box can't read (nullableAmountInput): refused as no amount is.
  amount: z
    .number({ error: 'Enter the amount to move (at least a cent).' })
    .nullable()
    .refine((amount) => amount !== null && toCents(amount) !== 0, 'Enter the amount to move (at least a cent).')
    .superRefine(refuseAmountPastColumn),
});
type MoveBalanceFormData = { amount: number | null };

interface MoveBalanceToNextPeriodModalProps {
  open: boolean;
  onClose: () => void;
  accountUuid: string;
  accountName: string;
  /** This account's balance for the source period (the default amount to move). */
  periodBalance: number;
  sourcePeriodUuid: string;
  sourcePeriodName: string;
  /** Next period's name, or null if it hasn't been created yet. */
  nextPeriodName: string | null;
  onSuccess: () => void;
}

/**
 * "Move balance to next period" — moves this account's period balance forward to
 * the next period on the SAME account, so a month you paid late (or double-paid)
 * reconciles across both months. Amount defaults to the period balance and is editable
 * (react-hook-form, moveBalanceSchema).
 */
const MoveBalanceToNextPeriodModal: React.FC<MoveBalanceToNextPeriodModalProps> = ({
  open,
  onClose,
  accountUuid,
  accountName,
  periodBalance,
  sourcePeriodUuid,
  sourcePeriodName,
  nextPeriodName,
  onSuccess,
}) => {
  const queryClient = useQueryClient();
  // The amount starts from the period's balance whenever the modal is (re)opened for
  // an account/period, or the balance changes.
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting: submitting },
  } = useForm<MoveBalanceFormData>({
    defaultValues: { amount: periodBalance },
    resolver: zodResolver(moveBalanceSchema) as never,
    shouldFocusError: false,
  });
  useFormReset(reset, { amount: periodBalance }, [open, periodBalance]);

  const onConfirm = async ({ amount }: MoveBalanceFormData) => {
    if (!nextPeriodName || amount === null) return;
    try {
      const res = await moveBalanceToNextPeriod({
        accountUuid,
        sourcePeriodUuid,
        amount,
      });
      toast.success(`Moved balance to ${res.next_period_name ?? 'the next period'}.`);
      // The move posts transfer transactions in both periods.
      invalidateTransactionData(queryClient);
      onSuccess();
      onClose();
    } catch (error) {
      logger.error({ err: error }, 'Failed to move balance to next period');
      toast.error('Failed to move balance to the next period');
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Content maxWidth="460px">
        <Dialog.Title>Move balance to next period</Dialog.Title>
        <Dialog.Description size="2" mb="4" className="text-[var(--gray-11)]">
          Move <strong>{accountName}</strong>'s balance forward to the next period. This adds a
          matching pair of transfer entries on this account — one out of {sourcePeriodName} and one
          into the next period — so both months reconcile.
        </Dialog.Description>

        {!nextPeriodName ? (
          <Callout.Root highContrast color="amber">
            <Callout.Icon><AlertTriangle size={16} /></Callout.Icon>
            <Callout.Text>
              The next budget period doesn't exist yet. Create it first, then move the balance.
            </Callout.Text>
          </Callout.Root>
        ) : (
          <Flex direction="column" gap="3">
            <Flex align="center" gap="2" wrap="wrap">
              <Text size="2" weight="medium">{sourcePeriodName}</Text>
              <ArrowRight size={16} className="text-[var(--gray-11)]" />
              <Text size="2" weight="medium">{nextPeriodName}</Text>
            </Flex>

            <Flex direction="column" gap="1">
              <Text as="label" htmlFor={FIELD_ID} size="2" weight="medium" className="block">Amount to move</Text>
              <Controller
                control={control}
                name="amount"
                render={({ field }) => (
                  <CurrencyInput
                    id={FIELD_ID}
                    {...nullableAmountInput(field.value, field.onChange)}
                    onBlur={field.onBlur}
                    allowNegative
                    {...fieldErrorProps(FIELD_ID, errors.amount, `${FIELD_ID}-hint`)}
                  />
                )}
              />
              <FieldError fieldId={FIELD_ID} message={errors.amount?.message} />
            </Flex>

            <Text as="p" id={`${FIELD_ID}-hint`} size="1" className="text-[var(--gray-11)]">
              Defaulted to this account's {sourcePeriodName} balance. Adjust it if you only want to
              move part of it.
            </Text>
          </Flex>
        )}

        <Flex gap="3" mt="4" justify="end">
          <Button variant="soft" color="gray" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit(onConfirm, () => document.getElementById(FIELD_ID)?.focus())}
            disabled={!nextPeriodName || submitting}
            loading={submitting}
          >
            Move balance
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default MoveBalanceToNextPeriodModal;
