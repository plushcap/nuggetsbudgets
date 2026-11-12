import React, { useMemo } from 'react';
import { CheckCircle, AlertTriangle, DollarSign, TrendingDown, Wifi } from 'lucide-react';
import { type BudgetPeriodItem } from '../services/api';
import {
  useBudgetPeriodsQuery,
  usePaginatedTransactionsQuery,
  useBudgetPeriodItemsQuery,
} from '../hooks/queries';
import { useAccountsQuery } from '../hooks/queries/accounts';
import { deriveAccountConnectionHealth, formatMoney } from '@nuggets/shared';
import { useAuth } from '../contexts/AuthContext';
import { calculateActualRemaining } from '../utils/budgetRemaining';
import DashboardSummaryCard from './DashboardSummaryCard';
import { Box, Flex } from '@radix-ui/themes';
import { centsOf } from '../utils/currency';

const DashboardSummary: React.FC = () => {
  const { user } = useAuth();

  const { data: periods = [], isLoading: periodsLoading } = useBudgetPeriodsQuery();

  // Pick the current budget period (this month, else active, else most recent).
  const currentPeriod = useMemo(() => {
    const today = new Date();
    const currentYear = today.getFullYear();
    const currentMonth = today.getMonth() + 1;
    return periods.find(p => p.year === currentYear && p.month_number === currentMonth)
      || periods.find(p => p.status === 'active')
      || periods[periods.length - 1];
  }, [periods]);

  const currentPeriodId = currentPeriod
    ? `${currentPeriod.year}-${currentPeriod.month_number.toString().padStart(2, '0')}`
    : '';

  // Cards swallow load failures silently (as before) → suppress global toasts.
  const myTasksQuery = usePaginatedTransactionsQuery(
    1, 1,
    user ? { review_status: 'needs review', assigned_to: user.id.toString() } : undefined,
    { enabled: !!user, meta: { suppressErrorToast: true } },
  );
  const allTasksQuery = usePaginatedTransactionsQuery(
    1, 1,
    { review_status: 'needs review' },
    { meta: { suppressErrorToast: true } },
  );
  const budgetItemsQuery = useBudgetPeriodItemsQuery(
    currentPeriod?.uuid,
    undefined,
    { meta: { suppressErrorToast: true } },
  );
  const accountsQuery = useAccountsQuery(false, { meta: { suppressErrorToast: true } });

  const myTasksCount = myTasksQuery.data?.pagination.total ?? 0;
  const allUnreviewedCount = allTasksQuery.data?.pagination.total ?? 0;

  // Connection health across sync-enabled SimpleFin accounts. Status
  // is derived from cheap persisted fields via the shared helper — no live call.
  const { disconnectedCount, delayedCount, connectionTotal } = useMemo(() => {
    const accounts = (accountsQuery.data ?? []).filter(
      (a) => a.import_provider === 'simplefin' && a.import_enabled,
    );
    let disconnected = 0;
    let delayed = 0;
    for (const a of accounts) {
      const health = deriveAccountConnectionHealth({
        import_provider: a.import_provider,
        import_balance_date: a.import_balance_date ?? null,
        import_last_error_code: a.import_last_error_code ?? null,
      });
      if (health.status === 'disconnected') disconnected += 1;
      else if (health.status === 'delayed') delayed += 1;
    }
    return { disconnectedCount: disconnected, delayedCount: delayed, connectionTotal: accounts.length };
  }, [accountsQuery.data]);

  const unhealthyConnections = disconnectedCount + delayedCount;
  const connectionBorderColor = disconnectedCount > 0
    ? 'red'
    : delayedCount > 0
      ? 'amber'
      : 'green';
  const connectionSubtitle = unhealthyConnections > 0
    ? `${disconnectedCount} failing · ${delayedCount} delayed`
    : `${connectionTotal} connected`;

  // Calculate budget metrics (the Budget page's "Actual" remaining).
  const { remainingBudget, overspentCount } = useMemo(() => {
    const resp = budgetItemsQuery.data;
    if (resp && resp.success && Array.isArray(resp.data)) {
      const items: BudgetPeriodItem[] = resp.data;
      // In whole cents, as Close-Out counts it: an item a cent over is overspent.
      const overspent = items.filter(item => centsOf(item.calculated_remaining) < 0).length;
      return { remainingBudget: calculateActualRemaining(items).remaining, overspentCount: overspent };
    }
    return { remainingBudget: 0, overspentCount: 0 };
  }, [budgetItemsQuery.data]);

  const loading = periodsLoading
    || myTasksQuery.isLoading
    || allTasksQuery.isLoading
    || budgetItemsQuery.isLoading
    || accountsQuery.isLoading;

  // Where each card leads.
  const myTasksPath = '/tasks?showMyTasks=true&includeUnassigned=false';
  const unreviewedPath = '/tasks?showMyTasks=false&includeUnassigned=true';
  const remainingBudgetPath = currentPeriodId ? `/close-out?period=${currentPeriodId}` : undefined;
  const overspentPath = currentPeriodId ? `/budgets?period=${currentPeriodId}` : undefined;
  const connectionsPath = '/accounts';

  return (
    <Flex 
      direction={{ initial: 'column', sm: 'row' }} 
      gap="4" 
      width="100%"
    >
      <Box flexGrow="1" flexShrink="1" flexBasis="0%">
        <DashboardSummaryCard
          icon={CheckCircle}
          label="Tasks Assigned To Me"
          value={myTasksCount}
          subtitle="Transactions needing review"
          borderColor="green"
          loading={loading}
          to={myTasksPath}
        />
      </Box>

      <Box flexGrow="1" flexShrink="1" flexBasis="0%">
        <DashboardSummaryCard
          icon={AlertTriangle}
          label="Total UnReviewed Transactions"
          value={allUnreviewedCount}
          subtitle="All users"
          borderColor="red"
          loading={loading}
          to={unreviewedPath}
        />
      </Box>

      <Box flexGrow="1" flexShrink="1" flexBasis="0%">
        <DashboardSummaryCard
          icon={DollarSign}
          label="Remaining Budget"
          // To the cent, in accounting style, and red only below zero: rounded to whole
          // dollars, a remaining of -$0.01 showed as a red ($0). It is whole cents (centsToAmount).
          value={formatMoney(remainingBudget, { negative: 'parentheses' })}
          subtitle="Current period"
          borderColor="blue"
          loading={loading}
          amount={remainingBudget}
          {...(remainingBudgetPath ? { to: remainingBudgetPath } : {})}
        />
      </Box>

      <Box flexGrow="1" flexShrink="1" flexBasis="0%">
        <DashboardSummaryCard
          icon={TrendingDown}
          label="Overspent Budget Items"
          value={overspentCount}
          subtitle="Current period"
          borderColor="purple"
          loading={loading}
          {...(overspentPath ? { to: overspentPath } : {})}
        />
      </Box>

      {(loading || connectionTotal > 0) && (
        <Box flexGrow="1" flexShrink="1" flexBasis="0%">
          <DashboardSummaryCard
            icon={Wifi}
            label="Account Connections"
            value={unhealthyConnections > 0 ? unhealthyConnections : 'Healthy'}
            subtitle={connectionSubtitle}
            borderColor={connectionBorderColor}
            loading={loading}
            to={connectionsPath}
            actionLabel="View accounts →"
          />
        </Box>
      )}
    </Flex>
  );
};

export default DashboardSummary;
