import React, { useEffect, useId, useRef, useState } from 'react';
import { Box, Flex, Popover, Text, TextField, VisuallyHidden } from '@radix-ui/themes';
import { Check, ChevronDown, Search } from 'lucide-react';
// Themes' Popover.Anchor (3.3.0) drops its children; the primitive it wraps doesn't.
import { Popover as PopoverPrimitive } from 'radix-ui';
import { useKeyboardAwareMaxHeight } from '../hooks/useKeyboardAwareMaxHeight';
import { useSeededState } from '../hooks/useSeededState';

/** One entry in a Combobox's list. */
export interface ComboboxOption {
  /** Unique within the list (React key). */
  key: string;
  /** What the option shows; its text is its accessible name. */
  content: React.ReactNode;
  /** Chosen: `aria-selected`, and a check mark. */
  selected?: boolean;
  onSelect: () => void;
  /** Leave the list open after choosing it (a multi-select's toggles). */
  keepOpen?: boolean;
  /**
   * An action row above the results ("Add …", "None"): drawn with a line under it, and
   * not counted as a result (the empty message and the spoken count leave it out).
   */
  divider?: boolean;
}

export interface ComboboxProps {
  /** What the trigger shows (the value, or the placeholder). */
  triggerContent: React.ReactNode;
  /**
   * The trigger's value as words ("Selected merchant: Corner Store", or the placeholder).
   * With `aria-labelledby` the trigger's name is the label, then this.
   */
  valueLabel: string;
  /** The id of the field's visible label. */
  'aria-labelledby'?: string | undefined;
  /**
   * The trigger button's id, for a `focusFirstError` selector or a `fieldErrorProps` field id,
   * so a refused field is focused on the trigger itself. Without one it makes its own.
   */
  id?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorDescribedBy): read after its name. */
  'aria-describedby'?: string | undefined;
  disabled?: boolean | undefined;
  /** A message under the field, read with the trigger, and a red border. */
  error?: string | undefined;
  className?: string | undefined;
  /** Open on mount (a mobile picker sheet). */
  defaultOpen?: boolean | undefined;
  /** Cap the list to the space above the on-screen keyboard. */
  keyboardAware?: boolean | undefined;

  /** The search text; the caller filters `options` by it. */
  search: string;
  onSearchChange: (search: string) => void;
  /** The search to start from when the list opens (default ''); a list open on mount starts from `search` as it is. */
  initialSearch?: string;
  /** Names of the search box ("Search merchants") and of the list ("Merchants"). */
  searchLabel: string;
  searchPlaceholder?: string;
  listLabel: string;

  options: ComboboxOption[];
  /** How many matches were left out of `options`; the list says to type to narrow it. */
  hiddenCount?: number;
  /** Shown under the action rows when nothing matches. */
  emptyMessage: React.ReactNode;
  /** Several options can be chosen (`aria-multiselectable`). */
  multiselectable?: boolean;

  /** Inside the field's box before the trigger: a multi-select's chips. */
  before?: React.ReactNode;
  /** Inside the field's box after the trigger: a clear button. */
  after?: React.ReactNode;
  /** The trigger button, so a caller can put the focus back on it (after removing a chip). */
  triggerRef?: React.Ref<HTMLButtonElement>;
}

/**
 * The one searchable picker, on Radix Themes' Popover so the list keeps the
 * theme, is placed by the trigger wherever the page has scrolled, and closes on Escape
 * or a click outside with the focus back on the trigger.
 *
 * It follows the WAI-ARIA "combobox with a dialog popup" pattern: the trigger is a
 * button showing the value; it opens a dialog holding a `role="combobox"` search box
 * that controls a `listbox`. The focus stays in the search box, and the highlighted
 * option is its `aria-activedescendant`, so a screen reader reads it while the arrow
 * keys move. `aria-selected` marks what is chosen.
 *
 * Keys in the search box: ArrowDown / ArrowUp move (ArrowUp from nothing goes to the
 * last), Enter chooses the highlighted option, Escape or Alt+ArrowUp closes, and Tab
 * closes back to the trigger (the list is portalled, so tabbing on would leave the
 * page). On the trigger, Enter, Space and ArrowDown open it.
 *
 * Long lists are capped by the caller rather than virtualized (`hiddenCount`): typing
 * narrows them, and every option stays a real element `aria-activedescendant` can name.
 */
const Combobox: React.FC<ComboboxProps> = ({
  triggerContent,
  valueLabel,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  id,
  disabled = false,
  error,
  className = '',
  defaultOpen = false,
  keyboardAware = false,
  search,
  onSearchChange,
  initialSearch = '',
  searchLabel,
  searchPlaceholder,
  listLabel,
  options,
  hiddenCount = 0,
  emptyMessage,
  multiselectable = false,
  before,
  after,
  triggerRef,
}) => {
  const baseId = useId();
  const triggerId = id ?? `${baseId}-trigger`;
  const listId = `${baseId}-list`;
  // Its own, not the trigger's: a page with a FieldError of its own names that `<id>-error`.
  const errorId = `${baseId}-trigger-error`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const [open, setOpen] = useState(defaultOpen);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listMaxHeight = useKeyboardAwareMaxHeight(listRef, open && keyboardAware);

  // Nothing is highlighted after the search or the list changes.
  const [highlighted, setHighlighted] = useSeededState(() => -1, [search, options.length, open]);
  const active = highlighted >= 0 && highlighted < options.length ? highlighted : -1;

  const changeOpen = (next: boolean) => {
    if (next === open) return;
    onSearchChange(next ? initialSearch : '');
    setOpen(next);
  };

  const choose = (option: ComboboxOption) => {
    option.onSelect();
    if (!option.keepOpen) changeOpen(false);
  };

  useEffect(() => {
    if (active < 0) return;
    document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    // optionId is derived from baseId, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (event.altKey) return;
        setHighlighted(options.length === 0 ? -1 : Math.min(active + 1, options.length - 1));
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (event.altKey) {
          changeOpen(false);
          return;
        }
        setHighlighted(active < 0 ? options.length - 1 : Math.max(active - 1, 0));
        break;
      case 'Enter': {
        event.preventDefault();
        const option = options[active];
        if (option) choose(option);
        break;
      }
      case 'Tab':
        event.preventDefault();
        changeOpen(false);
        break;
      // Escape: Popover's own dismiss closes it and returns the focus.
    }
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' && !open) {
      event.preventDefault();
      changeOpen(true);
    }
  };

  const describedByIds = [error ? errorId : undefined, describedBy].filter(Boolean).join(' ') || undefined;
  const resultCount = options.filter((option) => !option.divider).length + hiddenCount;

  return (
    <Box width="100%" className={className}>
      <Popover.Root open={open} onOpenChange={changeOpen}>
        <PopoverPrimitive.Anchor asChild>
          <Flex
            align="center"
            gap="2"
            wrap="wrap"
            px="2"
            minHeight="40px"
            width="100%"
            className={`
              bg-[var(--color-surface)]
              border rounded-[var(--radius-3)]
              ${error ? 'border-[var(--red-8)]' : 'field-border border-[var(--gray-a7)] hover:border-[var(--gray-a8)]'}
              transition-colors
              ${disabled ? 'opacity-50' : ''}
            `}
          >
            {before}
            <Popover.Trigger>
              <Box asChild flexGrow="1" flexBasis="0%" minWidth="8rem" minHeight="38px" px="1" display="inline-block"><button
                ref={triggerRef}
                type="button"
                id={triggerId}
                disabled={disabled}
                onKeyDown={onTriggerKeyDown}
                aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
                aria-label={valueLabel}
                aria-describedby={describedByIds}
                className="text-left text-[var(--gray-12)] bg-transparent border-0 rounded-[var(--radius-2)] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-[var(--accent-8)] disabled:cursor-not-allowed"
              >
                <Flex align="center" justify="between" gap="2">
                  <Flex align="center" gap="2" minWidth="0" flexGrow="1">
                    {triggerContent}
                  </Flex>
                  <ChevronDown
                    aria-hidden
                    size={16}
                    className={`text-[var(--gray-11)] shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
                  />
                </Flex>
              </button></Box>
            </Popover.Trigger>
            {after}
          </Flex>
        </PopoverPrimitive.Anchor>

        {/* Never taller than the room Radix found on the side it opened (it opens above when
            there's none below); the list shrinks and scrolls, the search box and footer stay. */}
        <Popover.Content
          align="start"
          sideOffset={4}
          aria-labelledby={labelledBy}
          aria-label={labelledBy ? undefined : listLabel}
          style={{
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            maxHeight: 'var(--radix-popover-content-available-height)',
            overflow: 'hidden',
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <Box p="2" flexShrink="0" className="border-b border-[var(--gray-a6)]">
            <TextField.Root
              ref={inputRef}
              size="2"
              value={search}
              onChange={(event) => onSearchChange(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder={searchPlaceholder}
              autoComplete="off"
              role="combobox"
              aria-label={searchLabel}
              aria-expanded
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            >
              <TextField.Slot>
                <Search aria-hidden size={16} />
              </TextField.Slot>
            </TextField.Root>
          </Box>

          <Box
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={listLabel}
            aria-multiselectable={multiselectable || undefined}
            overflowY="auto"
            minHeight="0"
            flexShrink="1"
            style={{ maxHeight: listMaxHeight ? `${Math.min(listMaxHeight, 300)}px` : '300px' }}
          >
            {options.map((option, index) => (
              <Flex
                key={option.key}
                id={optionId(index)}
                role="option"
                aria-selected={option.selected === true}
                align="center"
                gap="2"
                px="3"
                py="2"
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => {
                  if (index !== active) setHighlighted(index);
                }}
                onClick={() => choose(option)}
                className={`
                  cursor-pointer text-[var(--gray-12)]
                  ${option.divider ? 'border-b border-[var(--gray-a5)]' : ''}
                  ${index === active ? 'bg-[var(--accent-a4)]' : option.selected ? 'bg-[var(--accent-a2)]' : ''}
                `}
              >
                <Flex align="center" gap="2" minWidth="0" flexGrow="1">
                  {option.content}
                </Flex>
                {option.selected && <Check aria-hidden size={16} className="shrink-0 text-[var(--accent-11)]" />}
              </Flex>
            ))}
          </Box>
          {resultCount === 0 && (
            <Box px="3" py="4" flexShrink="0">
              <Text as="p" size="2" color="gray" align="center">
                {emptyMessage}
              </Text>
            </Box>
          )}
          {hiddenCount > 0 && (
            <Box px="3" py="2" flexShrink="0" className="border-t border-[var(--gray-a5)]">
              <Text as="p" size="1" color="gray">
                {hiddenCount} more — type to narrow the list.
              </Text>
            </Box>
          )}
          <VisuallyHidden role="status">
            {resultCount === 0 ? 'No results' : `${resultCount} ${resultCount === 1 ? 'result' : 'results'}`}
          </VisuallyHidden>
        </Popover.Content>
      </Popover.Root>

      {error && (
        <Text id={errorId} as="p" size="1" color="red" mt="1">
          {error}
        </Text>
      )}
    </Box>
  );
};

export default Combobox;
