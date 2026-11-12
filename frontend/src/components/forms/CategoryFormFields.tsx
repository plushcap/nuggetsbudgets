import React, { useId } from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { Flex, Text, TextField, TextArea, Select } from '@radix-ui/themes';
import FormSelectRoot from './FormSelectRoot';
import RadixIconPicker from '../RadixIconPicker';
import FieldError, { fieldErrorProps } from './FieldError';

/**
 * Category form shape + defaults, co-located with the shared fields component.
 *
 * Create and edit categories use the same fields, so a single type serves both.
 * (Moved out of `types/forms.ts` as part of the shared-<EntityForm> refactor.)
 */
export interface CategoryFormData {
  name: string;
  icon: string;
  /** Text; '' for none, which the page sends as null (categoryBody). */
  description: string;
  /** 'Undefined' for none. */
  priority: string;
  notes: string;
}

export const createDefaultCategoryForm = (): CategoryFormData => ({
  name: '',
  description: '',
  priority: 'Undefined',
  notes: '',
  icon: 'Tag',
});

interface CategoryFormFieldsProps {
  form: UseFormReturn<CategoryFormData>;
}

/**
 * The shared field block for the add and edit category forms. The parent owns
 * `useForm` (with the shared `categoryCreateSchema` resolver), the submit
 * mutation, and the page chrome; this renders the inputs + the icon picker.
 */
const CategoryFormFields: React.FC<CategoryFormFieldsProps> = ({ form }) => {
  const fieldId = useId();
  const { register, control, formState: { errors } } = form;

  return (
    <Flex direction="column" gap="6">
      {/* Category Name */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-name`} size="2" weight="medium" color="gray" highContrast>
          Category Name <span className="text-[var(--red-11)]">*</span>
        </Text>
        <TextField.Root
          id={`${fieldId}-name`}
          {...fieldErrorProps(`${fieldId}-name`, errors.name)}
          {...register('name')}
          placeholder="Enter category name"
          size="3"
          variant="surface"
          maxLength={255}
        />
        <FieldError fieldId={`${fieldId}-name`} message={errors.name?.message as string | undefined} />
      </Flex>

      {/* Description */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-description`} size="2" weight="medium" color="gray" highContrast>
          Description
        </Text>
        <TextField.Root
          id={`${fieldId}-description`}
          {...register('description')}
          placeholder="Brief description of the category"
          size="3"
          variant="surface"
        />
      </Flex>

      {/* Priority */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-priority`} size="2" weight="medium" color="gray" highContrast>
          Priority
        </Text>
        <Controller
          control={control}
          name="priority"
          render={({ field }) => (
            <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
              <Select.Trigger id={`${fieldId}-priority`} placeholder="Select priority" />
              <Select.Content>
                <Select.Item value="Undefined">Undefined</Select.Item>
                <Select.Item value="Essential">Essential</Select.Item>
                <Select.Item value="Optional">Optional</Select.Item>
              </Select.Content>
            </FormSelectRoot>
          )}
        />
        <Text size="1" color="gray">
          Essential: Must-pay expenses (rent, utilities, insurance){'\n'}
          Optional: Can be reduced or eliminated (dining out, entertainment)
        </Text>
      </Flex>

      {/* Icon — shared app-wide picker (search + categories + grid over iconCatalog) */}
      <Controller
        control={control}
        name="icon"
        render={({ field }) => (
          <RadixIconPicker
            value={field.value || 'Tag'}
            onChange={field.onChange}
            label="Icon"
          />
        )}
      />

      {/* Notes */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-notes`} size="2" weight="medium" color="gray" highContrast>
          Notes
        </Text>
        <TextArea
          id={`${fieldId}-notes`}
          {...register('notes')}
          rows={3}
          size="3"
          variant="surface"
          placeholder="Additional notes about this category"
          className="resize-none"
        />
      </Flex>
    </Flex>
  );
};

export default CategoryFormFields;
