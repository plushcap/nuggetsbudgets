import React, { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { Box, Button, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { deriveBudgetSections, computeAllSubtotals } from './budgetPageCalcs';
import type { BudgetPeriod, BudgetPeriodItem } from '../services/api';
import { useAccountsQuery, useBudgetPeriodsQuery, useBudgetPeriodItemsQuery, useBudgetItemsQuery } from '../hooks/queries';
import { useBudgetPeriodSelection } from '../hooks/useBudgetPeriodSelection';
import RetireBudgetItemDialog, { type RetiringItem } from '../components/budget/RetireBudgetItemDialog';
import BudgetTransferModal from '../components/BudgetTransferModal';
import BudgetItemActivityModal from '../components/BudgetItemActivityModal';
import BudgetPageHeader from '../components/budget/BudgetPageHeader';
import CreatePeriodDialog from '../components/budget/CreatePeriodDialog';
import ArchivedBudgetItemsCard from '../components/budget/ArchivedBudgetItemsCard';
import BudgetMobileList from '../components/budget/BudgetMobileList';
import BudgetDesktopList, { BudgetColumnHeaders } from '../components/budget/BudgetDesktopList';
import { BudgetActualCard, BudgetPlanCard, EnvelopeComparisonCard } from '../components/budget/BudgetSummaryCards';
import { useBudgetCollapse } from '../components/budget/useBudgetCollapse';
import { useInlineBudgetEdit } from '../components/budget/useInlineBudgetEdit';
import { goalHref, type BudgetRowActions } from '../components/budget/budgetRowActions';
import { EMPTY_LIST } from '../utils/emptyList';
import LoadError from '../components/LoadError';
import PageContainer from '../components/PageContainer';
import { budgetExpenseType, budgetItemStatus } from '@nuggets/shared';

/**
 * The Budget page: one period's items, by section, with the inline budget edits, the period's
 * totals and the envelope comparison. Its pieces are in components/budget; this
 * module loads the data and wires them together.
 */
const BudgetPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const budgetPeriodsQuery = useBudgetPeriodsQuery();
  const budgetPeriods = budgetPeriodsQuery.data ?? EMPTY_LIST;
  const { data: accounts = EMPTY_LIST } = useAccountsQuery();
  const { data: allBudgetItems = EMPTY_LIST } = useBudgetItemsQuery();
  const archivedItems = useMemo(
    () => allBudgetItems.filter((item) => item.status === budgetItemStatus.enum.archived).sort((a, b) => a.name.localeCompare(b.name)),
    [allBudgetItems],
  );
  const [showArchived, setShowArchived] = useState(false);
  const [retiring, setRetiring] = useState<RetiringItem | null>(null);
  // The item a dialog is for stays set while it closes, so its content doesn't blank first.
  const [transfer, setTransfer] = useState<{ open: boolean; itemId?: number }>({ open: false });
  const [activity, setActivity] = useState<{ open: boolean; itemId?: number }>({ open: false });

  const { currentPeriod, selectPeriod, isCurrentMonth } = useBudgetPeriodSelection(budgetPeriods, 'budget-selected-period');
  const edit = useInlineBudgetEdit();
  const collapse = useBudgetCollapse();

  // The period's items (refetched on a period change, and after a mutation's invalidation).
  const budgetPeriodItemsQuery = useBudgetPeriodItemsQuery(currentPeriod?.uuid);
  const budgetPeriodItems = useMemo<BudgetPeriodItem[]>(
    () => (budgetPeriodItemsQuery.data?.success && Array.isArray(budgetPeriodItemsQuery.data.data) ? budgetPeriodItemsQuery.data.data : []),
    [budgetPeriodItemsQuery.data],
  );
  const loading = budgetPeriodsQuery.isLoading || budgetPeriodItemsQuery.isLoading;

  // The sections (filtered, grouped, sorted) change only with the items; their totals also
  // follow the edits not saved yet, so they update the moment a budget is typed.
  const sections = useMemo(() => deriveBudgetSections(budgetPeriodItems), [budgetPeriodItems]);
  const subtotals = useMemo(() => computeAllSubtotals(sections, edit.pending), [sections, edit.pending]);
  // One set of goals for every view, the desktop grid's too: the period's (periodGoal in
  // @nuggets/shared). The grid listed and totalled the active ones only, leaving
  // out a paused goal's money this month that the Plan card and the mobile list counted.

  // Shows the first period `match` picks, once the list is refetched (a mutation's
  // invalidation doesn't wait for it).
  const showPeriod = async (match: (period: BudgetPeriod) => boolean) => {
    const { data: updatedPeriods = [] } = await budgetPeriodsQuery.refetch();
    const period = updatedPeriods.find(match);
    if (period) selectPeriod(period);
  };

  // Edit and add pages come back to this view of the budget.
  const returnTo = () => encodeURIComponent(`/budgets?${searchParams.toString()}`);
  const retire = (uuid: string, name: string, expenseType: string | null | undefined) =>
    setRetiring({ uuid, name, income: expenseType === budgetExpenseType.enum.Income });

  const actions: BudgetRowActions = {
    edit,
    searchParamsString: searchParams.toString(),
    view: (item) => navigate(`/budget-items/${item.budget_item_uuid}/view`),
    editItem: (item) => navigate(`/budget-items/${item.budget_item_uuid}/edit?returnTo=${returnTo()}`),
    retire: (item) => retire(item.budget_item_uuid, item.budget_item_name, item.expense_type),
    transfer: (item) => setTransfer({ open: true, itemId: item.id }),
    activity: (item) => setActivity({ open: true, itemId: item.id }),
  };
  const goalActions: BudgetRowActions = { ...actions, view: (item) => navigate(goalHref(item)) };

  const createPeriodDialog = (trigger: React.ReactElement) => (
    <CreatePeriodDialog trigger={trigger} budgetPeriods={budgetPeriods} showPeriod={showPeriod} />
  );

  if (loading && budgetPeriods.length === 0) {
    return (
      <PageContainer>
        <Flex justify="center" align="center" height="16rem">
          <Text size="4" color="gray">Loading budget...</Text>
        </Flex>
      </PageContainer>
    );
  }

  if (budgetPeriodsQuery.isError && budgetPeriods.length === 0) {
    return (
      <LoadError
        title="Couldn't load the budget"
        message="The budget periods didn't load. Try again in a moment."
        error={budgetPeriodsQuery.error}
        onRetry={() => void budgetPeriodsQuery.refetch()}
        retrying={budgetPeriodsQuery.isFetching}
      />
    );
  }

  if (!currentPeriod) {
    return (
      <PageContainer width="form">
        <Flex direction="column" align="center" gap="4" py="9">
          <Heading as="h1" size="6" align="center">Budget Plan</Heading>
          <Text color="gray" align="center">
            This ledger has no budget periods yet. A period is one month of your budget; create the first to start planning.
          </Text>
          {createPeriodDialog(
            <Button size="3">
              <Plus size={16} />
              Create budget period
            </Button>,
          )}
        </Flex>
      </PageContainer>
    );
  }

  if (budgetPeriodItemsQuery.isError && budgetPeriodItems.length === 0) {
    return (
      <LoadError
        title="Couldn't load the budget"
        message="This period's budget items didn't load. Try again in a moment."
        error={budgetPeriodItemsQuery.error}
        onRetry={() => void budgetPeriodItemsQuery.refetch()}
        retrying={budgetPeriodItemsQuery.isFetching}
      />
    );
  }

  const hasItems = budgetPeriodItems.length > 0;
  const activityItem = budgetPeriodItems.find((item) => item.id === activity.itemId);

  return (
    <PageContainer>
      <Flex direction="column" gap="6">
        <BudgetPageHeader
          currentPeriod={currentPeriod}
          budgetPeriods={budgetPeriods}
          isCurrentMonth={isCurrentMonth}
          onSelectPeriod={selectPeriod}
          onAddItem={() => navigate(`/budget-items/add?returnTo=${returnTo()}`)}
          archivedItems={archivedItems}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((shown) => !shown)}
          createPeriod={createPeriodDialog(
            <Button variant="soft" size="3">
              <Plus size={16} />
              Create Period
            </Button>,
          )}
        />

        {showArchived && archivedItems.length > 0 && (
          <ArchivedBudgetItemsCard
            items={archivedItems}
            onView={(item) => navigate(`/budget-items/${item.uuid}/view`)}
            onRestore={(item) => retire(item.uuid, item.name, item.expense_type)}
          />
        )}

        {/* The items, then the totals: beside them on a wide screen, under them on a narrow one. */}
        <Flex direction={{ initial: 'column', lg: 'row' }} gap="6">
          <Box flexGrow="1" flexShrink="1" flexBasis="0%" width={{ md: '80%' }}>
            {hasItems ? (
              <Flex direction="column" gap="4">
                <Box display={{ initial: 'none', md: 'block' }}>
                  <BudgetColumnHeaders />
                </Box>
                <Box display={{ initial: 'block', md: 'none' }}>
                  <BudgetMobileList
                    sections={sections}
                    subtotals={subtotals}
                    goalTotals={subtotals.savings}
                    actions={actions}
                    goalActions={goalActions}
                  />
                </Box>
                <Box display={{ initial: 'none', md: 'block' }}>
                  <BudgetDesktopList
                    sections={sections}
                    subtotals={subtotals}
                    goals={sections.savings}
                    goalTotals={subtotals.savings}
                    actions={actions}
                    goalActions={goalActions}
                    collapse={collapse}
                  />
                </Box>
              </Flex>
            ) : (
              <Card size="2" className="text-center">
                <Text className="text-[var(--gray-11)]">No budget items found for this period.</Text>
              </Card>
            )}
          </Box>

          <Flex direction="column" gap="4" width={{ initial: '100%', md: '20%' }}>
            {hasItems && (
              <>
                <BudgetPlanCard income={subtotals.income.budget} expenses={subtotals.expense.budget} savings={subtotals.savings.budget} />
                <BudgetActualCard items={budgetPeriodItems} />
                {accounts.length > 0 && <EnvelopeComparisonCard items={budgetPeriodItems} accounts={accounts} />}
              </>
            )}
          </Flex>
        </Flex>

        <BudgetTransferModal
          isOpen={transfer.open}
          onClose={() => setTransfer((prev) => ({ ...prev, open: false }))}
          budgetPeriodItems={budgetPeriodItems}
          {...(transfer.itemId !== undefined ? { selectedItemId: transfer.itemId } : {})}
          periodUuid={currentPeriod.uuid}
          onSuccess={async () => {
            await budgetPeriodItemsQuery.refetch();
          }}
        />

        <BudgetItemActivityModal
          isOpen={activity.open}
          onClose={() => setActivity((prev) => ({ ...prev, open: false }))}
          {...(activityItem ? { budgetPeriodItem: activityItem } : {})}
        />

        <RetireBudgetItemDialog item={retiring} onClose={() => setRetiring(null)} />
      </Flex>
    </PageContainer>
  );
};

export default BudgetPage;
