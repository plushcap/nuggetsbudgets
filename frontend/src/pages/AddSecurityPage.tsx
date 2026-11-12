import React from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { Box, Card, Flex, Grid, Text, TextField, TextArea, Select, Switch, Button } from '@radix-ui/themes';
import FormSelectRoot from '../components/forms/FormSelectRoot';
import { Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import { useCreateSecurityMutation } from '../hooks/queries/investments';
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
}


const AddSecurityPage: React.FC = () => {
  const navigate = useNavigate();
  const createMutation = useCreateSecurityMutation();
  const { register, handleSubmit, control, formState: { errors, isSubmitting } } = useForm<SecurityForm>({
    defaultValues: { ticker: '', name: '', security_type: 'stock', notes: '', is_pass_through: false },
  });

  const onSubmit = async (data: SecurityForm) => {
    try {
      await createMutation.mutateAsync({
        ...data,
        notes: data.notes.trim() || null,
        currency: 'USD',
        is_active: true,
        is_custom: false,
        track_underlying_holdings: false,
      });
      toast.success('Security created');
      navigate('/investments/securities');
    } catch (err) {
      logger.error({ err }, 'Failed to create security');
      toast.error(apiErrorMessage(err, 'Failed to create security'));
    }
  };

  return (
    <PageContainer width="form">
      <PageHeader title="Add security" icon={<Layers />} backPath="/investments/securities" />
      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="4" p="2">
            <Grid columns={{ initial: '1', sm: '2' }} gap="3">
              <Box>
                <Text as="label" htmlFor="add-security-ticker" size="2" mb="1" weight="medium" style={{ display: 'block' }}>Ticker</Text>
                <TextField.Root id="add-security-ticker" placeholder="ACMEC" {...register('ticker', { required: 'Ticker is required' })} {...fieldErrorProps('add-security-ticker', errors.ticker)} />
                <FieldError fieldId="add-security-ticker" message={errors.ticker?.message} />
              </Box>
              <Box>
                <Text as="label" htmlFor="add-security-name" size="2" mb="1" weight="medium" style={{ display: 'block' }}>Name</Text>
                <TextField.Root id="add-security-name" placeholder="Acme Corp." {...register('name', { required: 'Name is required' })} {...fieldErrorProps('add-security-name', errors.name)} />
                <FieldError fieldId="add-security-name" message={errors.name?.message} />
              </Box>
            </Grid>
            <Controller
              control={control}
              name="security_type"
              render={({ field }) => (
                <label>
                  <Text as="div" size="2" mb="1" weight="medium">Type</Text>
                  <FormSelectRoot value={field.value} onValueChange={field.onChange}>
                    <Select.Trigger style={{ width: '100%' }} />
                    <Select.Content>{SECURITY_TYPES.map((t) => <Select.Item key={t} value={t}>{SECURITY_TYPE_LABELS[t]}</Select.Item>)}</Select.Content>
                  </FormSelectRoot>
                </label>
              )}
            />
            <label>
              <Text as="div" size="2" mb="1" weight="medium">Notes</Text>
              <TextArea {...register('notes')} placeholder="e.g. Category: Large Blend" rows={2} />
            </label>
            <Controller
              control={control}
              name="is_pass_through"
              render={({ field }) => (
                <Flex align="center" gap="2" width="fit-content" asChild>
                  <label>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                    <Text size="2">Pass-through fund (ETF / mutual fund — split into multiple weighted categories)</Text>
                  </label>
                </Flex>
              )}
            />
            <Text size="1" color="gray">After creating, open the security to set its classification (asset class, sector, …).</Text>
            <Flex gap="3" justify="end">
              <Button type="button" variant="soft" color="gray" onClick={() => navigate('/investments/securities')}>Cancel</Button>
              <Button type="submit" disabled={isSubmitting}>Create</Button>
            </Flex>
          </Flex>
        </form>
      </Card>
    </PageContainer>
  );
};

export default AddSecurityPage;
