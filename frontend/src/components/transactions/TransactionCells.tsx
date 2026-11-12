import React from 'react';
import { Badge, Box, Flex, Text, VisuallyHidden } from '@radix-ui/themes';
import { AlertTriangle, Check, Clock, Split, User } from 'lucide-react';
import { TRANSACTION_STATUS_LABELS, vocabularyLabel, type TransactionTag, transactionReviewStatus } from '@nuggets/shared';
import type { Transaction, User as UserType } from '../../services/api';
import { chosenColourProps } from '../../utils/textColor';
import { reviewStatusWords, statusBadgeColor, tagIconComponent } from './transactionRows';
import { personInitials, personName } from '../../utils/personName';

/**
 * The transaction table's cells, shared by its desktop rows and its mobile cards. Icons carry
 * their words for a screen reader (and a tooltip).
 */

/** The review status as an icon: reviewed, flagged, or waiting for a review. */
export const ReviewStatusIcon: React.FC<{ transaction: Transaction }> = ({ transaction }) => {
  const words = reviewStatusWords(transaction);
  const icon =
    transaction.review_status === transactionReviewStatus.enum.reviewed ? (
      <Check size={16} className="text-[var(--green-12)]" aria-hidden="true" />
    ) : transaction.review_status === transactionReviewStatus.enum.flagged ? (
      <AlertTriangle size={16} className="text-[var(--red-11)]" aria-hidden="true" />
    ) : (
      <Clock size={16} className="text-[var(--amber-12)]" aria-hidden="true" />
    );
  return (
    <Flex as="span" display="inline-flex" title={words}>
      {icon}
      <VisuallyHidden>{words}</VisuallyHidden>
    </Flex>
  );
};

/** A person's initials on their colour, in a circle. */
export const PersonInitials: React.FC<{ user: UserType; title?: string | undefined; children?: React.ReactNode }> = ({
  user,
  title,
  children,
}) => (
  <Flex
    align="center"
    justify="center"
    title={title}
    width="24px"
    height="24px"
    {...chosenColourProps(user.default_color, 'gray', 'rounded-full text-xs font-medium')}
  >
    {children}
  </Flex>
);

/** Who the transaction is assigned to: their initials, named in full for a screen reader. */
export const Assignee: React.FC<{ user: UserType | null }> = ({ user }) =>
  user ? (
    <PersonInitials user={user} title={personName(user)}>
      <span aria-hidden="true">{personInitials(user)}</span>
      <VisuallyHidden>Assigned to {personName(user)}</VisuallyHidden>
    </PersonInitials>
  ) : (
    <Flex as="span" display="inline-flex" title="Unassigned">
      <User size={16} className="text-[var(--gray-11)]" aria-hidden="true" />
      <VisuallyHidden>Unassigned</VisuallyHidden>
    </Flex>
  );

/**
 * The transaction's budget item. A split parent's items are on its splits, so it has none of
 * its own: it says "Split" rather than "Uncategorized".
 */
export const BudgetItemLabel: React.FC<{ transaction: Transaction; emptySize: '1' | '2' }> = ({ transaction, emptySize }) =>
  transaction.is_split_parent ? (
    <Badge color="purple" variant="soft" size="1">
      <Split size={12} />
      Split
    </Badge>
  ) : transaction.budget_item_name ? (
    <Badge variant="soft" size="1">
      {transaction.budget_item_name}
    </Badge>
  ) : (
    <Text size={emptySize} color="gray">Uncategorized</Text>
  );

/** The transaction's tags as their icons in their colours, named for a screen reader (desktop). */
export const TagIcons: React.FC<{ tags: TransactionTag[] | null | undefined }> = ({ tags }) =>
  tags && tags.length > 0 ? (
    <>
      {tags.map((tag, index) => {
        const IconComponent = tagIconComponent(tag);
        return (
          <Box key={tag.id} title={tag.name} className="cursor-help">
            <IconComponent
              size={16}
              style={{ /* lint:guard colour: the tag's own colour */ color: tag.color || 'var(--accent-11)' }}
              aria-hidden="true"
            />
            <VisuallyHidden>{index > 0 ? `, ${tag.name}` : tag.name}</VisuallyHidden>
          </Box>
        );
      })}
    </>
  ) : (
    <Text size="1" color="gray">-</Text>
  );

/** The transaction's tags as badges in their colours, with their icons (mobile). */
export const TagBadges: React.FC<{ tags: TransactionTag[] }> = ({ tags }) => (
  <>
    {tags.map((tag) => {
      const IconComponent = tagIconComponent(tag);
      return (
        <Badge key={tag.id} variant="soft" size="1" {...chosenColourProps(tag.color)}>
          <IconComponent size={12} aria-hidden="true" />
          {tag.name}
        </Badge>
      );
    })}
  </>
);

/** The bank's status, in its label: green once cleared or reconciled, in step-12 text. */
export const StatusBadge: React.FC<{ status: Transaction['status'] }> = ({ status }) => (
  <Badge highContrast color={statusBadgeColor(status)} variant="soft" size="1">
    {vocabularyLabel(TRANSACTION_STATUS_LABELS, status)}
  </Badge>
);
