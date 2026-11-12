import React from 'react';
import { Flex } from '@radix-ui/themes';
import type { BudgetPeriodItem } from '../../services/api';
import type { Subtotal } from '../../pages/budgetPageCalcs';
import BudgetGoalCard from './BudgetGoalCard';
import { DesktopSectionHeader, MobileSectionHeader } from './BudgetSectionHeaders';
import type { BudgetRowActions } from './budgetRowActions';

/**
 * The Budget page's Goals section (its savings items, earliest target first), as the mobile
 * list's cards (`card`) or the desktop grid's rows, with its header and totals: one source for
 * both layouts. The caller picks the goals (the mobile list shows every one, the
 * desktop grid the active ones) and their totals.
 */
const BudgetGoalsSection: React.FC<{
  goals: BudgetPeriodItem[];
  totals: Subtotal;
  /** Opens a goal's page. */
  actions: BudgetRowActions;
  card?: boolean;
  /** Desktop only: whether the section is collapsed, and how to toggle it. */
  collapsed?: boolean;
  onToggle?: () => void;
}> = ({ goals, totals, actions, card = false, collapsed = false, onToggle }) => {
  if (goals.length === 0) return null;
  const list = (
    <Flex direction="column" gap={card ? '3' : '2'}>
      {goals.map((item) => <BudgetGoalCard key={item.uuid} item={item} actions={actions} card={card} />)}
    </Flex>
  );
  return (
    <Flex direction="column" gap="4">
      {card ? (
        <MobileSectionHeader title="Goals" budget={totals.budget} />
      ) : (
        // What the goals have put aside shows as its size, as each goal's does.
        <DesktopSectionHeader title="Goals" collapsed={collapsed} onToggle={() => onToggle?.()} totals={{ ...totals, actual: Math.abs(totals.actual) }} />
      )}
      {(card || !collapsed) && list}
    </Flex>
  );
};

export default BudgetGoalsSection;
