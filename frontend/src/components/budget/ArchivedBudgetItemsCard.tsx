import React from 'react';
import { Button, Card, Flex, Heading, Text } from '@radix-ui/themes';
import type { BudgetItem } from '../../services/api';

/** The ledger's archived budget items, each with a way to its page and to restore it. */
const ArchivedBudgetItemsCard: React.FC<{
  items: BudgetItem[];
  onView: (item: BudgetItem) => void;
  onRestore: (item: BudgetItem) => void;
}> = ({ items, onView, onRestore }) => (
  <Card>
    <Flex direction="column" gap="3">
      <Flex direction="column" gap="1">
        <Heading as="h2" size="4">Archived budget items</Heading>
        <Text size="2" color="gray">
          Hidden from new periods and the budget-item pickers. Their history stays, and they still show in periods they had activity in.
        </Text>
      </Flex>
      {items.map((item) => (
        <Flex key={item.uuid} justify="between" align="center" gap="3" wrap="wrap">
          <Text weight="medium">{item.name}</Text>
          <Flex gap="2">
            <Button variant="ghost" onClick={() => onView(item)}>View</Button>
            <Button variant="soft" onClick={() => onRestore(item)}>Restore…</Button>
          </Flex>
        </Flex>
      ))}
    </Flex>
  </Card>
);

export default ArchivedBudgetItemsCard;
