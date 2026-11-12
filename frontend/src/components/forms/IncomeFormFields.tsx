import React, { useId } from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { Flex, Text, TextField, TextArea, Grid } from '@radix-ui/themes';
import type { Tag } from '../../services/api';
import type { BudgetItemFormData } from '../../types/forms';
import RadixIconPicker from '../RadixIconPicker';
import RadixColorPicker from '../RadixColorPicker';
import CurrencyInput from '../CurrencyInput';
import TagSelector from '../TagSelector';
import SingleTagSelector from '../SingleTagSelector';
import BudgetItemNamespaceTags from '../BudgetItemNamespaceTags';
import FieldError, { fieldErrorProps } from './FieldError';
import { optionalAmountInput } from './optionalAmount';

/**
 * Income form shape + defaults, co-located with the shared fields component.
 * Create and edit share the same fields including the tag sections — the add
 * page applies the selected tags after the item is created (it has no uuid
 * until then), the edit page persists them immediately.
 */
export interface IncomeFormData extends BudgetItemFormData {
  expense_type: 'Income';
  name: string;
}

export const createDefaultIncomeForm = (): IncomeFormData => ({
  name: '',
  description: '',
  expense_type: 'Income',
  priority: 'Essential',
  type: 'Monthly',
  subtype: 'Fixed',
  rollover: false,
  isbill: false,
  notes: '',
  instructions: '',
  color: '#10B981',
  icon: 'DollarSign',
  category_id: null,
});

interface IncomeFormFieldsProps {
  form: UseFormReturn<IncomeFormData>;
  loading?: boolean;
  tags: Tag[];
  selectedTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
  autoTag: Tag | null;
  onAutoTagChange: (tag: Tag | null) => void;
  /** Existing item uuid for the report-namespace selector; null until created. */
  budgetItemUuid?: string | null | undefined;
}

/** Shared field block for the add/edit income forms. */
const IncomeFormFields: React.FC<IncomeFormFieldsProps> = ({
  form,
  loading,
  tags,
  selectedTags,
  onTagsChange,
  autoTag,
  onAutoTagChange,
  budgetItemUuid = null,
}) => {
  const { register, control, watch, formState: { errors } } = form;
  const fieldId = useId();
  const colorValue = watch('color');

  return (
    <Flex direction="column" gap="6">
      {/* Income Name */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="label" htmlFor="name">
          Income Name *
        </Text>
        <TextField.Root
          id="name"
          {...register('name')}
          {...fieldErrorProps('name', errors.name, !errors.name && 'name-help')}
          placeholder="e.g., Salary, Freelance, Side Business"
          size="3"
        />
        {errors.name ? (
          <FieldError fieldId="name" message={errors.name.message as string} />
        ) : (
          <Text id="name-help" size="1" color="gray">
            Enter a descriptive name for your income source
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
              value={field.value || 'DollarSign'}
              onChange={(iconName) => field.onChange(iconName)}
              color={colorValue || '#10B981'}
              disabled={loading}
              label="Icon"
              placeholder="Select an icon"
            />
          )}
        />

        <Controller
          control={control}
          name="color"
          render={({ field }) => (
            <RadixColorPicker
              value={field.value || '#10B981'}
              onChange={(color) => field.onChange(color)}
              disabled={loading}
              label="Color"
              placeholder="#10B981"
            />
          )}
        />
      </Grid>

      {/* Monthly Income Amount */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="label" htmlFor="amount">
          Monthly Income Amount
        </Text>
        <Controller
          control={control}
          name="default_budget_amount"
          render={({ field }) => (
            <CurrencyInput
              id="amount"
              {...optionalAmountInput(field)}
              {...fieldErrorProps('amount', errors.default_budget_amount)}
              size="3"
            />
          )}
        />
        <FieldError fieldId="amount" message={errors.default_budget_amount?.message} />
        <Text size="1" color="gray">
          Expected monthly income from this source
        </Text>
      </Flex>

      {/* Description */}
      <Flex direction="column" gap="2">
        <Text size="2" weight="medium" as="label" htmlFor="description">
          Description
        </Text>
        <TextArea
          id="description"
          {...register('description')}
          placeholder="Optional description of this income source..."
          rows={3}
          size="3"
        />
        <Text size="1" color="gray">
          Add any additional details about this income source
        </Text>
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
          Automatically apply this tag to all transactions assigned to this income
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
          placeholder="Additional notes or details..."
          rows={3}
          size="3"
        />
        <Text size="1" color="gray">
          Any other information you want to remember about this income
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
          placeholder="Context your AI agent (via MCP) reads when it works with this income..."
          rows={3}
          size="3"
        />
        <Text size="1" color="gray">
          Free-form context for AI agents. Distinct from the user-facing notes above.
        </Text>
      </Flex>
    </Flex>
  );
};

export default IncomeFormFields;
