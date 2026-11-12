import React, { useState, useEffect, useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import { budgetItemCreateSchema, formatMoney, budgetExpenseType } from '@nuggets/shared';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { CreditCard, Receipt, Save, Archive } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { currentPeriodFigures } from '../services/api';
import {
  useBudgetItemsQuery,
  useBudgetItemHistoryQuery,
  useCategoriesQuery,
  useTagsQuery,
  useBudgetItemTransactionsPage,
  useUpdateBudgetItemMutation,
} from '../hooks/queries';
import RetireBudgetItemDialog from '../components/budget/RetireBudgetItemDialog';
import NuggetSpinner from '../components/NuggetSpinner';
import { logger } from '../utils/logger';
import { apiErrorMessage } from '../utils/errors';
import { sameOriginPath } from '../utils/safeUrls';
import { Callout, Card, Flex, Box, Text, Button } from '@radix-ui/themes';
import { textColorProps } from '../utils/textColor';
import SettingsPageHeader from '../components/SettingsPageHeader';
import BudgetItemTransactionHistory from '../components/budget/BudgetItemTransactionHistory';
import ExpenseFormFields, { type ExpenseFormData, createDefaultExpenseForm } from '../components/forms/ExpenseFormFields';
import ConvertToBillDialog from '../components/bills/ConvertToBillDialog';
import { RolloverLockedNote, rolloverLockedText, useRolloverLocked } from '../components/budget/RolloverLockedNote';
import { EMPTY_LIST } from '../utils/emptyList';
import { useBudgetItemTags } from '../hooks/useBudgetItemTags';
import { amountSpent } from '../utils/budgetRemaining';
import PageContainer from '../components/PageContainer';

/** Transactions per page in the history sidebar. */
const HISTORY_PER_PAGE = 30;

/** The day of a date the API sent as 'YYYY-MM-DD' or as a timestamp ('YYYY-MM-DDT…'). */
// split always returns a first part, so [0] is there.
const dayPart = (value: string): string => value.split('T')[0]!;

const EditExpensePage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const [searchParams] = useSearchParams();

  const [converting, setConverting] = useState(false);

  const form = useForm<ExpenseFormData>({
    defaultValues: createDefaultExpenseForm(),
    resolver: withUnreadableAmounts(zodResolver(budgetItemCreateSchema)) as never,
  });
  const { handleSubmit, reset, getValues, control } = form;

  // Data
  const { data: budgetItems = EMPTY_LIST, isLoading: itemsLoading } = useBudgetItemsQuery();
  const { data: categories = [] } = useCategoriesQuery();
  const { data: tags = EMPTY_LIST, isLoading: tagsLoading } = useTagsQuery();
  const expenseItem = useMemo(
    () => budgetItems.find(item => item.uuid === uuid) ?? null,
    [budgetItems, uuid],
  );
  const loading = itemsLoading || tagsLoading;

  // The item's tags (saved as they change) and auto-tag (saved with the form).
  const { selectedTags, changeTags, autoTag, setAutoTag } = useBudgetItemTags(expenseItem, tags);
  // One page of this item's transactions at a time, from the server.
  const historyPage = useBudgetItemTransactionsPage(expenseItem?.uuid, HISTORY_PER_PAGE);

  const updateBudgetItemMutation = useUpdateBudgetItemMutation();
  const saving = updateBudgetItemMutation.isPending;
  const [retiring, setRetiring] = useState(false);


  // Where Back, Cancel and leaving go: the returnTo parameter if it is a path on this app, else the list.
  const returnUrl = sameOriginPath(searchParams.get('returnTo')) ?? '/settings/expenses';

  // Populate the form (and auto-tag) when the expense item loads.
  useEffect(() => {
    if (!expenseItem) return;

    reset({
      name: expenseItem.name,
      description: expenseItem.description || '',
      expense_type: (expenseItem.expense_type as 'Expense' | 'Income') || 'Expense',
      priority: (expenseItem.priority as 'Optional' | 'Essential') || 'Optional',
      type: (expenseItem.type as 'Monthly' | 'Envelope') || 'Monthly',
      subtype: (expenseItem.subtype as 'Fixed' | 'Flexible' | 'Paycheck') || 'Fixed',
      rollover: expenseItem.rollover || false,
      isbill: false, // Always false for expenses
      // An amount the item doesn't have (or has as 0), or no starting-balance date, is left out.
      ...(expenseItem.default_budget_amount ? { default_budget_amount: expenseItem.default_budget_amount } : {}),
      ...(expenseItem.rollover_target_amount ? { rollover_target_amount: expenseItem.rollover_target_amount } : {}),
      ...(expenseItem.rollover_starting_balance ? { rollover_starting_balance: expenseItem.rollover_starting_balance } : {}),
      ...(expenseItem.rollover_starting_balance_date ? { rollover_starting_balance_date: dayPart(expenseItem.rollover_starting_balance_date) } : {}),
      rollover_target_date: expenseItem.rollover_target_date ? dayPart(expenseItem.rollover_target_date) : null,
      notes: expenseItem.notes || '',
      instructions: expenseItem.instructions ?? '',
      color: expenseItem.color || '#3B82F6',
      icon: expenseItem.icon || 'CreditCard',
      category_id: expenseItem.category_id || null,
    });
  }, [expenseItem, tags, reset]);

  // Redirect when the expense can't be found after data has loaded.
  useEffect(() => {
    if (!loading && uuid && !expenseItem) {
      toast.error('Failed to load expense');
      navigate(returnUrl);
    }
  }, [loading, uuid, expenseItem, navigate, returnUrl]);

  // Supplementary budget progress for the current period: the item's figures there from
  // the event-sourced functions, one request. Keyed under the item, so a budget
  // edit (which invalidates budgetKeys.all) refreshes it.
  const currentHistory = useBudgetItemHistoryQuery(expenseItem?.uuid, 1, { enabled: !!expenseItem });
  const currentBudgetData = useMemo(() => currentPeriodFigures(currentHistory.data), [currentHistory.data]);
  const spent = currentBudgetData ? amountSpent(currentBudgetData.calculated_actual) : undefined;



  const onSubmit = async () => {
    // Its history fixes whether it rolls over: the note above the buttons says so,
    // and nothing is sent that the server would refuse.
    if (changesLockedRollover) {
      toast.error(rolloverLockedText(expenseItem!.name));
      return;
    }
    try {
      const expenseData = {
        ...getValues(),
        isbill: false, // Always false for expenses
        recurring_payment: false, // Always false for expenses
        transaction_auto_tag_id: autoTag?.id || null,
      };
      // Remove recurring payment fields since they're not used for expenses
      delete expenseData.recurring_payment_amount;
      delete expenseData.recurring_payment_frequency;
      delete expenseData.recurring_next_payment_date;

      await updateBudgetItemMutation.mutateAsync({ uuid: expenseItem!.uuid, data: expenseData });
      toast.success('Expense updated successfully!');
      navigate(returnUrl);
    } catch (error) {
      logger.error({ err: error, uuid }, 'Failed to update expense');
      toast.error((error instanceof Error && error.message) || 'Failed to update expense');
    }
  };

  // Archive, merge or delete: the dialog offers what fits this item.
  const openRetire = () => setRetiring(true);




  // Used by the "Progress Toward Goal" sidebar (envelope items only).
  const watchedTarget = useWatch({ control, name: 'rollover_target_amount' });
  // Monthly ↔ Envelope changes whether it rolls over, which its history may fix.
  const watchedRollover = useWatch({ control, name: 'rollover' });
  const rolloverLock = useRolloverLocked(expenseItem?.uuid);
  const changesLockedRollover = !!expenseItem && rolloverLock.locked && !!watchedRollover !== !!expenseItem.rollover;

  if (loading) {
    return (
      <PageContainer width="editor">
        <Flex direction="column" align="center" justify="center" gap="3" py="9">
          <NuggetSpinner size={48} />
          <Text color="gray">Loading expense...</Text>
        </Flex>
      </PageContainer>
    );
  }

  if (!expenseItem) {
    return (
      <PageContainer width="editor">
        <Flex align="center" justify="center" py="9">
          <Text color="red">Expense not found</Text>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="editor">
      {/* Header */}
        <SettingsPageHeader
          title="Edit Expense"
          subtitle="Update expense information and settings"
          icon={<CreditCard size={20} className="text-[var(--purple-11)]" />}
          iconBackground="bg-[var(--purple-3)]"
          backPath={returnUrl}
        />

        <Flex direction={{ initial: 'column', lg: 'row' }} gap={{ lg: '8' }}>

          {/* Main Form Content */}
          <Box flexGrow="1" minWidth="0">
            {/* Form */}
            <Card>
              <Box asChild p={{ initial: '4', sm: '5' }}><form onSubmit={handleSubmit(onSubmit)} >
                <Flex direction="column" gap="6">
                  <ExpenseFormFields
                    form={form}
                    categories={categories}
                    loading={loading}
                    tags={tags}
                    selectedTags={selectedTags}
                    onTagsChange={changeTags}
                    autoTag={autoTag}
                    onAutoTagChange={setAutoTag}
                    budgetItemUuid={uuid}
                    currentBalance={currentBudgetData ? Math.max(0, currentBudgetData.calculated_remaining) : null}
                  />
                  {changesLockedRollover && expenseItem && <RolloverLockedNote name={expenseItem.name} />}


                  {/* Form Actions */}
                  <Flex direction={{ initial: 'column', sm: 'row' }} justify="between" gap="3" pt="6" className="border-t border-[var(--gray-6)]">
                    <Flex direction={{ initial: 'column', sm: 'row' }} gap="3">
                      <Button
                    type="button"
                    variant="outline"
                    color="gray"
                    onClick={openRetire}
                  >
                    <Archive size={16} />
                    Archive or delete…
                  </Button>
                      {expenseItem && expenseItem.expense_type !== budgetExpenseType.enum.Income && (
                        <Button type="button" variant="soft" onClick={() => setConverting(true)}>
                          <Receipt size={16} />
                          Convert to bill
                        </Button>
                      )}
                    </Flex>

                    <Flex direction={{ initial: 'column', sm: 'row' }} gap="3">
                      <Button asChild variant="soft" color="gray">
                        <Link to={returnUrl}>Cancel</Link>
                      </Button>
                      <Button
                        type="submit"
                        disabled={saving}
                        loading={saving}
                      >
                        <Save size={16} />
                        Update Expense
                      </Button>
                    </Flex>
                  </Flex>
                </Flex>
              </form></Box>
            </Card>
          </Box>

          {/* Right Sidebar - History */}
          <Box display={{ initial: 'none', md: 'block' }} width="320px">
            <Flex direction="column" gap="6">
            
            {/* Progress Toward Goal Box */}
            {watchedTarget && watchedTarget > 0 && (
              <Card>
                <Flex direction="column" gap="4">
                  <Text size="4" weight="bold">Progress Toward Goal</Text>
                
                {currentBudgetData ? (
                  <Flex direction="column" gap="4">
                    {/* Goal Progress */}
                    <Flex direction="column" gap="2">
                      <Flex justify="between" align="center">
                        <Text size="2" color="gray">Target Amount</Text>
                        <Text size="2" weight="bold">
                          {formatMoney(Number(watchedTarget) || 0)}
                        </Text>
                      </Flex>
                      <Flex justify="between" align="center">
                        <Text size="2" color="gray">Current Savings</Text>
                        <Text size="2" weight="bold" color="green" highContrast>
                          {formatMoney(Number(Math.max(0, currentBudgetData.calculated_remaining)) || 0)}
                        </Text>
                      </Flex>
                      
                      {/* Progress Bar */}
                      <Box width="100%" height="12px" mb="2" className="rounded-full bg-[var(--gray-4)]">
                        <Box
                          height="12px" className="rounded-full transition-all duration-300 bg-[var(--green-9)]"
                          style={{
                            width: `${Math.min(100, Math.max(0, (Math.max(0, currentBudgetData.calculated_remaining) / watchedTarget) * 100))}%`,
                          }}
                        />
                      </Box>
                      
                      <Flex justify="between" align="center">
                        <Text size="1" color="gray">
                          {Math.round((Math.max(0, currentBudgetData.calculated_remaining) / watchedTarget) * 100)}% Complete
                        </Text>
                        <Text size="1" color="gray">
                          {formatMoney(Number(watchedTarget - Math.max(0, currentBudgetData.calculated_remaining)) || 0)} to go
                        </Text>
                      </Flex>
                    </Flex>
                    
                    {/* Budget Breakdown */}
                    <Flex direction="column" gap="1" pt="4" className="border-t border-[var(--gray-4)]">
                      {spent !== undefined && (
                        <Flex justify="between">
                          <Text size="1" color="gray">Previously Spent:</Text>
                          <Text size="1" weight="medium" color="red">
                            -{formatMoney(Number(spent) || 0)}
                          </Text>
                        </Flex>
                      )}
                      {currentBudgetData.calculated_transfers !== 0 && (
                        <Flex justify="between">
                          <Text size="1" color="gray">Transfers:</Text>
                          <Text size="1" weight="medium" {...textColorProps(currentBudgetData.calculated_transfers >= 0 ? 'green' : 'red')}>
                            {currentBudgetData.calculated_transfers >= 0 ? '+' : ''}{formatMoney(Number(currentBudgetData.calculated_transfers) || 0)}
                          </Text>
                        </Flex>
                      )}
                    </Flex>
                  </Flex>
                ) : currentHistory.isError ? (
                  <Callout.Root color="red" role="alert">
                    <Callout.Text>{apiErrorMessage(currentHistory.error, "Could not load this period's budget figures")}</Callout.Text>
                  </Callout.Root>
                ) : currentHistory.isLoading ? (
                  <Text color="gray" align="center">
                    Loading budget data...
                  </Text>
                ) : (
                  <Text color="gray" align="center">
                    No budget for this item in the current period
                  </Text>
                )}
                </Flex>
              </Card>
            )}
            
            <BudgetItemTransactionHistory
              transactions={historyPage.transactions}
              total={historyPage.total}
              page={historyPage.page}
              onPageChange={historyPage.setPage}
              loading={historyPage.loading}
              error={historyPage.error ? apiErrorMessage(historyPage.error, 'Could not load the transactions') : null}
              recordsPerPage={HISTORY_PER_PAGE}
              emptyStateDescription="Transactions will appear here once you start spending from this category"
            />
            
            </Flex>
          </Box>
        </Flex>

        {/* Confirmation Dialog */}
      {expenseItem && (
        <RetireBudgetItemDialog
          item={retiring ? { uuid: expenseItem.uuid, name: expenseItem.name, income: expenseItem.expense_type === budgetExpenseType.enum.Income } : null}
          onClose={() => setRetiring(false)}
          onDone={(outcome) => outcome !== 'restored' && navigate(returnUrl)}
        />
      )}
        {expenseItem && (
          <ConvertToBillDialog
            open={converting}
            onClose={() => setConverting(false)}
            item={{ uuid: expenseItem.uuid, name: expenseItem.name, rollover: expenseItem.rollover === true }}
            defaults={expenseItem.rollover
              ? {
                amount: expenseItem.rollover_target_amount ?? null,
                dueDate: expenseItem.rollover_target_date ? dayPart(expenseItem.rollover_target_date) : null,
              }
              : { amount: expenseItem.default_budget_amount ?? null, frequency: 1 }}
          />
        )}
      </PageContainer>
  );
};

export default EditExpensePage;
