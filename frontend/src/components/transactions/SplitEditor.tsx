import React from 'react';
import { Badge, Box, Button, Flex, Grid, Heading, IconButton, Text } from '@radix-ui/themes';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { formatMoney } from '@nuggets/shared';
import type { BudgetItem } from '../../services/api';
import { chosenColourProps, textColorProps } from '../../utils/textColor';
import CurrencyInput from '../CurrencyInput';
import RadixBudgetItemSelector from '../RadixBudgetItemSelector';
import TagSelector, { type Tag } from '../TagSelector';
import type { SplitEditor as SplitEditorState } from './useSplitEditor';

interface SplitEditorProps {
  editor: SplitEditorState;
  /** The transaction's amount, pre-signed. */
  amount: number;
  budgetItems: BudgetItem[];
  tags: Tag[];
  saving: boolean;
}

/** One split in the list being made: its budget item, tags and amount, and Remove. */
const PendingSplitRow: React.FC<{
  index: number;
  amount: number;
  share: string;
  budgetItemName: string | null;
  tags: Tag[];
  onRemove: () => void;
}> = ({ index, amount, share, budgetItemName, tags, onRemove }) => (
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
        {budgetItemName && (
          <Badge color="blue" size="1">
            {budgetItemName}
          </Badge>
        )}
      </Flex>
      {tags.length > 0 && (
        <Flex align="center" gap="1" wrap="wrap" mt="2">
          {tags.map((tag) => (
            <Badge key={tag.id} size="1" {...chosenColourProps(tag.color)}>
              {tag.name}
            </Badge>
          ))}
        </Flex>
      )}
    </Box>
    <Flex align="center" gap="3">
      <Box className="text-right">
        <Text as="div" size="4" weight="bold" {...textColorProps(amount < 0 ? 'red' : 'green')}>
          {formatMoney(amount)}
        </Text>
        <Text as="div" size="1" color="gray">
          {share}
        </Text>
      </Box>
      <IconButton type="button" variant="soft" color="red" onClick={onRemove} aria-label="Remove split">
        <Trash2 size={16} />
      </IconButton>
    </Flex>
  </Flex>
);

/**
 * The inline split editor (useSplitEditor): what the splits add up to and what's left, the
 * splits so far, a form for the next one, and Update Split once they add up.
 */
export const SplitEditor: React.FC<SplitEditorProps> = ({ editor, amount, budgetItems, tags, saving }) => {
  const total = editor.totalCents / 100;
  const remaining = editor.remainingCents / 100;
  const { newSplit } = editor;

  return (
    <>
      {/* What the splits add up to, and what's left */}
      <Box mb="4" p="4" className="rounded-[var(--radius-3)] bg-[var(--accent-3)] border border-[var(--accent-6)]">
        <Grid columns="3" gap="4" className="text-center">
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              Transaction Amount
            </Text>
            <Text as="div" size="4" weight="bold" {...textColorProps(amount < 0 ? 'red' : 'green')}>
              {formatMoney(amount)}
            </Text>
          </Box>
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              Split Total
            </Text>
            <Text as="div" size="4" weight="bold" {...textColorProps(total < 0 ? 'red' : 'green')}>
              {formatMoney(total)}
            </Text>
          </Box>
          <Box>
            <Text as="div" size="1" color="gray" mb="1">
              Remaining
            </Text>
            <Text as="div" size="4" weight="bold" {...textColorProps(remaining === 0 ? 'green' : 'orange')}>
              {formatMoney(remaining)}
            </Text>
          </Box>
        </Grid>
      </Box>

      {editor.pendingSplits.length > 0 && (
        <Flex direction="column" gap="3" mb="4">
          {editor.pendingSplits.map((split, index) => (
            <PendingSplitRow
              key={index}
              index={index}
              amount={split.amount}
              share={`${((Math.abs(split.amount) / Math.abs(amount)) * 100).toFixed(1)}%`}
              budgetItemName={(split.budget_item_id && budgetItems.find((bi) => bi.id === split.budget_item_id)?.name) || null}
              tags={split.tag_ids && split.tag_ids.length > 0 ? tags.filter((tag) => split.tag_ids?.includes(tag.id)) : []}
              onRemove={() => editor.removeSplit(index)}
            />
          ))}
        </Flex>
      )}

      {/* The next split */}
      <Flex direction="column" gap="4" p="4" className="rounded-[var(--radius-3)] bg-[var(--gray-2)] border border-[var(--gray-6)]">
        <Heading as="h3" size="2">
          Add Split
        </Heading>

        <Box>
          <Text as="label" htmlFor="new-split-amount" size="2" weight="medium" color="gray" mb="1" className="block">
            Amount *
          </Text>
          {/* Entered positive; it reads `1,234.56` and `1.234,56`, and keeps text it can't read
              in the box, explained, rather than cut it (the editor holds it as text). */}
          <CurrencyInput
            id="new-split-amount"
            value={newSplit.amount === '' ? null : Number(newSplit.amount)}
            // Text it can't read is "NaN" (Number reads it back as NaN), so a reset to empty is a
            // change the box sees; adding the split refuses it.
            onChange={(value, unreadable) => editor.setNewAmount(unreadable ? String(Number.NaN) : value === null ? '' : String(value))}
          />
        </Box>

        <Box>
          <Text as="div" id="new-split-budget-item" size="2" weight="medium" color="gray" mb="1">
            Budget Item
          </Text>
          <RadixBudgetItemSelector
            aria-labelledby="new-split-budget-item"
            value={newSplit.budgetItem}
            onChange={editor.setNewBudgetItem}
            budgetItems={budgetItems}
            placeholder="Select budget item..."
          />
        </Box>

        <Box>
          <Text as="div" id="new-split-tags" size="2" weight="medium" color="gray" mb="1">
            Tags
          </Text>
          <TagSelector aria-labelledby="new-split-tags" selectedTags={newSplit.tags} tags={tags} onChange={editor.setNewTags} />
        </Box>

        <Button
          type="button"
          variant="soft"
          color="gray"
          size="3"
          onClick={editor.addSplit}
          disabled={newSplit.amount === '' || Number.isNaN(Number(newSplit.amount))}
        >
          <Plus size={16} />
          Add Split
        </Button>
      </Flex>

      <Grid columns="2" gap="3" mt="4">
        <Button type="button" color="green" size="3" onClick={() => void editor.save()} disabled={!editor.canSave || saving} loading={saving}>
          <Save size={16} />
          Update Split
        </Button>
        <Button type="button" variant="soft" color="gray" size="3" onClick={editor.cancel} disabled={saving}>
          <X size={16} />
          Cancel
        </Button>
      </Grid>
    </>
  );
};
