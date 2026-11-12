import React, { useId, useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Dialog, Button, Flex, IconButton, Text, TextField, Tooltip } from '@radix-ui/themes';
import { ArrowRightLeft, RefreshCw } from 'lucide-react';
import { BudgetPeriodItem, transferBetweenBudgetItems } from '../services/api';
import { toast } from 'react-hot-toast';
import RadixBudgetItemSelector, { type BudgetItemChoice } from './RadixBudgetItemSelector';
import CurrencyInput from './CurrencyInput';
import { nullableAmountInput } from './forms/optionalAmount';
import FieldError, { fieldErrorProps, fieldErrorDescribedBy } from './forms/FieldError';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { focusFirstError } from '../utils/focusFirstError';
import { useFormReset } from '../hooks/useFormReset';
import { formatMoney, budgetExpenseType } from '@nuggets/shared';

interface BudgetTransferModalProps {
  isOpen: boolean;
  onClose: () => void;
  budgetPeriodItems: BudgetPeriodItem[];
  selectedItemId?: number; // Pre-selected budget period item
  /** The period's uuid, which the transfer route is named by. */
  periodUuid: string;
  onSuccess: () => void; // Callback after successful transfer
}

interface BudgetTransferFormData {
  fromId: number | null;
  toId: number | null;
  /** null until an amount is entered. */
  amount: number | null;
  description: string;
}

const remainingOf = (item: BudgetPeriodItem | undefined) => parseFloat(String(item?.calculated_remaining || 0));

/**
 * Two different budget items, and an amount above zero that the source has left
 * (the money moved comes out of what it has).
 */
export const budgetTransferSchema = (items: BudgetPeriodItem[]) =>
  z
    .object({
      fromId: z.number().nullable().refine((id) => id !== null, 'Choose the budget item the money comes from.'),
      toId: z.number().nullable().refine((id) => id !== null, 'Choose the budget item the money goes to.'),
      // NaN is text the box can't read (nullableAmountInput): refused as no amount is.
      amount: z.number({ error: 'Enter an amount greater than zero.' }).nullable().refine((amount) => amount !== null && amount > 0, 'Enter an amount greater than zero.'),
      description: z.string(),
    })
    .superRefine((data, ctx) => {
      if (data.fromId !== null && data.fromId === data.toId) {
        ctx.addIssue({ code: 'custom', path: ['toId'], message: 'Choose a different budget item from the one the money comes from.' });
      }
      const from = items.find((item) => item.id === data.fromId);
      if (from && data.amount !== null && data.amount > remainingOf(from)) {
        ctx.addIssue({ code: 'custom', path: ['amount'], message: `Insufficient funds. Available: ${formatMoney(remainingOf(from))}` });
      }
    });

/**
 * Budget Transfer Modal
 *
 * Allows users to transfer money between budget items within a period.
 * Supports "cover overage" workflow for overspent categories.
 *
 * react-hook-form with budgetTransferSchema; the amount is a CurrencyInput (it was a
 * number box). Opening it on an item prefills the form (again if the item or the
 * items change while it is open), and closing it clears it.
 */
const BudgetTransferModal: React.FC<BudgetTransferModalProps> = ({
  isOpen,
  onClose,
  budgetPeriodItems,
  selectedItemId,
  periodUuid,
  onSuccess
}) => {
  const fieldId = useId();
  const ids = { from: `${fieldId}-from`, to: `${fieldId}-to`, amount: `${fieldId}-amount`, description: `${fieldId}-description` };
  const itemsArray = useMemo(() => (Array.isArray(budgetPeriodItems) ? budgetPeriodItems : []), [budgetPeriodItems]);

  // What the form starts from: on an overspent item, cover its overage (it is the
  // destination, the amount is the overage); on any other, move money out of it. It
  // starts over when the modal opens or closes, or the item or what it has left
  // changes; a refetch that changes neither keeps what was typed.
  const selectedItem = isOpen && selectedItemId ? itemsArray.find((item) => item.id === selectedItemId) : undefined;
  const selectedRemaining = selectedItem ? remainingOf(selectedItem) : null;
  const { seed, isCoverOverage } = useMemo(() => {
    const empty: BudgetTransferFormData = { fromId: null, toId: null, amount: null, description: '' };
    if (!isOpen || !selectedItemId || selectedRemaining === null) return { seed: empty, isCoverOverage: false };
    return selectedRemaining < 0
      ? { seed: { ...empty, toId: selectedItemId, amount: Math.round(Math.abs(selectedRemaining) * 100) / 100 }, isCoverOverage: true }
      : { seed: { ...empty, fromId: selectedItemId }, isCoverOverage: false };
  }, [isOpen, selectedItemId, selectedRemaining]);
  const schema = useMemo(() => budgetTransferSchema(itemsArray), [itemsArray]);

  const {
    control,
    register,
    handleSubmit,
    getValues,
    setValue,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<BudgetTransferFormData>({
    defaultValues: seed,
    resolver: zodResolver(schema) as never,
    shouldFocusError: false,
  });
  useFormReset(reset, seed, [seed]);
  const [fromBudgetPeriodItemId, toBudgetPeriodItemId, amount] = useWatch({ control, name: ['fromId', 'toId', 'amount'] });

  // Filter budget items to only show expense items
  let expenseBudgetItems: BudgetItemChoice[] = [];

  try {
    expenseBudgetItems = itemsArray
      .filter(item => item && item.expense_type === budgetExpenseType.enum.Expense && item.budget_item_name)
      .map(item => ({
        id: item.id,
        name: item.budget_item_name,
        type: item.type,
        icon: item.icon || 'Tag',
        status: item.status,
      }));
  } catch (error) {
    logger.error({ err: error }, 'Error mapping expense budget items');
  }

  // Get selected item details for display
  const fromItem = itemsArray.find(item => item.id === fromBudgetPeriodItemId);
  const toItem = itemsArray.find(item => item.id === toBudgetPeriodItemId);

  // Calculate available balance for FROM item
  const fromItemAvailable = remainingOf(fromItem);
  const overdrawn = !!fromItem && amount !== null && amount > fromItemAvailable;

  const onSubmit = async (data: BudgetTransferFormData) => {
    const transferAmount = data.amount as number;
    try {
      await transferBetweenBudgetItems(
        periodUuid,
        data.fromId as number,
        data.toId as number,
        transferAmount,
        data.description || undefined
      );

      toast.success(
        isCoverOverage
          ? `Overage covered: ${formatMoney(transferAmount)} moved to ${toItem?.budget_item_name}`
          : `Transfer complete: ${formatMoney(transferAmount)} from ${fromItem?.budget_item_name} to ${toItem?.budget_item_name}`
      );

      onSuccess(); // Trigger parent to refresh data
      onClose();
    } catch (error) {
      logger.error({ err: error }, 'Budget transfer failed');
      toast.error(errorMessage(error, 'Failed to transfer funds'));
    }
  };

  const onInvalid = (formErrors: typeof errors) =>
    focusFirstError(formErrors, [
      ['fromId', `[id="${ids.from}"]`],
      ['toId', `[id="${ids.to}"]`],
      ['amount', `[id="${ids.amount}"]`],
    ]);

  const handleCancel = () => {
    onClose();
  };

  const handleSwap = () => {
    // Swap FROM and TO budget items
    const [from, to] = getValues(['fromId', 'toId']);
    setValue('fromId', to);
    setValue('toId', from);
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="500px" maxHeight="90vh">
        <Dialog.Title>
          <Flex align="center" gap="2">
            <ArrowRightLeft size={20} />
            {isCoverOverage ? 'Cover Budget Overage' : 'Transfer Between Categories'}
          </Flex>
        </Dialog.Title>

        <Dialog.Description size="2" mb="4">
          {isCoverOverage
            ? 'Move money from another category to cover this overspent budget.'
            : 'Move money from one budget category to another.'}
        </Dialog.Description>

        <form onSubmit={handleSubmit(onSubmit, onInvalid)} noValidate>
        <Flex direction="column" gap="4">
          {/* From Budget Item Selector */}
          <div>
            <Flex align="center" gap="2" mb="2">
              <Text as="div" id={`${ids.from}-label`} size="2" weight="medium">
                From Budget Item
              </Text>
              <Tooltip content="Swap From and To">
                <IconButton type="button" size="1" variant="ghost" color="gray" onClick={handleSwap} aria-label="Swap From and To">
                  <RefreshCw size={16} />
                </IconButton>
              </Tooltip>
            </Flex>
            <Controller
              control={control}
              name="fromId"
              render={({ field }) => (
                <RadixBudgetItemSelector
                  id={ids.from}
                  aria-labelledby={`${ids.from}-label`}
                  aria-describedby={fieldErrorDescribedBy(ids.from, errors.fromId, fromItem && `${ids.from}-available`)}
                  value={field.value}
                  onChange={field.onChange}
                  budgetItems={expenseBudgetItems}
                  placeholder="Select source budget item..."
                  disabled={false} // Always allow selecting FROM category
                />
              )}
            />
            {fromItem && (
              <Text as="p" id={`${ids.from}-available`} size="1" color="gray" mt="1">
                Available: {formatMoney(fromItemAvailable)}
              </Text>
            )}
            <FieldError fieldId={ids.from} message={errors.fromId?.message} />
          </div>

          {/* To Budget Item Selector */}
          <div>
            <Text as="div" id={`${ids.to}-label`} size="2" weight="medium" mb="2">
              To Budget Item
            </Text>
            <Controller
              control={control}
              name="toId"
              render={({ field }) => (
                <RadixBudgetItemSelector
                  id={ids.to}
                  aria-labelledby={`${ids.to}-label`}
                  aria-describedby={fieldErrorDescribedBy(ids.to, errors.toId)}
                  value={field.value}
                  onChange={field.onChange}
                  budgetItems={expenseBudgetItems}
                  placeholder="Select destination budget item..."
                  disabled={isCoverOverage} // Disabled in cover overage mode
                />
              )}
            />
            <FieldError fieldId={ids.to} message={errors.toId?.message} />
          </div>

          {/* Amount Input */}
          <div>
            <Text as="label" htmlFor={ids.amount} size="2" weight="medium" mb="2" className="block">
              Amount
            </Text>
            <Controller
              control={control}
              name="amount"
              render={({ field }) => (
                <CurrencyInput
                  id={ids.amount}
                  {...nullableAmountInput(field.value, field.onChange)}
                  onBlur={field.onBlur}
                  size="2"
                  {...fieldErrorProps(ids.amount, errors.amount, !errors.amount && overdrawn && `${ids.amount}-over`)}
                />
              )}
            />
            {errors.amount ? (
              <FieldError fieldId={ids.amount} message={errors.amount.message} />
            ) : (
              overdrawn && (
                <Text as="p" id={`${ids.amount}-over`} size="1" color="red" mt="1">
                  Amount exceeds available balance
                </Text>
              )
            )}
          </div>

          {/* Description (Optional) */}
          <div>
            <Text as="label" htmlFor={ids.description} size="2" weight="medium" mb="2" className="block">
              Description (Optional)
            </Text>
            <TextField.Root
              id={ids.description}
              {...register('description')}
              placeholder="e.g., Adjusted for unexpected expense"
            />
          </div>
        </Flex>

        <Flex gap="3" mt="4" justify="end">
          <Dialog.Close>
            <Button type="button" variant="soft" color="gray" onClick={handleCancel}>
              Cancel
            </Button>
          </Dialog.Close>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Moving Money...' : 'Move Money'}
          </Button>
        </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
};

export default BudgetTransferModal;
