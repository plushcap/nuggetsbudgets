import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatMoney, assetType } from '@nuggets/shared';
import { Link } from 'react-router-dom';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import type { Account, BudgetPeriod, ZeroBalanceAccount } from '../../services/api';
import { getIconByName } from '../../utils/iconCatalog';
import { todayLocal } from '../../utils/dateUtils';
import { centsOf, centsToAmount } from '../../utils/currency';
import { Box, Card, Flex, Text, Button } from '@radix-ui/themes';
import TransferModal from '../transfer/TransferModal';
import type { TransferFormData } from '../transfer/TransferForm';
import MoveBalanceToNextPeriodModal from './MoveBalanceToNextPeriodModal';
import { budgetKeys } from '../../hooks/queries/keys';

interface ZeroBalanceAccountCardProps {
  account: ZeroBalanceAccount;
  periodId: string;
  /** Full account rows, to resolve this card's id/type/default-pay-from for the transfer. */
  fullAccounts: Account[];
  budgetPeriods: BudgetPeriod[];
}

const ZeroBalanceAccountCard: React.FC<ZeroBalanceAccountCardProps> = ({
  account,
  periodId,
  fullAccounts,
  budgetPeriods,
}) => {
  const iconOption = getIconByName(account.icon);
  const IconComponent = iconOption?.component;
  const [transferOpen, setTransferOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const queryClient = useQueryClient();

  // Resolve this (source) period and the next chronological period for the
  // "move balance to next period" action.
  const sortedPeriods = [...budgetPeriods].sort(
    (a, b) => a.year - b.year || a.month_number - b.month_number
  );
  const sourcePeriod = budgetPeriods.find((p) => p.uuid === periodId) ?? null;
  const sourceIdx = sortedPeriods.findIndex((p) => p.uuid === periodId);
  const nextPeriod = sourceIdx >= 0 && sourceIdx < sortedPeriods.length - 1
    ? sortedPeriods[sourceIdx + 1]
    : null;

  // The full account row carries the numeric id, Asset/Liability type, and the
  // configured default pay-from account — none of which are on ZeroBalanceAccount.
  const full = fullAccounts.find((a) => a.uuid === account.uuid);

  const getAdjustmentText = (): string => {
    if (account.is_balanced) {
      return 'Balanced';
    }

    const amount = formatMoney(account.adjustment_needed);
    if (account.adjustment_direction === 'credit') {
      return `Needs credit of ${amount}`;
    } else if (account.adjustment_direction === 'debit') {
      return `Needs debit of ${amount}`;
    }
    return 'Balanced';
  };

  // Prefill the transfer with what the card says the period needs, not the account's
  // whole balance. adjustment_direction is the zero-balance audit's (AccountQueries'
  // zeroBalanceAudit), from the sum of the period's own transactions on this account,
  // pre-signed: 'credit' when it is below zero, so money comes in (a liability's charges are
  // paid from its pay-from account, an asset is topped up); 'debit' when it is above, so money
  // goes out (an asset's surplus is swept out). Either way the transfer, in this period, brings
  // the period to zero. adjustment_needed is that sum's size, sent in whole cents at two
  // decimals. A balanced period prefills no amount, and the usual direction (a liability
  // is paid, an asset swept out), so the button still serves another transfer. All fields stay
  // editable in the modal.
  const buildInitialValues = (): Partial<TransferFormData> => {
    if (!full) return {};
    const transaction_date = todayLocal();
    const budget_period_id = budgetPeriods.find((p) => p.uuid === periodId)?.id ?? null;
    const counterparty = full.default_pay_from_account_id ?? null;
    const direction = account.adjustment_direction;
    const neededCents = Math.abs(centsOf(account.adjustment_needed));
    const amount = direction !== 'balanced' && neededCents > 0 ? centsToAmount(neededCents) : null;
    const moneyIn = direction === 'credit' || (direction === 'balanced' && full.type === assetType.enum.Liability);

    if (moneyIn && full.type === assetType.enum.Liability) {
      return {
        type: 'payment',
        destination_account_id: full.id,
        source_account_id: counterparty,
        amount,
        transaction_date,
        budget_period_id,
        description: `Payment: ${full.name}`,
      };
    }
    return {
      type: 'transfer',
      source_account_id: moneyIn ? counterparty : full.id,
      destination_account_id: moneyIn ? full.id : counterparty,
      amount,
      transaction_date,
      budget_period_id,
      description: `Transfer: ${full.name}`,
    };
  };

  // The card's figures in whole cents, so their sign and zero aren't a float's.
  const periodCents = centsOf(account.period_balance);
  const currentCents = centsOf(account.current_balance);

  return (
    <Card size="2">
      {/* Account Header */}
      <Flex align="start" justify="between" mb="3">
        <Flex align="center" gap="3">
          <Box flexShrink="0">
            {IconComponent && (
              <IconComponent
                size={32} className="text-[var(--gray-11)]"
                strokeWidth={1.5}
              />
            )}
          </Box>
          <Box>
            <Text size="2" weight="bold" className="text-[var(--gray-12)]">
              {account.name}
            </Text>
            <Flex align="baseline" gap="2">
              <Text size="1" className="text-[var(--gray-11)] capitalize">
                {account.account_type.replace(/_/g, ' ')}
              </Text>
              <span className="text-xs text-[var(--gray-11)]">•</span>
              {/* Money through formatMoney, as everywhere (it was toLocaleString, no $). */}
              <span className={`${currentCents < 0 ? 'text-[var(--red-11)]' : 'text-[var(--green-12)]'} font-semibold text-xs`}>
                {formatMoney(centsToAmount(currentCents), { negative: 'parentheses' })}
              </span>
            </Flex>
          </Box>
        </Flex>

        {/* Status Indicator */}
        <Box flexShrink="0">
          {account.is_balanced ? (
            <CheckCircle2 size={24} className="text-[var(--green-12)]" />
          ) : (
            <AlertCircle size={24} className="text-[var(--red-11)]" />
          )}
        </Box>
      </Flex>

      {/* Period Balance */}
      <Box mb="3">
        <Text as="div" size="1" mb="1" className="text-[var(--gray-11)]">Period Balance</Text>
        <Text size="7" weight="bold" className={`${
          periodCents === 0
            ? 'text-[var(--accent-11)]'
            : periodCents > 0
            ? 'text-[var(--green-12)]'
            : 'text-[var(--red-11)]'
        }`}>
          {formatMoney(centsToAmount(periodCents), { negative: 'parentheses' })}
        </Text>
      </Box>

      {/* Adjustment Needed */}
      <Box mb="4">
        <Text size="2" weight="medium" className={
          account.is_balanced
            ? 'text-[var(--green-12)]'
            : 'text-[var(--red-11)]'
        }>
          {getAdjustmentText()}
        </Text>
      </Box>

      {/* Actions */}
      <Flex direction="column" gap="2">
        {/* One control, a link styled as a button: a Link around a Button nested two. */}
        <Button asChild variant="soft" >
          <Link to={`/accounts/${account.uuid}`}>View Transactions</Link>
        </Button>
        {full && (
          <Button onClick={() => setTransferOpen(true)}>
            Submit Transfer
          </Button>
        )}
        <Button variant="soft" onClick={() => setMoveOpen(true)}>
          Move balance to next period
        </Button>
      </Flex>

      <TransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        accounts={fullAccounts}
        budgetPeriods={budgetPeriods}
        initialValues={buildInitialValues()}
        onSuccess={() => setTransferOpen(false)}
      />

      <MoveBalanceToNextPeriodModal
        open={moveOpen}
        onClose={() => setMoveOpen(false)}
        accountUuid={account.uuid}
        accountName={account.name}
        periodBalance={account.period_balance}
        sourcePeriodUuid={periodId}
        sourcePeriodName={sourcePeriod?.name ?? 'this period'}
        nextPeriodName={nextPeriod?.name ?? null}
        onSuccess={() => queryClient.invalidateQueries({ queryKey: budgetKeys.all })}
      />
    </Card>
  );
};

export default ZeroBalanceAccountCard;
