import React, { useState, useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import { budgetItemCreateSchema, budgetExpenseType } from '@nuggets/shared';
import { logger } from '../utils/logger';
import { apiErrorMessage } from '../utils/errors';
import { sameOriginPath } from '../utils/safeUrls';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { DollarSign, Save, Archive } from 'lucide-react';
import { toast } from 'react-hot-toast';
import SettingsPageHeader from '../components/SettingsPageHeader';
import BudgetItemTransactionHistory from '../components/budget/BudgetItemTransactionHistory';
import {
  useBudgetItemsQuery,
  useBudgetItemTransactionsPage,
  useTagsQuery,
  useUpdateBudgetItemMutation,
} from '../hooks/queries';
import { getIconByName } from '../utils/iconCatalog';
import RetireBudgetItemDialog from '../components/budget/RetireBudgetItemDialog';
import { Card, Flex, Box, Text, Button } from '@radix-ui/themes';
import IncomeFormFields, { type IncomeFormData, createDefaultIncomeForm } from '../components/forms/IncomeFormFields';
import { EMPTY_LIST } from '../utils/emptyList';
import { useBudgetItemTags } from '../hooks/useBudgetItemTags';
import PageContainer from '../components/PageContainer';



/** Transactions per page in the history sidebar. */
const HISTORY_PER_PAGE = 20;

const EditIncomePage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const [searchParams] = useSearchParams();

  // Where Back, Cancel and leaving go: the returnTo parameter if it is a path on this app, else the list.
  const returnUrl = sameOriginPath(searchParams.get('returnTo')) ?? '/settings/income';

  // Data
  const { data: budgetItems = EMPTY_LIST, isLoading: itemsLoading } = useBudgetItemsQuery();
  const { data: tags = EMPTY_LIST, isLoading: tagsLoading } = useTagsQuery();
  const incomeItem = useMemo(
    () => budgetItems.find(item => item.uuid === uuid && item.expense_type === budgetExpenseType.enum.Income) ?? null,
    [budgetItems, uuid],
  );
  const loading = itemsLoading || tagsLoading;

  // The item's tags (saved as they change) and auto-tag (saved with the form).
  const { selectedTags, changeTags, autoTag, setAutoTag } = useBudgetItemTags(incomeItem, tags);
  // One page of this item's transactions at a time, from the server.
  const historyPage = useBudgetItemTransactionsPage(incomeItem?.uuid, HISTORY_PER_PAGE);

  const updateBudgetItemMutation = useUpdateBudgetItemMutation();
  const saving = updateBudgetItemMutation.isPending;
  const [retiring, setRetiring] = useState(false);


  const form = useForm<IncomeFormData>({
    defaultValues: createDefaultIncomeForm(),
    resolver: withUnreadableAmounts(zodResolver(budgetItemCreateSchema)) as never,
  });
  const { handleSubmit, reset, getValues } = form;

  // Populate the form (and auto-tag) when the income item loads.
  useEffect(() => {
    if (!incomeItem) return;

    reset({
      name: incomeItem.name,
      description: incomeItem.description || '',
      expense_type: 'Income',
      priority: 'Essential',
      type: 'Monthly',
      subtype: 'Fixed',
      rollover: false,
      isbill: false,
      // No amount (or 0) is left out.
      ...(incomeItem.default_budget_amount ? { default_budget_amount: incomeItem.default_budget_amount } : {}),
      notes: incomeItem.notes || '',
      instructions: incomeItem.instructions ?? '',
      color: incomeItem.color || '#10B981',
      icon: incomeItem.icon || 'DollarSign',
      category_id: null,
    });
  }, [incomeItem, tags, reset]);

  // Redirect when the income item can't be found after data has loaded.
  useEffect(() => {
    if (!loading && uuid && !incomeItem) {
      toast.error('Income item not found');
      navigate(returnUrl);
    }
  }, [loading, uuid, incomeItem, navigate, returnUrl]);



  const renderIcon = (iconName: string | undefined, size = 20) => {
    if (!iconName) return <DollarSign size={size} />;
    const iconOption = getIconByName(iconName);
    if (!iconOption) return <DollarSign size={size} />;
    const IconComponent = iconOption.component;
    return <IconComponent size={size} />;
  };

  const onSubmit = async () => {
    if (!incomeItem) return;

    try {
      const incomeData = {
        ...getValues(),
        expense_type: 'Income' as const,
        // An income item that rolls over keeps doing so: the page doesn't offer the change, and
        // once it has history the server refuses it.
        type: incomeItem.rollover ? incomeItem.type : 'Monthly',
        rollover: incomeItem.rollover === true,
        isbill: false,
        recurring_payment: false,
        transaction_auto_tag_id: autoTag?.id || null,
      };

      await updateBudgetItemMutation.mutateAsync({ uuid: incomeItem.uuid, data: incomeData });
      toast.success('Income updated successfully!');
      navigate(returnUrl);
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to save income');
      toast.error('Failed to save income');
    }
  };

  // Archive, merge or delete: the dialog offers what fits this item.
  const openRetire = () => setRetiring(true);

  if (loading) {
    return (
      <PageContainer width="editor">
        <Flex align="center" justify="center" py="9">
          <Text color="gray">Loading income...</Text>
        </Flex>
      </PageContainer>
    );
  }

  if (!incomeItem) {
    return (
      <PageContainer width="editor">
        <Flex align="center" justify="center" py="9">
          <Text color="red">Income not found</Text>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="editor">
      <Flex direction={{ initial: 'column', lg: 'row' }} gap="6">

        {/* Main Form Content */}
        <Box flexGrow="1" minWidth="0">
          {/* Header */}
          <SettingsPageHeader
            title="Edit Income"
            subtitle="Modify your income source details"
            icon={<div style={{ /* lint:guard colour: the income item's own colour */ color: incomeItem.color ?? undefined }}>{renderIcon(incomeItem.icon ?? undefined, 20)}</div>}
            iconBackground="bg-[var(--green-3)]"
            backPath={returnUrl}
            hideBackButton={false}
          />

          {/* Form */}
          <Card>
            <form onSubmit={handleSubmit(onSubmit)}>
              <Flex direction="column" gap="6">
                <IncomeFormFields
                  form={form}
                  loading={saving}
                  tags={tags}
                  selectedTags={selectedTags}
                  onTagsChange={changeTags}
                  autoTag={autoTag}
                  onAutoTagChange={setAutoTag}
                  budgetItemUuid={uuid}
                />

                {/* Form Actions */}
                <Flex direction={{ initial: 'column', md: 'row' }} justify="between" gap="3" pt="6" className="border-t border-[var(--gray-6)]">
                  {/* Archive or delete - stays on left */}
                  <Button
                    type="button"
                    variant="outline"
                    color="gray"
                    onClick={openRetire}
                  >
                    <Archive size={16} />
                    Archive or delete…
                  </Button>

                  {/* Cancel and Save buttons - grouped on right */}
                  <Flex gap="3">
                    <Button asChild variant="soft" color="gray" size="3">
                      <Link to={returnUrl}>Cancel</Link>
                    </Button>
                    <Button type="submit" disabled={saving} loading={saving} size="3">
                      <Save size={16} />
                      Save Changes
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </Card>
        </Box>

        {/* Transaction History Sidebar - Desktop Only */}
        <Box display={{ initial: 'none', md: 'block' }} width="320px">
          <Box style={{ marginTop: '6rem' }}>
            <BudgetItemTransactionHistory
              transactions={historyPage.transactions}
              total={historyPage.total}
              page={historyPage.page}
              onPageChange={historyPage.setPage}
              loading={historyPage.loading}
              error={historyPage.error ? apiErrorMessage(historyPage.error, 'Could not load the transactions') : null}
              recordsPerPage={HISTORY_PER_PAGE}
              emptyStateDescription="Income transactions will appear here once you start receiving income from this source"
              fallbackMerchantName="Income Source"
            />
          </Box>
        </Box>
      </Flex>

      {/* Confirmation Dialog */}
      {incomeItem && (
        <RetireBudgetItemDialog
          item={retiring ? { uuid: incomeItem.uuid, name: incomeItem.name, income: true } : null}
          onClose={() => setRetiring(false)}
          onDone={(outcome) => outcome !== 'restored' && navigate(returnUrl)}
        />
      )}
    </PageContainer>
  );
};

export default EditIncomePage;
