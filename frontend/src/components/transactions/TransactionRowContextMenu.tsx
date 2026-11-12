import React from 'react';
import { ContextMenu, Flex } from '@radix-ui/themes';
import type { BudgetItem, BudgetPeriod, Tag, Transaction, User } from '../../services/api';
import type { TransactionQuickActions } from '../../hooks/useTransactionQuickActions';
import { assignableBudgetItems } from '../../utils/budgetItems';
import { latestBudgetPeriods, tagIconComponent } from './transactionRows';
import { transactionReviewStatus } from '@nuggets/shared';
import { personName } from '../../utils/personName';

interface TransactionRowContextMenuProps {
  transaction: Transaction;
  actions: TransactionQuickActions;
  budgetPeriods: BudgetPeriod[];
  budgetItems: BudgetItem[];
  users: User[];
  /** The tags that may be applied (the active ones). */
  tags: Tag[];
}

/**
 * A desktop row's right-click menu: the quick actions (review, budget period, budget item,
 * assignee, a tag). The row's "Quick actions" button opens the same actions for the keyboard.
 */
const TransactionRowContextMenu: React.FC<TransactionRowContextMenuProps> = ({
  transaction,
  actions,
  budgetPeriods,
  budgetItems,
  users,
  tags,
}) => (
  <ContextMenu.Content>
    <ContextMenu.Item onClick={() => actions.toggleReviewed(transaction)}>
      {transaction.review_status === transactionReviewStatus.enum.reviewed ? 'Mark as Needs Review' : 'Mark as Reviewed'}
    </ContextMenu.Item>

    {budgetPeriods.length > 0 && (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>Budget Period</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {latestBudgetPeriods(budgetPeriods).map((period) => (
            <ContextMenu.Item key={period.id} onClick={() => actions.changeBudgetPeriod(transaction, period.id)}>
              {period.name}
            </ContextMenu.Item>
          ))}
          <ContextMenu.Separator />
          <ContextMenu.Item onClick={() => actions.changeBudgetPeriod(transaction, null)}>
            Clear Budget Period
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )}

    {budgetItems.length > 0 && (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>Budget Item</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {assignableBudgetItems(budgetItems).map((item) => (
            <ContextMenu.Item key={item.id} onClick={() => actions.changeBudgetItem(transaction, item.id)}>
              {item.name}
            </ContextMenu.Item>
          ))}
          <ContextMenu.Separator />
          <ContextMenu.Item onClick={() => actions.changeBudgetItem(transaction, null)}>
            Clear Budget Item
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )}

    {users.length > 0 && (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>Assign To</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {users.map((user) => (
            <ContextMenu.Item key={user.id} onClick={() => actions.assignUser(transaction, user.id)}>
              {personName(user)}
            </ContextMenu.Item>
          ))}
          <ContextMenu.Separator />
          <ContextMenu.Item onClick={() => actions.assignUser(transaction, null)}>
            Unassign
          </ContextMenu.Item>
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )}

    {tags.length > 0 && (
      <ContextMenu.Sub>
        <ContextMenu.SubTrigger>Apply Tag</ContextMenu.SubTrigger>
        <ContextMenu.SubContent>
          {tags.map((tag) => {
            const IconComponent = tagIconComponent(tag);
            return (
              <ContextMenu.Item key={tag.id} onClick={() => actions.applyTag(transaction, tag.uuid)}>
                <Flex gap="2" align="center">
                  <IconComponent
                    size={16}
                    style={{ /* lint:guard colour: the tag's own colour */ color: tag.color || 'var(--accent-11)' }}
                  />
                  <span>{tag.name}</span>
                </Flex>
              </ContextMenu.Item>
            );
          })}
        </ContextMenu.SubContent>
      </ContextMenu.Sub>
    )}
  </ContextMenu.Content>
);

export default TransactionRowContextMenu;
