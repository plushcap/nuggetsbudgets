import React from 'react';
import { Link } from 'react-router-dom';
import { Badge, Box, Flex, Text } from '@radix-ui/themes';
import { Check, ExternalLink, Tag as TagIcon } from 'lucide-react';
import type { BudgetItem } from '../../services/api';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';
import { FieldCaption, FieldStatus, ReadOnlyValue, type FieldSaveStatus } from './TransactionFieldParts';

const CAPTION_ID = 'transaction-budget-item';

interface BudgetItemFieldProps {
  editing: boolean;
  status: FieldSaveStatus;
  /** A split parent's budget items are its splits': it has none of its own. */
  isSplitParent: boolean;
  /** The budget item the form holds. */
  value: number | null;
  onChange: (budgetItemId: number | null) => void;
  budgetItems: BudgetItem[];
  /** The transaction's budget item, shown while it isn't edited. */
  budgetItemName: string | null;
  budgetItemUuid: string | null;
}

/** The transaction's budget item, with a link to the item's rules. */
export const BudgetItemField: React.FC<BudgetItemFieldProps> = ({
  editing,
  status,
  isSplitParent,
  value,
  onChange,
  budgetItems,
  budgetItemName,
  budgetItemUuid,
}) => {
  // The chosen item's uuid, once the budget items have loaded: until then there is no link to
  // its rules (it was `/budget-items/undefined/rules`).
  const chosenUuid = value ? budgetItems.find((bi) => bi.id === value)?.uuid : undefined;
  return (
    <Box>
      <FieldCaption id={CAPTION_ID}>
        Budget Item
        <FieldStatus {...status} />
        {isSplitParent && (
          <Badge color="gray" size="1" ml="2">
            On each split
          </Badge>
        )}
      </FieldCaption>
      {editing && !isSplitParent ? (
        <Box>
          <RadixBudgetItemSelector
            aria-labelledby={CAPTION_ID}
            value={value}
            onChange={onChange}
            budgetItems={budgetItems}
            placeholder="Select a budget item..."
          />
          {/* The chosen budget item, with a link to its rules */}
          {value ? (
            <Flex align="center" justify="between" mt="2">
              <Text size="1" color="green" highContrast>
                <Flex as="span" align="center" gap="1">
                  <Check size={12} />
                  Budget item selected
                </Flex>
              </Text>
              {chosenUuid && (
                <a
                  href={`/budget-items/${chosenUuid}/rules`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--accent-11)] hover:text-[var(--accent-12)]"
                >
                  <Flex as="span" align="center" gap="1">
                    View Rules
                    <ExternalLink size={12} />
                  </Flex>
                </a>
              )}
            </Flex>
          ) : null}
        </Box>
      ) : (
        <ReadOnlyValue>
          {isSplitParent ? (
            <Text color="gray">Each split has its own budget item. Use Edit Splits below to change them.</Text>
          ) : budgetItemName ? (
            <Flex align="center" justify="between">
              <Flex align="center" gap="2">
                <TagIcon size={16} className="text-[var(--green-12)]" />
                <Text weight="medium" color="gray" highContrast>
                  {budgetItemName}
                </Text>
              </Flex>
              {budgetItemUuid && (
                <Link
                  to={`/budget-items/${budgetItemUuid}/rules`}
                  className="text-sm font-medium transition-colors text-[var(--accent-11)] hover:text-[var(--accent-12)]"
                  title="View automatic assignment rules for this budget item"
                >
                  View Rules
                </Link>
              )}
            </Flex>
          ) : (
            <Text color="gray">No budget item</Text>
          )}
        </ReadOnlyValue>
      )}
    </Box>
  );
};
