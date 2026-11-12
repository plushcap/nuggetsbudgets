import React from 'react';
import { Button, Card, Flex, Heading, Select, Text } from '@radix-ui/themes';
import { Archive, Plus } from 'lucide-react';
import type { BudgetItem, BudgetPeriod } from '../../services/api';
import { periodKey, periodsNewestFirst } from '../../utils/budgetPeriods';

/** A period's name in the picker ("October 2026"). */
const periodLabel = (period: BudgetPeriod) =>
  new Date(period.year, period.month_number - 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

/**
 * The Budget page's header: its title, the period picker and the page's actions. A past or
 * future period's header is yellow (the Card's fill is --card-background-color).
 */
const BudgetPageHeader: React.FC<{
  currentPeriod: BudgetPeriod;
  budgetPeriods: BudgetPeriod[];
  isCurrentMonth: boolean;
  onSelectPeriod: (period: BudgetPeriod) => void;
  onAddItem: () => void;
  archivedItems: BudgetItem[];
  showArchived: boolean;
  onToggleArchived: () => void;
  /** The create-period dialog, with its trigger. */
  createPeriod: React.ReactNode;
}> = ({ currentPeriod, budgetPeriods, isCurrentMonth, onSelectPeriod, onAddItem, archivedItems, showArchived, onToggleArchived, createPeriod }) => (
  <Card size="2" className={isCurrentMonth ? '' : '[--card-background-color:var(--yellow-3)]'}>
    <Flex direction={{ initial: 'column', sm: 'row' }} align={{ initial: 'stretch', sm: 'center' }} justify="between" gap="4">
      <Flex direction="column" gap="1">
        <Heading size="6" weight="bold">Budget Plan</Heading>
        <Text size="2" color="gray">Track your monthly income and expenses</Text>
      </Flex>

      <Flex direction={{ initial: 'column', xs: 'row' }} align="stretch" gap="3" minWidth="0">
        <Button size="3" onClick={onAddItem}>
          <Plus size={16} />
          Add Budget Item
        </Button>

        {archivedItems.length > 0 && (
          <Button size="3" variant="soft" color="gray" aria-pressed={showArchived} onClick={onToggleArchived}>
            <Archive size={16} />
            {showArchived ? 'Hide archived' : `Show archived (${archivedItems.length})`}
          </Button>
        )}

        <Select.Root
          value={periodKey(currentPeriod)}
          onValueChange={(value) => {
            const period = budgetPeriods.find((p) => periodKey(p) === value);
            if (period) onSelectPeriod(period);
          }}
          size="3"
        >
          <Select.Trigger className="min-w-[180px]" aria-label="Budget period" />
          <Select.Content>
            {periodsNewestFirst(budgetPeriods).map((period) => (
              <Select.Item key={period.id} value={periodKey(period)}>{periodLabel(period)}</Select.Item>
            ))}
          </Select.Content>
        </Select.Root>

        {createPeriod}
      </Flex>
    </Flex>
  </Card>
);

export default BudgetPageHeader;
