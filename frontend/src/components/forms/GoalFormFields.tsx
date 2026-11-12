import React, { useState } from 'react';
import { type UseFormReturn, Controller } from 'react-hook-form';
import { Box, Flex, Text, IconButton, TextField, TextArea, Select, Grid } from '@radix-ui/themes';
import FormSelectRoot from './FormSelectRoot';
import { Upload, X } from 'lucide-react';
import CurrencyInput from '../CurrencyInput';
import RadixDatePicker from '../RadixDatePicker';
import FieldError, { fieldErrorProps, fieldErrorDescribedBy } from './FieldError';
import { optionalAmountInput } from './optionalAmount';
import FilePickerButton from './FilePickerButton';
import { IMAGE_UPLOAD_TYPES, imageUploadProblem } from '../../utils/imageUploads';
import { BUDGET_ITEM_STATUSES, BUDGET_ITEM_STATUS_LABELS, type BudgetItemStatus } from '@nuggets/shared';

/**
 * Goal form shape + defaults, co-located with the shared fields component.
 *
 * Create and edit share the same fields (the add form was brought up to match
 * edit, which had accreted the full status set). The image file is handled in
 * each page's local state and passed in via props, since the upload timing
 * differs (create uploads after the goal exists; edit can replace an existing
 * image). Goal status covers the full lifecycle on both forms.
 */
export interface GoalFormData {
  name: string;
  description?: string | null | undefined;
  target_amount: number;
  target_date: string;
  estimated_monthly_contribution?: number | null | undefined;
  status: BudgetItemStatus;
}

export const createDefaultGoalForm = (): GoalFormData => ({
  name: '',
  description: '',
  target_amount: 0,
  target_date: '',
  estimated_monthly_contribution: 0,
  status: 'active',
});

interface GoalFormFieldsProps {
  form: UseFormReturn<GoalFormData>;
  imagePreview: string | null;
  /** The picture picked, once it is one the server takes (imageUploadProblem). */
  onImageChange: (file: File) => void;
  onRemoveImage: () => void;
}

/** Shared field block for the add/edit goal forms (fields + image picker). */
const GoalFormFields: React.FC<GoalFormFieldsProps> = ({ form, imagePreview, onImageChange, onRemoveImage }) => {
  const { register, control, formState: { errors } } = form;
  // Why a picked picture wasn't taken, beside its button: the pages toasted it, and
  // took any image type the server then refused.
  const [imageProblem, setImageProblem] = useState<string | null>(null);
  const pickImage = (file: File) => {
    const problem = imageUploadProblem(file);
    setImageProblem(problem);
    if (!problem) onImageChange(file);
  };

  return (
    <Flex direction="column" gap="6">
      {/* Goal Name */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="name">
          Goal Name <Text as="span" color="red">*</Text>
        </Text>
        <TextField.Root
          id="name"
          {...fieldErrorProps('name', errors.name)}
          {...register('name')}
          placeholder="e.g., Emergency Fund, New Car, Vacation"
          size="3"
          maxLength={200}
        />
        <FieldError fieldId="name" message={errors.name?.message as string | undefined} />
      </Flex>

      {/* Description */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="description">Description</Text>
        <TextArea
          id="description"
          {...register('description')}
          placeholder="Add details about your goal..."
          rows={3}
          resize="none"
        />
      </Flex>

      {/* Target Amount and Target Date */}
      <Grid columns={{ initial: '1', sm: '2' }} gap="5">
        <Flex direction="column" gap="2">
          <Text as="label" size="2" weight="medium" htmlFor="target_amount">
            Target Amount <Text as="span" color="red">*</Text>
          </Text>
          <Controller
            control={control}
            name="target_amount"
            render={({ field }) => (
              <CurrencyInput
                id="target_amount"
                // Empty is 0, which the schema refuses; text it can't read is NaN, which the pages'
                // resolver refuses (UNREADABLE_REQUIRED_AMOUNT_MESSAGE): it was 0 too.
                {...optionalAmountInput(field)}
                {...fieldErrorProps('target_amount', errors.target_amount)}
                size="3"
              />
            )}
          />
          <FieldError fieldId="target_amount" message={errors.target_amount?.message as string | undefined} />
        </Flex>

        <Flex direction="column" gap="2">
          <Text as="div" size="2" weight="medium" id="target_date_label">
            Target Date <Text as="span" color="red">*</Text>
          </Text>
          <Controller
            control={control}
            name="target_date"
            render={({ field }) => (
              <RadixDatePicker
                aria-labelledby="target_date_label"
                aria-describedby={fieldErrorDescribedBy('target_date', errors.target_date)}
                value={field.value}
                onChange={(date) => field.onChange(date)}
                placeholder="Pick a target date"
                size="3"
              />
            )}
          />
          <FieldError fieldId="target_date" message={errors.target_date?.message as string | undefined} />
        </Flex>
      </Grid>

      {/* Estimated Monthly Contribution */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="monthly_contribution">
          Estimated Monthly Contribution
        </Text>
        <Controller
          control={control}
          name="estimated_monthly_contribution"
          render={({ field }) => (
            <CurrencyInput
              id="monthly_contribution"
              {...optionalAmountInput(field)}
              {...fieldErrorProps('monthly_contribution', errors.estimated_monthly_contribution)}
              size="3"
            />
          )}
        />
        <FieldError fieldId="monthly_contribution" message={errors.estimated_monthly_contribution?.message} />
        <Text size="1" color="gray">
          Optional: How much do you plan to save each month?
        </Text>
      </Flex>

      {/* Goal Image */}
      <Flex direction="column" gap="2">
        <Text as="p" size="2" weight="medium">Goal Image</Text>

        {imagePreview ? (
          <Box position="relative">
            <Box asChild width="100%" height="192px"><img
              src={imagePreview}
              alt="Goal preview"
              className="object-cover rounded-[var(--radius-4)]"
            /></Box>
            <IconButton
              type="button"
              color="red"
              onClick={onRemoveImage}
              aria-label="Remove image"
              className="absolute top-2 right-2"
            >
              <X size={16} />
            </IconButton>
          </Box>
        ) : (
          <Box
            p="6" className="text-center border-2 border-dashed border-[var(--gray-6)] rounded-[var(--radius-3)]"
          >
            <Upload size={48} className="mx-auto mb-4 text-[var(--gray-11)]" />
            <FilePickerButton
              accept={IMAGE_UPLOAD_TYPES.join(',')}
              onFiles={([file]) => file && pickImage(file)}
              aria-describedby={fieldErrorDescribedBy('goal-image', imageProblem, 'goal-image-hint')}
              color="blue"
            >
              Choose Image
            </FilePickerButton>
            <Text as="div" id="goal-image-hint" size="1" color="gray" mt="2">
              PNG, JPG, GIF or WebP up to 5MB
            </Text>
            {/* Said as it appears: the chooser leaves the focus on the button. */}
            <Box aria-live="polite">
              <FieldError fieldId="goal-image" message={imageProblem} />
            </Box>
          </Box>
        )}
      </Flex>

      {/* Status */}
      <Flex direction="column" gap="2">
        <Text as="label" size="2" weight="medium" htmlFor="status">Status</Text>
        <Controller
          control={control}
          name="status"
          render={({ field }) => (
            <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
              <Select.Trigger id="status" />
              <Select.Content>
                {BUDGET_ITEM_STATUSES.map((s) => (
                  <Select.Item key={s} value={s}>{BUDGET_ITEM_STATUS_LABELS[s]}</Select.Item>
                ))}
              </Select.Content>
            </FormSelectRoot>
          )}
        />
      </Flex>
    </Flex>
  );
};

export default GoalFormFields;
