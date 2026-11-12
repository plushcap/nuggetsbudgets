import { useMemo, useRef, useState } from 'react';
import { Badge, Flex, IconButton, Text } from '@radix-ui/themes';
import { Tag as TagIcon, Plus, X } from 'lucide-react';
import type { Tag } from '../services/api';
import type { TransactionTag } from '@nuggets/shared';
import Combobox, { type ComboboxOption } from './Combobox';
import { TagGlyph, TagOptionContent } from './tagOptionContent';

// Re-export the shared Tag type so existing consumers that import it from this
// component keep working, while the prop types stay in sync with the API.
export type { Tag };

/** How many tags the list shows at once; typing narrows the rest. */
const SHOWN = 20;

// Sort tags by most-recently-used first (see tags.last_used_at), then
// alphabetically. Tags never applied to a transaction (null last_used_at)
// sort to the end.
const compareByRecency = (a: Tag, b: Tag): number => {
  const at = a.last_used_at ? Date.parse(a.last_used_at) : null;
  const bt = b.last_used_at ? Date.parse(b.last_used_at) : null;
  if (at !== bt) {
    if (at === null) return 1;
    if (bt === null) return -1;
    return bt - at; // most recent first
  }
  return a.name.localeCompare(b.name);
};

/**
 * The chosen tags are full tags, or the five fields a transaction answer carries for each of
 * its tags (TransactionTag: id, uuid, name, colour, icon); the list is the ledger's tags.
 */
export interface TagSelectorProps<T extends TransactionTag = Tag> {
  selectedTags: T[];
  onChange: (tags: T[]) => void;
  onCreateNew?: ((name: string) => void) | undefined;
  tags: Array<Tag & T>;
  loading?: boolean | undefined;
  placeholder?: string | undefined;
  className?: string | undefined;
  disabled?: boolean | undefined;
  error?: string | undefined;
  multiSelect?: boolean;
  defaultOpen?: boolean | undefined; // Open the list immediately (e.g. mobile picker sheet)
  keyboardAware?: boolean | undefined; // Cap the list to the space above the on-screen keyboard
  /** The id of this field's visible label. The trigger is named by it, then by its own value. */
  'aria-labelledby'?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorDescribedBy): read after its name. */
  'aria-describedby'?: string | undefined;
  /**
   * The trigger button's id, for a `focusFirstError` selector or a `fieldErrorProps` field id,
   * so a refused field is focused on the trigger itself. Without one it makes its own.
   */
  id?: string | undefined;
}

/**
 * The tag picker: active tags, most recently used first, searched by name and hierarchy
 * path, with an "Add new tag" row when nothing has the typed name. In multi-select mode
 * (the default) choosing toggles a tag and the list stays open; the chosen tags show as
 * chips beside the trigger, each with its own remove button. Built on Combobox.
 */
function TagSelector<T extends TransactionTag = Tag>({
  selectedTags,
  onChange,
  onCreateNew,
  tags,
  placeholder = 'Select tags...',
  className = '',
  disabled = false,
  error,
  multiSelect = true,
  defaultOpen = false,
  keyboardAware = false,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  id,
}: TagSelectorProps<T>) {
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
    return [...found].sort(compareByRecency);
  }, [search, tags]);

  const typed = search.trim();
  const exactMatch = tags.some((t) => t.name.toLowerCase() === typed.toLowerCase());
  const isSelected = (tag: TransactionTag) => selectedTags.some((t) => t.id === tag.id);

  const toggle = (tag: Tag & T) => {
    if (!multiSelect) onChange([tag]);
    else if (isSelected(tag)) onChange(selectedTags.filter((t) => t.id !== tag.id));
    else onChange([...selectedTags, tag]);
  };

  const options: ComboboxOption[] = [];
  if (onCreateNew && typed && !exactMatch) {
    options.push({
      key: 'create',
      divider: true,
      onSelect: () => onCreateNew(typed),
      content: (
        <>
          <Plus aria-hidden size={16} className="shrink-0 text-[var(--accent-11)]" />
          <Text size="2" weight="medium" className="text-[var(--accent-11)]">
            Add new tag: "{typed}"
          </Text>
        </>
      ),
    });
  }
  for (const tag of matching.slice(0, SHOWN)) {
    options.push({
      key: String(tag.id),
      selected: isSelected(tag),
      keepOpen: multiSelect,
      onSelect: () => toggle(tag),
      content: <TagOptionContent tag={tag} />,
    });
  }

  const count = selectedTags.length;
  const chips =
    count > 0 ? (
      <Flex gap="1" wrap="wrap" py="1">
        {selectedTags.map((tag) => (
          <Badge key={tag.id} size="2" color="gray" variant="surface">
            <TagGlyph tag={tag} size={12} />
            {tag.name}
            <IconButton
              type="button"
              size="1"
              variant="ghost"
              color="gray"
              disabled={disabled}
              aria-label={`Remove ${tag.name}`}
              onClick={() => {
                onChange(selectedTags.filter((t) => t.id !== tag.id));
                // The chip and its button go: the focus moves to the field, not the page.
                triggerRef.current?.focus();
              }}
            >
              <X aria-hidden size={12} />
            </IconButton>
          </Badge>
        ))}
      </Flex>
    ) : undefined;

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
      valueLabel={count > 0 ? `${count} ${count === 1 ? 'tag' : 'tags'} selected` : placeholder}
      before={chips}
      triggerRef={triggerRef}
      triggerContent={
        count > 0 ? (
          <Text size="2" color="gray">{multiSelect ? 'Add a tag…' : 'Change…'}</Text>
        ) : (
          <>
            <TagIcon aria-hidden size={16} className="shrink-0 text-[var(--gray-11)]" />
            <Text color="gray">{placeholder}</Text>
          </>
        )
      }
      search={search}
      onSearchChange={setSearch}
      searchLabel="Search tags"
      searchPlaceholder="Search tags..."
      listLabel="Tags"
      multiselectable={multiSelect}
      options={options}
      hiddenCount={Math.max(0, matching.length - SHOWN)}
      emptyMessage={search ? 'No tags found' : 'No tags available'}
    />
  );
}

export default TagSelector;
