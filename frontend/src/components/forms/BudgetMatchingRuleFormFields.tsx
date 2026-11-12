import React, { useId } from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { Flex, Text, TextField, TextArea, Select, Checkbox, Grid } from '@radix-ui/themes';
import FormSelectRoot from './FormSelectRoot';
import type { BudgetItem, MerchantLite } from '../../services/api';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';
import RadixMerchantSelector from '../RadixMerchantSelector';
import { useSeededState } from '../../hooks/useSeededState';
import FieldError, { fieldErrorDescribedBy, fieldErrorProps } from './FieldError';
import CurrencyInput from '../CurrencyInput';
import { nullableAmountInput } from './optionalAmount';
import type { BudgetItemMatchingRuleMethod } from '@nuggets/shared';

/**
 * Budget matching rule form shape + defaults, co-located with the shared
 * fields component. Create and edit share the same fields including the active
 * toggle — the add page sets it on create, the edit page persists it on save.
 */
export interface BudgetMatchingRuleFormData {
  /** null until one is chosen (the API answers null for a rule whose item is gone). */
  budget_item_id: number | null;
  merchant_id?: number | null | undefined;
  method: BudgetItemMatchingRuleMethod;
  matching_text?: string | null | undefined;
  amount_min?: number | null | undefined;
  amount_max?: number | null | undefined;
  priority: number | null;
  is_active: boolean;
  notes?: string | null | undefined;
}

export const createDefaultBudgetMatchingRuleForm = (): BudgetMatchingRuleFormData => ({
  budget_item_id: 0,
  merchant_id: null,
  method: 'contains',
  matching_text: '',
  amount_min: null,
  amount_max: null,
  priority: 100,
  is_active: true,
  notes: '',
});

const methodOptions = [
  { value: 'contains', label: 'Contains', description: 'Transaction description contains the text' },
  { value: 'exact', label: 'Exact Match', description: 'Transaction description exactly matches the text' },
  { value: 'starts_with', label: 'Starts With', description: 'Transaction description starts with the text' },
  { value: 'ends_with', label: 'Ends With', description: 'Transaction description ends with the text' },
  { value: 'regex', label: 'Regex Pattern', description: 'Transaction description matches regular expression' },
  { value: 'merchant_exact', label: 'Merchant Match', description: 'Transaction is from a specific merchant' },
];

interface BudgetMatchingRuleFormFieldsProps {
  form: UseFormReturn<BudgetMatchingRuleFormData>;
  budgetItems: BudgetItem[];
  merchants: MerchantLite[];
  /** Lock the budget-item selector (add page, pre-selected via query param). */
  budgetItemDisabled?: boolean;
  /** Show the "budget item pre-selected" helper text (add page). */
  budgetItemPreselectedNote?: boolean;
}

/** Shared field block for the add/edit budget-matching-rule forms. */
const BudgetMatchingRuleFormFields: React.FC<BudgetMatchingRuleFormFieldsProps> = ({
  form,
  budgetItems,
  merchants,
  budgetItemDisabled = false,
  budgetItemPreselectedNote = false,
}) => {
  const fieldId = useId();
  const { control, register, watch, setValue, formState: { errors } } = form;

  const watchedMethod = watch('method');
  const watchedMerchantId = watch('merchant_id');

  // Merchant search text (UI-only; the chosen merchant_id lives in the form).
  // It shows the chosen merchant's name (the edit case), set again when the
  // merchant or the merchant list changes.
  const [merchantSearch, setMerchantSearch] = useSeededState<string>((current) => {
    const selectedMerchant = watchedMerchantId ? merchants.find(m => m.id === watchedMerchantId) : undefined;
    return selectedMerchant ? selectedMerchant.name : (current ?? '');
  }, [watchedMerchantId, merchants]);
  const selectedMethod = methodOptions.find(m => m.value === watchedMethod);
  const isTextBasedMethod = ['exact', 'contains', 'starts_with', 'ends_with', 'regex'].includes(watchedMethod);
  const isMerchantMethod = watchedMethod === 'merchant_exact';

  return (
    <Flex direction="column" gap="5">
      {/* Active Status Toggle */}
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2" asChild>
          <Text as="label" htmlFor="is_active" size="2" weight="medium" color="gray" highContrast style={{ cursor: 'pointer' }}>
            <Controller
              control={control}
              name="is_active"
              render={({ field }) => (
                <Checkbox
                  id="is_active"
                  checked={!!field.value}
                  onCheckedChange={(checked) => field.onChange(checked === true)}
                  size="2"
                />
              )}
            />
            Rule is active
          </Text>
        </Flex>
        <Text size="2" color="gray">
          Inactive rules will not be used for automatic budget assignment.
        </Text>
      </Flex>

      {/* Budget Item Selection */}
      <Flex direction="column" gap="2">
        <Text as="div" id={`${fieldId}-budget-item`} size="2" weight="medium" color="gray" highContrast>
          Budget Item <Text color="red">*</Text>
        </Text>
        <Controller
          control={control}
          name="budget_item_id"
          render={({ field }) => (
            <RadixBudgetItemSelector
              aria-labelledby={`${fieldId}-budget-item`}
              aria-describedby={fieldErrorDescribedBy(`${fieldId}-budget-item-field`, errors.budget_item_id)}
              value={field.value}
              onChange={(value) => field.onChange(value || 0)}
              budgetItems={budgetItems}
              placeholder="Select a budget item..."
              disabled={budgetItemDisabled}
            />
          )}
        />
        <FieldError fieldId={`${fieldId}-budget-item-field`} message={errors.budget_item_id?.message as string | undefined} />
        {budgetItemPreselectedNote && (
          <Text size="2" color="gray">
            Budget item pre-selected. This rule will be created for the specific budget item.
          </Text>
        )}
      </Flex>

      {/* Method Selection */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor={`${fieldId}-method`} color="gray" highContrast>
          Matching Method <Text color="red">*</Text>
        </Text>
        <Controller
          control={control}
          name="method"
          render={({ field }) => (
            <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
              <Select.Trigger id={`${fieldId}-method`} placeholder="Select matching method..." />
              <Select.Content>
                {methodOptions.map(option => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </FormSelectRoot>
          )}
        />
        {selectedMethod && (
          <Text size="2" color="gray">
            {selectedMethod.description}
          </Text>
        )}
      </Flex>

      {/* Matching Text (for text-based methods) */}
      {isTextBasedMethod && (
        <Flex direction="column" gap="2">
          <Text as="label" size="2" weight="medium" htmlFor="matching_text" color="gray" highContrast>
            Matching Text <Text color="red">*</Text>
          </Text>
          <TextField.Root
            id="matching_text"
            {...register('matching_text')}
            placeholder={watchedMethod === 'regex' ? 'Regular expression pattern' : 'Text to match in transaction descriptions'}
            size="3"
            variant="surface"
            className="font-mono"
            {...fieldErrorProps('matching_text', errors.matching_text)}
          />
          <FieldError fieldId="matching_text" message={errors.matching_text?.message as string | undefined} />
          <Text size="2" color="gray">
            {watchedMethod === 'regex'
              ? 'Enter a regular expression, up to 200 characters, with no repeat inside a repeat such as (a+)+'
              : 'Enter the text to match in transaction descriptions (case-insensitive)'}
          </Text>
        </Flex>
      )}

      {/* Merchant Selection (for merchant method) */}
      {isMerchantMethod && (
        <Flex direction="column" gap="2">
          <Text as="div" id={`${fieldId}-merchant`} size="2" weight="medium" color="gray" highContrast>
            Merchant <Text color="red">*</Text>
          </Text>
          <RadixMerchantSelector
            aria-labelledby={`${fieldId}-merchant`}
            aria-describedby={fieldErrorDescribedBy(`${fieldId}-merchant-field`, errors.merchant_id)}
            value={merchantSearch}
            onChange={setMerchantSearch}
            onSelectMerchant={(merchant) => setValue('merchant_id', merchant ? merchant.id : null, { shouldValidate: !!errors.merchant_id })}
            merchants={merchants}
            required={true}
            placeholder="Start typing merchant name..."
            size="3"
          />
          {/* The rule schema (shared) refuses merchant_exact without a merchant, on this field. */}
          <FieldError fieldId={`${fieldId}-merchant-field`} message={errors.merchant_id?.message as string | undefined} />
        </Flex>
      )}

      {/* Amount Range (optional) */}
      <Flex direction="column" gap="2">
        <Text as="div" id={`${fieldId}-amount-range`} size="2" weight="medium" color="gray" highContrast>
          Amount Range (optional)
        </Text>
        <Grid role="group" aria-labelledby={`${fieldId}-amount-range`} columns={{ initial: '1', sm: '2' }} gap="4">
          <Flex direction="column" gap="1">
            <Text as="label" htmlFor="amount_min" size="1" color="gray">Minimum Amount</Text>
            <Controller
              control={control}
              name="amount_min"
              render={({ field }) => (
                <CurrencyInput
                  id="amount_min"
                  ref={field.ref}
                  {...nullableAmountInput(field.value, field.onChange)}
                  onBlur={field.onBlur}
                  hideOwnHint
                  size="3"
                  {...fieldErrorProps('amount_min', errors.amount_min)}
                />
              )}
            />
            <FieldError fieldId="amount_min" message={errors.amount_min?.message} />
          </Flex>
          <Flex direction="column" gap="1">
            <Text as="label" htmlFor="amount_max" size="1" color="gray">Maximum Amount</Text>
            <Controller
              control={control}
              name="amount_max"
              render={({ field }) => (
                <CurrencyInput
                  id="amount_max"
                  ref={field.ref}
                  {...nullableAmountInput(field.value, field.onChange)}
                  onBlur={field.onBlur}
                  hideOwnHint
                  size="3"
                  {...fieldErrorProps('amount_max', errors.amount_max)}
                />
              )}
            />
            <FieldError fieldId="amount_max" message={errors.amount_max?.message} />
          </Flex>
        </Grid>
        <Text size="2" color="gray">
          Leave empty to match all amounts. Rule will only apply to transactions within this range.
        </Text>
      </Flex>

      {/* Priority */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="priority" color="gray" highContrast>
          Priority
        </Text>
        <Controller
          control={control}
          name="priority"
          render={({ field }) => (
            <TextField.Root
              id="priority"
              min="1"
              max="999"
              value={field.value?.toString() || '100'}
              onChange={(e) => field.onChange(parseInt(e.target.value) || 100)}
              size="3"
              variant="surface"
            />
          )}
        />
        <Text size="2" color="gray">
          Lower numbers have higher priority. Rules are processed in priority order.
        </Text>
      </Flex>

      {/* Notes */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="notes" color="gray" highContrast>
          Notes (optional)
        </Text>
        <TextArea
          id="notes"
          rows={3}
          {...register('notes')}
          placeholder="Add any notes about this rule..."
          size="3"
          variant="surface"
        />
      </Flex>
    </Flex>
  );
};

export default BudgetMatchingRuleFormFields;
