import React from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { Flex, Text, TextField, TextArea } from '@radix-ui/themes';
import FieldError, { fieldErrorProps } from './FieldError';

/**
 * Institution form shape + defaults, co-located with the shared fields
 * component. Create and edit use the same fields, so one type serves both.
 */
export interface InstitutionFormData {
  name: string;
  /** Text; '' for none, which the pages send as null. */
  notes: string;
}

export const createDefaultInstitutionForm = (): InstitutionFormData => ({
  name: '',
  notes: '',
});

interface InstitutionFormFieldsProps {
  form: UseFormReturn<InstitutionFormData>;
}

/** Shared field block for the add/edit institution forms. */
const InstitutionFormFields: React.FC<InstitutionFormFieldsProps> = ({ form }) => {
  const { register, formState: { errors } } = form;

  return (
    <Flex direction="column" gap="5">
      {/* Institution Name */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="name" color="gray" highContrast>
          Institution Name <Text color="red">*</Text>
        </Text>
        <TextField.Root
          id="name"
          {...fieldErrorProps('name', errors.name)}
          {...register('name')}
          placeholder="Enter institution name (e.g., Example Bank, Sample Credit Union)"
          size="3"
          variant="surface"
        />
        <FieldError fieldId="name" message={errors.name?.message as string | undefined} />
      </Flex>

      {/* Notes */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="notes" color="gray" highContrast>
          Notes
        </Text>
        <TextArea
          id="notes"
          {...register('notes')}
          placeholder="Optional notes about this institution..."
          size="3"
          variant="surface"
          rows={4}
        />
      </Flex>
    </Flex>
  );
};

export default InstitutionFormFields;
