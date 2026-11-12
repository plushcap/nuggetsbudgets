import React, { useState } from 'react';
import FilePickerButton from '../components/forms/FilePickerButton';
import FieldError, { fieldErrorDescribedBy } from '../components/forms/FieldError';
import { IMAGE_UPLOAD_TYPES, imageUploadProblem } from '../utils/imageUploads';
import { useForm, type FieldErrors } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import { accountCreateSchema } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { useNavigate } from 'react-router-dom';
import { toast } from 'react-hot-toast';
import { useInstitutionsQuery, useCreateAccountWithImageMutation } from '../hooks/queries';
import { Card, Flex, Box, Heading, Text, Button, IconButton } from '@radix-ui/themes';
import { X, Upload, Image as ImageIcon } from 'lucide-react';
import PageHeader from '../components/PageHeader';
import AccountFormFields, { type AccountFormData, createDefaultAccountForm } from '../components/forms/AccountFormFields';
import PageContainer from '../components/PageContainer';

const AddAccountPage: React.FC = () => {
  const navigate = useNavigate();

  const { data: institutions = [], isLoading: loadingInstitutions } = useInstitutionsQuery();
  const createAccountMutation = useCreateAccountWithImageMutation();
  const isSubmitting = createAccountMutation.isPending;

  // react-hook-form drives form state + validation (shared accountCreateSchema).
  // The form shape carries UI-only fields (close_account, image, etc.) beyond
  // the API schema; the resolver validates the schema-relevant fields and we
  // read the full values via getValues() on submit.
  const form = useForm<AccountFormData>({
    defaultValues: createDefaultAccountForm(),
    resolver: withUnreadableAmounts(zodResolver(accountCreateSchema)) as never,
  });
  const { handleSubmit, getValues } = form;

  // Image is a File — kept outside RHF (files don't round-trip cleanly).
  const [accountImage, setAccountImage] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  // Why a picked image wasn't taken, beside its button: it was a toast, and checked
  // less than the server does (any image type).
  const [imageProblem, setImageProblem] = useState<string | null>(null);

  const handleImageUpload = (file: File) => {
    const problem = imageUploadProblem(file);
    setImageProblem(problem);
    if (problem) return;
    setAccountImage(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const removeImage = () => {
    setAccountImage(null);
    setImagePreview(null);
    setImageProblem(null);
  };

  // Surface validation failures so a blocked submit isn't silent (no onSubmit, no
  // toast). Mirrors EditAccountPage.
  const onInvalid = (formErrors: FieldErrors<AccountFormData>) => {
    const fieldLabels: Partial<Record<keyof AccountFormData, string>> = {
      name: 'Account Name',
      account_group: 'Account Group',
      type: 'Account Category',
      account_type: 'Account Type',
      icon: 'Account Icon',
      initial_balance: 'Initial Balance',
    };
    const invalid = Object.keys(formErrors)
      .map((key) => fieldLabels[key as keyof AccountFormData] || key)
      .join(', ');
    // Log only field→message; the raw RHF error objects carry DOM/fiber refs.
    const messages = Object.fromEntries(
      Object.entries(formErrors).map(([key, e]) => [key, (e as { message?: string })?.message])
    );
    logger.warn({ invalidFields: messages }, 'Account create blocked by validation');
    toast.error(invalid ? `Please fix: ${invalid}` : 'Please fix the highlighted fields before saving.');
  };

  const onSubmit = handleSubmit(async () => {
    try {
      // Use the full form values (RHF tracks every registered field, including
      // the UI-only ones the API schema doesn't model).
      const formData = getValues();
      const formDataToSend = new FormData();

      formDataToSend.append('name', formData.name);
      formDataToSend.append('type', formData.type);
      formDataToSend.append('account_type', formData.account_type);
      formDataToSend.append('account_group', formData.account_group);
      formDataToSend.append('initial_balance', (formData.initial_balance ?? 0).toString());
      if (formData.notes) {
        formDataToSend.append('notes', formData.notes);
      }
      if (formData.instructions) {
        formDataToSend.append('instructions', formData.instructions);
      }
      formDataToSend.append('icon', formData.icon);
      if (formData.subtype) {
        formDataToSend.append('subtype', formData.subtype);
      }
      if (formData.custom_sort !== null && formData.custom_sort !== undefined) {
        formDataToSend.append('custom_sort', formData.custom_sort.toString());
      }
      formDataToSend.append('is_active', (!formData.close_account).toString());
      formDataToSend.append('hide_transactions', formData.hide_transactions.toString());
      formDataToSend.append('hide_account', formData.hide_account.toString());
      formDataToSend.append('exclude_account_balance', formData.exclude_account_balance.toString());
      formDataToSend.append('is_envelope_account', formData.is_envelope_account.toString());
      formDataToSend.append('require_zero_balance', formData.require_zero_balance.toString());

      if (formData.institution_id) {
        formDataToSend.append('institution_id', formData.institution_id.toString());
      }
      if (formData.account_number) {
        formDataToSend.append('account_number', formData.account_number);
      }
      if (formData.routing_number) {
        formDataToSend.append('routing_number', formData.routing_number);
      }

      if (accountImage) {
        formDataToSend.append('account_image', accountImage);
      }

      await createAccountMutation.mutateAsync(formDataToSend);

      toast.success('Account created successfully!');
      navigate('/accounts');
    } catch (error) {
      logger.error({ err: error }, 'Failed to create account');
      toast.error('Failed to create account. Please try again.');
    }
  }, onInvalid);

  return (
    <PageContainer width="form">
      <PageHeader
        title="Add New Account"
        subtitle="Create a new financial account"
        backPath="/accounts"
      />

      {/* Form */}
      <Card>
        <Heading size="4" mb="4">Account Information</Heading>

        <Flex asChild direction="column" gap="6">
        <form onSubmit={onSubmit}>
          {/* Image Upload Section */}
          <Flex direction="column" gap="3">
            <Text as="p" size="2" weight="medium">
              Account Image
            </Text>

            <Flex align="center" gap="4">
              {/* Image Preview */}
              <Box position="relative">
                {imagePreview ? (
                  <Box position="relative">
                    <Box asChild width="80px" height="80px"><img
                      src={imagePreview}
                      alt="Account preview"
                      className="rounded-full object-cover border-2 border-[var(--gray-6)] shadow-xs"
                    /></Box>
                    <IconButton
                      type="button"
                      onClick={removeImage}
                      color="red"
                      radius="full"
                      size="1"
                      aria-label="Remove image"
                      style={{ position: 'absolute', top: -4, right: -4 }}
                    >
                      <X size={12} />
                    </IconButton>
                  </Box>
                ) : (
                  <Flex
                    align="center"
                    justify="center"
                    width="80px" height="80px" className="rounded-full bg-[var(--gray-3)] border-2 border-[var(--gray-6)] shadow-xs"
                  >
                    <ImageIcon size={24} className="text-[var(--gray-11)]" />
                  </Flex>
                )}
              </Box>

              {/* Upload Button */}
              <Box flexGrow="1">
                <FilePickerButton
                  accept={IMAGE_UPLOAD_TYPES.join(',')}
                  onFiles={([file]) => file && handleImageUpload(file)}
                  aria-describedby={fieldErrorDescribedBy('account-image', imageProblem, 'account-image-hint')}
                  color="gray"
                >
                  <Upload size={16} />
                  Upload Image
                </FilePickerButton>
                <Text as="p" id="account-image-hint" size="1" color="gray" mt="1">
                  JPG, PNG, GIF or WebP (max 5MB)
                </Text>
                {/* Said as it appears: the chooser leaves the focus on the button. */}
                <Box aria-live="polite">
                  <FieldError fieldId="account-image" message={imageProblem} />
                </Box>
              </Box>
            </Flex>
          </Flex>

          <AccountFormFields form={form} institutions={institutions} loadingInstitutions={loadingInstitutions} />

          {/* Form Actions */}
          <Flex align="center" justify="end" gap="3" pt="4" className="border-t border-[var(--gray-6)]">
            <Button
              type="button"
              variant="soft"
              color="gray"
              onClick={() => navigate('/accounts')}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting} loading={isSubmitting}>
              Create Account
            </Button>
          </Flex>
        </form>
        </Flex>
      </Card>
    </PageContainer>
  );
};

export default AddAccountPage;
