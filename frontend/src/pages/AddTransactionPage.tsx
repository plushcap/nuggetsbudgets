import React, { useEffect } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  REVIEW_STATUSES,
  REVIEW_STATUS_LABELS,
  TRANSACTION_STATUSES,
  TRANSACTION_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  transactionType,
  transactionStatus,
  transactionReviewStatus,
  assetType,
} from '@nuggets/shared';
import { TRANSACTION_TYPE_OPTIONS } from '../utils/vocabularyOptions';
import { logger } from '../utils/logger';
import { apiErrorMessage } from '../utils/errors';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, AlertTriangle
} from 'lucide-react';
import {
  useAccountQuery,
  useBudgetItemsQuery,
  useBudgetPeriodsQuery,
  useMerchantsQuery,
  useCreateMerchantMutation,
  useCreateTransactionMutation,
} from '../hooks/queries';
import toast from 'react-hot-toast';
import { CreateTransactionFormData, createDefaultTransactionForm } from '../types/forms';
import { Card, Select, TextArea, Badge, Flex, Grid, Box, Heading, Text, Button } from '@radix-ui/themes';
import FormSelectRoot from '../components/forms/FormSelectRoot';
import FieldError, { fieldErrorProps, fieldErrorDescribedBy } from '../components/forms/FieldError';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import RadixMerchantSelector from '../components/RadixMerchantSelector';
import RadixDatePicker from '../components/RadixDatePicker';
import CurrencyInput from '../components/CurrencyInput';
import { nullableAmountInput, refuseAmountPastColumn } from '../components/forms/optionalAmount';
import { periodChoices } from '../utils/budgetPeriods';
import { assignableBudgetItems } from '../utils/budgetItems';
import { focusFirstError } from '../utils/focusFirstError';
import { EMPTY_LIST } from '../utils/emptyList';
import PageContainer from '../components/PageContainer';
import { formatCurrency } from '../utils/currency';

/**
 * What Add Transaction accepts: a merchant, an amount other than zero and a date,
 * and the type and statuses the database allows (@nuggets/shared).
 */
export const addTransactionFormSchema = z.object({
  merchant_name: z.string().trim().min(1, 'Enter or choose a merchant.'),
  merchant_id: z.number().nullable(),
  amount: z
    .number({ error: 'Enter the amount.' })
    .nullable()
    .refine((value) => value !== null, 'Enter the amount.')
    .refine((value) => value !== 0, 'Enter an amount other than zero.')
    .superRefine(refuseAmountPastColumn),
  transaction_date: z.string().min(1, 'Pick the date.'),
  type: transactionType,
  status: transactionStatus,
  review_status: transactionReviewStatus,
  description: z.string(),
  budget_item_id: z.number().nullable(),
  budget_period_id: z.number().nullable(),
});

const TYPE_COLOR: Record<string, 'green' | 'red' | 'purple' | 'blue' | 'orange' | 'gray'> = {
  income: 'green',
  expense: 'red',
  payment: 'purple',
  transfer: 'blue',
  'balance adjustment': 'orange',
};


/** Each field's control, in the order the form shows them: the first with an error gets the focus. */
const FIELD_ORDER = [
  ['type', '#add-tx-type'],
  ['amount', '#add-tx-amount'],
  ['merchant_name', '#add-tx-merchant-field'],
  ['transaction_date', '#add-tx-date-field'],
  ['description', '#add-tx-description'],
] as const;

const AddTransactionPage: React.FC = () => {
  const { accountUuid } = useParams<{ accountUuid: string }>();
  const navigate = useNavigate();

  // Data
  const { data: account = null, isLoading: accountLoading } = useAccountQuery(accountUuid);
  const { data: budgetItems = EMPTY_LIST, isLoading: budgetItemsLoading } = useBudgetItemsQuery();
  const { data: budgetPeriods = EMPTY_LIST, isLoading: budgetPeriodsLoading } = useBudgetPeriodsQuery();
  const { data: merchants = EMPTY_LIST, isLoading: merchantsLoading } = useMerchantsQuery({ lite: true });
  const loading = accountLoading || budgetItemsLoading || budgetPeriodsLoading || merchantsLoading;

  const createMerchantMutation = useCreateMerchantMutation();
  const createTransactionMutation = useCreateTransactionMutation();

  const {
    control,
    register,
    handleSubmit,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<CreateTransactionFormData>({
    defaultValues: createDefaultTransactionForm(),
    resolver: zodResolver(addTransactionFormSchema) as never,
    // Most fields here are custom controls; focusFirstError (below) focuses them.
    shouldFocusError: false,
  });
  const [type, amount, merchantId] = useWatch({ control, name: ['type', 'amount', 'merchant_id'] });
  const saving = isSubmitting || createMerchantMutation.isPending;

  // Redirect when no account was provided in the route.
  useEffect(() => {
    if (!accountUuid) {
      toast.error('Account not found');
      navigate('/accounts');
    }
  }, [accountUuid, navigate]);

  const handleCreateNewMerchant = async (name: string) => {
    try {
      const newMerchant = await createMerchantMutation.mutateAsync({
        name: name,
        notes: `Created from transaction on ${new Date().toLocaleDateString()}`
      });
      setValue('merchant_name', newMerchant.name, { shouldValidate: true });
      setValue('merchant_id', newMerchant.id);
      toast.success(`Created new merchant: ${newMerchant.name}`);
    } catch (error) {
      logger.error({ err: error, merchantName: name }, 'Failed to create merchant');
      toast.error('Failed to create new merchant');
    }
  };

  const onSubmit = async (formData: CreateTransactionFormData) => {
    if (!account?.uuid) {
      toast.error('Account not found');
      return;
    }

    try {
      // If merchant name exists but no merchant_id, create the merchant first
      let merchantId = formData.merchant_id;

      if (formData.merchant_name && !merchantId) {
        logger.debug({ merchantName: formData.merchant_name }, 'Creating new merchant');
        try {
          const newMerchant = await createMerchantMutation.mutateAsync({
            name: formData.merchant_name.trim(),
            notes: `Auto-created from transaction on ${new Date().toLocaleDateString()}`
          });
          merchantId = newMerchant.id;
          toast.success(`Created new merchant: ${newMerchant.name}`);
        } catch (merchantError) {
          logger.error({ err: merchantError, merchantName: formData.merchant_name }, 'Failed to create merchant during transaction creation');
          toast.error('Failed to create merchant. Continuing without merchant.');
          // Continue without merchant - it's not critical
        }
      }

      // The merchant, period and item are left out when none is chosen.
      await createTransactionMutation.mutateAsync({
        account_uuid: account.uuid,
        ...(merchantId ? { merchant_id: merchantId } : {}),
        amount: formData.amount as number,
        description: formData.description,
        transaction_date: formData.transaction_date,
        type: formData.type,
        ...(formData.budget_period_id ? { budget_period_id: formData.budget_period_id } : {}),
        ...(formData.budget_item_id ? { budget_item_id: formData.budget_item_id } : {}),
        status: formData.status,
        review_status: formData.review_status
      });

      toast.success('Transaction created successfully');
      navigate(`/accounts/${account.uuid}`);
    } catch (error) {
      logger.error({ err: error }, 'Failed to create transaction');
      toast.error(apiErrorMessage(error, 'Failed to create transaction'));
    }
  };

  const handleCancel = () => {
    navigate(`/accounts/${account?.uuid || ''}`);
  };

  if (loading) {
    return (
      <PageContainer width="form">
        <PageLoader label="Loading…" />
      </PageContainer>
    );
  }

  if (!account) {
    return (
      <PageContainer width="form">
        <Flex direction="column" align="center" justify="center" gap="4" py="9">
          <AlertTriangle size={64} className="text-[var(--gray-11)]" />
          <Heading size="5">Account not found</Heading>
          <Text color="gray" align="center">The account you're looking for doesn't exist or may have been deleted.</Text>
          <Button onClick={() => navigate('/accounts')}>
            <ArrowLeft size={16} />
            Go to Accounts
          </Button>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="form">
      {/* Header - Consistent with Transaction Details */}
      <PageHeader
        title="Add Transaction"
        subtitle={`${account.name} • ${account.account_type}`}
        onBack={handleCancel}
      />

      {/* Form Content */}
      <Card>
        <Heading as="h2" size="4" mb="6">Transaction Information</Heading>

        <Flex asChild direction="column" gap="6">
        <form onSubmit={handleSubmit(onSubmit, (formErrors) => focusFirstError(formErrors, FIELD_ORDER))} noValidate>

          {/* Basic Information */}
          <Flex direction="column" gap="3">
            <Heading as="h3" size="2">Basic Information</Heading>
            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              {/* Transaction Type */}
              <Flex direction="column">
                <Text as="label" htmlFor="add-tx-type" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
                  Transaction Type
                </Text>
                <Controller
                  control={control}
                  name="type"
                  render={({ field }) => (
                    <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                      <Select.Trigger id="add-tx-type" {...fieldErrorProps('add-tx-type', errors.type)} />
                      <Select.Content>
                        {/* A liability account takes no income (the server refuses one). A
                            starting balance is the account's opening balance, which its form sets. */}
                        {TRANSACTION_TYPE_OPTIONS.filter(
                          (t) => t !== 'starting balance' && (t !== 'income' || account.type !== assetType.enum.Liability),
                        ).map((t) => (
                          <Select.Item key={t} value={t}>{TRANSACTION_TYPE_LABELS[t]}</Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
                <FieldError fieldId="add-tx-type" message={errors.type?.message} />
                <Box mt="2" aria-hidden="true">
                  <Badge color={TYPE_COLOR[type] ?? 'gray'} variant="soft">
                    {TRANSACTION_TYPE_LABELS[type]}
                  </Badge>
                </Box>
              </Flex>

              {/* Amount */}
              <Box>
                <Text as="label" htmlFor="add-tx-amount" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
                  Amount *
                </Text>
                <Controller
                  control={control}
                  name="amount"
                  render={({ field }) => (
                    <CurrencyInput
                      id="add-tx-amount"
                      required
                      {...nullableAmountInput(field.value, field.onChange)}
                      onBlur={field.onBlur}
                      size="3"
                      allowNegative
                      {...fieldErrorProps('add-tx-amount', errors.amount)}
                    />
                  )}
                />
                <FieldError fieldId="add-tx-amount" message={errors.amount?.message} />
                {amount !== null && Number.isFinite(amount) && amount !== 0 && (
                  <Text as="div" size="2" color="gray" mt="2">
                    Preview: {formatCurrency(amount)}
                  </Text>
                )}
              </Box>
            </Grid>
          </Flex>

          {/* Merchant and Date */}
          <Flex direction="column" gap="3" pt="2" className="border-t border-[var(--gray-6)]">
            <Heading as="h3" size="2">Merchant and Date</Heading>
            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              {/* Merchant Name */}
              <Box>
                <Text as="div" id="add-tx-merchant" size="2" weight="medium" mb="2">
                  Merchant Name *
                </Text>
                <Controller
                  control={control}
                  name="merchant_name"
                  render={({ field }) => (
                    <RadixMerchantSelector
                      id="add-tx-merchant-field"
                      aria-labelledby="add-tx-merchant"
                      clearable
                      value={field.value}
                      onChange={(value) => {
                        // A typed name isn't an existing merchant (yet).
                        field.onChange(value);
                        setValue('merchant_id', null);
                      }}
                      onSelectMerchant={(merchant) => {
                        if (!merchant) return;
                        field.onChange(merchant.name);
                        setValue('merchant_id', merchant.id);
                      }}
                      onCreateNew={handleCreateNewMerchant}
                      merchants={merchants}
                      loading={loading}
                      required={true}
                      error={errors.merchant_name?.message}
                      size="3"
                    />
                  )}
                />
                {merchantId && (
                  <Text as="div" size="1" color="green" mt="2" className="flex items-center gap-1" highContrast>
                    <Check size={12} aria-hidden="true" />
                    Using existing merchant
                  </Text>
                )}
              </Box>

              {/* Transaction Date */}
              <Box>
                <Text as="div" id="add-tx-date" size="2" weight="medium" mb="2">
                  Transaction Date *
                </Text>
                <Controller
                  control={control}
                  name="transaction_date"
                  render={({ field }) => (
                    <RadixDatePicker
                      id="add-tx-date-field"
                      aria-labelledby="add-tx-date"
                      aria-describedby={fieldErrorDescribedBy('add-tx-date-field', errors.transaction_date)}
                      value={field.value}
                      onChange={field.onChange}
                      placeholder="Select transaction date"
                      size="3"
                    />
                  )}
                />
                <FieldError fieldId="add-tx-date-field" message={errors.transaction_date?.message} />
              </Box>
            </Grid>
          </Flex>

          {/* Description */}
          <Box pt="2" className="border-t border-[var(--gray-6)]">
            <Text as="label" htmlFor="add-tx-description" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
              Description
            </Text>
            <TextArea
              id="add-tx-description"
              {...register('description')}
              placeholder="Enter description (optional)"
              rows={3}
              size="3"
              variant="surface"
            />
          </Box>

          {/* Budget Information */}
          <Flex direction="column" gap="3" pt="2" className="border-t border-[var(--gray-6)]">
            <Heading as="h3" size="2">Budget Information</Heading>
            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              {/* Budget Period */}
              <Flex direction="column">
                <Text as="label" htmlFor="add-tx-budget-period" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
                  Budget Period
                </Text>
                <Controller
                  control={control}
                  name="budget_period_id"
                  render={({ field }) => (
                    <FormSelectRoot
                      value={field.value?.toString() || 'none'}
                      onValueChange={(value) => field.onChange(value === 'none' ? null : Number(value))}
                      size="3"
                    >
                      <Select.Trigger id="add-tx-budget-period" />
                      <Select.Content>
                        <Select.Item value="none">Select budget period (optional)</Select.Item>
                        {periodChoices(budgetPeriods, field.value).map(period => (
                          <Select.Item key={period.id} value={period.id.toString()}>
                            {period.name}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
              </Flex>

              {/* Budget Item */}
              <Flex direction="column">
                <Text as="label" htmlFor="add-tx-budget-item" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
                  Budget Item
                </Text>
                <Controller
                  control={control}
                  name="budget_item_id"
                  render={({ field }) => (
                    <FormSelectRoot
                      value={field.value?.toString() || 'none'}
                      onValueChange={(value) => field.onChange(value === 'none' ? null : Number(value))}
                      size="3"
                    >
                      <Select.Trigger id="add-tx-budget-item" />
                      <Select.Content>
                        <Select.Item value="none">Select budget item (optional)</Select.Item>
                        {assignableBudgetItems(budgetItems).map(item => (
                          <Select.Item key={item.id} value={item.id.toString()}>
                            {item.name}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
              </Flex>
            </Grid>
          </Flex>

          {/* Transaction Settings */}
          <Flex direction="column" gap="3" pt="2" className="border-t border-[var(--gray-6)]">
            <Heading as="h3" size="2">Transaction Settings</Heading>
            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              {/* Status */}
              <Flex direction="column">
                <Text as="label" htmlFor="add-tx-status" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
                  Status
                </Text>
                <Controller
                  control={control}
                  name="status"
                  render={({ field }) => (
                    <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                      <Select.Trigger id="add-tx-status" />
                      <Select.Content>
                        {TRANSACTION_STATUSES.map((s) => (
                          <Select.Item key={s} value={s}>{TRANSACTION_STATUS_LABELS[s]}</Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
              </Flex>

              {/* Review Status */}
              <Flex direction="column">
                <Text as="label" htmlFor="add-tx-review-status" size="2" weight="medium" mb="2" style={{ display: 'block' }}>
                  Review Status
                </Text>
                <Controller
                  control={control}
                  name="review_status"
                  render={({ field }) => (
                    <FormSelectRoot value={field.value} onValueChange={field.onChange} size="3">
                      <Select.Trigger id="add-tx-review-status" />
                      <Select.Content>
                        {REVIEW_STATUSES.map((s) => (
                          <Select.Item key={s} value={s}>{REVIEW_STATUS_LABELS[s]}</Select.Item>
                        ))}
                      </Select.Content>
                    </FormSelectRoot>
                  )}
                />
              </Flex>
            </Grid>
          </Flex>

          {/* Form Actions. The button stays enabled: a refused submit names what's missing
              at each field and focuses the first one. */}
          <Flex align="center" justify="end" gap="3" pt="4" className="border-t border-[var(--gray-6)]">
            <Button
              type="button"
              variant="soft"
              color="gray"
              onClick={handleCancel}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving} loading={saving}>
              <Check size={16} />
              Create Transaction
            </Button>
          </Flex>
        </form>
        </Flex>
      </Card>
    </PageContainer>
  );
};

export default AddTransactionPage;
