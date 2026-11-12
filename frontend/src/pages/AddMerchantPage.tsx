import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card } from '@radix-ui/themes';
import { Save, Store } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { merchantCreateSchema } from '@nuggets/shared';
import type { Tag } from '../services/api';
import { useCreateMerchantMutation, useTagsQuery } from '../hooks/queries';
import { useMerchantImageUpload } from '../hooks/useMerchantImageUpload';
import SettingsPageHeader from '../components/SettingsPageHeader';
import PageContainer from '../components/PageContainer';
import MerchantFormFields, { type MerchantFormData, createDefaultMerchantForm } from '../components/forms/MerchantFormFields';
import MerchantImageField from '../components/merchants/MerchantImageField';
import { merchantFields, merchantPaths } from '../components/merchants/merchantFields';
import { EMPTY_LIST } from '../utils/emptyList';
import { errorMessage } from '../utils/errors';

/** A new merchant: its details, auto-tag and image (uploaded once the merchant is saved). */
const AddMerchantPage: React.FC = () => {
  const navigate = useNavigate();
  const [autoTag, setAutoTag] = useState<Tag | null>(null);
  const [saving, setSaving] = useState(false);
  const image = useMerchantImageUpload();
  const createMerchantMutation = useCreateMerchantMutation();
  const { data: tags = EMPTY_LIST } = useTagsQuery();

  const form = useForm<MerchantFormData>({
    defaultValues: createDefaultMerchantForm(),
    resolver: zodResolver(merchantCreateSchema) as never,
  });
  const { handleSubmit, getValues } = form;

  const onSubmit = async () => {
    try {
      setSaving(true);
      const merchant = await createMerchantMutation.mutateAsync(merchantFields(getValues(), autoTag?.id ?? null, 'omit'));
      await image.uploadFor(merchant, 'Merchant created but image upload failed');
      toast.success('Merchant created successfully');
      navigate(merchantPaths.list);
    } catch (error) {
      toast.error(errorMessage(error, 'Failed to create merchant'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer width="form">
      <SettingsPageHeader
        title="Add Merchant"
        subtitle="Create a new merchant profile"
        icon={<Store size={20} className="text-[var(--accent-11)]" />}
        iconBackground="bg-[var(--accent-3)]"
        backPath={merchantPaths.list}
        primaryAction={{
          label: 'Create Merchant',
          onClick: (e) => {
            e?.preventDefault();
            void handleSubmit(onSubmit)();
          },
          icon: <Save size={16} />,
          disabled: saving,
          loading: saving,
        }}
      />

      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <MerchantFormFields
            form={form}
            tags={tags}
            autoTag={autoTag}
            onAutoTagChange={setAutoTag}
            imageSlot={<MerchantImageField upload={image} />}
          />
        </form>
      </Card>
    </PageContainer>
  );
};

export default AddMerchantPage;
