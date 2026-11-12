import React from 'react';
import { Box, Flex } from '@radix-ui/themes';
import type { BudgetSections, BudgetSubtotals, Subtotal } from '../../pages/budgetPageCalcs';
import BudgetItemMobileCard from './BudgetItemMobileCard';
import BudgetGoalsSection from './BudgetGoalsSection';
import { MobileSectionHeader } from './BudgetSectionHeaders';
import { BUDGET_SUBTYPE_ORDER, BUDGET_TYPE_ORDER } from './budgetFigures';
import type { BudgetRowActions } from './budgetRowActions';

/**
 * The Budget page's items on a narrow screen: Income, Goals and Expenses (by type, then
 * subtype) as cards, each section headed by what it budgets.
 */
const BudgetMobileList: React.FC<{
  sections: BudgetSections;
  subtotals: BudgetSubtotals;
  /** Every goal's totals (the mobile list shows them all). */
  goalTotals: Subtotal;
  actions: BudgetRowActions;
  goalActions: BudgetRowActions;
}> = ({ sections, subtotals, goalTotals, actions, goalActions }) => {
  const grouped = sections.expenseGrouped;
  return (
    <Flex direction="column" gap="5">
      {sections.income.length > 0 && (
        <Flex direction="column" gap="4">
          <MobileSectionHeader title="Income" budget={subtotals.income.budget} />
          <Flex direction="column" gap="3">
            {sections.income.map((item) => <BudgetItemMobileCard key={item.uuid} item={item} actions={actions} income />)}
          </Flex>
        </Flex>
      )}

      <BudgetGoalsSection goals={sections.savings} totals={goalTotals} actions={goalActions} card />

      {sections.expenseItems.length > 0 && (
        <Flex direction="column" gap="4">
          <MobileSectionHeader title="Expenses" budget={subtotals.expense.budget} />
          {BUDGET_TYPE_ORDER.map((type) => {
            const byType = grouped[type];
            if (!byType) return null;
            return (
              <Flex key={type} direction="column" gap="3">
                <MobileSectionHeader title={type} budget={subtotals.byType[type]?.budget ?? 0} level="type" />
                {BUDGET_SUBTYPE_ORDER.map((subtype) => {
                  const items = byType[subtype];
                  if (!items) return null;
                  return (
                    <Flex key={`${type}-${subtype}`} direction="column" gap="2">
                      <MobileSectionHeader title={subtype} budget={subtotals.bySubtype[`${type}::${subtype}`]?.budget ?? 0} level="subtype" />
                      <Box pl="2">
                        <Flex direction="column" gap="2">
                          {items.map((item) => (
                            <BudgetItemMobileCard key={item.uuid} item={item} actions={actions} groupType={type} groupSubtype={subtype} />
                          ))}
                        </Flex>
                      </Box>
                    </Flex>
                  );
                })}
              </Flex>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
};

export default BudgetMobileList;
