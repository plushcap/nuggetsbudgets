import React, { useId } from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import { Card, Flex, Text, Button, TextField, TextArea, Select, Checkbox, Grid, Box } from '@radix-ui/themes';
import FormSelectRoot from './FormSelectRoot';
import type { Tag } from '../../services/api';
import type { BudgetItemFormData } from '../../types/forms';
import {
  useCategoriesQuery,
  useMerchantsQuery,
  useCreateMerchantMutation,
} from '../../hooks/queries';
import { logger } from '../../utils/logger';
import { calculateNextPaymentDate } from '../../utils/billSchedule';
import { EMPTY_LIST } from '../../utils/emptyList';
import { centsToAmount, perMonthRoundedUp, toCents } from '../../utils/currency';
import RadixIconPicker from '../RadixIconPicker';
import RadixColorPicker from '../RadixColorPicker';
import RadixDatePicker from '../RadixDatePicker';
import CurrencyInput from '../CurrencyInput';
import TagSelector from '../TagSelector';
import RadixMerchantSelector from '../RadixMerchantSelector';
import SingleTagSelector from '../SingleTagSelector';
import BudgetItemNamespaceTags from '../BudgetItemNamespaceTags';
import FieldError, { fieldErrorProps } from './FieldError';
import { optionalAmountInput } from './optionalAmount';
import { formatMoney } from '@nuggets/shared';

/**
 * Bill form shape + defaults, co-located with the shared fields component.
 * Create and edit share the same fields including the tag sections — the add
 * page applies the selected tags after the item is created (it has no uuid
 * until then), the edit page persists them immediately.
 */
export interface BillFormData extends BudgetItemFormData {
  name: string;
  isbill?: boolean;
  recurring_payment?: boolean;
  recurring_payment_amount?: number;
  recurring_payment_frequency?: number;
  recurring_next_payment_date?: string;
  recurring_amount_varies?: boolean;
}

export const createDefaultBillForm = (): BillFormData => ({
  name: '',
  isbill: true,
  recurring_payment: true,
  expense_type: 'Expense',
  priority: 'Essential',
  type: 'Monthly',
  subtype: 'Fixed',
  rollover: false,
  notes: '',
  instructions: '',
  color: '#F59E0B',
  icon: 'Receipt',
  category_id: null,
  merchant_id: null,
});

/** Live, backend-calculated budget figures for the current period (edit only). */
export interface BillCurrentBudgetData {
  calculated_budget: number;
  calculated_actual: number;
  calculated_remaining: number;
  calculated_transfers: number;
}


interface BillFormFieldsProps {
  form: UseFormReturn<BillFormData>;
  loading?: boolean;
  tags: Tag[];
  selectedTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
  autoTag: Tag | null;
  onAutoTagChange: (tag: Tag | null) => void;
  /** Existing item uuid for the report-namespace selector; null until created. */
  budgetItemUuid?: string | null | undefined;
  /** Live budget figures for the validation calc; null on the add page. */
  currentBudgetData?: BillCurrentBudgetData | null;
}

/** Shared field block for the add/edit bill forms. */
const BillFormFields: React.FC<BillFormFieldsProps> = ({
  form,
  loading,
  tags,
  selectedTags,
  onTagsChange,
  autoTag,
  onAutoTagChange,
  budgetItemUuid = null,
  currentBudgetData = null,
}) => {
  const fieldId = useId();
  const { register, control, watch, setValue, formState: { errors } } = form;

  const { data: categories = [] } = useCategoriesQuery();
  const { data: merchants = EMPTY_LIST } = useMerchantsQuery({ lite: true });
  const createMerchantMutation = useCreateMerchantMutation();
  const isCreatingMerchant = createMerchantMutation.isPending;

  // The chosen merchant lives in the form as merchant_id; the picker shows its name.
  const watchedMerchantId = watch('merchant_id');
  const merchantName = (watchedMerchantId && merchants.find(m => m.id === watchedMerchantId)?.name) || '';

  const watchedBillAmount = watch('recurring_payment_amount');
  const watchedDefaultBudget = watch('default_budget_amount');
  const watchedFrequency = watch('recurring_payment_frequency');
  const watchedTarget = watch('rollover_target_amount');
  const watchedStarting = watch('rollover_starting_balance');
  const watchedNextDate = watch('recurring_next_payment_date');
  const colorValue = watch('color');
  const showRecurringSection = !!watchedFrequency && watchedFrequency > 1;
  const showEnvelopeWarning = (watchedBillAmount || 0) > 0 && (watchedTarget || 0) > (watchedBillAmount || 0);

  const handleCreateMerchant = async (merchantName: string) => {
    if (!merchantName.trim()) return;
    try {
      const newMerchant = await createMerchantMutation.mutateAsync({ name: merchantName.trim() });

      setValue('merchant_id', newMerchant.id, { shouldDirty: true });

      toast.success(`Merchant "${merchantName}" created successfully!`);
    } catch (error) {
      logger.error({ err: error }, 'Failed to create merchant');
      toast.error('Failed to create merchant');
    }
  };

  return (
    <Flex direction="column" gap="6">
      {/* Bill Name */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="label" htmlFor="name">
          Bill Name *
        </Text>
        <TextField.Root
          id="name"
          {...register('name')}
          {...fieldErrorProps('name', errors.name, !errors.name && 'name-help')}
          placeholder="e.g., Electric Bill, Internet Service"
          size="3"
        />
        {errors.name ? (
          <FieldError fieldId="name" message={errors.name.message as string} />
        ) : (
          <Text id="name-help" size="1" color="gray">
            Enter a descriptive name for your bill
          </Text>
        )}
      </Flex>

      {/* Merchant Selection */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="div" id={`${fieldId}-merchant`}>Merchant</Text>
        <RadixMerchantSelector
          aria-labelledby={`${fieldId}-merchant`}
          value={merchantName}
          onChange={() => { /* the name follows merchant_id */ }}
          onSelectMerchant={(merchant) => setValue('merchant_id', merchant ? merchant.id : null, { shouldDirty: true })}
          onCreateNew={isCreatingMerchant ? undefined : (name) => void handleCreateMerchant(name)}
          merchants={merchants}
          placeholder="Search for a merchant..."
          clearable
        />
      </Flex>

      {/* Bill Amount, Category, and Payment Frequency */}
      <Grid columns={{ initial: '1', sm: '3' }} gap="5">
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium" as="label" htmlFor="recurring_payment_amount">
            Bill Amount
          </Text>
          <Controller
            control={control}
            name="recurring_payment_amount"
            render={({ field }) => (
              <CurrencyInput
                id="recurring_payment_amount"
                // Mirror bill amount into the envelope target amount.
                {...optionalAmountInput(field, (amount) => setValue('rollover_target_amount', amount))}
                {...fieldErrorProps('recurring_payment_amount', errors.recurring_payment_amount)}
                size="3"
              />
            )}
          />
          <FieldError fieldId="recurring_payment_amount" message={errors.recurring_payment_amount?.message} />
          <Controller
            control={control}
            name="recurring_amount_varies"
            render={({ field }) => (
              <Text as="label" size="2">
                <Flex gap="2" align="center">
                  <Checkbox checked={field.value === true} onCheckedChange={(checked) => field.onChange(checked === true)} />
                  The amount varies (forecast from the last 3 payments)
                </Flex>
              </Text>
            )}
          />
        </Flex>

        <Flex direction="column" gap="2">
          <Text size="2" weight="medium" as="label" htmlFor={`${fieldId}-category`}>Category</Text>
          <Controller
            control={control}
            name="category_id"
            render={({ field }) => (
              <FormSelectRoot
                value={field.value?.toString() || 'null'}
                onValueChange={(value) => field.onChange(value && value !== 'null' ? parseInt(value) : null)}
                size="3"
              >
                <Select.Trigger id={`${fieldId}-category`} placeholder="Select a category" />
                <Select.Content>
                  <Select.Item value="null">Select a category</Select.Item>
                  {categories.map((category) => (
                    <Select.Item key={category.id} value={category.id.toString()}>
                      {category.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </FormSelectRoot>
            )}
          />
        </Flex>

        <Flex direction="column" gap="2">
          <Text size="2" weight="medium" as="label" htmlFor={`${fieldId}-frequency`}>Payment Frequency</Text>
          <Controller
            control={control}
            name="recurring_payment_frequency"
            render={({ field }) => (
              <FormSelectRoot
                value={(field.value || 1).toString()}
                onValueChange={(value) => field.onChange(parseInt(value))}
                size="3"
              >
                <Select.Trigger id={`${fieldId}-frequency`} />
                <Select.Content>
                  <Select.Item value="1">Monthly</Select.Item>
                  <Select.Item value="2">Every 2 Months</Select.Item>
                  <Select.Item value="3">Quarterly (3 Months)</Select.Item>
                  <Select.Item value="6">Every 6 Months</Select.Item>
                  <Select.Item value="12">Yearly (12 Months)</Select.Item>
                  <Select.Item value="24">Every 2 Years</Select.Item>
                </Select.Content>
              </FormSelectRoot>
            )}
          />
        </Flex>
      </Grid>

      {/* First Payment Date and Default Budget Amount */}
      <Grid columns={{ initial: '1', sm: '2' }} gap="5">
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium" as="div" id={`${fieldId}-first-payment`}>First Payment Date</Text>
          <Controller
            control={control}
            name="recurring_next_payment_date"
            render={({ field }) => (
              <RadixDatePicker
                aria-labelledby={`${fieldId}-first-payment`}
                value={field.value || ''}
                onChange={(value) => field.onChange(value || undefined)}
                placeholder="Select first payment date"
              />
            )}
          />
        </Flex>
        <Flex direction="column" gap="2">
          <Text size="2" weight="medium" as="label" htmlFor="default_budget_amount">
            Default Budget Amount
          </Text>
          <Controller
            control={control}
            name="default_budget_amount"
            render={({ field }) => (
              <CurrencyInput
                id="default_budget_amount"
                {...optionalAmountInput(field)}
                {...fieldErrorProps('default_budget_amount', errors.default_budget_amount)}
                size="3"
              />
            )}
          />
          <FieldError fieldId="default_budget_amount" message={errors.default_budget_amount?.message} />
        </Flex>
      </Grid>

      {/* Icon and Color Selection */}
      <Grid columns={{ initial: '1', sm: '2' }} gap="5">
        <Controller
          control={control}
          name="icon"
          render={({ field }) => (
            <RadixIconPicker
              value={field.value || 'Receipt'}
              onChange={(icon) => field.onChange(icon)}
              color={colorValue || '#F59E0B'}
              disabled={loading}
              label="Icon"
            />
          )}
        />
        <Controller
          control={control}
          name="color"
          render={({ field }) => (
            <RadixColorPicker
              value={field.value || '#F59E0B'}
              onChange={(color) => field.onChange(color)}
              disabled={loading}
              label="Color"
            />
          )}
        />
      </Grid>

      {/* Budget Validation Section */}
      {(() => {
        const billAmount = watchedBillAmount || 0;
        const defaultBudgetAmount = watchedDefaultBudget || 0;
        const frequency = watchedFrequency || 1;
        // Use the live calculated balance, falling back to the entered starting
        // balance for new bills (no period data yet).
        const currentBalance = currentBudgetData ? Math.max(0, currentBudgetData.calculated_remaining) : (watchedStarting || 0);

        // Months until the next payment date.
        const nextPaymentDate = calculateNextPaymentDate(watchedNextDate, watchedFrequency);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let monthsUntilPayment = frequency; // Default to frequency if we can't calculate.
        if (nextPaymentDate) {
          const yearsDiff = nextPaymentDate.getFullYear() - today.getFullYear();
          const monthsDiff = nextPaymentDate.getMonth() - today.getMonth();
          monthsUntilPayment = Math.max(1, yearsDiff * 12 + monthsDiff);
        }

        let hasValidationErrors = false;
        let hasExcessWarning = false;
        let requiredBudgetAmount = 0;
        let validationMessage = '';
        let excessMessage = '';

        if (billAmount > 0 && defaultBudgetAmount > 0) {
          // In whole cents, rounded up to the cent: a float's Math.ceil(x * 100) asked for
          // $150.31 of a $150.30 bill.
          const amountNeeded = centsToAmount(Math.max(0, toCents(billAmount) - toCents(currentBalance)));
          requiredBudgetAmount = perMonthRoundedUp(amountNeeded, monthsUntilPayment);

          if (defaultBudgetAmount < requiredBudgetAmount) {
            hasValidationErrors = true;
            validationMessage = `You need to budget ${formatMoney(Number(requiredBudgetAmount) || 0)} per month to reach your goal. Calculation: (${formatMoney(Number(billAmount) || 0)} - ${formatMoney(Number(currentBalance) || 0)} current balance) ÷ ${monthsUntilPayment} month${monthsUntilPayment === 1 ? '' : 's'} until payment = ${formatMoney(Number(requiredBudgetAmount) || 0)}`;
          } else if (defaultBudgetAmount > requiredBudgetAmount * 1.05) {
            hasExcessWarning = true;
            const excessAmount = defaultBudgetAmount - requiredBudgetAmount;
            excessMessage = `The planned savings amount will exceed 5% of what is needed. You're budgeting ${formatMoney(Number(excessAmount) || 0)} more than required. This money could be used elsewhere.`;
          }
        }

        if (!hasValidationErrors && !hasExcessWarning) return null;

        const handleAutoFix = () => {
          setValue('default_budget_amount', requiredBudgetAmount);
          if (frequency > 1 && (!watchedTarget || watchedTarget === 0)) {
            setValue('rollover_target_amount', billAmount);
          }
          toast.success('Budget amounts updated with correct values');
        };

        if (hasValidationErrors) {
          return (
            <Card className="[--card-background-color:var(--red-3)]">
              <Flex align="start" gap="3">
                <Box flexShrink="0">
                  <svg className="h-5 w-5 text-[var(--red-11)]" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                  </svg>
                </Box>
                <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%">
                  <Text size="2" weight="medium" color="red">
                    Insufficient Budget Amount
                  </Text>
                  <Flex direction="column" gap="2">
                    <Text size="2" color="red">{validationMessage}</Text>
                    <Flex direction="column" gap="1">
                      <Text size="2" color="red">
                        <strong>Current Default Budget Amount:</strong> {formatMoney(Number(defaultBudgetAmount) || 0)}
                      </Text>
                      <Text size="2" color="red">
                        <strong>Required Default Budget Amount:</strong> {formatMoney(Number(requiredBudgetAmount) || 0)}
                      </Text>
                    </Flex>
                  </Flex>
                  <div>
                    <Button
                      type="button"
                      onClick={handleAutoFix}
                      size="2"
                      color="red"
                      variant="soft"
                      style={{ cursor: 'pointer' }}
                    >
                      Fix Budget Amounts
                    </Button>
                  </div>
                </Flex>
              </Flex>
            </Card>
          );
        }

        if (hasExcessWarning) {
          return (
            <Card className="[--card-background-color:var(--yellow-3)]">
              <Flex align="start" gap="3">
                <Box flexShrink="0">
                  <svg className="h-5 w-5 text-[var(--yellow-12)]" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                  </svg>
                </Box>
                <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%">
                  <Text size="2" weight="medium" color="yellow" highContrast>
                    Excess Budget Amount
                  </Text>
                  <Flex direction="column" gap="2">
                    <Text size="2" color="yellow" highContrast>{excessMessage}</Text>
                    <Flex direction="column" gap="1">
                      <Text size="2" color="yellow" highContrast>
                        <strong>Current Default Budget Amount:</strong> {formatMoney(Number(defaultBudgetAmount) || 0)}
                      </Text>
                      <Text size="2" color="yellow" highContrast>
                        <strong>Required Default Budget Amount:</strong> {formatMoney(Number(requiredBudgetAmount) || 0)}
                      </Text>
                    </Flex>
                  </Flex>
                </Flex>
              </Flex>
            </Card>
          );
        }

        return null;
      })()}

      {/* Envelope Settings Section - Only show when frequency > 1 */}
      {showRecurringSection && (
        <Card className="[--card-background-color:var(--blue-3)]">
          <Flex direction="column" gap="4">
            <Text size="2" weight="medium">Envelope Settings (Non-Monthly Bill)</Text>

            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="rollover_target_amount">
                  Envelope Target Amount
                </Text>
                <Controller
                  control={control}
                  name="rollover_target_amount"
                  render={({ field }) => (
                    <CurrencyInput
                      id="rollover_target_amount"
                      name="rollover_target_amount"
                      {...optionalAmountInput(field)}
                      {...fieldErrorProps('rollover_target_amount', errors.rollover_target_amount)}
                      size="3"
                    />
                  )}
                />
                <FieldError fieldId="rollover_target_amount" message={errors.rollover_target_amount?.message} />
                {showEnvelopeWarning && (
                  <Text size="1" color="red">
                    Warning: Target amount exceeds bill amount
                  </Text>
                )}
              </Flex>

              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="rollover_starting_balance">
                  Envelope Starting Balance
                </Text>
                <Controller
                  control={control}
                  name="rollover_starting_balance"
                  render={({ field }) => (
                    <CurrencyInput
                      id="rollover_starting_balance"
                      name="rollover_starting_balance"
                      {...optionalAmountInput(field)}
                      {...fieldErrorProps('rollover_starting_balance', errors.rollover_starting_balance)}
                      size="3"
                      allowNegative
                    />
                  )}
                />
                <FieldError fieldId="rollover_starting_balance" message={errors.rollover_starting_balance?.message} />
              </Flex>
            </Grid>

            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="rollover_starting_balance_date">
                  Starting Balance Date
                </Text>
                <TextField.Root
                  id="rollover_starting_balance_date"
                  type="date"
                  {...register('rollover_starting_balance_date')}
                  size="3"
                />
              </Flex>
              <div>
                {/* Empty div for spacing */}
              </div>
            </Grid>
          </Flex>
        </Card>
      )}

      {/* Tags */}
      <Flex direction="column" gap="2">
        <Text as="div" id={`${fieldId}-tags`} size="2" weight="medium">Tags</Text>
        <TagSelector
          aria-labelledby={`${fieldId}-tags`}
          selectedTags={selectedTags}
          onChange={onTagsChange}
          tags={tags}
          placeholder="Select tags..."
        />
      </Flex>

      {/* Report namespace tags */}
      <BudgetItemNamespaceTags budgetItemUuid={budgetItemUuid} />

      {/* Transaction Auto-Tag */}
      <Flex direction="column" gap="2">
        <Text as="div" id={`${fieldId}-auto-tag`} size="2" weight="medium">Auto-Tag for Transactions</Text>
        <Text size="1" color="gray" mb="1">
          Automatically apply this tag to all transactions assigned to this bill
        </Text>
        <SingleTagSelector
          aria-labelledby={`${fieldId}-auto-tag`}
          selectedTag={autoTag}
          onChange={onAutoTagChange}
          tags={tags}
          placeholder="Select auto-tag (optional)..."
        />
      </Flex>

      {/* Notes */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="label" htmlFor="notes">
          Notes
        </Text>
        <TextArea
          id="notes"
          {...register('notes')}
          rows={3}
          placeholder="Additional notes about this bill..."
          size="3"
        />
        <Text size="1" color="gray">
          Any additional information about this bill
        </Text>
      </Flex>

      {/* AI instructions */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="label" htmlFor="instructions">
          ✨ AI instructions
        </Text>
        <TextArea
          id="instructions"
          {...register('instructions')}
          rows={3}
          placeholder="Context your AI agent (via MCP) reads when it works with this bill..."
          size="3"
        />
        <Text size="1" color="gray">
          Free-form context for AI agents. Distinct from the user-facing notes above.
        </Text>
      </Flex>
    </Flex>
  );
};

export default BillFormFields;
