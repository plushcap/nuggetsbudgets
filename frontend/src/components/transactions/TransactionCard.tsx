import React from 'react';
import { Badge, Box, Button, Card, Checkbox, Flex, Separator, Text } from '@radix-ui/themes';
import { Split } from 'lucide-react';
import type { Transaction } from '../../services/api';
import { formatCurrency } from '../../utils/currency';
import { DateUtils } from '../../utils/dateUtils';
import { textColorProps } from '../../utils/textColor';
import { amountColor, payeeOf, rowLabel, selectLabel, type TransactionRowViewProps } from './transactionRows';
import { Assignee, BudgetItemLabel, ReviewStatusIcon, StatusBadge, TagBadges } from './TransactionCells';

interface TransactionCardProps extends TransactionRowViewProps {
  onToggleReviewed: (transaction: Transaction) => void;
}

/** A button of the card's action bar: a full-height third of it (square-cornered: radius="none"). */
const ACTION_STYLE: React.CSSProperties = { flex: 1, minHeight: '48px' };

/**
 * A transaction on a phone. Its quick actions open from the "Quick" button; there is
 * intentionally no long-press gesture, which used to fire by accident while scrolling.
 */
const TransactionCard: React.FC<TransactionCardProps> = ({
  transaction,
  lookups,
  showCheckboxes,
  showAccount,
  showBalance,
  selected,
  onSelect,
  onEdit,
  onOpenActions,
  onToggleReviewed,
}) => {
  const budgetPeriodName = lookups.budgetPeriodName(transaction);
  return (
    <Card className="overflow-hidden" style={{ padding: 0 }}>
      <Flex direction="column" gap="3" p="3">
        {/* Checkbox and date; review status and assignee */}
        <Flex justify="between" align="center">
          <Flex align="center" gap="2">
            {showCheckboxes && (
              <Checkbox
                aria-label={selectLabel(transaction)}
                checked={selected}
                onCheckedChange={() => onSelect?.(transaction.uuid)}
              />
            )}
            <Text size="2" weight="medium">
              {DateUtils.formatDateUS(transaction.transaction_date)}
            </Text>
          </Flex>
          <Flex align="center" gap="2">
            <ReviewStatusIcon transaction={transaction} />
            <Assignee user={lookups.assignedUser(transaction)} />
          </Flex>
        </Flex>

        {/* The account (when shown), with the type and status */}
        {showAccount && (
          <Box>
            <Text as="div" size="1" color="gray" mb="1">Account</Text>
            <Flex justify="between" align="center">
              <Text size="2" weight="medium">
                {lookups.accountName(transaction) || '-'}
              </Text>
              <Flex gap="2">
                <Badge variant="soft" size="1" color="gray">
                  {transaction.type}
                </Badge>
                <StatusBadge status={transaction.status} />
              </Flex>
            </Flex>
          </Box>
        )}

        <Box>
          <Text as="div" weight="bold" size="3">
            {payeeOf(transaction)}
          </Text>
        </Box>

        {/* Amount, and the running balance (when shown) */}
        <Flex justify="between" align="center">
          <Box>
            <Text as="div" size="1" color="gray" mb="1">Amount</Text>
            <Flex gap="2" align="center">
              <Text as="div" size="4" weight="bold" {...textColorProps(amountColor(transaction.amount))}>
                {formatCurrency(transaction.amount)}
              </Text>
              {transaction.is_split_parent && (
                <Split size={16} className="text-[var(--gray-11)]" aria-label="Split transaction" />
              )}
            </Flex>
          </Box>
          {showBalance && (
            <Box style={{ textAlign: 'right' }}>
              <Text as="div" size="1" color="gray" mb="1">Balance</Text>
              <Text as="div" size="4" weight="bold">
                {formatCurrency(lookups.runningBalance(transaction))}
              </Text>
            </Box>
          )}
        </Flex>

        {/* Budget period and budget item */}
        <Flex justify="between" align="center">
          <Box>
            {budgetPeriodName ? (
              <Badge variant="soft" size="1" color="purple">
                {budgetPeriodName}
              </Badge>
            ) : (
              <Text size="1" color="gray">No period</Text>
            )}
          </Box>
          <Flex gap="1" align="center">
            <BudgetItemLabel transaction={transaction} emptySize="1" />
          </Flex>
        </Flex>

        {transaction.tags && transaction.tags.length > 0 && (
          <Box>
            <Text as="div" size="1" color="gray" mb="1">Tags</Text>
            <Flex gap="1" wrap="wrap" align="center">
              <TagBadges tags={transaction.tags} />
            </Flex>
          </Box>
        )}
      </Flex>

      {/* Action bar: large touch targets */}
      <Separator size="4" />
      <Flex minHeight="48px">
        <Button
          variant="soft"
          size="3"
          onClick={(e) => {
            e.stopPropagation();
            onEdit(transaction);
          }}
          aria-label={`Edit ${rowLabel(transaction)}`}
          radius="none"
          style={ACTION_STYLE}
        >
          Edit
        </Button>
        <Button
          variant="soft"
          size="3"
          onClick={(e) => {
            e.stopPropagation();
            onOpenActions(transaction, e.currentTarget);
          }}
          aria-label={`Quick actions for ${rowLabel(transaction)}`}
          aria-haspopup="dialog"
          radius="none"
          style={ACTION_STYLE}
        >
          Quick
        </Button>
        <Button
          variant="soft"
          size="3"
          onClick={(e) => {
            e.stopPropagation();
            onToggleReviewed(transaction);
          }}
          radius="none"
          style={ACTION_STYLE}
        >
          Review
        </Button>
      </Flex>
    </Card>
  );
};

export default TransactionCard;
