import React, { useId, useMemo, useRef, useState } from 'react';
import { IconButton, Text } from '@radix-ui/themes';
import { Tag as TagIcon, X } from 'lucide-react';
import type { Tag } from '../services/api';
import Combobox, { type ComboboxOption } from './Combobox';
import { TagOptionContent } from './tagOptionContent';

// Re-export the shared Tag type so existing consumers that import it from this
// component keep working, while the prop types stay in sync with the API.
export type { Tag };

/** How many tags the list shows at once; typing narrows the rest. */
const SHOWN = 20;

export interface SingleTagSelectorProps {
  selectedTag: Tag | null;
  onChange: (tag: Tag | null) => void;
  tags: Tag[];
  placeholder?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  label?: string | undefined;
  /** The id of this field's visible label. The trigger is named by it, then by its own value. */
  'aria-labelledby'?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorDescribedBy): read after its name. */
  'aria-describedby'?: string | undefined;
}

/**
 * Picks one tag (the auto-tag of a budget item or merchant): active tags by hierarchy
 * level, then name, searched by name and path, with a remove button beside the trigger.
 * Built on Combobox.
 */
const SingleTagSelector: React.FC<SingleTagSelectorProps> = ({
  selectedTag,
  onChange,
  tags,
  placeholder = 'Select a tag...',
  className = '',
  disabled = false,
  error,
  label,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': describedBy,
}) => {
  const labelId = useId();
  const labelledBy = ariaLabelledBy ?? (label ? labelId : undefined);
  const [search, setSearch] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);

  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const active = tags.filter((tag) => tag.is_active !== false);
    const found = needle
      ? active.filter(
          (tag) => tag.name.toLowerCase().includes(needle) || (tag.hierarchy_path ?? '').toLowerCase().includes(needle),
        )
      : active;
    return [...found].sort((a, b) => (a.level !== b.level ? a.level - b.level : a.name.localeCompare(b.name)));
  }, [search, tags]);

  const options: ComboboxOption[] = matching.slice(0, SHOWN).map((tag) => ({
    key: String(tag.id),
    selected: selectedTag?.id === tag.id,
    onSelect: () => onChange(tag),
    content: <TagOptionContent tag={tag} />,
  }));

  return (
    <div className={className}>
      {label && (
        <Text size="2" weight="medium" as="div" id={labelId} mb="2">
          {label}
        </Text>
      )}
      <Combobox
        disabled={disabled}
        error={error}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        triggerRef={triggerRef}
        valueLabel={selectedTag ? `Selected tag: ${selectedTag.name}` : placeholder}
        triggerContent={
          selectedTag ? (
            <TagOptionContent tag={selectedTag} />
          ) : (
            <>
              <TagIcon aria-hidden size={16} className="shrink-0 text-[var(--gray-11)]" />
              <Text color="gray">{placeholder}</Text>
            </>
          )
        }
        after={
          selectedTag ? (
            <IconButton
              type="button"
              size="1"
              variant="ghost"
              color="gray"
              disabled={disabled}
              aria-label={`Remove ${selectedTag.name}`}
              onClick={() => {
                onChange(null);
                // The button goes with the tag: the focus moves to the field, not the page.
                triggerRef.current?.focus();
              }}
            >
              <X aria-hidden size={16} />
            </IconButton>
          ) : undefined
        }
        search={search}
        onSearchChange={setSearch}
        searchLabel="Search tags"
        searchPlaceholder="Search tags..."
        listLabel="Tags"
        options={options}
        hiddenCount={Math.max(0, matching.length - SHOWN)}
        emptyMessage={search ? 'No tags found' : 'No tags available'}
      />
    </div>
  );
};

export default SingleTagSelector;
