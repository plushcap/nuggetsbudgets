import React, { useState, useEffect, useMemo } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { withUnreadableAmounts } from '../components/forms/optionalAmount';
import { budgetItemCreateSchema, formatMoney, budgetEventTransactionType } from '@nuggets/shared';
import { useNavigate, useParams, useSearchParams, Link } from 'react-router-dom';
import { Receipt, Save, Archive, ArrowLeftRight } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { currentPeriodFigures, type BudgetEventHistory, type BudgetItem } from '../services/api';
import {
  useBudgetItemsQuery,
  useBudgetItemHistoryQuery,
  useTagsQuery,
  useBudgetItemTransactionsPage,
  useBudgetEventHistoryQuery,
  useUpdateBudgetItemMutation,
} from '../hooks/queries';
import { logger } from '../utils/logger';
import RetireBudgetItemDialog from '../components/budget/RetireBudgetItemDialog';
import ConvertToExpenseDialog from '../components/bills/ConvertToExpenseDialog';
import { RolloverLockedNote, rolloverLockedText, useRolloverLocked } from '../components/budget/RolloverLockedNote';
import { DateUtils, formatInstantDate, toCalendarDateString } from '../utils/dateUtils';
import { Callout, Card, Flex, Box, Text, Button, ScrollArea } from '@radix-ui/themes';
import { textColorProps } from '../utils/textColor';
import SettingsPageHeader from '../components/SettingsPageHeader';
import ProgressTowardGoalCard from '../components/ProgressTowardGoalCard';
import BudgetItemTransactionHistory from '../components/budget/BudgetItemTransactionHistory';
import { EMPTY_LIST } from '../utils/emptyList';
import { apiErrorMessage } from '../utils/errors';
import { sameOriginPath } from '../utils/safeUrls';
import { useBudgetItemTags } from '../hooks/useBudgetItemTags';
import BillFormFields, {
  type BillFormData,
  createDefaultBillForm,
} from '../components/forms/BillFormFields';
import { calculateNextPaymentDate } from '../utils/billSchedule';
import { amountSpent } from '../utils/budgetRemaining';
import { centsToAmount, perMonthRoundedUp, toCents } from '../utils/currency';
import PageContainer from '../components/PageContainer';


/** Transactions per page in the history sidebar. */
const HISTORY_PER_PAGE = 10;

/** The day of a date the API sent as 'YYYY-MM-DD' or as a timestamp ('YYYY-MM-DDT…'). */
// split always returns a first part, so [0] is there.
const dayPart = (value: string): string => value.split('T')[0]!;

/**
 * The frequency the form starts from: the bill's, or Monthly for one below 1, which an item may
 * hold from before the API refused it (no schedule: the Bills page leaves it out).
 * The select shows Monthly for it, and saving saves that.
 */
export const formFrequency = (months: number | null | undefined): number => (months != null && months >= 1 ? months : 1);

/**
 * The kind a bill is saved as with `frequency` (months): a monthly bill is paid from the month's
 * budget and a less frequent one saves up as an envelope, so a change of frequency across monthly
 * makes it the other kind. Any other save keeps the type and rollover it holds.
 */
export function billKindAfterSave(
  bill: Pick<BudgetItem, 'type' | 'rollover' | 'recurring_payment_frequency'>,
  frequency: number,
): { type: string | null; rollover: boolean } {
  const saved = formFrequency(bill.recurring_payment_frequency);
  if ((frequency > 1) !== (saved > 1)) return { type: frequency > 1 ? 'Envelope' : 'Monthly', rollover: frequency > 1 };
  return { type: bill.type, rollover: bill.rollover === true };
}

const EditBillsPage: React.FC = () => {
  const navigate = useNavigate();
  const { uuid } = useParams<{ uuid: string }>();
  const [searchParams] = useSearchParams();

  const form = useForm<BillFormData>({
    defaultValues: createDefaultBillForm(),
    resolver: withUnreadableAmounts(zodResolver(budgetItemCreateSchema)) as never,
  });
  const { handleSubmit, reset, control } = form;

  // Watched values consumed by the "Progress Toward Goal" sidebar.
  const [watchedDefaultBudget, watchedFrequency, watchedTarget, watchedNextDate] = useWatch({
    control,
    name: ['default_budget_amount', 'recurring_payment_frequency', 'rollover_target_amount', 'recurring_next_payment_date'],
  });

  // Data
  const { data: budgetItems = EMPTY_LIST, isLoading: itemsLoading } = useBudgetItemsQuery();
  const { data: tags = EMPTY_LIST, isLoading: tagsLoading } = useTagsQuery();
  const billItem = useMemo(
    () => budgetItems.find(item => item.uuid === uuid && item.isbill === true) ?? null,
    [budgetItems, uuid],
  );
  const loading = itemsLoading || tagsLoading;
  // A monthly bill doesn't roll over and a less frequent one does, but only a change of frequency
  // across monthly changes that: a bill made through the API or MCP may hold either,
  // and every save sent `frequency > 1`, so such a bill with history refused even a name change.
  // A change its history fixes is refused.
  const rolloverLock = useRolloverLocked(billItem?.uuid);
  const kindAfter = billItem ? billKindAfterSave(billItem, watchedFrequency || 1) : null;
  const changesLockedRollover = !!billItem && !!kindAfter && rolloverLock.locked && kindAfter.rollover !== (billItem.rollover === true);

  // The item's tags (saved as they change) and auto-tag (saved with the form).
  const { selectedTags, changeTags, autoTag, setAutoTag } = useBudgetItemTags(billItem, tags);
  // One page of this bill's transactions at a time, from the server.
  const historyPage = useBudgetItemTransactionsPage(billItem?.uuid, HISTORY_PER_PAGE);
  const { data: eventHistory, isLoading: eventHistoryLoading } = useBudgetEventHistoryQuery(billItem?.uuid as string);

  const updateBudgetItemMutation = useUpdateBudgetItemMutation();
  const saving = updateBudgetItemMutation.isPending;
  const [retiring, setRetiring] = useState(false);
  const [converting, setConverting] = useState(false);

  // The item's budget event history (budget set, moved, rolled over).
  const budgetTransactions: BudgetEventHistory[] = eventHistory?.data || [];

  // Where Back, Cancel and leaving go: the returnTo parameter if it is a path on this app, else the list.
  const returnUrl = sameOriginPath(searchParams.get('returnTo')) ?? '/settings/bills';

  // Populate the form (and auto-tag + envelope warning) when the bill loads.
  useEffect(() => {
    if (!billItem) return;

    // A payment amount, a date or instructions the bill doesn't have are left out (empty fields).
    const nextPaymentDate = billItem.recurring_next_payment_date;
    const startingBalanceDate = billItem.rollover_starting_balance_date;
    reset({
      name: billItem.name,
      merchant_id: billItem.merchant_id || null,
      ...(billItem.recurring_payment_amount != null ? { recurring_payment_amount: billItem.recurring_payment_amount } : {}),
      recurring_amount_varies: billItem.recurring_amount_varies === true,
      recurring_payment_frequency: formFrequency(billItem.recurring_payment_frequency),
      category_id: billItem.category_id || null,
      ...(nextPaymentDate ? { recurring_next_payment_date: dayPart(nextPaymentDate) } : {}),
      icon: billItem.icon,
      color: billItem.color || '#F59E0B',
      default_budget_amount: billItem.default_budget_amount,
      rollover_target_amount: billItem.rollover_target_amount,
      rollover_starting_balance: billItem.rollover_starting_balance,
      ...(startingBalanceDate ? { rollover_starting_balance_date: dayPart(startingBalanceDate) } : {}),
      notes: billItem.notes,
      ...(billItem.instructions != null ? { instructions: billItem.instructions } : {}),
    });
  }, [billItem, tags, reset]);

  // Redirect when the bill can't be found after data has loaded.
  useEffect(() => {
    if (!loading && uuid && !billItem) {
      toast.error('Bill not found');
      navigate(returnUrl);
    }
  }, [loading, uuid, billItem, navigate, returnUrl]);

  // Supplementary budget progress for the current period: the item's figures there from
  // the event-sourced functions, one request. Keyed under the item, so a budget
  // edit (which invalidates budgetKeys.all) refreshes it.
  const currentHistory = useBudgetItemHistoryQuery(billItem?.uuid, 1, { enabled: !!billItem });
  const currentBudgetData = useMemo(() => currentPeriodFigures(currentHistory.data), [currentHistory.data]);




  // Use common date formatting utility
  const formatDate = (dateString: string) => DateUtils.formatDateUS(dateString);

  // Calculate expected total by next payment date
  const calculateExpectedTotal = (): { amount: number; status: 'success' | 'warning' | 'danger' } | null => {
    if (!currentBudgetData || !watchedTarget || watchedTarget <= 0) {
      return null;
    }

    const nextPaymentDate = calculateNextPaymentDate(watchedNextDate, watchedFrequency);
    if (!nextPaymentDate) {
      return null;
    }
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Calculate months until next payment
    const monthsUntilPayment = (nextPaymentDate.getFullYear() - today.getFullYear()) * 12 + 
                               (nextPaymentDate.getMonth() - today.getMonth());
    
    // Expected total = current savings + (monthly budget * months remaining)
    const currentSavings = Math.max(0, currentBudgetData.calculated_remaining);
    const monthlyBudget = watchedDefaultBudget || 0;
    const expectedTotal = currentSavings + (monthlyBudget * monthsUntilPayment);

    // Determine status based on target amount
    const targetAmount = watchedTarget;
    let status: 'success' | 'warning' | 'danger';
    
    if (expectedTotal < targetAmount) {
      status = 'danger'; // Red: won't have enough
    } else if (expectedTotal < targetAmount * 1.05) {
      status = 'warning'; // Yellow: within 5% buffer
    } else {
      status = 'success'; // Green: over the amount
    }
    
    return { amount: expectedTotal, status };
  };

  // The values the resolver passes on, not getValues(): an envelope amount hidden by a monthly
  // frequency that can't be read is left out there (withUnreadableAmounts).
  const onSubmit = async (formData: BillFormData) => {
    if (!billItem) return;
    // Its history fixes whether it rolls over: the note says so; nothing is sent.
    if (changesLockedRollover) {
      toast.error(rolloverLockedText(billItem.name));
      return;
    }

    try {
      const frequency = formData.recurring_payment_frequency || 1;

      // Calculate default_budget_amount if not provided
      let defaultBudgetAmount = formData.default_budget_amount;
      if (!defaultBudgetAmount && formData.recurring_payment_amount) {
        const startingBalance = formData.rollover_starting_balance || 0;
        // In whole cents, rounded up only when the months don't divide it: Math.ceil(x * 100)
        // asked 150.31 of a 150.30 bill.
        const remaining = centsToAmount(Math.max(0, toCents(formData.recurring_payment_amount) - toCents(startingBalance)));
        defaultBudgetAmount = perMonthRoundedUp(remaining, frequency);
      }

      const submitData = {
        ...formData,
        // Bill-specific defaults
        recurring_payment: true,
        isbill: true,
        expense_type: 'Expense' as const,
        subtype: 'Fixed' as const,
        // Its kind (type and rollover): kept, unless the frequency moves across monthly.
        ...billKindAfterSave(billItem, frequency),
        recurring_payment_frequency: frequency,
        // Left out when the form has none.
        ...(defaultBudgetAmount !== undefined ? { default_budget_amount: defaultBudgetAmount } : {}),
        transaction_auto_tag_id: autoTag?.id || null,
      };

      await updateBudgetItemMutation.mutateAsync({ uuid: billItem.uuid, data: submitData });
      toast.success('Bill updated successfully');
      navigate(returnUrl);
    } catch (err) {
      logger.error({ err, uuid }, 'Failed to update bill');
      toast.error((err instanceof Error && err.message) || 'Failed to update bill');
    }
  };

  // Archive, merge or delete: the dialog offers what fits this item.
  const openRetire = () => setRetiring(true);

  if (loading) {
    return (
      <PageContainer width="editor">
        <Flex align="center" justify="center" py="9">
          <Text color="gray">Loading bill...</Text>
        </Flex>
      </PageContainer>
    );
  }

  if (!billItem) {
    return (
      <PageContainer width="editor">
        <Flex align="center" justify="center" py="9">
          <Text color="red">Bill not found</Text>
        </Flex>
      </PageContainer>
    );
  }

  return (
    <PageContainer width="editor">
      {/* Header */}
      <SettingsPageHeader
        title="Edit Bill"
        subtitle="Update bill information and settings"
        icon={<Receipt size={20} className="text-[var(--orange-12)]" />}
        iconBackground="bg-[var(--orange-3)]"
        backPath={returnUrl}
      />

      <Flex direction={{ initial: 'column', lg: 'row' }} gap="6">

        {/* Main Form Content */}
        <Box flexGrow="1" minWidth="0">
          {/* Form */}
          <Card>
              <form onSubmit={handleSubmit(onSubmit)}>
                <Flex direction="column" gap="6">
                  <BillFormFields
                    form={form}
                    loading={saving}
                    tags={tags}
                    selectedTags={selectedTags}
                    onTagsChange={changeTags}
                    autoTag={autoTag}
                    onAutoTagChange={setAutoTag}
                    budgetItemUuid={uuid}
                    currentBudgetData={currentBudgetData}
                  />
                  {changesLockedRollover && billItem && <RolloverLockedNote name={billItem.name} />}


                {/* Form Actions */}
                <Flex direction={{ initial: 'column', md: 'row' }} justify="between" gap="3" pt="6" className="border-t border-[var(--gray-6)]">
                  <Flex direction={{ initial: 'column', md: 'row' }} gap="3">
                    <Button
                      type="button"
                      variant="outline"
                      color="gray"
                      onClick={openRetire}
                    >
                      <Archive size={16} />
                      Archive or delete…
                    </Button>
                    <Button type="button" variant="soft" onClick={() => setConverting(true)}>
                      <ArrowLeftRight size={16} />
                      Convert to expense
                    </Button>
                  </Flex>

                  <Flex gap="3" direction={{ initial: 'column-reverse', md: 'row' }}>
                    <Button asChild variant="soft" color="gray" size="3">
                      <Link to={returnUrl}>
                        Cancel
                      </Link>
                    </Button>
                    <Button
                      type="submit"
                      disabled={saving}
                      loading={saving}
                      size="3"
                    >
                      <Save size={16} />
                      Save Changes
                    </Button>
                  </Flex>
                </Flex>
              </Flex>
            </form>
          </Card>
        </Box>

        {/* Right Sidebar - Desktop only */}
        <Box display={{ initial: 'none', md: 'block' }} width="320px">
          <Flex direction="column" gap="6">
            
            {/* Progress Toward Goal Box */}
            {watchedTarget && watchedTarget > 0 && currentHistory.isError && (
              <Callout.Root color="red" role="alert">
                <Callout.Text>{apiErrorMessage(currentHistory.error, "Could not load this period's budget figures")}</Callout.Text>
              </Callout.Root>
            )}
            {watchedTarget && watchedTarget > 0 && currentBudgetData && (
              <ProgressTowardGoalCard
                targetAmount={watchedTarget}
                currentSavings={Math.max(0, currentBudgetData.calculated_remaining)}
                monthlyBudget={currentBudgetData.calculated_budget}
                monthlySpent={currentBudgetData.calculated_actual}
                previouslySpent={amountSpent(currentBudgetData.calculated_actual)}
                transfers={currentBudgetData.calculated_transfers !== 0 ? currentBudgetData.calculated_transfers : undefined}
                expectedTotal={(() => {
                  const expectedTotal = calculateExpectedTotal();
                  const nextPaymentDate = calculateNextPaymentDate(watchedNextDate, watchedFrequency);
                  if (expectedTotal && nextPaymentDate) {
                    return {
                      amount: expectedTotal.amount,
                      date: formatDate(toCalendarDateString(nextPaymentDate)),
                      status: expectedTotal.status
                    };
                  }
                  return null;
                })()}
              />
            )}
            
            {/* History: the bill's transactions, a page at a time (the edit pages' shared panel) */}
            <BudgetItemTransactionHistory
              transactions={historyPage.transactions}
              total={historyPage.total}
              page={historyPage.page}
              onPageChange={historyPage.setPage}
              loading={historyPage.loading}
              error={historyPage.error ? apiErrorMessage(historyPage.error, 'Could not load the transactions') : null}
              recordsPerPage={HISTORY_PER_PAGE}
              emptyStateDescription="Transactions will appear here once this bill is paid"
            />

            {/* Budget changes, by period */}
            <Card>
              <Flex direction="column" gap="4">
                <Text size="5" weight="bold">Budget Changes</Text>
                <ScrollArea style={{ maxHeight: '24rem' }}>
                  {eventHistoryLoading ? (
                    <Flex direction="column" align="center" gap="3" py="8">
                      <Box height="24px" width="24px" className="animate-spin rounded-full border-b-2 border-[var(--accent-9)]" />
                      <Text size="2" color="gray">Loading history...</Text>
                    </Flex>
                  ) : (
                    budgetTransactions.length > 0 ? (
                      // Group transactions by period for better organization
                      (() => {
                        const groupedTransactions = budgetTransactions.reduce<Record<string, BudgetEventHistory[]>>((groups, transaction) => {
                          const periodName = transaction.periodName || 'No Period';
                          if (!groups[periodName]) {
                            groups[periodName] = [];
                          }
                          groups[periodName].push(transaction);
                          return groups;
                        }, {});

                        return (
                          <Flex direction="column" gap="4">
                            {Object.entries(groupedTransactions)
                              .slice(0, 3) // Limit to recent 3 periods
                              .map(([periodName, transactions]) => (
                                <Flex direction="column" gap="2" key={periodName}>
                                  {/* Period Header */}
                                  <Text size="1" weight="bold" color="gray" className="border-b border-[var(--gray-6)]" style={{ paddingBottom: '4px' }}>
                                    {periodName}
                                  </Text>
                                
                                  {/* Transactions in this period */}
                                  <Flex direction="column" gap="3" ml="2">
                                    {transactions.slice(0, 5).map((budgetTransaction, index) => (
                                      <Flex direction="column" gap="1" key={`${budgetTransaction.eventId}-${index}`}>
                                        <Flex justify="between" align="start">
                                          <Flex direction="column" gap="1" flexGrow="1" flexBasis="0%" minWidth="0">
                                            <Text size="2" weight="medium">
                                              {budgetTransaction.eventType.replace('_', ' ').toUpperCase()}
                                            </Text>
                                            <Text size="1" color="gray" truncate>
                                              {budgetTransaction.description}
                                            </Text>
                                            <Text size="1" color="gray">
                                              {formatInstantDate(budgetTransaction.timestamp, 'en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })}
                                              {budgetTransaction.userName && ` • ${budgetTransaction.userName}`}
                                            </Text>
                                          </Flex>
                                          <Text
                                            size="2"
                                            weight="bold"
                                            {...textColorProps(
                                              budgetTransaction.transactionType === budgetEventTransactionType.enum.add || budgetTransaction.transactionType === budgetEventTransactionType.enum.move_in
                                                ? 'green'
                                                : 'red',
                                            )}
                                            ml="2"
                                          >
                                            {budgetTransaction.transactionType === budgetEventTransactionType.enum.add || budgetTransaction.transactionType === budgetEventTransactionType.enum.move_in ? '+' : '-'}
                                            {formatMoney(Math.abs(budgetTransaction.amount))}
                                          </Text>
                                        </Flex>
                                      </Flex>
                                    ))}
                                  </Flex>
                                </Flex>
                              ))}
                          </Flex>
                        );
                      })()
                    ) : (
                      <Flex direction="column" align="center" gap="3" py="8">
                        <Text size="2" color="gray">
                          No budget changes found for this bill
                        </Text>
                      </Flex>
                    )
                  )}
                </ScrollArea>
              </Flex>
            </Card>
          </Flex>
        </Box>
      </Flex>

      {/* Confirmation Dialog */}
      {billItem && (
        <RetireBudgetItemDialog
          item={retiring ? { uuid: billItem.uuid, name: billItem.name, income: false } : null}
          onClose={() => setRetiring(false)}
          onDone={(outcome) => outcome !== 'restored' && navigate(returnUrl)}
        />
      )}
      {billItem && (
        <ConvertToExpenseDialog
          open={converting}
          onClose={() => setConverting(false)}
          item={{ uuid: billItem.uuid, name: billItem.name, rollover: billItem.rollover === true }}
        />
      )}
    </PageContainer>
  );
};

export default EditBillsPage;
