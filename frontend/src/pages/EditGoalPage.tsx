import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { UNREADABLE_REQUIRED_AMOUNT_MESSAGE, withUnreadableAmounts } from '../components/forms/optionalAmount';
import { goalCreateSchema, formatMoney } from '@nuggets/shared';
import { useNavigate, useParams } from 'react-router-dom';
import { logger } from '../utils/logger';
import {
  Target, Calendar,
  Plus, Trash2, Wallet, Tag
} from 'lucide-react';
import { type Account } from '../services/api';
import {
  useGoalQuery,
  useAccountsQuery,
  useBudgetItemsQuery,
  useUpdateGoalMutation,
  useUploadGoalImageMutation,
  useDeleteGoalImageMutation,
  useAssociateAccountWithGoalMutation,
  useRemoveAccountFromGoalMutation,
  useAssociateBudgetItemWithGoalMutation,
  useRemoveBudgetItemFromGoalMutation,
} from '../hooks/queries';
import toast from 'react-hot-toast';
import { Card, Flex, Grid, Box, Heading, Text, Button, IconButton } from '@radix-ui/themes';
import PageHeader from '../components/PageHeader';
import PageLoader from '../components/PageLoader';
import BudgetItemNamespaceTags from '../components/BudgetItemNamespaceTags';
import GoalFormFields, { type GoalFormData, createDefaultGoalForm } from '../components/forms/GoalFormFields';
import { useSeededState } from '../hooks/useSeededState';
import PageContainer from '../components/PageContainer';

const EditGoalPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const { data: goalData, isLoading: loading } = useGoalQuery(uuid);
  const goal = goalData?.goal ?? null;

  const { data: allAccounts = [] } = useAccountsQuery();
  const availableAccounts = allAccounts.filter((a: Account) => !a.hide_account && !a.close_account);
  const { data: allBudgetItems = [] } = useBudgetItemsQuery();
  // Only show envelope items (rollover=true)
  const availableBudgetItems = allBudgetItems.filter(b => b.rollover);

  const updateGoalMutation = useUpdateGoalMutation();
  const uploadGoalImageMutation = useUploadGoalImageMutation();
  const deleteGoalImageMutation = useDeleteGoalImageMutation();
  const associateAccountMutation = useAssociateAccountWithGoalMutation();
  const removeAccountMutation = useRemoveAccountFromGoalMutation();
  const associateBudgetItemMutation = useAssociateBudgetItemWithGoalMutation();
  const removeBudgetItemMutation = useRemoveBudgetItemFromGoalMutation();
  const saving = updateGoalMutation.isPending || uploadGoalImageMutation.isPending;

  // Form state via react-hook-form (shared goalCreateSchema for validation).
  const form = useForm<GoalFormData>({
    defaultValues: createDefaultGoalForm(),
    resolver: withUnreadableAmounts(zodResolver(goalCreateSchema), { target_amount: UNREADABLE_REQUIRED_AMOUNT_MESSAGE }) as never,
  });
  const { handleSubmit, reset, getValues } = form;

  // Image (existing string path or a newly-chosen File) kept outside RHF; both
  // start as the goal's image each time it loads.
  const [goalImage, setGoalImage] = useSeededState<string | File | null>(
    (current) => (goal ? goal.image_path || null : (current ?? null)),
    [goal],
  );
  const [imagePreview, setImagePreview] = useSeededState<string | null>(
    (current) => (goal ? goal.image_path || null : (current ?? null)),
    [goal],
  );

  // Association selectors
  const [showAccountSelector, setShowAccountSelector] = useState(false);
  const [showBudgetItemSelector, setShowBudgetItemSelector] = useState(false);

  // Populate the form when the goal loads.
  useEffect(() => {
    if (!goal) return;
    reset({
      name: goal.name,
      description: goal.description || '',
      // A goal made as a budget item has no target or date: the form asks for them.
      target_amount: goal.target_amount ?? 0,
      // split always returns a first part, so [0] is there.
      target_date: goal.target_date == null ? '' : goal.target_date.split('T')[0]!,
      estimated_monthly_contribution: goal.estimated_monthly_contribution || 0,
      status: goal.status,
    });
  }, [goal, reset]);

  // GoalFormFields has checked it (imageUploadProblem), and says beside the button why not.
  const handleImageChange = (file: File) => {
    setGoalImage(file);
    const reader = new FileReader();
    reader.onloadend = () => setImagePreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const removeImage = async () => {
    if (goal?.image_path) {
      try {
        await deleteGoalImageMutation.mutateAsync(uuid!);
        toast.success('Image removed');
        setImagePreview(null);
        setGoalImage(null);
      } catch {
        toast.error('Failed to remove image');
      }
    } else {
      setGoalImage(null);
      setImagePreview(null);
    }
  };

  const handleAddAccount = async (accountId: number) => {
    try {
      await associateAccountMutation.mutateAsync({ uuid: uuid!, accountId });
      toast.success('Account linked to goal');
      setShowAccountSelector(false);
    } catch (error) {
      logger.error({ err: error, goalUuid: uuid }, 'Failed to add account to goal');
      toast.error('Failed to link account');
    }
  };

  const handleRemoveAccount = async (accountUuid: string) => {
    try {
      await removeAccountMutation.mutateAsync({ uuid: uuid!, accountUuid });
      toast.success('Account unlinked from goal');
    } catch (error) {
      logger.error({ err: error, goalUuid: uuid }, 'Failed to remove account from goal');
      toast.error('Failed to unlink account');
    }
  };

  const handleAddBudgetItem = async (budgetItemId: number) => {
    try {
      await associateBudgetItemMutation.mutateAsync({ uuid: uuid!, budgetItemId });
      toast.success('Budget item linked to goal');
      setShowBudgetItemSelector(false);
    } catch (error) {
      logger.error({ err: error, goalUuid: uuid }, 'Failed to add budget item to goal');
      toast.error('Failed to link budget item');
    }
  };

  const handleRemoveBudgetItem = async (budgetItemUuid: string) => {
    try {
      await removeBudgetItemMutation.mutateAsync({ uuid: uuid!, budgetItemUuid });
      toast.success('Budget item unlinked from goal');
    } catch (error) {
      logger.error({ err: error, goalUuid: uuid }, 'Failed to remove budget item from goal');
      toast.error('Failed to unlink budget item');
    }
  };

  // name + target_amount (> 0) + target_date are validated by goalCreateSchema.
  const onSubmit = async () => {
    const formData = { ...getValues(), goal_image: goalImage };

    try {
      await updateGoalMutation.mutateAsync({ uuid: uuid!, data: formData });

      if (formData.goal_image instanceof File) {
        await uploadGoalImageMutation.mutateAsync({ uuid: uuid!, formData: formData.goal_image });
      }

      toast.success('Goal updated successfully');
      navigate('/goals');
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to update goal');
      toast.error('Failed to update goal');
    }
  };


  // null for a goal with no target: it has no share of one.
  const calculateProgress = (): number | null => {
    if (!goal || goal.target_amount == null) return null;
    if (goal.target_amount <= 0) return 0;
    const current = goal.current_progress || 0;
    return Math.min((current / goal.target_amount) * 100, 100);
  };

  const associatedAccountIds = goal?.associated_accounts?.map(a => a.id) || [];
  const associatedBudgetItemIds = goal?.associated_budget_items?.map(b => b.id) || [];
  const unlinkedAccounts = availableAccounts.filter(a => !associatedAccountIds.includes(a.id));
  const unlinkedBudgetItems = availableBudgetItems.filter(b => !associatedBudgetItemIds.includes(b.id));

  if (loading) {
    return (
      <PageContainer width="editor">
        <PageLoader label="Loading goal…" />
      </PageContainer>
    );
  }

  if (!goal) return null;

  const progress = calculateProgress();

  return (
    <PageContainer width="editor">
      {/* Header */}
      <PageHeader
        title="Edit Goal"
        icon={<Target size={20} />}
        backPath="/goals"
      />

      <Grid columns={{ initial: '1', lg: '3' }} gap="6">
        {/* Left Column - Form */}
        <Box gridColumn={{ lg: 'span 2' }}>
          <Flex direction="column" gap="6">
            {/* Progress Card */}
            <Card>
              <Heading size="4" mb="4">Current Progress</Heading>

              <Box mb="4">
                <Flex align="center" justify="between" mb="2">
                  <Text size="2" weight="medium" color="gray">Progress</Text>
                  <Text size="7" weight="bold">{progress == null ? 'No target' : `${progress.toFixed(1)}%`}</Text>
                </Flex>
                <Box width="100%" height="16px" overflow="hidden" className="bg-[var(--gray-4)] rounded-full">
                  {progress != null && (
                    <Box
                      height="100%"
                      className={`transition-all duration-500 ${
                        progress >= 100 ? 'bg-[var(--green-9)]' :
                        progress >= 75 ? 'bg-[var(--accent-9)]' :
                        progress >= 50 ? 'bg-[var(--yellow-9)]' : 'bg-[var(--orange-9)]'
                      }`}
                      style={{ width: `${Math.min(progress, 100)}%` }}
                    />
                  )}
                </Box>
              </Box>

              <Grid columns="3" gap="4" mt="6">
                <Box className="bg-[var(--accent-3)] rounded-[var(--radius-4)]" p="4" style={{ textAlign: 'center' }}>
                  <Text as="p" size="1" color="gray" mb="1">Current</Text>
                  <Text size="4" weight="bold">
                    {formatMoney(goal.current_progress || 0)}
                  </Text>
                </Box>
                <Box className="bg-[var(--accent-3)] rounded-[var(--radius-4)]" p="4" style={{ textAlign: 'center' }}>
                  <Text as="p" size="1" color="gray" mb="1">Target</Text>
                  <Text size="4" weight="bold">
                    {goal.target_amount == null ? 'None' : formatMoney(goal.target_amount)}
                  </Text>
                </Box>
                <Box className="bg-[var(--green-3)] rounded-[var(--radius-4)]" p="4" style={{ textAlign: 'center' }}>
                  <Text as="p" size="1" color="gray" mb="1">Remaining</Text>
                  <Text size="4" weight="bold">
                    {goal.remaining_amount == null ? 'None' : formatMoney(goal.remaining_amount)}
                  </Text>
                </Box>
              </Grid>

              {goal.projection && (goal.projection.pastPerformanceDate || goal.projection.plannedContributionDate) && (
                <Box className="bg-[var(--gray-3)] rounded-[var(--radius-4)]" mt="4" p="4">
                  <Flex align="center" gap="2" className="text-[var(--gray-11)]">
                    <Calendar size={16} />
                    <Text size="2">
                      Projected completion: <Text weight="bold" ml="2">
                        {goal.projection.pastPerformanceDate || goal.projection.plannedContributionDate || 'Unknown'}
                      </Text>
                    </Text>
                  </Flex>
                </Box>
              )}
            </Card>

            {/* Edit Form */}
            <Card>
              <Flex asChild direction="column" gap="6">
              <form onSubmit={handleSubmit(onSubmit)}>
                <Heading size="4">Goal Details</Heading>

                <GoalFormFields
                  form={form}
                  imagePreview={imagePreview}
                  onImageChange={handleImageChange}
                  onRemoveImage={removeImage}
                />

                <Flex gap="3" pt="4" className="border-t border-[var(--gray-6)]">
                  <Button
                    type="button"
                    variant="soft"
                    color="gray"
                    onClick={() => navigate('/goals')}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={saving}
                    loading={saving}
                    className="flex-1"
                  >
                    Save Changes
                  </Button>
                </Flex>
              </form>
              </Flex>
            </Card>
          </Flex>
        </Box>

        {/* Right Column - Associations */}
        <Flex direction="column" gap="6">
          {/* Associated Accounts */}
          <Card>
            <Flex align="center" justify="between" mb="4">
              <Flex align="center" gap="2">
                <Wallet size={20} className="text-[var(--gray-11)]" />
                <Heading size="4">Linked Accounts</Heading>
              </Flex>
              <IconButton
                onClick={() => setShowAccountSelector(!showAccountSelector)}
                variant="soft"
                aria-label="Add account to goal"
              >
                <Plus size={16} />
              </IconButton>
            </Flex>

            {showAccountSelector && unlinkedAccounts.length > 0 && (
              <Flex direction="column" gap="2" mb="4" p="4" className="bg-[var(--accent-3)] rounded-[var(--radius-4)]">
                <Text size="2" weight="medium" mb="2">Select account to link:</Text>
                {unlinkedAccounts.map(account => (
                  <Button
                    key={account.id}
                    onClick={() => handleAddAccount(account.id)}
                    variant="soft"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                  >
                    {account.name}
                  </Button>
                ))}
              </Flex>
            )}

            {goal.associated_accounts && goal.associated_accounts.length > 0 ? (
              <Flex direction="column" gap="3">
                {goal.associated_accounts.map(account => {
                  // null = unavailable: show it, never $0.
                  const rawBalance = account.calculated_balance;
                  const balance = rawBalance == null ? null : Number(rawBalance) || 0;
                  return (
                    <Flex key={account.id} align="center" justify="between" p="3" className="bg-[var(--gray-3)] rounded-[var(--radius-4)]">
                      <Box>
                        <Text as="p" size="2" weight="medium">{account.name}</Text>
                        <Text size="2" className="text-[var(--green-12)]">{balance === null ? 'Unavailable' : formatMoney(balance)}</Text>
                      </Box>
                      <IconButton
                        onClick={() => handleRemoveAccount(account.uuid)}
                        color="red"
                        variant="soft"
                        aria-label="Unlink account"
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </Flex>
                  );
                })}
                <Box pt="2" className="border-t border-[var(--gray-6)]">
                  <Text as="p" size="2" color="gray">Total from accounts:</Text>
                  <Text size="6" weight="bold" className="text-[var(--green-12)]">
                    {goal.associated_accounts.some((account) => account.calculated_balance == null)
                      ? 'Unavailable'
                      : formatMoney(
                        goal.associated_accounts.reduce((sum, account) => {
                          const balance = Number(account.calculated_balance) || 0;
                          return sum + balance;
                        }, 0)
                      )}
                  </Text>
                </Box>
              </Flex>
            ) : (
              <Text as="p" size="2" color="gray" align="center" className="py-4">
                No accounts linked yet
              </Text>
            )}
          </Card>

          {/* Associated Budget Items */}
          <Card>
            <Flex align="center" justify="between" mb="4">
              <Flex align="center" gap="2">
                <Tag size={20} className="text-[var(--gray-11)]" />
                <Heading size="4">Linked Envelopes</Heading>
              </Flex>
              <IconButton
                onClick={() => setShowBudgetItemSelector(!showBudgetItemSelector)}
                variant="soft"
                aria-label="Add envelope to goal"
              >
                <Plus size={16} />
              </IconButton>
            </Flex>

            {showBudgetItemSelector && unlinkedBudgetItems.length > 0 && (
              <Flex direction="column" gap="2" mb="4" p="4" className="bg-[var(--accent-3)] rounded-[var(--radius-4)]">
                <Text size="2" weight="medium" mb="2">Select envelope to link:</Text>
                {unlinkedBudgetItems.map(item => (
                  <Button
                    key={item.id}
                    onClick={() => handleAddBudgetItem(item.id)}
                    variant="soft"
                    style={{ width: '100%', justifyContent: 'flex-start' }}
                  >
                    {item.name}
                  </Button>
                ))}
              </Flex>
            )}

            {goal.associated_budget_items && goal.associated_budget_items.length > 0 ? (
              <Flex direction="column" gap="3">
                {goal.associated_budget_items.map(item => (
                  <Flex key={item.id} align="center" justify="between" p="3" className="bg-[var(--gray-3)] rounded-[var(--radius-4)]">
                    <Box>
                      <Text as="p" size="2" weight="medium">{item.name}</Text>
                    </Box>
                    <IconButton
                      onClick={() => handleRemoveBudgetItem(item.uuid)}
                      color="red"
                      variant="soft"
                      aria-label="Unlink envelope"
                    >
                      <Trash2 size={16} />
                    </IconButton>
                  </Flex>
                ))}
                <Box pt="2" className="border-t border-[var(--gray-6)]">
                  <Text as="p" size="2" color="gray">Total from envelopes:</Text>
                  <Text size="6" weight="bold" className="text-[var(--green-12)]">
                    {formatMoney(goal.total_from_budget_items || 0)}
                  </Text>
                </Box>
              </Flex>
            ) : (
              <Text as="p" size="2" color="gray" align="center" className="py-4">
                No budget items linked yet
              </Text>
            )}
          </Card>

          {/* Report namespace tags — goals are budget_items, so they tag the same way */}
          <BudgetItemNamespaceTags budgetItemUuid={uuid} />
        </Flex>
      </Grid>
    </PageContainer>
  );
};

export default EditGoalPage;
