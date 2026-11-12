import React from 'react';
import { Box, Button, Flex, Text } from '@radix-ui/themes';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatMoney } from '@nuggets/shared';
import type { Subtotal } from '../../pages/budgetPageCalcs';
import { remainingTone } from './budgetFigures';
import { ActionCell, FigureCell } from './BudgetItemParts';

/** How deep a header is: a section (Income, Goals, Expenses), a type, or a subtype. */
export type HeaderLevel = 'section' | 'type' | 'subtype';

const MOBILE_STYLE: Record<HeaderLevel, { box: string; px: '3' | '4'; py: '2' | '3'; title: React.ComponentProps<typeof Text>; amount: '1' | '2' }> = {
  section: { box: 'bg-[var(--gray-4)] rounded-t-[var(--radius-4)]', px: '4', py: '3', title: { size: '4', weight: 'bold' }, amount: '2' },
  type: { box: 'bg-[var(--gray-3)] rounded-[var(--radius-4)]', px: '4', py: '2', title: { size: '3', weight: 'bold' }, amount: '2' },
  subtype: { box: 'bg-[var(--gray-2)] rounded-[var(--radius-3)]', px: '3', py: '2', title: { size: '2', weight: 'medium' }, amount: '1' },
};

/** A mobile list's header: its title and what its items budget. */
export const MobileSectionHeader: React.FC<{ title: string; budget: number; level?: HeaderLevel }> = ({ title, budget, level = 'section' }) => {
  const style = MOBILE_STYLE[level];
  return (
    <Box px={style.px} py={style.py} className={style.box}>
      <Flex align="center" justify="between">
        <Text {...style.title}>{title}</Text>
        <Text size={style.amount} weight="bold">{formatMoney(budget)}</Text>
      </Flex>
    </Box>
  );
};

/**
 * A desktop header's three totals, under the Planned, Actual and Remaining columns: laid out as
 * the column headings are (a row card's margin and padding on the right, then the actions
 * column), so each total sits under its heading.
 */
const HeaderTotals: React.FC<{ totals: Pick<Subtotal, 'budget' | 'actual' | 'remaining'> }> = ({ totals }) => (
  <Flex gap="2" align="center" flexShrink="0" mr="3" pr="3" className="text-sm font-semibold">
    <FigureCell><span className="text-[var(--gray-12)]">{formatMoney(totals.budget)}</span></FigureCell>
    <FigureCell><span className="text-[var(--gray-12)]">{formatMoney(totals.actual)}</span></FigureCell>
    <FigureCell><span className={remainingTone(totals.remaining)}>{formatMoney(totals.remaining)}</span></FigureCell>
    <ActionCell />
  </Flex>
);

const DESKTOP_BUTTON: Record<HeaderLevel, string> = {
  section: 'text-lg font-semibold',
  type: 'text-md font-semibold',
  subtype: 'text-sm font-medium',
};

/**
 * A desktop section's header: a button that collapses it, and its totals. The button and the
 * totals share one row, which is what a screen reader and the tests read as the header's line.
 */
export const DesktopSectionHeader: React.FC<{
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  totals: Pick<Subtotal, 'budget' | 'actual' | 'remaining'>;
  level?: HeaderLevel;
}> = ({ title, collapsed, onToggle, totals, level = 'section' }) => {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  const toggle = (
    <Button variant="ghost" color="gray" onClick={onToggle} className={DESKTOP_BUTTON[level]}>
      <Chevron size={level === 'section' ? 20 : 16} />
      <span>{title}</span>
    </Button>
  );
  if (level === 'section') {
    return (
      <Flex align="center" justify="between">
        {toggle}
        <HeaderTotals totals={totals} />
      </Flex>
    );
  }
  // A type's and a subtype's title is indented; their totals stay under the headings.
  return (
    <Box pl="4" py={level === 'type' ? '3' : '2'}>
      <Flex align="center" justify="between">
        {toggle}
        <HeaderTotals totals={totals} />
      </Flex>
    </Box>
  );
};
