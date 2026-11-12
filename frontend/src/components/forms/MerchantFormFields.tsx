import React, { useId } from 'react';
import { type UseFormReturn } from 'react-hook-form';
import { Flex, Text, TextField, TextArea } from '@radix-ui/themes';
import type { Tag } from '../../services/api';
import SingleTagSelector from '../SingleTagSelector';
import FieldError, { fieldErrorProps } from './FieldError';

/**
 * Merchant form shape + defaults, co-located with the shared fields component.
 * Create and edit share the same fields including the transaction auto-tag —
 * the add page sends it in the create payload, the edit page persists it on
 * save. The divergent image uploader is supplied by each page via `imageSlot`.
 */
export interface MerchantFormData {
  name: string;
  merchant_website?: string;
  merchant_accountid?: string;
  notes?: string;
  instructions?: string;
  // Held on the form for parity; the actual upload is managed per page.
  merchant_image?: File | string | null;
}

export const createDefaultMerchantForm = (): MerchantFormData => ({
  name: '',
  merchant_website: '',
  merchant_accountid: '',
  notes: '',
  instructions: '',
  merchant_image: null,
});

interface MerchantFormFieldsProps {
  form: UseFormReturn<MerchantFormData>;
  tags: Tag[];
  autoTag: Tag | null;
  onAutoTagChange: (tag: Tag | null) => void;
  /** Page-specific image uploader, rendered between the auto-tag and notes. */
  imageSlot?: React.ReactNode;
}

/** Shared field block for the add/edit merchant forms. */
const MerchantFormFields: React.FC<MerchantFormFieldsProps> = ({
  form,
  tags,
  autoTag,
  onAutoTagChange,
  imageSlot,
}) => {
  const fieldId = useId();
  const { register, formState: { errors } } = form;

  return (
    <Flex direction="column" gap="6">
      {/* Merchant Name */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-name`} size="2" weight="medium">
          Merchant Name <span className="text-[var(--red-11)]">*</span>
        </Text>
        <TextField.Root
          id={`${fieldId}-name`}
          {...fieldErrorProps(`${fieldId}-name`, errors.name)}
          {...register('name')}
          placeholder="Enter merchant name"
          size="3"
          variant="surface"
          maxLength={255}
        />
        <FieldError fieldId={`${fieldId}-name`} message={errors.name?.message as string | undefined} />
      </Flex>

      {/* Website URL */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-website`} size="2" weight="medium">Website URL</Text>
        <TextField.Root
          id={`${fieldId}-website`}
          {...register('merchant_website')}
          placeholder="https://example.com"
          size="3"
          variant="surface"
          inputMode="url"
          {...fieldErrorProps(`${fieldId}-website`, errors.merchant_website)}
        />
        <FieldError fieldId={`${fieldId}-website`} message={errors.merchant_website?.message as string | undefined} />
      </Flex>

      {/* Account ID */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-account-id`} size="2" weight="medium">Account ID</Text>
        <TextField.Root
          id={`${fieldId}-account-id`}
          {...register('merchant_accountid')}
          placeholder="Your account ID with this merchant"
          size="3"
          variant="surface"
          maxLength={100}
        />
      </Flex>

      {/* Transaction Auto-Tag */}
      <Flex direction="column" gap="2">
        <Text as="div" id={`${fieldId}-auto-tag`} size="2" weight="medium">Auto-Tag for Transactions</Text>
        <Text size="1" color="gray">
          Automatically apply this tag to all transactions from this merchant (overrides budget item auto-tags)
        </Text>
        <SingleTagSelector
          aria-labelledby={`${fieldId}-auto-tag`}
          selectedTag={autoTag}
          onChange={onAutoTagChange}
          tags={tags}
          placeholder="Select auto-tag (optional)..."
        />
      </Flex>

      {/* Merchant Image (page-specific uploader) */}
      {imageSlot}

      {/* Notes */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-notes`} size="2" weight="medium">Notes</Text>
        <TextArea
          id={`${fieldId}-notes`}
          {...register('notes')}
          rows={3}
          size="3"
          variant="surface"
          className="resize-none"
          placeholder="Additional notes about this merchant"
        />
      </Flex>

      {/* AI instructions */}
      <Flex direction="column" gap="2">
        <Text as="label" htmlFor={`${fieldId}-instructions`} size="2" weight="medium">✨ AI instructions</Text>
        <TextArea
          id={`${fieldId}-instructions`}
          {...register('instructions')}
          rows={3}
          size="3"
          variant="surface"
          className="resize-none"
          placeholder="Context your AI agent (via MCP) reads when it works with this merchant. E.g. aliases, classification rules, or anything you’d explain to a new bookkeeper."
        />
      </Flex>
    </Flex>
  );
};

export default MerchantFormFields;
