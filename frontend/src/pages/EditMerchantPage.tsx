import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Box, Button, Card, Flex, Heading } from '@radix-ui/themes';
import { Save, Store } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { merchantCreateSchema } from '@nuggets/shared';
import { useMerchantQuery, useTagsQuery, useUpdateMerchantMutation } from '../hooks/queries';
import { useMerchantImageUpload } from '../hooks/useMerchantImageUpload';
import { useSeededState } from '../hooks/useSeededState';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageContainer from '../components/PageContainer';
import MerchantFormFields, { type MerchantFormData, createDefaultMerchantForm } from '../components/forms/MerchantFormFields';
import MerchantImageField from '../components/merchants/MerchantImageField';
import { merchantFields, merchantFormValues, merchantPaths } from '../components/merchants/merchantFields';
import { EMPTY_LIST } from '../utils/emptyList';
import { errorMessage } from '../utils/errors';

/** A merchant's details, auto-tag and image, seeded from the merchant once it loads. */
const EditMerchantPage: React.FC = () => {
  const { uuid } = useParams<{ uuid: string }>();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const image = useMerchantImageUpload();
  const { data: merchant = null, isLoading: loading, isError } = useMerchantQuery(uuid);
  const { data: tags = EMPTY_LIST } = useTagsQuery();
  const updateMerchantMutation = useUpdateMerchantMutation();

  // The merchant's image and auto-tag once it loads, again when it or the tags change.
  const [currentImageUrl, setCurrentImageUrl] = useSeededState<string | null>(
    (current) => (merchant ? merchant.merchant_image || null : (current ?? null)),
    [merchant, tags],
  );
  // The merchant's auto-tag, by id: the form's own state, seeded from the merchant and changed
  // only by the picker. The picker shows it once the tags have loaded; saving sends the id, so a
  // save before they load (or when they failed) keeps it (it sent none, a clear).
  const [autoTagId, setAutoTagId] = useSeededState<number | null>(
    (current) => (merchant ? merchant.transaction_auto_tag_id : (current ?? null)),
    [merchant],
  );
  const autoTag = useMemo(() => tags.find((tag) => tag.id === autoTagId) ?? null, [tags, autoTagId]);

  const form = useForm<MerchantFormData>({
    defaultValues: createDefaultMerchantForm(),
    resolver: zodResolver(merchantCreateSchema) as never,
  });
  const { handleSubmit, reset, getValues } = form;

  // Seed the form from the merchant once it loads.
  useEffect(() => {
    if (merchant) reset(merchantFormValues(merchant));
  }, [merchant, tags, reset]);

  // Back to the list if the merchant can't be loaded.
  useEffect(() => {
    if (isError) {
      toast.error('Failed to load merchant');
      navigate(merchantPaths.list);
    }
  }, [isError, navigate]);

  const onSubmit = async () => {
    if (!merchant) return;
    try {
      setSaving(true);
      await updateMerchantMutation.mutateAsync({ uuid: merchant.uuid, data: merchantFields(getValues(), autoTagId, 'clear') });
      await image.uploadFor(merchant, 'Merchant updated but image upload failed');
      toast.success('Merchant updated successfully');
      navigate(merchantPaths.list);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to update merchant'));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <PageContainer width="form">
        <Flex direction="column" gap="4">
          <Box height="32px" width="25%" className="rounded-[var(--radius-2)] animate-pulse bg-[var(--gray-3)]" />
          <Box height="384px" className="rounded-[var(--radius-5)] animate-pulse bg-[var(--gray-3)]" />
        </Flex>
      </PageContainer>
    );
  }

  if (!merchant) {
    return (
      <PageContainer width="form">
        <Flex direction="column" align="center" gap="2" py="9">
          <Heading size="6">Merchant not found</Heading>
          <Button variant="ghost" asChild>
            <Link to={merchantPaths.list}>Return to merchants</Link>
          </Button>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Edit Merchant"
        subtitle="Update merchant information"
        icon={<Store size={20} />}
        iconBackground="bg-[var(--orange-3)]"
        backPath={merchantPaths.list}
        hideBackButton={false}
      />

      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="4" p="4">
            <MerchantFormFields
              form={form}
              tags={tags}
              autoTag={autoTag}
              onAutoTagChange={(tag) => setAutoTagId(tag?.id ?? null)}
              imageSlot={(
                <MerchantImageField
                  upload={image}
                  currentImageUrl={currentImageUrl}
                  onCurrentImageError={() => setCurrentImageUrl(null)}
                />
              )}
            />

            <Flex gap="3" mt="4">
              <Button type="button" variant="soft" color="gray" style={{ flex: 1 }} onClick={() => navigate(merchantPaths.list)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving} loading={saving} style={{ flex: 1 }}>
                <Save size={16} />
                <span>Save Changes</span>
              </Button>
            </Flex>
          </Flex>
        </form>
      </Card>
    </PageContainer>
  );
};

export default EditMerchantPage;
