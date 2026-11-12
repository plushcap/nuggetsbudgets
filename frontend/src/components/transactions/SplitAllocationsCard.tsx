import React from 'react';
import { Badge, Box, Button, Card, Flex, Heading, Text } from '@radix-ui/themes';
import { Edit3, Plus, Split, X } from 'lucide-react';
import { formatMoney, type TransactionSplitChild, type TransactionWithSplits } from '@nuggets/shared';
import type { BudgetItem } from '../../services/api';
import { chosenColourProps, textColorProps } from '../../utils/textColor';
import type { Tag } from '../TagSelector';
import { SplitEditor } from './SplitEditor';
import type { UseConfirmationReturn } from '../../hooks/useConfirmation';
import { useSplitEditor } from './useSplitEditor';

/**
 * A split as the transaction lists it: its budget item, tags, note and share. Typed as the
 * split answer has it: a production build keeps an answer that didn't match its schema.
 */
const SplitChildRow: React.FC<{ index: number; child: TransactionSplitChild; parent: TransactionWithSplits }> = ({
  index,
  child,
  parent,
}) => (
  <Flex
    direction={{ initial: 'column', sm: 'row' }}
    align={{ sm: 'center' }}
    justify={{ sm: 'between' }}
    gap="3"
    p="4"
    className="rounded-[var(--radius-3)] bg-[var(--gray-2)] border border-[var(--gray-6)]"
  >
    <Box flexGrow="1">
      <Flex align="center" gap="2" mb="1" wrap="wrap">
        <Text size="2" weight="medium" color="gray" highContrast>
          Split {index + 1}
        </Text>
        {child.budget_item_name && (
          <Badge color="blue" size="1">
            {child.budget_item_name}
          </Badge>
        )}
      </Flex>
      {child.tags && child.tags.length > 0 && (
        <Flex align="center" gap="1" wrap="wrap" mt="2">
          {child.tags.map((tag) => (
            <Badge key={tag.id} size="1" {...chosenColourProps(tag.color)}>
              {tag.name}
            </Badge>
          ))}
        </Flex>
      )}
      {child.description && child.description !== parent.description && (
        <Text as="p" size="2" color="gray" mt="1">
          {child.description}
        </Text>
      )}
    </Box>
    <Box className="text-right sm:text-left">
      <Text as="div" size="4" weight="bold" {...textColorProps(child.amount < 0 ? 'red' : 'green')}>
        {formatMoney(child.amount)}
      </Text>
      <Text as="div" size="1" color="gray">
        {((Math.abs(child.amount) / Math.abs(parent.amount)) * 100).toFixed(1)}%
      </Text>
    </Box>
  </Flex>
);

/** The card's title, with its icon. */
const SplitHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Heading as="h2" size="4">
    <Flex align="center" gap="2">
      <Split size={20} className="text-[var(--gray-11)]" />
      {children}
    </Flex>
  </Heading>
);

interface SplitAllocationsCardProps {
  transaction: TransactionWithSplits;
  budgetItems: BudgetItem[];
  tags: Tag[];
  /** One of the page's writes is running. */
  saving: boolean;
  /** Runs a write with the page's buttons waiting (useTransactionEditor). */
  whileSaving: (write: () => Promise<void>) => Promise<void>;
  confirmAsync: UseConfirmationReturn['confirmAsync'];
}

/**
 * A transaction's splits: Start Split for one that isn't split, its splits with Edit Splits
 * and Unsplit for one that is, and the inline editor while they're edited.
 */
export const SplitAllocationsCard: React.FC<SplitAllocationsCardProps> = ({
  transaction,
  budgetItems,
  tags,
  saving,
  whileSaving,
  confirmAsync,
}) => {
  const editor = useSplitEditor({ transaction, confirmAsync, whileSaving });
  // As the split answer types them (a production build keeps an answer that didn't match).
  const children: TransactionSplitChild[] = transaction.split_children ?? [];

  // A side of a transfer isn't split: the server refuses it (409
  // TRANSFER_SPLIT_REFUSED). One split before the rule keeps its splits, and can be unsplit.
  const transferSide = (transaction.transfer_transaction_id ?? null) !== null;

  if (!transaction.is_split_parent && !editor.isEditing) {
    return (
      <Card>
        <Flex justify="between" align="center" gap="3" wrap="wrap">
          <SplitHeading>Split Transaction</SplitHeading>
          {!transferSide && (
            <Button variant="soft" color="gray" onClick={editor.start} disabled={saving}>
              <Plus size={16} />
              Start Split
            </Button>
          )}
        </Flex>
        <Text as="p" size="2" color="gray" mt="3">
          {transferSide
            ? "This is one side of a transfer, which moves money between two accounts and isn't split across budget items."
            : 'Split this transaction into multiple budget allocations. Add splits one at a time until they equal the transaction amount.'}
        </Text>
      </Card>
    );
  }

  if (!editor.isEditing && children.length === 0) return null;

  return (
    <Card>
      {/* On a phone the buttons go under the title rather than past the card's edge. */}
      <Flex justify="between" align="center" gap="3" wrap="wrap" mb="4">
        <SplitHeading>Split Allocations ({editor.isEditing ? editor.pendingSplits.length : children.length})</SplitHeading>
        {!editor.isEditing && (
          <Flex gap="2">
            {!transferSide && (
              <Button variant="soft" color="gray" size="2" onClick={editor.start} disabled={saving}>
                <Edit3 size={16} />
                Edit Splits
              </Button>
            )}
            <Button variant="soft" color="orange" size="2" onClick={() => void editor.unsplit()} disabled={saving}>
              <X size={16} />
              Unsplit
            </Button>
          </Flex>
        )}
      </Flex>

      {editor.isEditing ? (
        <SplitEditor editor={editor} amount={transaction.amount} budgetItems={budgetItems} tags={tags} saving={saving} />
      ) : (
        <>
          <Flex direction="column" gap="3">
            {children.map((child, index) => (
              <SplitChildRow key={child.id} index={index} child={child} parent={transaction} />
            ))}
          </Flex>
          <Box mt="4" pt="4" className="border-t border-[var(--gray-6)]">
            <Flex justify="between" align="center">
              <Text size="2" weight="medium" color="gray">
                Total
              </Text>
              <Text size="4" weight="bold" color="gray" highContrast>
                {formatMoney(transaction.amount)}
              </Text>
            </Flex>
          </Box>
        </>
      )}
    </Card>
  );
};
