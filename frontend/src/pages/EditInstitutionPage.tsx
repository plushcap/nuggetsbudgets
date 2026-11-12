import React, { useEffect } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { institutionCreateSchema } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { errorMessage } from '../utils/errors';
import { useNavigate, useParams } from 'react-router-dom';
import { Building2, Save } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useInstitutionQuery, useUpdateInstitutionMutation } from '../hooks/queries/referenceData';
import SettingsPageHeader from '../components/SettingsPageHeader';
import { Card, Flex, Box, Text, Button } from '@radix-ui/themes';
import InstitutionFormFields, { type InstitutionFormData, createDefaultInstitutionForm } from '../components/forms/InstitutionFormFields';
import PageContainer from '../components/PageContainer';

const EditInstitutionPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const updateInstitutionMutation = useUpdateInstitutionMutation();
  const loading = updateInstitutionMutation.isPending;

  const {
    data: institution,
    isLoading: loadingData,
    error: loadError,
  } = useInstitutionQuery(uuid, { meta: { suppressErrorToast: true } });

  const form = useForm<InstitutionFormData>({
    defaultValues: createDefaultInstitutionForm(),
    resolver: zodResolver(institutionCreateSchema) as never,
  });
  const { handleSubmit, reset, control } = form;

  // Populate the form once the institution loads.
  useEffect(() => {
    if (institution) {
      reset({ name: institution.name, notes: institution.notes || '' });
    }
  }, [institution, reset]);

  // On load failure, notify and return to the list (preserves prior behavior).
  useEffect(() => {
    if (loadError) {
      logger.error({ err: loadError, uuid }, 'Failed to load institution');
      toast.error('Failed to load institution');
      navigate('/settings/institutions');
    }
  }, [loadError, uuid, navigate]);

  const onSubmit = async (data: InstitutionFormData) => {
    if (!uuid) return;
    try {
      await updateInstitutionMutation.mutateAsync({
        uuid,
        data: {
          name: data.name.trim(),
          // A PUT replaces the institution: cleared notes are sent as none.
          notes: data.notes?.trim() || null,
        },
      });

      toast.success('Institution updated successfully');
      navigate('/settings/institutions');
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to update institution');
      toast.error(errorMessage(error, 'Failed to update institution'));
    }
  };

  const nameValue = useWatch({ control, name: 'name' });

  if (loadingData) {
    return (
      <PageContainer width="form">
        <Flex direction="column" gap="6" className="animate-pulse">
          {/* Header Skeleton */}
          <Flex align="center" gap="3">
            <Box width="40px" height="40px" className="rounded-[var(--radius-5)] bg-[var(--gray-3)]" />
            <Flex direction="column" gap="2" flexGrow="1" flexBasis="0%">
              <Box height="24px" width="192px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
              <Box height="16px" width="256px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
            </Flex>
          </Flex>
          {/* Form Skeleton */}
          <Card>
            <Flex direction="column" gap="5">
              <Box>
                <Box height="16px" width="128px" mb="2" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
                <Box height="48px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
              </Box>
              <Box>
                <Box height="16px" width="96px" mb="2" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
                <Box height="96px" className="rounded-[var(--radius-2)] bg-[var(--gray-3)]" />
              </Box>
            </Flex>
          </Card>
        </Flex>
      </PageContainer>
    );
  }

  if (!institution) {
    return (
      <PageContainer width="form">
        <Card>
          <Flex direction="column" align="center" gap="4" py="9">
            <Text size="5" weight="medium" className="text-[var(--gray-12)]">
              Institution not found
            </Text>
            <Button onClick={() => navigate('/settings/institutions')}>
              Back to Institutions
            </Button>
          </Flex>
        </Card>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header */}
      <SettingsPageHeader
        title="Edit Institution"
        subtitle="Update institution details"
        icon={<Building2 size={20} className="text-[var(--accent-11)]" />}
        backPath="/settings/institutions"
        primaryAction={{
          label: 'Save Changes',
          onClick: (e) => {
            e?.preventDefault();
            handleSubmit(onSubmit)();
          },
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

export default EditInstitutionPage;
