import React from 'react';
import { Box, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { Calendar, DollarSign, Tag as TagIcon, type LucideIcon } from 'lucide-react';
import { REVIEW_STATUS_LABELS, TRANSACTION_STATUS_LABELS, formatMoney, vocabularyLabel, type TransactionWithSplits } from '@nuggets/shared';
import { textColorProps } from '../../utils/textColor';
import { ImportInformationCard } from './ImportInformationCard';
import { ReviewStatusIcon, TransactionStatusIcon } from './TransactionStatusIcons';

/** One half of the budget assignment: a name on a coloured chip, or a dashed "none". */
const AssignmentChip: React.FC<{
  caption: string;
  name: string | null | undefined;
  Icon: LucideIcon;
  none: string;
  /** The named chip's icon colour and panel. */
  iconClass: string;
  chipClass: string;
}> = ({ caption, name, Icon, none, iconClass, chipClass }) => (
  <Box>
    <Text as="p" size="1" color="gray" mb="1">{caption}</Text>
    {name ? (
      <Flex align="center" gap="2" p="2" className={chipClass}>
        <Icon size={12} className={iconClass} />
        <Text size="2" weight="medium" color="gray" highContrast>
          {name}
        </Text>
      </Flex>
    ) : (
      <Flex align="center" gap="2" p="2" className="bg-[var(--gray-2)] rounded-[var(--radius-2)] border border-dashed border-[var(--gray-6)]">
        <Icon size={12} className="text-[var(--gray-11)]" />
        <Text size="2" className="italic" color="gray">
          {none}
        </Text>
      </Flex>
    )}
  </Box>
);

/** The transaction's budget period and item, shown when it has either. */
const BudgetAssignmentCard: React.FC<{ transaction: TransactionWithSplits }> = ({ transaction }) => (
  <Card>
    <Heading as="h3" size="3" mb="4">
      <Flex align="center" gap="2">
        <DollarSign size={16} className="text-[var(--accent-11)]" />
        Budget Assignment
      </Flex>
    </Heading>

    <Flex direction="column" gap="3">
      <AssignmentChip
        caption="Budget Period"
        name={transaction.budget_period_name}
        Icon={Calendar}
        iconClass="text-[var(--accent-11)]"
        none="No budget period"
        chipClass="bg-[var(--accent-3)] rounded-[var(--radius-2)] border border-[var(--accent-6)]"
      />
      <AssignmentChip
        caption="Budget Item"
        name={transaction.budget_item_name}
        Icon={TagIcon}
        iconClass="text-[var(--green-12)]"
        none="No budget item"
        chipClass="bg-[var(--green-3)] rounded-[var(--radius-2)] border border-[var(--green-6)]"
      />

      <Box pt="2" className="text-center border-t border-[var(--gray-6)]">
        {transaction.budget_period_name && transaction.budget_item_name ? (
          <Text as="p" size="1" color="gray">
            Linked to budget period item
          </Text>
        ) : (
          <Text as="p" size="1" color="yellow" highContrast>
            Partial budget assignment
          </Text>
        )}
      </Box>
    </Flex>
  </Card>
);

/** One line of the status card: a caption on the left, its value on the right. */
const StatusLine: React.FC<{ caption: string; children: React.ReactNode }> = ({ caption, children }) => (
  <Flex align="center" justify="between">
    <Text size="2" color="gray">{caption}</Text>
    {children}
  </Flex>
);

/**
 * The page's side column (below the transaction on a phone): its budget assignment, status,
 * what its import said, and the account's running balance after it.
 */
export const TransactionSidebar: React.FC<{ transaction: TransactionWithSplits }> = ({ transaction }) => (
  <Flex direction="column" gap="6">
    {(transaction.budget_period_name || transaction.budget_item_name) && <BudgetAssignmentCard transaction={transaction} />}

    <Card>
      <Heading as="h3" size="3" mb="4">Status</Heading>
      <Flex direction="column" gap="3">
        <StatusLine caption="Review Status">
          <Flex align="center" gap="1">
            <ReviewStatusIcon status={transaction.review_status} />
            <Text size="2">{vocabularyLabel(REVIEW_STATUS_LABELS, transaction.review_status)}</Text>
          </Flex>
        </StatusLine>
        <StatusLine caption="Status">
          <Flex align="center" gap="1">
            <TransactionStatusIcon status={transaction.status} />
            <Text size="2">{vocabularyLabel(TRANSACTION_STATUS_LABELS, transaction.status)}</Text>
          </Flex>
        </StatusLine>
        <StatusLine caption="Account">
          <Text size="2" color="gray" highContrast>
            {transaction.account_name}
          </Text>
        </StatusLine>
      </Flex>
    </Card>

    {(transaction.is_import || transaction.import_transaction_id || transaction.import_description) && (
      <ImportInformationCard transaction={transaction} />
    )}

    {transaction.running_account_balance && (
      <Card>
        <Heading as="h3" size="3" mb="4">Balance Impact</Heading>
        <Box className="text-center">
          <Text as="p" size="2" color="gray" mb="1">Running Balance</Text>
          <Text as="p" size="5" weight="bold" {...textColorProps(transaction.running_account_balance >= 0 ? 'green' : 'red')}>
            {formatMoney(transaction.running_account_balance)}
          </Text>
        </Box>
      </Card>
    )}
  </Flex>
);
