import React, { useEffect } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, Flex, Grid, Box, Text, TextField, TextArea, Select, Switch, Button } from '@radix-ui/themes';
import FormSelectRoot from '../components/forms/FormSelectRoot';
import { Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import FundCompositionEditor from '../components/FundCompositionEditor';
import { useSecurityQuery, useUpdateSecurityMutation } from '../hooks/queries/investments';
import { logger } from '../utils/logger';
import { SECURITY_TYPES, SECURITY_TYPE_LABELS, type SecurityType } from '@nuggets/shared';
import FieldError, { fieldErrorProps } from '../components/forms/FieldError';
import { apiErrorMessage } from '../utils/errors';
import PageContainer from '../components/PageContainer';

interface SecurityForm {
  ticker: string;
  name: string;
  security_type: SecurityType;
  notes: string;
  is_pass_through: boolean;
  is_active: boolean;
}


const EditSecurityPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const { data: security, isLoading } = useSecurityQuery(uuid);
  const updateMutation = useUpdateSecurityMutation();
  const { register, handleSubmit, control, reset, formState: { errors, isSubmitting } } = useForm<SecurityForm>({
    defaultValues: { ticker: '', name: '', security_type: 'stock', notes: '', is_pass_through: false, is_active: true },
  });

  useEffect(() => {
    if (security) {
      reset({
        ticker: security.ticker,
        name: security.name,
        security_type: security.security_type as SecurityType,
        notes: security.notes ?? '',
        is_pass_through: security.is_pass_through,
        is_active: security.is_active,
      });
    }
  }, [security, reset]);

  const onSubmit = async (data: SecurityForm) => {
    if (!uuid) return;
    try {
      await updateMutation.mutateAsync({ uuid, data: { ...data, notes: data.notes.trim() || null } });
      toast.success('Security updated');
      navigate('/investments/securities');
    } catch (err) {
      logger.error({ err }, 'Failed to update security');
      toast.error(apiErrorMessage(err, 'Failed to update security'));
    }
  };

  if (isLoading) return <PageContainer width="form"><PageLoader label="Loading security…" /></PageContainer>;

  return (
    <PageContainer width="form">
      <PageHeader title="Edit security" icon={<Layers />} backPath="/investments/securities" />
      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="4" p="2">
            <Grid columns={{ initial: '1', sm: '2' }} gap="3">
              <Box>
                <Text as="label" htmlFor="edit-security-ticker" size="2" mb="1" weight="medium" style={{ display: 'block' }}>Ticker</Text>
                <TextField.Root id="edit-security-ticker" {...register('ticker', { required: 'Ticker is required' })} {...fieldErrorProps('edit-security-ticker', errors.ticker)} />
                <FieldError fieldId="edit-security-ticker" message={errors.ticker?.message} />
              </Box>
              <Box>
                <Text as="label" htmlFor="edit-security-name" size="2" mb="1" weight="medium" style={{ display: 'block' }}>Name</Text>
                <TextField.Root id="edit-security-name" {...register('name', { required: 'Name is required' })} {...fieldErrorProps('edit-security-name', errors.name)} />
                <FieldError fieldId="edit-security-name" message={errors.name?.message} />
              </Box>
            </Grid>
            <Controller control={control} name="security_type" render={({ field }) => (
              <label>
                <Text as="div" size="2" mb="1" weight="medium">Type</Text>
                <FormSelectRoot value={field.value} onValueChange={field.onChange}>
                  <Select.Trigger style={{ width: '100%' }} />
                  <Select.Content>{SECURITY_TYPES.map((t) => <Select.Item key={t} value={t}>{SECURITY_TYPE_LABELS[t]}</Select.Item>)}</Select.Content>
                </FormSelectRoot>
              </label>
            )} />
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Notes</Text>
              <TextArea {...register('notes')} placeholder="e.g. Category: Large Blend" rows={2} />
            </label>
            <Controller control={control} name="is_pass_through" render={({ field }) => (
              <Flex align="center" gap="2" width="fit-content" asChild><label><Switch checked={field.value} onCheckedChange={field.onChange} /><Text size="2">Pass-through fund (split into multiple weighted categories)</Text></label></Flex>
            )} />
            <Controller control={control} name="is_active" render={({ field }) => (
              <Flex align="center" gap="2" width="fit-content" asChild><label><Switch checked={field.value} onCheckedChange={field.onChange} /><Text size="2">Active</Text></label></Flex>
            )} />
            <Flex gap="3" justify="end">
              <Button type="button" variant="soft" color="gray" onClick={() => navigate('/investments/securities')}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting}>Save</Button>
            </Flex>
          </Flex>
        </form>
      </Card>

      {uuid && security && (
        <Box mt="4">
          <FundCompositionEditor securityUuid={uuid} isPassThrough={security.is_pass_through} securityType={security.security_type} />
        </Box>
      )}
    </PageContainer>
  );
};

export default EditSecurityPage;
