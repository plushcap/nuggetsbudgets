import React, { useMemo, useState } from 'react';
import { Flex, Text } from '@radix-ui/themes';
import { Building, Plus, X } from 'lucide-react';
import type { MerchantLite } from '../services/api';
import Combobox, { type ComboboxOption } from './Combobox';

/** How many merchants the list shows at once; typing narrows the rest. */
const SHOWN = 10;

export interface RadixMerchantSelectorProps {
  /** The chosen merchant's name ('' for none). */
  value: string;
  onChange: (value: string) => void;
  onSelectMerchant: (merchant: MerchantLite | null) => void;
  onCreateNew?: ((name: string) => void) | undefined;
  /** The lite list is enough: a selector reads only id, uuid, name and website. */
  merchants: MerchantLite[];
  loading?: boolean | undefined;
  required?: boolean;
  placeholder?: string | undefined;
  size?: '1' | '2' | '3';
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  /** Offer "No merchant" while one is chosen and the search is empty or still its name: onChange('') and onSelectMerchant(null). */
  clearable?: boolean;
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

const MerchantBadge: React.FC<{ icon: React.ReactNode }> = ({ icon }) => (
  <Flex align="center" justify="center" flexShrink="0" width="32px" height="32px" className="rounded-full bg-[var(--accent-a3)] text-[var(--accent-11)]">
    {icon}
  </Flex>
);

/**
 * The merchant picker: searches names and websites, offers to add a merchant no one has
 * (`onCreateNew`), and opens with the current name as the search. Built on Combobox.
 */
const RadixMerchantSelector: React.FC<RadixMerchantSelectorProps> = ({
  value,
  onChange,
  onSelectMerchant,
  onCreateNew,
  merchants,
  placeholder = 'Select a merchant...',
  className = '',
  disabled = false,
  error,
  clearable = false,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  id,
}) => {
  const [search, setSearch] = useState('');
  const selectedMerchant = merchants.find((m) => m.name === value);

  // Alphabetical: all of them with no search, else those whose name or website contains it.
  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const found = needle
      ? merchants.filter(
          (m) => m.name.toLowerCase().includes(needle) || m.merchant_website?.toLowerCase().includes(needle),
        )
      : [...merchants];
    return found.sort((a, b) => a.name.localeCompare(b.name));
  }, [search, merchants]);

  const typed = search.trim();
  const exactMatch = merchants.some((m) => m.name.toLowerCase() === typed.toLowerCase());

  const options: ComboboxOption[] = [];
  if (onCreateNew && typed && !exactMatch) {
    options.push({
      key: 'create',
      divider: true,
      onSelect: () => onCreateNew(typed),
      content: (
        <>
          <MerchantBadge icon={<Plus aria-hidden size={16} />} />
          <Text size="2" weight="medium">Add "{typed}"</Text>
        </>
      ),
    });
  }
  if (clearable && value && (!typed || typed === value)) {
    options.push({
      key: 'none',
      divider: true,
      onSelect: () => {
        onChange('');
        onSelectMerchant(null);
      },
      content: (
        <>
          <MerchantBadge icon={<X aria-hidden size={16} />} />
          <Text size="2" color="gray">No merchant</Text>
        </>
      ),
    });
  }
  for (const merchant of matching.slice(0, SHOWN)) {
    options.push({
      key: String(merchant.id),
      selected: merchant.name === value,
      onSelect: () => {
        onChange(merchant.name);
        onSelectMerchant(merchant);
      },
      content: (
        <>
          <MerchantBadge icon={<Building aria-hidden size={16} />} />
          <Flex direction="column" minWidth="0">
            <Text size="2" weight="medium" truncate>{merchant.name}</Text>
            {merchant.merchant_website && (
              <Text size="1" color="gray" truncate>{merchant.merchant_website}</Text>
            )}
          </Flex>
        </>
      ),
    });
  }

  return (
    <Combobox
      className={className}
      disabled={disabled}
      error={error}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      id={id}
      valueLabel={selectedMerchant ? `Selected merchant: ${selectedMerchant.name}` : placeholder}
      triggerContent={
        <>
          <Building aria-hidden size={16} className="shrink-0 text-[var(--gray-11)]" />
          {selectedMerchant ? (
            <Text truncate>{selectedMerchant.name}</Text>
          ) : (
            <Text color="gray">{placeholder}</Text>
          )}
        </>
      }
      search={search}
      onSearchChange={setSearch}
      initialSearch={value}
      searchLabel="Search merchants"
      searchPlaceholder="Search merchants..."
      listLabel="Merchants"
      options={options}
      hiddenCount={Math.max(0, matching.length - SHOWN)}
      emptyMessage={search ? `No matches found for "${search}"` : 'No merchants available'}
    />
  );
};

export default RadixMerchantSelector;
