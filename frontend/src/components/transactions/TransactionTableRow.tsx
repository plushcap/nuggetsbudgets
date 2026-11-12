import React from 'react';
import { Badge, Checkbox, ContextMenu, Flex, IconButton, Table, Text } from '@radix-ui/themes';
import { Edit, MoreHorizontal, Split } from 'lucide-react';
import { formatCurrency } from '../../utils/currency';
import { DateUtils } from '../../utils/dateUtils';
import { textColorProps } from '../../utils/textColor';
import { amountColor, payeeOf, rowLabel, selectLabel, type TransactionRowViewProps } from './transactionRows';
import { Assignee, BudgetItemLabel, ReviewStatusIcon, StatusBadge, TagIcons } from './TransactionCells';

interface TransactionTableRowProps extends TransactionRowViewProps {
  /** The row's right-click menu (a ContextMenu.Content). */
  menu: React.ReactNode;
}

/**
 * A desktop row. It has no click of its own (a row can't hold a stretched link): its
 * Edit and Quick actions buttons are what the keyboard and a screen reader reach, and the
 * right-click menu offers the same quick actions as the button.
 */
const TransactionTableRow: React.FC<TransactionTableRowProps> = ({
  transaction,
  lookups,
  showCheckboxes,
  showAccount,
  showBalance,
  selected,
  onSelect,
  onEdit,
  onOpenActions,
  menu,
}) => {
  const accountName = showAccount ? lookups.accountName(transaction) : null;
  const budgetPeriodName = lookups.budgetPeriodName(transaction);
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>
        <Table.Row className="row-hover transition-colors">
          {showCheckboxes && (
            <Table.Cell>
              <Checkbox
                aria-label={selectLabel(transaction)}
                checked={selected}
                onCheckedChange={() => onSelect?.(transaction.uuid)}
              />
            </Table.Cell>
          )}
          <Table.Cell>
            <ReviewStatusIcon transaction={transaction} />
          </Table.Cell>
          <Table.Cell>
            <Assignee user={lookups.assignedUser(transaction)} />
          </Table.Cell>
          <Table.Cell>
            <Text size="2">{DateUtils.formatDateUS(transaction.transaction_date)}</Text>
          </Table.Cell>
          {showAccount && (
            <Table.Cell>
              {accountName ? <Text size="2">{accountName}</Text> : <Text size="2" color="gray">-</Text>}
            </Table.Cell>
          )}
          <Table.Cell>
            <Text size="2">{payeeOf(transaction)}</Text>
          </Table.Cell>
          <Table.Cell>
            <Badge variant="soft" size="1" color="gray">
              {transaction.type}
            </Badge>
          </Table.Cell>
          <Table.Cell>
            {budgetPeriodName ? <Text size="2">{budgetPeriodName}</Text> : <Text size="2" color="gray">-</Text>}
          </Table.Cell>
          <Table.Cell>
            <Flex gap="1" align="center" wrap="wrap">
              <BudgetItemLabel transaction={transaction} emptySize="2" />
            </Flex>
          </Table.Cell>
          <Table.Cell>
            <Flex gap="1" wrap="wrap" align="center">
              <TagIcons tags={transaction.tags} />
            </Flex>
          </Table.Cell>
          <Table.Cell>
            <Flex gap="2" align="center">
              <Text size="2" weight="medium" {...textColorProps(amountColor(transaction.amount))}>
                {formatCurrency(transaction.amount)}
              </Text>
              {transaction.is_split_parent && (
                <Split size={14} className="text-[var(--gray-11)]" aria-label="Split transaction" />
              )}
            </Flex>
          </Table.Cell>
          {showBalance && (
            <Table.Cell>
              <Text size="2" weight="medium">
                {formatCurrency(lookups.runningBalance(transaction))}
              </Text>
            </Table.Cell>
          )}
          <Table.Cell>
            <StatusBadge status={transaction.status} />
          </Table.Cell>
          <Table.Cell>
            <Flex gap="3" align="center">
              <IconButton
                variant="ghost"
                size="1"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(transaction);
                }}
                title="Edit transaction"
                aria-label={`Edit ${rowLabel(transaction)}`}
              >
                <Edit size={16} />
              </IconButton>
              {/* The right-click menu's actions, for the keyboard (and anyone without a right button). */}
              <IconButton
                variant="ghost"
                size="1"
                color="gray"
                onClick={(e) => onOpenActions(transaction, e.currentTarget)}
                title="Quick actions"
                aria-label={`Quick actions for ${rowLabel(transaction)}`}
                aria-haspopup="dialog"
              >
                <MoreHorizontal size={16} />
              </IconButton>
            </Flex>
          </Table.Cell>
        </Table.Row>
      </ContextMenu.Trigger>
      {menu}
    </ContextMenu.Root>
  );
};

export default TransactionTableRow;
