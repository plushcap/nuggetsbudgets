import React from 'react';
import { Badge, Box, Button, Flex, Text, TextField } from '@radix-ui/themes';
import { CheckCircle } from 'lucide-react';
import type { BudgetPeriodItem } from '../../services/api';
import { getIconByName } from '../../utils/iconCatalog';
import { chosenTintStyle, textColorProps } from '../../utils/textColor';
import { focusOnMount } from '../../utils/focusOnMount';
import { budgetEditLabel } from './budgetEditLabel';
import { BUDGET_STATUS_LABELS, plainBarClass, STATUS_BAR_CLASS, styledAmount, type BudgetStatus } from './budgetFigures';
import type { InlineBudgetEdit } from './useInlineBudgetEdit';

/**
 * The pieces every budget-item row and card is built from: the item's icon, its
 * status, its bar and its editable budget. The desktop rows, the mobile cards and the goal cards
 * each had their own copy of each.
 */

/** The item's icon on a tint of its colour, drawn in a shade that reads on it. */
export const BudgetItemIcon: React.FC<{ item: Pick<BudgetPeriodItem, 'icon' | 'color'>; large?: boolean }> = ({ item, large }) => {
  const Icon = getIconByName(item.icon ?? '')?.component;
  return (
    <Box flexShrink="0" p="2" className="rounded-full" style={chosenTintStyle(item.color)}>
      {Icon && <Icon size={large ? 20 : 16} />}
    </Box>
  );
};

const STATUS_COLOR: Record<BudgetStatus, 'red' | 'orange' | 'yellow' | 'green' | 'gray' | 'amber'> = {
  'over-budget': 'red',
  spent: 'red',
  critical: 'red',
  warning: 'orange',
  'near-limit': 'yellow',
  'on-track': 'green',
  // Income and goals.
  expected: 'gray',
  'partly-received': 'amber',
  received: 'green',
  'above-plan': 'green',
  funded: 'green',
};

/** Where the item stands ("Near Limit"); `spentIcon` marks a spent item with a check. */
export const BudgetStatusBadge: React.FC<{ status: BudgetStatus; spentIcon?: boolean }> = ({ status, spentIcon }) => (
  <Badge size="1" variant="soft" radius="full" {...textColorProps(STATUS_COLOR[status])}>
    {spentIcon && status === 'spent' && <CheckCircle size={12} aria-hidden="true" />}
    {BUDGET_STATUS_LABELS[status]}
  </Badge>
);

/**
 * The item's bar, `percent` full. A flexible monthly item's (`byStatus`) fills from the right in
 * its status's colour, as what is left shrinks; the others fill from the left, red over budget,
 * yellow near the limit, else green.
 */
export const BudgetProgressBar: React.FC<{ percent: number; status: BudgetStatus; byStatus?: boolean; thick?: boolean }> = ({
  percent,
  status,
  byStatus = false,
  thick = false,
}) => {
  const height = thick ? '8px' : '6px';
  return (
    <Flex justify={byStatus ? 'end' : 'start'} width="100%" height={height} className="bg-[var(--gray-3)] rounded-full">
      <Box
        height={height}
        width={`${Math.min(percent, 100)}%`}
        className={`rounded-full transition-all duration-300 opacity-50 ${byStatus ? STATUS_BAR_CLASS[status] : plainBarClass(status)}`}
      />
    </Flex>
  );
};

/**
 * The item's budget, a button that opens it for editing in place (named for the item), or
 * the open field. A row's is compact and fills its column; a card's is larger.
 */
export const BudgetAmountField: React.FC<{
  item: BudgetPeriodItem;
  edit: InlineBudgetEdit;
  /** The field's id, unique on the page (both layouts are in the document). */
  fieldId: string;
  card?: boolean;
}> = ({ item, edit, fieldId, card = false }) => {
  if (edit.isEditing(item)) {
    return (
      <TextField.Root
        size={card ? '2' : '1'}
        type="text"
        id={fieldId}
        name={fieldId}
        aria-label={`Budget for ${item.budget_item_name}`}
        placeholder="0"
        value={edit.editingValue(item)}
        onChange={(e) => edit.change(item, e)}
        onKeyDown={(e) => edit.keyDown(item, e)}
        onBlur={() => edit.blur(item)}
        className={card ? 'w-28 text-right' : 'w-full text-right'}
        ref={focusOnMount}
      >
        <TextField.Slot>$</TextField.Slot>
      </TextField.Root>
    );
  }
  const amount = styledAmount(edit.budgetOf(item));
  return (
    <Button
      variant="ghost"
      color="gray"
      onClick={() => edit.startEdit(item)}
      aria-label={budgetEditLabel(item.budget_item_name, amount.text)}
      // A row's figure sits at its column's right edge, as the headings and totals do:
      // a ghost button's padding hangs outside its box, and its content was centred.
      className={card ? `text-base font-semibold py-1 px-2 ${amount.className}` : `w-full justify-end text-sm font-medium py-1 px-2 ${amount.className}`}
    >
      {amount.text}
    </Button>
  );
};

/**
 * A figure column, 6rem wide, its text at the right edge: the column headings', the totals' and
 * each row's (a row's budget button keeps its padding outside the column, as a ghost button does).
 */
export const FigureCell: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box width="6rem" flexShrink="0" className="text-right">{children}</Box>
);

/**
 * The column after the figures, 24px wide: a row's actions menu, or nothing (the headings, the
 * totals, a goal's row). Every line of the desktop grid ends in one, so their figures line up.
 * The menu's ghost button hangs 4px outside its own box, so the column, not the button,
 * sets the width.
 */
export const ActionCell: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <Flex width="24px" flexShrink="0" justify="center">{children}</Flex>
);

/** A card's figure: its label over its amount. */
export const CardFigure: React.FC<{ label: string; children: React.ReactNode; onClick?: (e: React.MouseEvent) => void }> = ({
  label,
  children,
  onClick,
}) => (
  <Box onClick={onClick}>
    <Text as="p" size="2" color="gray" mb="1">{label}</Text>
    {children}
  </Box>
);
