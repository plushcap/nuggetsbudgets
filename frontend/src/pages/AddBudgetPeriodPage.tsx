import React from 'react';
import { useForm, Controller, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { budgetPeriodCreateSchema } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { useNavigate } from 'react-router-dom';
import { Plus, Calendar, AlertCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { CreateBudgetPeriodFormData, createDefaultBudgetPeriodForm } from '../types/forms';
import { useCreateManagedBudgetPeriodMutation } from '../hooks/queries';
import { Card, Grid, Flex, Text, Button, Select } from '@radix-ui/themes';
import FormSelectRoot from '../components/forms/FormSelectRoot';
import PageHeader from '../components/PageHeader';
import { apiErrorMessage } from '../utils/errors';
import PageContainer from '../components/PageContainer';

const AddBudgetPeriodPage: React.FC = () => {
  const navigate = useNavigate();
  const createPeriodMutation = useCreateManagedBudgetPeriodMutation();
  const loading = createPeriodMutation.isPending;

  const { handleSubmit, control } = useForm<CreateBudgetPeriodFormData>({
    defaultValues: createDefaultBudgetPeriodForm(),
    resolver: zodResolver(budgetPeriodCreateSchema) as never,
  });

  const onSubmit = async (data: CreateBudgetPeriodFormData) => {
    try {
      const result = await createPeriodMutation.mutateAsync([data.year, data.month]);

      toast.success(
        `Budget period created successfully! ${result.budget_items_created} budget items created, ${result.transactions_associated} transactions associated.`
      );

      navigate('/settings/budget-periods');
    } catch (error) {
      logger.error({ err: error }, 'Failed to create budget period');
      toast.error(apiErrorMessage(error, 'Failed to create budget period'));
    }
  };

  const [selectedYear, selectedMonth] = useWatch({ control, name: ['year', 'month'] });

  // Generate year options (current year +/- 5 years)
  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from(
    { length: 11 }, 
    (_, i) => currentYear - 5 + i
  );

  // Generate month options
  const monthOptions = [
    { value: 1, label: 'January' },
    { value: 2, label: 'February' },
    { value: 3, label: 'March' },
    { value: 4, label: 'April' },
    { value: 5, label: 'May' },
    { value: 6, label: 'June' },
    { value: 7, label: 'July' },
    { value: 8, label: 'August' },
    { value: 9, label: 'September' },
    { value: 10, label: 'October' },
    { value: 11, label: 'November' },
    { value: 12, label: 'December' }
  ];

  const getMonthName = (month: number) => {
    return monthOptions.find(m => m.value === month)?.label || '';
  };

  return (
    <PageContainer width="form">
      {/* Header */}
      <PageHeader
        title="Create Budget Period"
        subtitle="Add a new budget period with automatic rollover"
        icon={<Plus size={20} />}
        backPath="/settings/budget-periods"
      />

      {/* Info Card */}
      <Card mb="8" className="[--card-background-color:var(--accent-3)]">
        <Flex gap="3" align="start">
          <AlertCircle size={20} className="shrink-0 text-[var(--accent-11)]" style={{ marginTop: '2px' }} />
          <Flex direction="column" gap="2">
            <Text size="3" weight="medium" className="text-[var(--accent-11)]">
              What happens when you create a budget period?
            </Text>
            <Flex direction="column" gap="1" asChild>
              <ul className="text-[var(--accent-11)]" style={{ fontSize: 'var(--font-size-2)' }}>
                <li>• Budget items from previous periods will be rolled over with their settings</li>
                <li>• Envelope items will carry forward their remaining balances</li>
                <li>• Any existing transactions in this time period will be automatically associated</li>
                <li>• Default budget amounts will be applied to new period items</li>
              </ul>
            </Flex>
          </Flex>
        </Flex>
      </Card>

      {/* Form */}
      <Card>
        <form onSubmit={handleSubmit(onSubmit)}>
          <Flex direction="column" gap="6">
            <Grid columns={{ initial: '1', md: '2' }} gap="6">
              {/* Year Selection */}
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="year">
                  Year
                </Text>
                <Controller
                  control={control}
                  name="year"
                  render={({ field }) => (
                    <FormSelectRoot
                      value={field.value?.toString()}
                      onValueChange={(value) => field.onChange(parseInt(value))}
                      size="3"
                    >
                      <Select.Trigger id="year" />
                      <Select.Content>
                        {yearOptions.map(year => (
                          <Select.Item key={year} value={year.toString()}>
                            {year}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
              </Flex>

              {/* Month Selection */}
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium" as="label" htmlFor="month">
                  Month
                </Text>
                <Controller
                  control={control}
                  name="month"
                  render={({ field }) => (
                    <FormSelectRoot
                      value={field.value?.toString()}
                      onValueChange={(value) => field.onChange(parseInt(value))}
                      size="3"
                    >
                      <Select.Trigger id="month" />
                      <Select.Content>
                        {monthOptions.map(month => (
                          <Select.Item key={month.value} value={month.value.toString()}>
                            {month.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
              </Flex>
            </Grid>

            {/* Preview */}
            <Card variant="surface" className="[--card-background-color:var(--gray-3)]">
              <Flex direction="column" gap="2">
                <Text size="2" weight="medium">Period Preview</Text>
                <Flex align="center" gap="2" className="text-[var(--gray-11)]">
                  <Calendar size={16} />
                  <Text size="2">{getMonthName(selectedMonth)} {selectedYear}</Text>
                </Flex>
              </Flex>
            </Card>

            {/* Submit Buttons */}
            <Flex gap="3" pt="6">
              <Button
                type="button"
                onClick={() => navigate('/settings/budget-periods')}
                variant="soft"
                color="gray"
                size="3"
                className="flex-1"
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={loading}
                loading={loading}
                size="3"
                className="flex-1"
              >
                <Plus size={16} />
                Create Budget Period
              </Button>
            </Flex>
          </Flex>
        </form>
      </Card>
    </PageContainer>
  );
};

export default AddBudgetPeriodPage;
