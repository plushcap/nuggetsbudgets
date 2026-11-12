import React from 'react';
import { Box, Card, Flex, Grid, Text } from '@radix-ui/themes';
import type { BudgetPeriodItem } from '../../services/api';
import { formatCalendarDate } from '../../utils/dateUtils';
import { ActionCell, BudgetAmountField, BudgetItemIcon, BudgetProgressBar, BudgetStatusBadge, CardFigure, FigureCell } from './BudgetItemParts';
import StretchedLink, { ABOVE_STRETCHED_LINK } from '../StretchedLink';
import { goalFigures } from './budgetFigures';
import { goalHref, type BudgetRowActions } from './budgetRowActions';

/**
 * One savings goal on the Budget page, as a mobile card (`card`) or a desktop row: one source
 * for both, which had been two copies. Its name links to the goal's page; on the
 * mobile card that link is stretched over the card, so a click anywhere on it, and the
 * keyboard, open the goal, while its budget field stays above the link.
 */
const BudgetGoalCard: React.FC<{ item: BudgetPeriodItem; actions: BudgetRowActions; card?: boolean }> = ({ item, actions, card = false }) => {
  const budget = actions.edit.budgetOf(item);
  const { actual, remaining, status, percent } = goalFigures(item, budget);
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    actions.view(item);
  };
  const targetDate = item.goal_target_date && (
    <Text size="1" weight="medium" className="text-[var(--accent-11)] whitespace-nowrap">
      Target: {formatCalendarDate(item.goal_target_date)}
    </Text>
  );
  const bar = budget > 0 && (
    <Box mt={card ? '3' : '1'}>
      <BudgetProgressBar percent={percent} status={status} thick={card} />
    </Box>
  );

  if (card) {
    return (
      <Card variant="surface" size="2" className="hover:shadow-xs transition-shadow">
        <Flex align="center" gap="3" mb="3">
          <BudgetItemIcon item={item} large />
          <Box flexGrow="1" minWidth="0">
            <StretchedLink
              to={goalHref(item)}
              className="text-sm font-semibold text-[var(--gray-12)] hover:text-[var(--accent-11)] truncate underline-offset-4 hover:underline"
            >
              {item.budget_item_name}
            </StretchedLink>
            <Flex align="center" gap="2" mt="1">
              {targetDate}
              <BudgetStatusBadge status={status} />
            </Flex>
          </Box>
        </Flex>

        <Grid columns="3" gap="4" className="text-center">
          <CardFigure label="Budget">
            <Flex align="center" justify="center" gap="1" className={ABOVE_STRETCHED_LINK}>
              <BudgetAmountField item={item} edit={actions.edit} fieldId={`budget-mobile-goal-${item.uuid}`} card />
            </Flex>
          </CardFigure>
          <CardFigure label="Actual">
            <Text as="p" className={`text-base font-semibold ${actual.className}`}>{actual.text}</Text>
          </CardFigure>
          <CardFigure label="Remaining">
            <Text as="p" className={`text-base font-semibold ${remaining.className}`}>{remaining.text}</Text>
          </CardFigure>
        </Grid>
        {bar}
      </Card>
    );
  }

  return (
    <Card mr="3" className="hover:shadow-xs transition-shadow">
      <Flex align="center" mb="2">
        <Flex align="center" gap="3" minWidth="0" flexShrink="1">
          <BudgetItemIcon item={item} />
          <Flex align="center" gap="2" minWidth="0">
            <a
              href={goalHref(item)}
              onClick={open}
              className="text-left focus:outline-hidden focus:ring-2 focus:ring-[var(--accent-9)] focus:ring-offset-2 rounded-[var(--radius-2)]"
            >
              <Text size="2" weight="medium" className="text-[var(--gray-12)] hover:text-[var(--accent-11)] truncate cursor-pointer transition-colors underline-offset-4 hover:underline">
                {item.budget_item_name}
              </Text>
            </a>
            {targetDate}
          </Flex>
        </Flex>

        <Flex align="center" gap="2" flexShrink="0" ml="auto">
          <FigureCell>
            <BudgetAmountField item={item} edit={actions.edit} fieldId={`budget-${item.uuid}`} />
          </FigureCell>
          <FigureCell>
            <Text as="p" size="2" weight="medium" className={`py-1 ${actual.className}`}>{actual.text}</Text>
          </FigureCell>
          <FigureCell>
            <Text as="p" size="2" weight="medium" className={`py-1 ${remaining.className}`}>{remaining.text}</Text>
          </FigureCell>
          {/* No menu, but its column: the figures sit under the headings as every row's do. */}
          <ActionCell />
        </Flex>
      </Flex>
      {bar}
    </Card>
  );
};

export default BudgetGoalCard;
