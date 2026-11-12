import React from 'react';
import { Badge, Box, Card, Flex, IconButton, Text } from '@radix-ui/themes';
import { ArrowRightLeft, Activity } from 'lucide-react';
import type { BudgetPeriodItem } from '../../services/api';
import BudgetItemRowMenu from './BudgetItemRowMenu';
import { ActionCell, BudgetAmountField, BudgetItemIcon, BudgetProgressBar, BudgetStatusBadge, FigureCell } from './BudgetItemParts';
import { budgetStatus, envelopeTarget, progressPercentage, remainingOf, statusKind, styledAmount } from './budgetFigures';
import { itemEditHref, type BudgetRowActions } from './budgetRowActions';
import { budgetExpenseType, budgetItemStatus } from '@nuggets/shared';

export interface BudgetItemDesktopRowProps {
  item: BudgetPeriodItem;
  actions: BudgetRowActions;
  /**
   * Expense rows pass their group's type/subtype, which styles the progress bar (a flexible
   * monthly item's fills by status). Income rows omit these and get the plain bar.
   */
  groupType?: string | undefined;
  groupSubtype?: string | undefined;
}

/**
 * One budget-item row in the desktop Budget grid. Shared by the Income and Expense sections
 * (the Transfer/Activity controls self-gate on `expense_type === 'Expense'`).
 */
const BudgetItemDesktopRow: React.FC<BudgetItemDesktopRowProps> = ({ item, actions, groupType, groupSubtype }) => {
  const budget = actions.edit.budgetOf(item);
  const actual = styledAmount(item.calculated_actual);
  const remaining = styledAmount(remainingOf(item), 'remaining');
  const status = budgetStatus(item.calculated_actual, budget, item.calculated_remaining, statusKind(item));
  const target = envelopeTarget(item);
  const showProgressBar = budget > 0 || (item.type === 'Envelope' && !!item.rollover_target_amount);

  return (
    <Card mr="3" className="hover:shadow-xs transition-shadow">
      <Flex align="center" mb="2">
        <Flex align="center" gap="3" minWidth="0" flexShrink="1">
          <BudgetItemIcon item={item} />
          <Flex align="center" gap="2" minWidth="0">
            <a
              href={itemEditHref(item, actions.searchParamsString)}
              onClick={(e) => {
                e.preventDefault();
                actions.view(item);
              }}
              className="text-left focus:outline-hidden focus:ring-2 focus:ring-[var(--accent-9)] focus:ring-offset-2 rounded-[var(--radius-2)]"
            >
              <Text size="2" weight="medium" className="text-[var(--gray-12)] hover:text-[var(--accent-11)] truncate cursor-pointer transition-colors underline-offset-4 hover:underline">
                {item.budget_item_name}
              </Text>
            </a>
            {item.status === budgetItemStatus.enum.archived && <Badge color="gray" variant="soft" size="1">Archived</Badge>}
            <BudgetStatusBadge status={status} spentIcon />
            {target && (
              <Text size="1" weight="medium" className="text-[var(--accent-11)] whitespace-nowrap">
                {`${target.saved} of ${target.target}: ${target.percent}%`}
              </Text>
            )}
          </Flex>
        </Flex>

        <Flex align="center" gap="2" flexShrink="0" ml="auto">
          {item.expense_type === budgetExpenseType.enum.Expense && (
            <>
              <IconButton
                variant="ghost"
                color="gray"
                size="1"
                aria-label="Transfer money"
                title="Transfer money"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.transfer(item);
                }}
              >
                <ArrowRightLeft size={16} />
              </IconButton>
              <IconButton
                variant="ghost"
                color="gray"
                size="1"
                aria-label="View activity"
                title="View activity"
                onClick={(e) => {
                  e.stopPropagation();
                  actions.activity(item);
                }}
              >
                <Activity size={16} />
              </IconButton>
            </>
          )}
          <FigureCell>
            <BudgetAmountField item={item} edit={actions.edit} fieldId={`budget-${item.uuid}`} />
          </FigureCell>
          <FigureCell>
            <Text as="p" size="2" weight="medium" className={`py-1 ${actual.className}`}>{actual.text}</Text>
          </FigureCell>
          <FigureCell>
            <Text as="p" size="2" weight="medium" className={`py-1 ${remaining.className}`}>{remaining.text}</Text>
          </FigureCell>
          <ActionCell>
            <BudgetItemRowMenu onView={() => actions.view(item)} onEdit={() => actions.editItem(item)} onRetire={() => actions.retire(item)} />
          </ActionCell>
        </Flex>
      </Flex>

      {showProgressBar && (
        <Box mt="1">
          <BudgetProgressBar
            percent={progressPercentage(item, budget)}
            status={status}
            byStatus={groupType === 'Monthly' && groupSubtype === 'Flexible'}
          />
        </Box>
      )}
    </Card>
  );
};

export default BudgetItemDesktopRow;
