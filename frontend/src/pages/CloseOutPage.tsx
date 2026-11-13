import React, { useState, useMemo } from 'react';
import { budgetExpenseType, envelopeReconciliation, formatMoney } from '@nuggets/shared';
import { type BudgetPeriodItem } from '../services/api';
import {
  useAccountsQuery,
  useBudgetPeriodsQuery,
  useBudgetPeriodItemsQuery,
  useZeroBalanceAccountsQuery,
} from '../hooks/queries';
import ZeroBalanceAccountsSection from '../components/closeout/ZeroBalanceAccountsSection';
import EnvelopeReconciliationSection, { type EnvelopeUnavailable } from '../components/closeout/EnvelopeReconciliationSection';
import EnvelopeSavingsTransferSection from '../components/closeout/EnvelopeSavingsTransferSection';
import OverspentItemsModal from '../components/closeout/OverspentItemsModal';
import { Box, Flex, Heading, Text, Callout, Card, Select, Grid } from '@radix-ui/themes';
import DashboardSummaryCard from '../components/DashboardSummaryCard';
import { TrendingDown, Wallet } from 'lucide-react';
import { periodChoices, periodKey } from '../utils/budgetPeriods';
import { useBudgetPeriodSelection } from '../hooks/useBudgetPeriodSelection';
import { EMPTY_LIST } from '../utils/emptyList';
import { centsOf, centsToAmount } from '../utils/currency';
import { calculateActualRemaining } from '../utils/budgetRemaining';
import PageContainer from '../components/PageContainer';

/** A figure of the month: its label, and the figure beside it; a total is larger, by its sign. */
const StatusLine: React.FC<{ label: string; amount: number; total?: boolean }> = ({ label, amount, total = false }) =>
  total ? (
    <Flex justify="between" align="center">
      <Text size="3" weight="bold" className="text-[var(--gray-12)]">{label}</Text>
      <Text size="3" weight="bold" className={amount >= 0 ? 'text-[var(--green-12)]' : 'text-[var(--red-11)]'}>
        {formatMoney(amount)}
      </Text>
    </Flex>
  ) : (
    <Flex justify="between" align="center">
      <span>{label}</span>
      <Text weight="bold">{formatMoney(amount)}</Text>
    </Flex>
  );

const CloseOutPage: React.FC = () => {
  const { data: budgetPeriods = EMPTY_LIST } = useBudgetPeriodsQuery();
  const [overspentModal, setOverspentModal] = useState<'monthly' | 'envelope' | null>(null);

  // The URL's `period` (else the one chosen last in this tab, else today's month).
  const { currentPeriod, selectPeriod, isCurrentMonth } = useBudgetPeriodSelection(budgetPeriods, 'closeout-selected-period');

  const zeroBalanceQuery = useZeroBalanceAccountsQuery(currentPeriod?.uuid);
  const zeroBalanceData = zeroBalanceQuery.data;
  const budgetItemsQuery = useBudgetPeriodItemsQuery(currentPeriod?.uuid);
  const accountsQuery = useAccountsQuery(false);
  const accounts = accountsQuery.data ?? EMPTY_LIST;
  // The accounts count too: until they load, the envelope section would say that no
  // envelope account is configured.
  const loading = accountsQuery.isLoading || (!!currentPeriod && (budgetItemsQuery.isLoading || zeroBalanceQuery.isLoading));

  const budgetPeriodItems: BudgetPeriodItem[] = useMemo(
    () => (budgetItemsQuery.data?.success && budgetItemsQuery.data.data ? budgetItemsQuery.data.data : []),
    [budgetItemsQuery.data],
  );

  // The month's figures: the same formula, in whole cents, as the Budget page's Actual box and
  // the Dashboard card. Close-Out had kept a copy that counted every Envelope item's plan.
  const calculateBudgetStatus = () => {
    if (!budgetPeriodItems || budgetPeriodItems.length === 0) {
      return null;
    }
    const { remaining, ...figures } = calculateActualRemaining(budgetPeriodItems);
    return { ...figures, actualRemaining: remaining };
  };

  // The envelope accounts' money against what the envelopes should hold: the same figures, in
  // whole cents, as the Budget page's Envelope Comparison (envelopeReconciliation, @nuggets/shared).
  // An unavailable envelope balance (null) skips it; the banner below says why.
  const envelopeBalanceUnavailable = accounts.some(a => a.is_envelope_account && a.calculated_balance == null);
  const closeOutData = useMemo(
    () => (currentPeriod && zeroBalanceData
      ? { zero_balance: zeroBalanceData, envelope: envelopeReconciliation(budgetPeriodItems, accounts) }
      : null),
    [currentPeriod, zeroBalanceData, accounts, budgetPeriodItems],
  );

  // Surface query failures in the inline error banner, and the same reason in the envelope
  // section, which otherwise said no envelope account was configured. The accounts are
  // among them: without them there is no envelope account to find. A household with
  // none, whose other data failed, is still told it has none.
  const loadFailed = zeroBalanceQuery.isError || budgetItemsQuery.isError || accountsQuery.isError;
  const error = loadFailed
    ? 'Failed to load close-out data'
    : envelopeBalanceUnavailable
      ? 'Envelope account balance unavailable; envelope reconciliation skipped'
      : null;
  const envelopeAccountMayExist = accountsQuery.isError || accounts.some((a) => a.is_envelope_account);
  const envelopeUnavailable: EnvelopeUnavailable | null =
    loadFailed && envelopeAccountMayExist ? 'failed' : envelopeBalanceUnavailable ? 'balance' : null;

  const budgetStatus = calculateBudgetStatus();

  return (
    <PageContainer>
      <Flex direction="column" gap="6">
      {/* Header with Period Selector and Budget Status */}
      {/* A past or future period's header in yellow (the Card's fill is --card-background-color) */}
      <Card size="2" className={isCurrentMonth ? '' : '[--card-background-color:var(--yellow-3)]'}>
        <Flex direction="column" gap="4">
          {/* Title and Period Selector Row */}
          <Flex
            direction={{ initial: 'column', sm: 'row' }}
            align={{ initial: 'stretch', sm: 'center' }}
            justify="between"
            gap="4"
          >
            <Flex direction="column" gap="1">
              <Heading as="h1" size="6" weight="bold">Monthly Close-Out</Heading>
              <Text size="2" color="gray">Reconcile accounts and close the month</Text>
            </Flex>

            {/* Period Picker */}
            {currentPeriod && (
              <Select.Root
                value={periodKey(currentPeriod)}
                onValueChange={(value) => {
                  const period = budgetPeriods.find((p) => periodKey(p) === value);
                  if (period) {
                    selectPeriod(period);
                  }
                }}
                size="3"
              >
                <Select.Trigger className="min-w-[180px]" aria-label="Budget period" />
                <Select.Content>
                  {periodChoices(budgetPeriods, currentPeriod.id).map(period => (
                    <Select.Item key={period.id} value={periodKey(period)}>
                      {new Date(period.year, period.month_number - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            )}
          </Flex>

          {/* The month's figures. What comes off shows as the signed amount it adds: a
              literal '-' before it showed -$0.00 for nothing, and --$5.00 below zero. */}
          {!loading && budgetStatus && (
            <Flex direction="column" gap="1" pt="2" className="text-sm text-[var(--gray-11)] border-t border-[var(--gray-6)]">
              <StatusLine label="Actual Income:" amount={budgetStatus.actualIncome} />
              <StatusLine label="Spent (Monthly Expenses):" amount={budgetStatus.monthlyActual} />
              <StatusLine label="Planned (Envelopes):" amount={-budgetStatus.envelopeBudgetAmount} />
              <StatusLine label="Saved (Goals):" amount={-budgetStatus.savingsBudgetAmount} />
              <Box pt="1" className="border-t border-[var(--gray-6)]">
                <StatusLine label="Actual Remaining:" amount={budgetStatus.actualRemaining} total />
              </Box>
              <Box pt="2">
                <StatusLine label="Unpaid Bills (Remaining Fixed):" amount={-budgetStatus.fixedRemaining} />
              </Box>
              <Box pt="1" className="border-t border-[var(--gray-6)]">
                <StatusLine label="Estimated Remaining:" amount={budgetStatus.estimatedRemaining} total />
              </Box>
            </Flex>
          )}
        </Flex>
      </Card>

      {/* Overspent Summary Cards */}
      {!loading && budgetPeriodItems.length > 0 && (() => {
        // In whole cents: an item a cent over is overspent, as the Dashboard counts it.
        const overspentMonthly = budgetPeriodItems.filter(item =>
          item.type === 'Monthly' && item.expense_type === budgetExpenseType.enum.Expense && centsOf(item.calculated_remaining) < 0
        );
        const overspentEnvelopes = budgetPeriodItems.filter(item =>
          item.type === 'Envelope' && centsOf(item.calculated_remaining) < 0
        );
        const overspentTotal = (items: BudgetPeriodItem[]) =>
          centsToAmount(items.reduce((sum, item) => sum + centsOf(item.calculated_remaining), 0));
        return (
          <>
            <Grid columns={{ initial: '1', sm: '2' }} gap="4">
              <DashboardSummaryCard
                icon={TrendingDown}
                label="Overspent Monthly Expenses"
                value={overspentMonthly.length}
                subtitle={overspentMonthly.length > 0
                  ? formatMoney(overspentTotal(overspentMonthly))
                  : 'All on track'}
                borderColor={overspentMonthly.length > 0 ? 'red' : 'green'}
                {...(overspentMonthly.length > 0 ? { amount: overspentTotal(overspentMonthly) } : {})}
                {...(overspentMonthly.length > 0 ? { onClick: () => setOverspentModal('monthly'), actionLabel: 'View items →' } : {})}
              />
              <DashboardSummaryCard
                icon={Wallet}
                label="Overspent Envelopes"
                value={overspentEnvelopes.length}
                subtitle={overspentEnvelopes.length > 0
                  ? formatMoney(overspentTotal(overspentEnvelopes))
                  : 'All on track'}
                borderColor={overspentEnvelopes.length > 0 ? 'red' : 'green'}
                {...(overspentEnvelopes.length > 0 ? { amount: overspentTotal(overspentEnvelopes) } : {})}
                {...(overspentEnvelopes.length > 0 ? { onClick: () => setOverspentModal('envelope'), actionLabel: 'View items →' } : {})}
              />
            </Grid>

            <OverspentItemsModal
              open={overspentModal === 'monthly'}
              onClose={() => setOverspentModal(null)}
              title="Overspent Monthly Expenses"
              items={overspentMonthly}
            />
            <OverspentItemsModal
              open={overspentModal === 'envelope'}
              onClose={() => setOverspentModal(null)}
              title="Overspent Envelopes"
              items={overspentEnvelopes}
            />
          </>
        );
      })()}

      {/* Main Content */}
      {error && (
        <Callout.Root color="red">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <Flex direction="column" gap="6">
        <ZeroBalanceAccountsSection
          accounts={closeOutData?.zero_balance.accounts || []}
          summary={closeOutData?.zero_balance.summary || {
            total_accounts: 0,
            balanced_count: 0,
            needs_adjustment_count: 0,
            total_adjustment_amount: 0,
          }}
          periodId={currentPeriod?.uuid || ''}
          isLoading={loading}
          fullAccounts={accounts}
          budgetPeriods={budgetPeriods}
        />

        <EnvelopeReconciliationSection
          reconciliation={closeOutData?.envelope || null}
          unavailable={envelopeUnavailable}
          isLoading={loading}
          fullAccounts={accounts}
          budgetPeriods={budgetPeriods}
          periodId={currentPeriod?.uuid || ''}
        />

        <EnvelopeSavingsTransferSection
          budgetPeriodItems={budgetPeriodItems}
          periodUuid={currentPeriod?.uuid || ''}
          isLoading={loading}
        />
      </Flex>
      </Flex>
    </PageContainer>
  );
};

export default CloseOutPage;
