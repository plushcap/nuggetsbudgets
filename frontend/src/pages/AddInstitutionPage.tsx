import React from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { institutionCreateSchema } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { useNavigate } from 'react-router-dom';
import { Building2, Save } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useCreateInstitutionMutation } from '../hooks/queries/referenceData';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { Card } from '@radix-ui/themes';
import InstitutionFormFields, { type InstitutionFormData, createDefaultInstitutionForm } from '../components/forms/InstitutionFormFields';
import PageContainer from '../components/PageContainer';

const AddInstitutionPage: React.FC = () => {
  const navigate = useNavigate();
  const createInstitutionMutation = useCreateInstitutionMutation();
  const loading = createInstitutionMutation.isPending;

  const form = useForm<InstitutionFormData>({
    defaultValues: createDefaultInstitutionForm(),
    resolver: zodResolver(institutionCreateSchema) as never,
  });
  const { handleSubmit, control } = form;

  const onSubmit = async (data: InstitutionFormData) => {
    try {
      const notes = data.notes?.trim();
      await createInstitutionMutation.mutateAsync({
        name: data.name.trim(),
        // Empty notes are left out.
        ...(notes ? { notes } : {}),
      });

      toast.success('Institution created successfully');
      navigate('/settings/institutions');
    } catch (error) {
      logger.error({ err: error }, 'Failed to create institution');
      toast.error(errorMessage(error, 'Failed to create institution'));
    }
  };

  const nameValue = useWatch({ control, name: 'name' });

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Add Institution"
        subtitle="Create a new financial institution"
        icon={<Building2 size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings/institutions"
        primaryAction={{
          label: 'Create Institution',
          onClick: () => { handleSubmit(onSubmit)(); },
          icon: <Save size={16} />,
          disabled: loading || !nameValue?.trim(),
          loading: loading
        }}
      />

      {/* Form */}
      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <InstitutionFormFields form={form} />
        </form>
      </Card>
    </PageContainer>
  );
};

export default AddInstitutionPage;
