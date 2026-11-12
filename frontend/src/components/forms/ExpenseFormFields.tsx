import React, { useId } from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { toast } from 'react-hot-toast';
import { X } from 'lucide-react';
import { Card, Flex, Text, Button, TextField, TextArea, Select, Grid, Box } from '@radix-ui/themes';
import FormSelectRoot from './FormSelectRoot';
import type { Category, Tag } from '../../services/api';
import type { BudgetItemFormData } from '../../types/forms';
import RadixIconPicker from '../RadixIconPicker';
import RadixColorPicker from '../RadixColorPicker';
import CurrencyInput from '../CurrencyInput';
import TagSelector from '../TagSelector';
import SingleTagSelector from '../SingleTagSelector';
import BudgetItemNamespaceTags from '../BudgetItemNamespaceTags';
import { requiredMonthlySavings } from '../../utils/envelopeSavings';
import FieldError, { fieldErrorProps } from './FieldError';
import { optionalAmountInput } from './optionalAmount';
import { BUDGET_PRIORITIES, BUDGET_PRIORITY_LABELS, formatMoney } from '@nuggets/shared';

/**
 * Expense form shape + defaults, co-located with the shared fields component.
 * Create and edit share the same fields including the tag sections — the add
 * page applies the selected tags after the item is created (it has no uuid
 * until then), the edit page persists them immediately.
 */
export interface ExpenseFormData extends BudgetItemFormData {
  expense_type: 'Expense' | 'Income';
  name: string;
}

export const createDefaultExpenseForm = (): ExpenseFormData => ({
  name: '',
  description: '',
  expense_type: 'Expense',
  priority: 'Optional',
  type: 'Monthly',
  subtype: 'Flexible',
  rollover: false,
  isbill: false,
  notes: '',
  instructions: '',
  color: '#EF4444',
  icon: 'CreditCard',
  category_id: null,
});


interface ExpenseFormFieldsProps {
  form: UseFormReturn<ExpenseFormData>;
  categories: Category[];
  loading?: boolean;
  tags: Tag[];
  selectedTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
  autoTag: Tag | null;
  onAutoTagChange: (tag: Tag | null) => void;
  /** Existing item uuid for the report-namespace selector; null until created. */
  budgetItemUuid?: string | null | undefined;
  /** The envelope's live balance when editing (null for a new item). */
  currentBalance?: number | null;
}

/** Shared field block for the add/edit expense forms. */
const ExpenseFormFields: React.FC<ExpenseFormFieldsProps> = ({
  form,
  categories,
  loading,
  tags,
  selectedTags,
  onTagsChange,
  autoTag,
  onAutoTagChange,
  budgetItemUuid = null,
  currentBalance = null,
}) => {
  const { register, control, watch, setValue, formState: { errors } } = form;
  const fieldId = useId();

  const watchedType = watch('type');
  const watchedDefault = watch('default_budget_amount');
  const watchedTarget = watch('rollover_target_amount');
  const watchedStarting = watch('rollover_starting_balance');
  const watchedTargetDate = watch('rollover_target_date');
  const colorValue = watch('color');
  const showEnvelopeSection = watchedType === 'Envelope';

  return (
    <Flex direction="column" gap="6">
      {/* Expense Name */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor="name" size="2" weight="medium">Expense Name *</Text>
        <TextField.Root
          id="name"
          {...register('name')}
          {...fieldErrorProps('name', errors.name, !errors.name && 'name-help')}
          placeholder="e.g., Groceries, Entertainment, Clothing"
          size="3"
        />
        {errors.name ? (
          <FieldError fieldId="name" message={errors.name.message as string} />
        ) : (
          <Text id="name-help" size="1" color="gray">
            Enter a descriptive name for your expense
          </Text>
        )}
      </Flex>

      {/* Icon and Color Selection */}
      <Grid columns={{ initial: '1', sm: '2' }} gap="5">
        <Controller
          control={control}
          name="icon"
          render={({ field }) => (
            <RadixIconPicker
              value={field.value || 'CreditCard'}
              onChange={(icon) => field.onChange(icon)}
              color={colorValue || '#8B5CF6'}
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
              value={field.value || '#8B5CF6'}
              onChange={(color) => field.onChange(color)}
              disabled={loading}
              label="Color"
            />
          )}
        />
      </Grid>

      {/* Type, Priority, Subtype */}
      <Grid columns={{ initial: '1', sm: '3' }} gap="5">
        <Flex direction="column" gap="2">
          <Text as="label" htmlFor={`${fieldId}-type`} size="2" weight="medium">Type</Text>
          <Controller
            control={control}
            name="type"
            render={({ field }) => (
              <FormSelectRoot
                value={field.value ?? undefined}
                onValueChange={(value) => {
                  field.onChange(value);
                  // Type-specific rollover defaults.
                  if (value === 'Envelope') {
                    setValue('rollover', true);
                  } else if (value === 'Monthly') {
                    setValue('rollover', false);
                    setValue('rollover_target_amount', undefined);
                    setValue('rollover_target_date', null);
                    setValue('rollover_starting_balance', undefined);
                    setValue('rollover_starting_balance_date', undefined);
                  }
                }}
                size="3"
              >
                <Select.Trigger id={`${fieldId}-type`} />
                <Select.Content>
                  <Select.Item value="Monthly">Monthly</Select.Item>
                  <Select.Item value="Envelope">Envelope</Select.Item>
                </Select.Content>
              </FormSelectRoot>
            )}
          />
        </Flex>

        <Flex direction="column" gap="2">
          <Text as="label" htmlFor={`${fieldId}-priority`} size="2" weight="medium">Priority</Text>
          <Controller
            control={control}
            name="priority"
            render={({ field }) => (
              <FormSelectRoot value={field.value ?? undefined} onValueChange={field.onChange} size="3">
                <Select.Trigger id={`${fieldId}-priority`} />
                <Select.Content>
                  {BUDGET_PRIORITIES.map((p) => (
                    <Select.Item key={p} value={p}>{BUDGET_PRIORITY_LABELS[p]}</Select.Item>
                  ))}
                </Select.Content>
              </FormSelectRoot>
            )}
          />
        </Flex>

        <Flex direction="column" gap="2">
          <Text as="label" htmlFor={`${fieldId}-subtype`} size="2" weight="medium">Subtype</Text>
          <Controller
            control={control}
            name="subtype"
            render={({ field }) => (
              <FormSelectRoot value={field.value ?? undefined} onValueChange={field.onChange} size="3">
                <Select.Trigger id={`${fieldId}-subtype`} />
                <Select.Content>
                  <Select.Item value="Fixed">Fixed</Select.Item>
                  <Select.Item value="Flexible">Flexible</Select.Item>
                  <Select.Item value="Paycheck">Paycheck</Select.Item>
                </Select.Content>
              </FormSelectRoot>
            )}
          />
        </Flex>
      </Grid>

      {/* Category */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-category`} size="2" weight="medium">Category</Text>
        <Controller
          control={control}
          name="category_id"
          render={({ field }) => (
            <FormSelectRoot
              value={field.value?.toString() || 'null'}
              onValueChange={(value) => field.onChange(value && value !== 'null' ? parseInt(value) : null)}
              size="3"
            >
              <Select.Trigger id={`${fieldId}-category`} placeholder="Select a category..." />
              <Select.Content>
                <Select.Item value="null">Select a category...</Select.Item>
                {categories.map(category => (
                  <Select.Item key={category.id} value={category.id.toString()}>
                    {category.name}
                  </Select.Item>
                ))}
              </Select.Content>
            </FormSelectRoot>
          )}
        />
      </Flex>

      {/* Default Budget Amount */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor="default_budget_amount" size="2" weight="medium">
          {watchedType === 'Monthly' ? 'Monthly Budget Amount' : 'Monthly Savings Amount'}
        </Text>
        <Controller
          control={control}
          name="default_budget_amount"
          render={({ field }) => (
            <CurrencyInput
              id="default_budget_amount"
              name="default_budget_amount"
              {...optionalAmountInput(field)}
              {...fieldErrorProps('default_budget_amount', errors.default_budget_amount)}
              size="3"
            />
          )}
        />
        <FieldError fieldId="default_budget_amount" message={errors.default_budget_amount?.message} />
      </Flex>

      {/* Budget Validation Section */}
      {(() => {
        const defaultBudgetAmount = watchedDefault || 0;
        const targetAmount = watchedTarget || 0;
        // The envelope's live balance when editing, else the starting balance entered.
        const balance = currentBalance ?? (watchedStarting || 0);

        let hasValidationErrors = false;
        let requiredBudgetAmount = 0;
        let validationMessage = '';

        // Without a target date there's no deadline to save toward, so nothing to check.
        const required = watchedType === 'Envelope' && defaultBudgetAmount > 0
          ? requiredMonthlySavings(targetAmount, balance, watchedTargetDate)
          : null;
        if (required && defaultBudgetAmount < required.amount) {
          hasValidationErrors = true;
          requiredBudgetAmount = required.amount;
          const monthsText = `${required.months} month${required.months === 1 ? '' : 's'}`;
          validationMessage = `To reach your target of ${formatMoney(Number(targetAmount) || 0)} by the target date, you need to save ${formatMoney(Number(required.amount) || 0)} monthly. Calculation: (${formatMoney(Number(targetAmount) || 0)} - ${formatMoney(Number(balance) || 0)} ${currentBalance != null ? 'current balance' : 'starting balance'}) ÷ ${monthsText} until the target date = ${formatMoney(Number(required.amount) || 0)}`;
        }

        if (!hasValidationErrors) return null;

        const handleAutoFix = () => {
          setValue('default_budget_amount', requiredBudgetAmount);
          toast.success('Budget amount updated with correct value');
        };

        // Red warning for insufficient budget.
        return (
          <Card className="[--card-background-color:var(--red-3)]">
            <Flex align="start" gap="3">
              <Box flexShrink="0">
                <X size={20} className="text-[var(--red-11)]" />
              </Box>
              <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%">
                <Text size="2" weight="medium" color="red">
                  Insufficient Savings Amount
                </Text>
                <Text size="2" color="red">{validationMessage}</Text>
                <Flex direction="column" gap="1">
                  <Text size="2" color="red">
                    <strong>Current Monthly Savings:</strong> {formatMoney(Number(defaultBudgetAmount) || 0)}
                  </Text>
                  <Text size="2" color="red">
                    <strong>Required Monthly Savings:</strong> {formatMoney(Number(requiredBudgetAmount) || 0)}
                  </Text>
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
                    Fix Savings Amount
                  </Button>
                </div>
              </Flex>
            </Flex>
          </Card>
        );
      })()}

      {/* Envelope Settings Section */}
      {showEnvelopeSection && (
        <Card>
          <Flex direction="column" gap="4">
            <Text size="2" weight="medium">Envelope Settings</Text>

            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="rollover_target_amount" size="2" weight="medium">Target Amount</Text>
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
              </Flex>

              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="rollover_starting_balance" size="2" weight="medium">Starting Balance</Text>
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
                <Text as="label" htmlFor="rollover_starting_balance_date" size="2" weight="medium">Starting Balance Date</Text>
                <TextField.Root
                  id="rollover_starting_balance_date"
                  type="date"
                  {...register('rollover_starting_balance_date')}
                  size="3"
                />
              </Flex>

              <Flex direction="column" gap="2">
                <Text as="label" htmlFor="rollover_target_date" size="2" weight="medium">Target Date</Text>
                <TextField.Root
                  id="rollover_target_date"
                  type="date"
                  {...register('rollover_target_date')}
                  size="3"
                />
                <Text size="1" color="gray">
                  When the envelope should reach its target. Optional; used to check the monthly savings amount.
                </Text>
              </Flex>
            </Grid>
          </Flex>
        </Card>
      )}

      {/* Description */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-description`} size="2" weight="medium">Description</Text>
        <TextArea
          id={`${fieldId}-description`}
          {...register('description')}
          rows={3}
          placeholder="Optional description of this expense..."
        />
      </Flex>

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
          Automatically apply this tag to all transactions assigned to this expense
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
        <Text as="label" htmlFor={`${fieldId}-notes`} size="2" weight="medium">Notes</Text>
        <TextArea
          id={`${fieldId}-notes`}
          {...register('notes')}
          rows={3}
          placeholder="Additional notes or details..."
        />
      </Flex>

      {/* AI instructions */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-instructions`} size="2" weight="medium">✨ AI instructions</Text>
        <TextArea
          id={`${fieldId}-instructions`}
          {...register('instructions')}
          rows={3}
          placeholder="Context your AI agent (via MCP) reads when it works with this expense..."
        />
        <Text size="1" color="gray">
          Free-form context for AI agents. Distinct from the user-facing notes above.
        </Text>
      </Flex>
    </Flex>
  );
};

export default ExpenseFormFields;
