import React from 'react';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { MoreVertical, Eye, Pencil, Archive } from 'lucide-react';

export interface BudgetItemRowMenuProps {
  onView: () => void;
  onEdit: () => void;
  /** Archive, merge or delete it. */
  onRetire: () => void;
}

/**
 * The per-row "⋮" actions menu shared by the desktop row and mobile card.
 * Stops click propagation so opening it never triggers the card's row click.
 */
const BudgetItemRowMenu: React.FC<BudgetItemRowMenuProps> = ({ onView, onEdit, onRetire }) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      <IconButton
        variant="ghost"
        color="gray"
        size="1"
        aria-label="Budget item actions"
        title="Actions"
        onClick={(e) => e.stopPropagation()}
      >
        <MoreVertical size={16} />
      </IconButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content>
      <DropdownMenu.Item onSelect={onView}>
        <Eye size={16} /> View
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={onEdit}>
        <Pencil size={16} /> Edit
      </DropdownMenu.Item>
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={onRetire}>
        <Archive size={16} /> Archive or delete…
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
);

export default BudgetItemRowMenu;
