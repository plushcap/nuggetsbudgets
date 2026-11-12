import React, { useMemo, useState } from 'react';
import { Tag, X } from 'lucide-react';
import { Badge, Text } from '@radix-ui/themes';
import { assignableBudgetItems } from '../utils/budgetItems';
import { getIconByName } from '../utils/iconCatalog';
import type { BudgetItem } from '../services/api';

/** What the picker shows of a budget item: its name, type and icon, and whether it's archived. */
export type BudgetItemChoice = Pick<BudgetItem, 'id' | 'name' | 'type' | 'icon'> & { status?: BudgetItem['status'] | undefined };
import Combobox, { type ComboboxOption } from './Combobox';

/** How many items the list shows at once; typing narrows the rest. */
const SHOWN = 100;

interface RadixBudgetItemSelectorProps {
  value: number | null;
  onChange: (value: number | null) => void;
  budgetItems: BudgetItemChoice[];
  placeholder?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  defaultOpen?: boolean | undefined; // Open the list immediately (e.g. mobile picker sheet)
  keyboardAware?: boolean | undefined; // Cap the list to the space above the on-screen keyboard
  /** The id of this field's visible label. The trigger is named by it, then by its own value. */
  'aria-labelledby'?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorProps): read after its name. */
  'aria-describedby'?: string | undefined;
  /**
   * The trigger button's id, for a `focusFirstError` selector or a `fieldErrorProps` field id,
   * so a refused field is focused on the trigger itself. Without one it makes its own.
   */
  id?: string | undefined;
}

// Resolve icons from the curated catalog (the set the icon picker offers), not the whole
// lucide-react namespace, so the bundle doesn't take the entire icon library.
const ItemIcon: React.FC<{ name?: string | null }> = ({ name }) => {
  const Icon = (name && getIconByName(name)?.component) || Tag;
  return <Icon aria-hidden size={16} className="shrink-0 text-[var(--gray-11)]" />;
};

const byTypeThenName = (a: BudgetItemChoice, b: BudgetItemChoice) => {
  const typeA = a.type ?? '';
  const typeB = b.type ?? '';
  if (typeA !== typeB) return typeB.localeCompare(typeA); // Monthly before Annual
  return a.name.localeCompare(b.name);
};

/**
 * The budget item picker: "No budget item", then the items sorted by type and name; every
 * word of the search must appear in an item's name or type. Archived items aren't offered,
 * but the current one still shows if it is. Built on Combobox.
 */
const RadixBudgetItemSelector: React.FC<RadixBudgetItemSelectorProps> = ({
  value,
  onChange,
  budgetItems: allBudgetItems,
  placeholder = 'Select a budget item...',
  className = '',
  disabled = false,
  error,
  defaultOpen = false,
  keyboardAware = false,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  id,
}) => {
  const [search, setSearch] = useState('');
  const budgetItems = useMemo(() => assignableBudgetItems(allBudgetItems, value), [allBudgetItems, value]);
  const selectedItem = budgetItems.find((item) => item.id === value);

  const matching = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    return budgetItems
      .filter((item) => {
        const text = `${item.name} ${item.type || ''}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort(byTypeThenName);
  }, [search, budgetItems]);

  const options: ComboboxOption[] = [
    {
      key: 'none',
      divider: true,
      selected: value === null,
      onSelect: () => onChange(null),
      content: (
        <>
          <X aria-hidden size={16} className="shrink-0 text-[var(--gray-11)]" />
          <Text size="2" color="gray" className="italic">No budget item</Text>
        </>
      ),
    },
    ...matching.slice(0, SHOWN).map((item) => ({
      key: String(item.id),
      selected: item.id === value,
      onSelect: () => onChange(item.id),
      content: (
        <>
          <ItemIcon name={item.icon} />
          <Text size="2" weight="medium" truncate>
            <Badge size="1" {...(item.type === 'Monthly' ? {} : { color: 'gray' as const })} mr="2">
              {item.type}
            </Badge>
            {item.name}
          </Text>
        </>
      ),
    })),
  ];

  return (
    <Combobox
      className={className}
      disabled={disabled}
      error={error}
      defaultOpen={defaultOpen}
      keyboardAware={keyboardAware}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      id={id}
      valueLabel={selectedItem ? `Selected: ${selectedItem.type}: ${selectedItem.name}` : placeholder}
      triggerContent={
        selectedItem ? (
          <>
            <ItemIcon name={selectedItem.icon} />
            <Text truncate>
              {selectedItem.type}: {selectedItem.name}
            </Text>
          </>
        ) : (
          <Text color="gray">{placeholder}</Text>
        )
      }
      search={search}
      onSearchChange={setSearch}
      searchLabel="Search budget items"
      searchPlaceholder="Search budget items..."
      listLabel="Budget items"
      options={options}
      hiddenCount={Math.max(0, matching.length - SHOWN)}
      emptyMessage={search.trim() ? `No matches found for "${search}"` : 'No budget items yet'}
    />
  );
};

export default RadixBudgetItemSelector;
