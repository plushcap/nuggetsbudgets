import React, { useEffect, useMemo, useId } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { TRANSACTION_TYPE_LABELS, transferCreateSchema, type TransferCreateInput, formatMoney } from '@nuggets/shared';
import { Button, TextField, TextArea, Select, Flex, Text, Box, IconButton, Tooltip } from '@radix-ui/themes';
import FormSelectRoot from '../forms/FormSelectRoot';
import FieldError, { fieldErrorProps } from '../forms/FieldError';
import { Info } from 'lucide-react';
import toast from 'react-hot-toast';
import { logger } from '../../utils/logger';
import type { Account, BudgetPeriod } from '../../services/api';
import { useCreateTransferMutation } from '../../hooks/queries';
import { useConfirmation } from '../../hooks/useConfirmation';
import ConfirmationDialog from '../ConfirmationDialog';
import CurrencyInput from '../CurrencyInput';
import { nullableAmountInput, refuseAmountPastColumn } from '../forms/optionalAmount';
import { periodChoices } from '../../utils/budgetPeriods';
import { isCalendarDateInRange, todayLocal } from '../../utils/dateUtils';
import { apiErrorMessage } from '../../utils/errors';
import { focusFirstError } from '../../utils/focusFirstError';

export interface TransferFormData {
  source_account_id: number | null;
  destination_account_id: number | null;
  /** null until an amount is entered. */
  amount: number | null;
  transaction_date: string;
  type: TransferCreateInput['type'];
  description: string;
  budget_period_id: number | null;
}

/**
 * What a transfer needs: two different accounts, an amount above zero, a date and a
 * type (the type's values and the amount rule as POST /api/transfer checks them,
 * transferCreateSchema in @nuggets/shared).
 */
export const transferFormSchema = z
  .object({
    source_account_id: z.number().nullable().refine((id) => id !== null, 'Source account is required'),
    destination_account_id: z.number().nullable().refine((id) => id !== null, 'Destination account is required'),
    // NaN is text the box can't read (nullableAmountInput): refused as no amount is.
    amount: z.number({ error: 'Amount must be greater than zero' }).nullable().refine((amount) => amount !== null && amount > 0, 'Amount must be greater than zero').superRefine(refuseAmountPastColumn),
    transaction_date: z.string().min(1, 'Date is required'),
    type: transferCreateSchema.shape.type,
    description: z.string(),
    budget_period_id: z.number().nullable(),
  })
  .refine((data) => data.source_account_id === null || data.source_account_id !== data.destination_account_id, {
    path: ['destination_account_id'],
    message: 'Cannot transfer to the same account',
  });

interface TransferFormProps {
  accounts: Account[];
  budgetPeriods: BudgetPeriod[];
  /** Seed values (e.g. prefilled from a Close-Out card). Read once on mount. */
  initialValues?: Partial<TransferFormData> | undefined;
  onSuccess?: () => void;
  onCancel?: () => void;
}

const currentPeriodId = (budgetPeriods: BudgetPeriod[]): number | null => {
  const today = todayLocal();
  return budgetPeriods.find((period) => isCalendarDateInRange(today, period.start_date, period.end_date))?.id ?? null;
};

/**
 * Reusable transfer form: the field set, validation, confirmation, and submit
 * extracted from TransferMoneyPage so it can also be rendered prefilled inside a
 * modal (e.g. paying a credit card from Close-Out). The caller owns the queries,
 * page/modal chrome, and what happens onSuccess/onCancel.
 *
 * react-hook-form with transferFormSchema: a refused submit shows each field's
 * message under it, ties it to the field (aria-invalid, aria-describedby) and focuses
 * the first such field.
 */
const TransferForm: React.FC<TransferFormProps> = ({
  accounts: accountsProp,
  budgetPeriods,
  initialValues,
  onSuccess,
  onCancel,
}) => {
  const fieldId = useId();
  const ids = {
    from: `${fieldId}-from`,
    to: `${fieldId}-to`,
    amount: `${fieldId}-amount`,
    date: `${fieldId}-date`,
    period: `${fieldId}-budget-period`,
    type: `${fieldId}-type`,
    description: `${fieldId}-description`,
  };
  const { confirmAsync, dialogProps } = useConfirmation();
  const createTransferMutation = useCreateTransferMutation();

  // Sort accounts by custom_sort (nulls/undefined last), then by name.
  const accounts = useMemo(() => {
    return [...accountsProp].sort((a, b) => {
      const aSort = a.custom_sort ?? null;
      const bSort = b.custom_sort ?? null;
      if (aSort === null && bSort === null) return a.name.localeCompare(b.name);
      if (aSort === null) return 1;
      if (bSort === null) return -1;
      return aSort - bSort;
    });
  }, [accountsProp]);

  const {
    control,
    register,
    handleSubmit,
    getValues,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TransferFormData>({
    defaultValues: {
      source_account_id: null,
      destination_account_id: null,
      amount: null,
      transaction_date: todayLocal(),
      type: 'transfer',
      description: '',
      // The budget period that covers today, unless the caller chose one.
      budget_period_id: currentPeriodId(budgetPeriods),
      ...initialValues,
    },
    resolver: zodResolver(transferFormSchema) as never,
    shouldFocusError: false,
  });
  const sourceAccountId = useWatch({ control, name: 'source_account_id' });
  const submitting = isSubmitting || createTransferMutation.isPending;

  // Periods that arrive after the form mounts: pick today's, if none is chosen yet.
  useEffect(() => {
    const today = currentPeriodId(budgetPeriods);
    if (today !== null && getValues('budget_period_id') == null) setValue('budget_period_id', today);
  }, [budgetPeriods, getValues, setValue]);

  const onSubmit = async (formData: TransferFormData) => {
    const sourceAccount = accounts.find((a) => a.id === formData.source_account_id);
    const destAccount = accounts.find((a) => a.id === formData.destination_account_id);
    const amount = formData.amount as number;

    const confirmed = await confirmAsync({
      title: 'Confirm Transfer',
      message: `Transfer ${formatMoney(amount)} from ${sourceAccount?.name} to ${destAccount?.name}?`,
      variant: 'info',
      confirmText: 'Transfer',
    });
    if (!confirmed) return;

    try {
      // The mutation invalidates accounts, transactions, and budgets on success
      // (a transfer moves money between accounts and affects budget spend).
      await createTransferMutation.mutateAsync({ ...formData, amount });
      toast.success('Transfer created successfully');
      onSuccess?.();
    } catch (err) {
      logger.error({ err, formData }, 'Failed to create transfer');
      toast.error(apiErrorMessage(err, 'Failed to create transfer'));
    }
  };

  const onInvalid = (formErrors: typeof errors) => {
    toast.error('Please fix form errors');
    focusFirstError(formErrors, [
      ['source_account_id', `[id="${ids.from}"]`],
      ['destination_account_id', `[id="${ids.to}"]`],
      ['amount', `[id="${ids.amount}"]`],
      ['transaction_date', `[id="${ids.date}"]`],
    ]);
  };

  const activeAccounts = accounts.filter((acc) => !acc.hide_account && !acc.close_account);
  const destinationAccounts = activeAccounts.filter((acc) => acc.id !== sourceAccountId);
  const accountValue = (id: number | null) => id?.toString() || 'null';
  const toAccountId = (value: string) => (value && value !== 'null' ? parseInt(value) : null);

  return (
    <>
      <form onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
        <Flex direction="column" gap="4">
          {/* Source Account */}
          <Box>
            <Text as="label" htmlFor={ids.from} size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              From Account <Text color="red">*</Text>
            </Text>
            <Controller
              control={control}
              name="source_account_id"
              render={({ field }) => (
                <FormSelectRoot value={accountValue(field.value)} onValueChange={(value) => field.onChange(toAccountId(value))} size="3">
                  <Select.Trigger
                    id={ids.from}
                    placeholder="Select source account..."
                    color={errors.source_account_id ? 'red' : undefined}
                    {...fieldErrorProps(ids.from, errors.source_account_id)}
                  />
                  <Select.Content>
                    <Select.Item value="null">Select source account...</Select.Item>
                    {activeAccounts.map((account) => (
                      <Select.Item key={account.id} value={account.id.toString()}>
                        {account.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
            <FieldError fieldId={ids.from} message={errors.source_account_id?.message} />
          </Box>

          {/* Destination Account */}
          <Box>
            <Text as="label" htmlFor={ids.to} size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              To Account <Text color="red">*</Text>
            </Text>
            <Controller
              control={control}
              name="destination_account_id"
              render={({ field }) => (
                <FormSelectRoot
                  value={accountValue(field.value)}
                  onValueChange={(value) => field.onChange(toAccountId(value))}
                  size="3"
                  disabled={!sourceAccountId}
                >
                  <Select.Trigger
                    id={ids.to}
                    placeholder={sourceAccountId ? 'Select destination account...' : 'Select source account first...'}
                    color={errors.destination_account_id ? 'red' : undefined}
                    {...fieldErrorProps(ids.to, errors.destination_account_id)}
                  />
                  <Select.Content>
                    <Select.Item value="null">Select destination account...</Select.Item>
                    {destinationAccounts.map((account) => (
                      <Select.Item key={account.id} value={account.id.toString()}>
                        {account.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
            <FieldError fieldId={ids.to} message={errors.destination_account_id?.message} />
          </Box>

          {/* Amount */}
          <Box>
            <Text as="label" htmlFor={ids.amount} size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              Amount <Text color="red">*</Text>
            </Text>
            <Controller
              control={control}
              name="amount"
              render={({ field }) => (
                <CurrencyInput
                  id={ids.amount}
                  {...nullableAmountInput(field.value, field.onChange)}
                  onBlur={field.onBlur}
                  size="3"
                  color={errors.amount ? 'red' : undefined}
                  {...fieldErrorProps(ids.amount, errors.amount)}
                />
              )}
            />
            <FieldError fieldId={ids.amount} message={errors.amount?.message} />
          </Box>

          {/* Transaction Date */}
          <Box>
            <Text as="label" htmlFor={ids.date} size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              Date <Text color="red">*</Text>
            </Text>
            <TextField.Root
              id={ids.date}
              type="date"
              {...register('transaction_date')}
              {...fieldErrorProps(ids.date, errors.transaction_date)}
              size="3"
            />
            <FieldError fieldId={ids.date} message={errors.transaction_date?.message} />
          </Box>

          {/* Budget Period */}
          <Box>
            <Text as="label" htmlFor={ids.period} size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              Budget Period
            </Text>
            <Controller
              control={control}
              name="budget_period_id"
              render={({ field }) => (
                <FormSelectRoot value={field.value?.toString() || 'null'} onValueChange={(value) => field.onChange(toAccountId(value))} size="3">
                  <Select.Trigger id={ids.period} placeholder="No budget period" />
                  <Select.Content>
                    <Select.Item value="null">No budget period</Select.Item>
                    {periodChoices(budgetPeriods, field.value).map((period) => (
                      <Select.Item key={period.id} value={period.id.toString()}>
                        {period.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
          </Box>

          {/* Transaction Type */}
          <Box>
            <Flex align="center" gap="2" mb="2">
              <Text as="label" htmlFor={ids.type} size="2" weight="medium">
                Type <Text color="red">*</Text>
              </Text>
              <Tooltip content="Payment: Creates a merchant from the destination account name for tracking. Transfer: Generic transfer between accounts without merchant tracking.">
                <IconButton size="1" variant="ghost" type="button" aria-label="About the transfer types">
                  <Info size={12} />
                </IconButton>
              </Tooltip>
            </Flex>
            <Controller
              control={control}
              name="type"
              render={({ field }) => (
                <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                  <Select.Trigger id={ids.type} />
                  <Select.Content>
                    {transferCreateSchema.shape.type.options.map((t) => (
                      <Select.Item key={t} value={t}>{TRANSACTION_TYPE_LABELS[t]}</Select.Item>
                    ))}
                  </Select.Content>
                </FormSelectRoot>
              )}
            />
          </Box>

          {/* Description */}
          <Box>
            <Text as="label" htmlFor={ids.description} size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              Description
            </Text>
            <TextArea
              id={ids.description}
              {...register('description')}
              placeholder="Enter transaction description (optional)..."
              size="3"
              rows={3}
            />
          </Box>

          {/* Actions */}
          <Flex gap="3" justify="end" pt="4" className="border-t border-[var(--gray-6)]">
            <Button type="button" variant="soft" onClick={() => onCancel?.()} disabled={submitting} size="3">
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} size="3">
              {submitting ? 'Creating Transfer...' : 'Create Transfer'}
            </Button>
          </Flex>
        </Flex>
      </form>

      <ConfirmationDialog {...dialogProps} />
    </>
  );
};

export default TransferForm;
