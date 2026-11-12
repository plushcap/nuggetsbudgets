import React from 'react';
import { Badge, Box, Card, Flex, Grid, IconButton, Text } from '@radix-ui/themes';
import { ArrowRightLeft } from 'lucide-react';
import type { BudgetPeriodItem } from '../../services/api';
import StretchedLink, { ABOVE_STRETCHED_LINK } from '../StretchedLink';
import BudgetItemRowMenu from './BudgetItemRowMenu';
import { BudgetAmountField, BudgetItemIcon, BudgetProgressBar, BudgetStatusBadge, CardFigure } from './BudgetItemParts';
import { budgetStatus, envelopeTarget, progressPercentage, remainingOf, statusKind, styledAmount } from './budgetFigures';
import type { BudgetRowActions } from './budgetRowActions';
import { budgetExpenseType, budgetItemStatus } from '@nuggets/shared';

export interface BudgetItemMobileCardProps {
  item: BudgetPeriodItem;
  actions: BudgetRowActions;
  /** Expense cards pass group type/subtype (styles the bar); omit for income. */
  groupType?: string | undefined;
  groupSubtype?: string | undefined;
  /** Income cards show a larger icon and a `type • subtype` line; expense cards do not. */
  income?: boolean;
}

/**
 * One budget-item card in the mobile Budget list. Shared by the Income and Expense sections; the
 * Transfer control self-gates on `expense_type === 'Expense'`. Its name links to the item's page,
 * stretched over the card: a click anywhere on it, and the keyboard, open the item, while
 * its menu, Transfer and budget field stay above the link.
 */
/** The item's page, which its card opens (as the page's `view` action does). */
const itemViewHref = (item: BudgetPeriodItem): string => `/budget-items/${item.budget_item_uuid}/view`;

const BudgetItemMobileCard: React.FC<BudgetItemMobileCardProps> = ({ item, actions, groupType, groupSubtype, income = false }) => {
  const budget = actions.edit.budgetOf(item);
  const actual = styledAmount(item.calculated_actual);
  const remaining = styledAmount(remainingOf(item), 'remaining');
  const status = budgetStatus(item.calculated_actual, budget, item.calculated_remaining, statusKind(item));
  const target = envelopeTarget(item);
  const showProgressBar = budget > 0 || (item.type === 'Envelope' && !!item.rollover_target_amount);

  return (
    <Card size="2" className="hover:shadow-xs transition-shadow">
      <Flex align="center" gap="3" mb="3">
        <BudgetItemIcon item={item} large={income} />
        <Box flexGrow="1" minWidth="0">
          <StretchedLink
            to={itemViewHref(item)}
            className="text-sm font-semibold text-[var(--gray-12)] hover:text-[var(--accent-11)] truncate underline-offset-4 hover:underline"
          >
            {item.budget_item_name}
          </StretchedLink>
          <Flex align="center" gap="2" mt="1">
            {item.status === budgetItemStatus.enum.archived && <Badge color="gray" variant="soft" size="1">Archived</Badge>}
            {income && (
              <Text size="1" className="text-[var(--gray-11)]">
                {item.type} • {item.subtype}
              </Text>
            )}
            <BudgetStatusBadge status={status} />
          </Flex>
        </Box>
        {/* A flex box, so the menu button sits in the row's middle (a block's line box would raise it). */}
        <Flex flexShrink="0" className={ABOVE_STRETCHED_LINK}>
          <BudgetItemRowMenu onView={() => actions.view(item)} onEdit={() => actions.editItem(item)} onRetire={() => actions.retire(item)} />
        </Flex>
      </Flex>

      <Grid columns="3" gap="4" className="text-center">
        <CardFigure label="Budget">
          <Flex align="center" justify="center" gap="1" className={ABOVE_STRETCHED_LINK}>
            {item.expense_type === budgetExpenseType.enum.Expense && (
              <IconButton
                variant="ghost"
                color="gray"
                size="1"
                aria-label="Transfer money"
                title="Transfer money"
                onClick={() => actions.transfer(item)}
              >
                <ArrowRightLeft size={16} />
              </IconButton>
            )}
            <BudgetAmountField item={item} edit={actions.edit} fieldId={`budget-mobile-${item.uuid}`} card />
          </Flex>
        </CardFigure>
        <CardFigure label="Actual">
          <Text as="p" className={`text-base font-semibold ${actual.className}`}>{actual.text}</Text>
        </CardFigure>
        <CardFigure label="Remaining">
          <Text as="p" className={`text-base font-semibold ${remaining.className}`}>{remaining.text}</Text>
        </CardFigure>
      </Grid>

      {showProgressBar && (
        <Box mt="3">
          <BudgetProgressBar
            percent={progressPercentage(item, budget)}
            status={status}
            byStatus={groupType === 'Monthly' && groupSubtype === 'Flexible'}
            thick
          />
          {target && (
            <Text as="p" size="1" align="center" weight="medium" mt="2" className="text-[var(--accent-11)]">
              {`${target.percent}% of target (${target.saved} / ${target.target})`}
            </Text>
          )}
        </Box>
      )}
    </Card>
  );
};

export default BudgetItemMobileCard;
