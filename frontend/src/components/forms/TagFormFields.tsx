import React from 'react';
import { Controller, type Control, type FieldErrors, type UseFormRegister } from 'react-hook-form';
import { Checkbox, Flex, Select, Text, TextArea, TextField } from '@radix-ui/themes';
import RadixIconPicker from '../RadixIconPicker';
import RadixColorPicker from '../RadixColorPicker';
import FieldError, { fieldErrorProps } from './FieldError';
import type { Tag } from '../../services/api/types';
import type { TagFormData } from '../../types/forms';

/** The Parent Tag select's "no parent" choice: a Radix Select.Item's value can't be empty. */
export const NO_PARENT = 'none';

interface TagFormFieldsProps {
  /** Starts the fields' ids ('add-tag', 'edit-tag'). */
  idPrefix: string;
  control: Control<TagFormData>;
  register: UseFormRegister<TagFormData>;
  errors: FieldErrors<TagFormData>;
  /** The parents offered, and whether the top level is. */
  parents: readonly Tag[];
  offerTop: boolean;
  /** Under the parent (the edit dialog's report namespace). */
  children?: React.ReactNode;
}

/**
 * A tag's fields, in the Tags page's Add and Edit dialogs (react-hook-form,
 * checked with `tagWriteSchema`): name, icon, colour, description, active, parent.
 */
const TagFormFields: React.FC<TagFormFieldsProps> = ({ idPrefix, control, register, errors, parents, offerTop, children }) => {
  const nameId = `${idPrefix}-name`;
  const parentId = `${idPrefix}-parent`;
  return (
    <Flex direction="column" gap="3" mt="4">
      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={nameId} size="2" weight="medium">Name *</Text>
        <TextField.Root id={nameId} variant="surface" placeholder="Tag name" {...register('name')} {...fieldErrorProps(nameId, errors.name)} />
        <FieldError fieldId={nameId} message={errors.name?.message ?? null} />
      </Flex>

      <Controller
        control={control}
        name="icon"
        render={({ field }) => <RadixIconPicker value={field.value} onChange={field.onChange} label="Icon" />}
      />

      <Controller
        control={control}
        name="color"
        render={({ field }) => <RadixColorPicker value={field.value} onChange={field.onChange} label="Color" />}
      />

      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={`${idPrefix}-description`} size="2" weight="medium">Description</Text>
        <TextArea id={`${idPrefix}-description`} variant="surface" rows={3} placeholder="Optional description" {...register('description')} />
      </Flex>

      <Flex align="center" gap="3">
        <Controller
          control={control}
          name="is_active"
          render={({ field }) => <Checkbox id={`${idPrefix}-active`} checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />}
        />
        <Text as="label" htmlFor={`${idPrefix}-active`} size="2" weight="medium">Active (visible in transaction selection)</Text>
      </Flex>

      <Flex direction="column" gap="1">
        <Text as="label" htmlFor={parentId} size="2" weight="medium">Parent Tag</Text>
        <Controller
          control={control}
          name="parent_id"
          render={({ field }) => (
            <Select.Root
              value={field.value ? String(field.value) : NO_PARENT}
              onValueChange={(value) => field.onChange(value === NO_PARENT ? null : parseInt(value, 10))}
            >
              <Select.Trigger id={parentId} variant="surface" />
              <Select.Content>
                {offerTop && <Select.Item value={NO_PARENT}>None (Root Level)</Select.Item>}
                {parents.map((tag) => (
                  <Select.Item key={tag.id} value={String(tag.id)}>
                    {tag.hierarchy_path}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          )}
        />
      </Flex>

      {children}
    </Flex>
  );
};

export default TagFormFields;
