import React from 'react';
import { Box, Card, Flex, Text } from '@radix-ui/themes';
import { Wallet } from 'lucide-react';
import { formatMoney } from '@nuggets/shared';
import type { Account, BudgetPeriodItem } from '../../services/api';
import { calculateActualRemaining } from '../../utils/budgetRemaining';
import { centsOf, centsToAmount, toCents } from '../../utils/currency';

/**
 * The Budget page's sidebar: the month's plan, what actually came in and went out, and the
 * envelopes against the envelope accounts. A figure taken off the total shows as
 * the signed amount it adds: a label written "-$X" showed -$0.00 for nothing and
 * --$5.00 for an amount below zero.
 */

/** A figure's line: its label, and the figure beside it. */
const SummaryLine: React.FC<{ label: string; children: React.ReactNode; strong?: boolean }> = ({ label, children, strong }) => (
  <Flex justify="between" align="center" className={strong ? 'font-bold' : undefined}>
    <span>{label}</span>
    <span className={strong ? undefined : 'font-semibold'}>{children}</span>
  </Flex>
);

/** The figures, and the total under a rule. */
const SummaryMath: React.FC<{ children: React.ReactNode; total: React.ReactNode }> = ({ children, total }) => (
  <Flex direction="column" gap="1" className="text-xs text-[var(--gray-11)]">
    {children}
    <Box pt="1" className="border-t border-[var(--gray-6)]">{total}</Box>
  </Flex>
);

const tone = (amount: number) => (amount >= 0 ? 'text-[var(--green-12)]' : 'text-[var(--red-11)]');

/** A card's title and its figure, both coloured by the figure's sign. */
const SummaryTitle: React.FC<{ title: string; amount: number }> = ({ title, amount }) => (
  <Flex align="center" justify="between" mb="4">
    <Text size="4" weight="bold" className={tone(amount)}>{title}</Text>
    <Text size="4" weight="bold" className={tone(amount)}>{formatMoney(amount)}</Text>
  </Flex>
);

/**
 * The plan: what the Income, Expense and Savings sections budget (with any edit not saved yet),
 * added and taken off in whole cents: as floats, a plan that came to nothing could be
 * -1.1e-13, shown as -$0.00 in red.
 */
export const BudgetPlanCard: React.FC<{ income: number; expenses: number; savings: number }> = ({ income, expenses, savings }) => {
  const net = centsToAmount(toCents(income) - toCents(expenses) - toCents(savings));
  return (
    <Card size="2">
      <SummaryTitle title="Budget" amount={net} />
      <SummaryMath total={<SummaryLine label="Calculation:" strong>{formatMoney(net)}</SummaryLine>}>
        <SummaryLine label="Total Income:">{formatMoney(income)}</SummaryLine>
        <SummaryLine label="Total Expenses:">{formatMoney(-expenses)}</SummaryLine>
        <SummaryLine label="Total Savings:">{formatMoney(-savings)}</SummaryLine>
      </SummaryMath>
    </Card>
  );
};

/** What actually came in, less what monthly items spent and envelopes and goals put aside. */
export const BudgetActualCard: React.FC<{ items: BudgetPeriodItem[] }> = ({ items }) => {
  const { actualIncome, envelopeBudgetAmount, monthlyActual, savingsBudgetAmount, remaining } = calculateActualRemaining(items);
  return (
    <Card mt="4" size="2">
      <SummaryTitle title="Actual" amount={remaining} />
      <SummaryMath total={<SummaryLine label="Remaining:" strong>{formatMoney(remaining)}</SummaryLine>}>
        <SummaryLine label="Actual Income:">{formatMoney(actualIncome)}</SummaryLine>
        <SummaryLine label="Spent (Monthly Expenses):">{formatMoney(monthlyActual)}</SummaryLine>
        <SummaryLine label="Planned (Envelopes):">{formatMoney(-envelopeBudgetAmount)}</SummaryLine>
        <SummaryLine label="Saved (Goals):">{formatMoney(-savingsBudgetAmount)}</SummaryLine>
      </SummaryMath>
    </Card>
  );
};

/**
 * The envelopes' balances (each one's calculated_remaining, rollover and starting amounts
 * included) against the envelope accounts', in whole cents. An account whose balance is
 * unavailable (null) makes the comparison unavailable. Nothing when there are neither.
 */
/**
 * The period's envelopes against the envelope accounts. `accounts` carry each envelope account's money
 * through the period (`withEnvelopeBalances`), named by `through` (the period's name), not its balance today.
 */
export const EnvelopeComparisonCard: React.FC<{ items: BudgetPeriodItem[]; accounts: Account[]; through: string }> = ({ items, accounts, through }) => {
  const envelopeItems = items.filter((item) => item.type === 'Envelope');
  const envelopeAccounts = accounts.filter((account) => account.is_envelope_account === true);
  if (envelopeItems.length === 0 && envelopeAccounts.length === 0) return null;

  const budgetCents = envelopeItems.reduce((sum, item) => sum + centsOf(item.calculated_remaining), 0);
  const accountCents = envelopeAccounts.reduce((sum, account) => sum + centsOf(account.calculated_balance), 0);
  const unavailable = envelopeAccounts.some((account) => account.calculated_balance == null);
  const difference = centsToAmount(budgetCents - accountCents);
  const shown = (amount: number) => (unavailable ? 'Unavailable' : formatMoney(amount));

  return (
    <Card mt="4" size="2">
      <Flex align="center" justify="between" mb="4">
        <Flex align="center" gap="2">
          <Wallet size={20} className="text-[var(--accent-11)]" />
          <Text size="4" weight="bold" className="text-[var(--gray-12)]">Envelope Comparison</Text>
        </Flex>
        <Text size="4" weight="bold" className={tone(difference)}>{shown(difference)}</Text>
      </Flex>

      <SummaryMath total={<SummaryLine label="Difference:" strong>{shown(difference)}</SummaryLine>}>
        <SummaryLine label="Budgeted Envelope Savings:">{formatMoney(centsToAmount(budgetCents))}</SummaryLine>
        <SummaryLine label={`Actual Envelope Account Total, through ${through}:`}>{shown(centsToAmount(-accountCents))}</SummaryLine>
      </SummaryMath>

      <Box mt="3" pt="3" className="border-t border-[var(--gray-6)]">
        <Flex direction="column" gap="1" className="text-xs text-[var(--gray-11)]">
          <Flex justify="between">
            <span>Envelope Budget Items:</span>
            <span>{envelopeItems.length}</span>
          </Flex>
          <Flex justify="between">
            <span>Envelope Accounts:</span>
            <span>{envelopeAccounts.length}</span>
          </Flex>
          {envelopeAccounts.length > 0 && (
            <Box>
              <Box mb="1" className="font-medium text-[var(--gray-12)]">Envelope Accounts, through {through}:</Box>
              {envelopeAccounts.map((account) => (
                <Flex key={account.id} justify="between" className="text-xs">
                  <Box mr="2" className="truncate">{account.name}</Box>
                  <span className="font-medium">{account.calculated_balance == null ? 'Unavailable' : formatMoney(account.calculated_balance)}</span>
                </Flex>
              ))}
            </Box>
          )}
        </Flex>
      </Box>
    </Card>
  );
};
