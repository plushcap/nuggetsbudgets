import React from 'react';
import { Box, Flex } from '@radix-ui/themes';
import type { BudgetPeriodItem } from '../../services/api';
import type { BudgetSections, BudgetSubtotals, Subtotal } from '../../pages/budgetPageCalcs';
import BudgetItemDesktopRow from './BudgetItemDesktopRow';
import BudgetGoalsSection from './BudgetGoalsSection';
import { ActionCell, FigureCell } from './BudgetItemParts';
import { DesktopSectionHeader } from './BudgetSectionHeaders';
import { BUDGET_SUBTYPE_ORDER, BUDGET_TYPE_ORDER } from './budgetFigures';
import type { BudgetCollapse } from './useBudgetCollapse';
import type { BudgetRowActions } from './budgetRowActions';

/** The grid's column names, over each row's Planned, Actual and Remaining figures. */
export const BudgetColumnHeaders: React.FC = () => (
  <Flex align="center" justify="between">
    <Box flexGrow="1" />
    {/* The right offset mirrors a row's card (its margin and padding, 12px each) and its
        trailing actions column, so these headings sit exactly over the values in each row. */}
    <Flex gap="2" align="center" mr="3" pr="3" className="text-xs font-medium text-[var(--gray-11)] uppercase tracking-wide">
      {/* Each name is its column's own element, in this row: the e2e journey finds the
          columns as the children of the element around "Planned". */}
      <FigureCell>Planned</FigureCell>
      <FigureCell>Actual</FigureCell>
      <FigureCell>Remaining</FigureCell>
      <ActionCell />
    </Flex>
  </Flex>
);

const Rows: React.FC<{ items: BudgetPeriodItem[]; actions: BudgetRowActions; type?: string; subtype?: string }> = ({
  items,
  actions,
  type,
  subtype,
}) => (
  <Flex direction="column" gap="2">
    {items.map((item) => (
      <BudgetItemDesktopRow key={item.uuid} item={item} actions={actions} groupType={type} groupSubtype={subtype} />
    ))}
  </Flex>
);

/**
 * The Budget page's items on a wide screen: Income, Goals and Expenses (by type, then subtype)
 * as rows under collapsible headers with their totals.
 */
const BudgetDesktopList: React.FC<{
  sections: BudgetSections;
  subtotals: BudgetSubtotals;
  /** The active goals (the grid shows only those) and their totals. */
  goals: BudgetPeriodItem[];
  goalTotals: Subtotal;
  actions: BudgetRowActions;
  goalActions: BudgetRowActions;
  collapse: BudgetCollapse;
}> = ({ sections, subtotals, goals, goalTotals, actions, goalActions, collapse }) => {
  const grouped = sections.expenseGrouped;
  const expensesCollapsed = collapse.section('Expense');
  return (
    <Flex direction="column" gap="5">
      {sections.income.length > 0 && (
        <Flex direction="column" gap="4">
          <DesktopSectionHeader
            title="Income"
            collapsed={collapse.section('Income')}
            onToggle={() => collapse.toggleSection('Income')}
            totals={subtotals.income}
          />
          {!collapse.section('Income') && <Rows items={sections.income} actions={actions} />}
        </Flex>
      )}

      <BudgetGoalsSection
        goals={goals}
        totals={goalTotals}
        actions={goalActions}
        collapsed={collapse.section('Savings')}
        onToggle={() => collapse.toggleSection('Savings')}
      />

      {sections.expenseItems.length > 0 && (
        <Flex direction="column" gap="4">
          <DesktopSectionHeader
            title="Expenses"
            collapsed={expensesCollapsed}
            onToggle={() => collapse.toggleSection('Expense')}
            totals={subtotals.expense}
          />
          {!expensesCollapsed && BUDGET_TYPE_ORDER.map((type) => {
            const byType = grouped[type];
            const typeTotals = subtotals.byType[type];
            if (!byType || !typeTotals) return null;
            const typeCollapsed = collapse.type('Expense', type);
            return (
              <Box key={`Expense-${type}`}>
                <DesktopSectionHeader
                  title={type}
                  level="type"
                  collapsed={typeCollapsed}
                  onToggle={() => collapse.toggleType('Expense', type)}
                  totals={typeTotals}
                />
                {!typeCollapsed && BUDGET_SUBTYPE_ORDER.map((subtype) => {
                  const items = byType[subtype];
                  const subtypeTotals = subtotals.bySubtype[`${type}::${subtype}`];
                  if (!items || !subtypeTotals) return null;
                  const subtypeCollapsed = collapse.subtype('Expense', type, subtype);
                  return (
                    <Box key={`Expense-${type}-${subtype}`}>
                      <DesktopSectionHeader
                        title={subtype}
                        level="subtype"
                        collapsed={subtypeCollapsed}
                        onToggle={() => collapse.toggleSubtype('Expense', type, subtype)}
                        totals={subtypeTotals}
                      />
                      {!subtypeCollapsed && (
                        // Indented on the left only: on the right, the rows' figures stay under the headings.
                        <Box py="3" pl="3">
                          <Rows items={items} actions={actions} type={type} subtype={subtype} />
                        </Box>
                      )}
                    </Box>
                  );
                })}
              </Box>
            );
          })}
        </Flex>
      )}
    </Flex>
  );
};

export default BudgetDesktopList;
