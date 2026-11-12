import React, { useState, useMemo, useEffect, useId } from 'react';
import { Box, Flex, Grid, TextField, Select, Button, Text, ScrollArea, Popover, Spinner } from '@radix-ui/themes';
import { User as UserIcon } from 'lucide-react';
import { getIconByName, type IconComponent } from '../utils/iconCatalog';
import { ICON_GROUPS, loadIconIndex, type IconIndexEntry } from '../utils/iconSearchIndex';
import { readableOn } from '../hooks/useChartTheme';

type FullIconLibrary = typeof import('../utils/iconLibraryFull');

interface RadixIconPickerProps {
  value: string;
  onChange: (iconName: string) => void;
  color?: string;
  disabled?: boolean | undefined;
  label?: string;
  placeholder?: string;
  /** The id of a visible label elsewhere that names this field (instead of `label`). */
  'aria-labelledby'?: string | undefined;
  /** Ids of the field's hint and error messages (fieldErrorDescribedBy): read after its name. */
  'aria-describedby'?: string | undefined;
}

const ALL_CATEGORY = 'All';

// Cap how many icons render at once. The full Lucide set is ~2,000 icons;
// rendering them all is needlessly heavy, so we cap and nudge the user to
// refine via search/category when there are more matches.
const RENDER_LIMIT = 300;

export const RadixIconPicker: React.FC<RadixIconPickerProps> = ({
  value,
  onChange,
  color = '#3B82F6',
  disabled = false,
  label = 'Icon',
  placeholder = 'Select an icon',
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
}) => {
  const labelId = useId();
  const triggerId = useId();
  // Named by its label, then by the value it shows.
  const labelledBy = ariaLabelledBy ?? (label ? labelId : undefined);
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState(ALL_CATEGORY);
  const [index, setIndex] = useState<IconIndexEntry[] | null>(null);
  const [fullLibrary, setFullLibrary] = useState<FullIconLibrary | null>(null);

  // The first time the picker opens, lazily load (in their own chunks) both the
  // search/group index and the full icon set, so the grid renders instantly.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    if (!index) {
      loadIconIndex().then((loaded) => {
        if (!cancelled) setIndex(loaded);
      });
    }
    if (!fullLibrary) {
      import('../utils/iconLibraryFull').then((mod) => {
        if (!cancelled) setFullLibrary(mod);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, index, fullLibrary]);

  const isReady = index !== null && fullLibrary !== null;

  const categories = useMemo(() => [ALL_CATEGORY, ...ICON_GROUPS], []);

  // Helper to render an icon by its stored name, falling back to a user icon.
  const renderIcon = (iconName: string, style?: React.CSSProperties): React.ReactElement => {
    const iconOption = getIconByName(iconName);
    const IconComponent = iconOption?.component ?? UserIcon;
    return <IconComponent style={style} />;
  };

  const filteredIcons = useMemo(() => {
    if (!index) return [];
    const query = searchQuery.trim().toLowerCase();

    return index.filter((icon) => {
      if (selectedCategory !== ALL_CATEGORY && !icon.groups.includes(selectedCategory)) {
        return false;
      }
      if (query && !icon.searchText.includes(query) && !icon.name.toLowerCase().includes(query)) {
        return false;
      }
      return true;
    });
  }, [index, searchQuery, selectedCategory]);

  const visibleIcons = filteredIcons.slice(0, RENDER_LIMIT);
  const hiddenCount = filteredIcons.length - visibleIcons.length;

  const handleIconSelect = (iconName: string) => {
    onChange(iconName);
    setIsOpen(false);
    setSearchQuery('');
    setSelectedCategory(ALL_CATEGORY);
  };

  return (
    <Flex direction="column" gap="2">
      {label && !ariaLabelledBy && (
        <Text size="2" weight="medium" as="div" id={labelId}>
          {label}
        </Text>
      )}

      <Popover.Root open={isOpen} onOpenChange={setIsOpen}>
        <Popover.Trigger>
          <Button
            type="button"
            variant="surface"
            color="gray"
            // An input's border (index.css): 3:1 against the dark page.
            className="field-border"
            disabled={disabled}
            id={triggerId}
            aria-labelledby={labelledBy ? `${labelledBy} ${triggerId}` : undefined}
            aria-describedby={ariaDescribedBy}
            style={{
              width: '100%',
              justifyContent: 'space-between',
              minHeight: '44px',
            }}
          >
            <Flex align="center" gap="3">
              <Flex
                width="32px"
                height="32px"
                align="center"
                justify="center"
                className="rounded-[var(--radius-4)]"
                style={{
                  // lint:guard colour: the colour the icon is shown in (the item's own).
                  backgroundColor: color,
                }}
              >
                {renderIcon(value || 'User', {
                  width: '16px',
                  height: '16px',
                  // lint:guard colour: black or white, whichever reads on the item's own colour.
                  color: readableOn(color),
                })}
              </Flex>
              <Text>{value || placeholder}</Text>
            </Flex>
          </Button>
        </Popover.Trigger>

        <Popover.Content
          width="400px"
          maxWidth="90vw"
          sideOffset={5}
        >
          <Flex direction="column" gap="3">
            {/* Search Input */}
            <TextField.Root
              aria-label="Search icons"
              placeholder="Search all icons..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="2"
            />

            {/* Category Filter */}
            <Select.Root value={selectedCategory} onValueChange={setSelectedCategory}>
              <Select.Trigger aria-label="Icon category" style={{ width: '100%' }} />
              <Select.Content>
                {categories.map((category) => (
                  <Select.Item key={category} value={category}>
                    {category}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>

            {/* Icon Grid */}
            <ScrollArea style={{ maxHeight: '256px' }}>
              {!isReady ? (
                <Flex align="center" justify="center" gap="2" p="4">
                  <Spinner />
                  <Text size="2" color="gray">
                    Loading icons…
                  </Text>
                </Flex>
              ) : (
                <Grid columns="6" gap="2">
                  {visibleIcons.length > 0 ? (
                    visibleIcons.map((icon) => {
                      const IconComponent: IconComponent = fullLibrary?.getFullIcon(icon.name) ?? UserIcon;
                      const isSelected = value === icon.name;

                      return (
                        <Button
                          key={icon.name}
                          type="button"
                          onClick={() => handleIconSelect(icon.name)}
                          variant={isSelected ? 'soft' : 'ghost'}
                          color={isSelected ? 'blue' : 'gray'}
                          style={{
                            padding: '8px',
                            height: 'auto',
                            aspectRatio: '1',
                            cursor: 'pointer',
                          }}
                          title={icon.name}
                          aria-label={icon.name}
                        >
                          <IconComponent size={20} />
                        </Button>
                      );
                    })
                  ) : (
                    <Box gridColumn="1 / -1" p="4" style={{ textAlign: 'center' }}>
                      <Text size="2" color="gray">
                        No icons found
                      </Text>
                    </Box>
                  )}
                </Grid>
              )}
            </ScrollArea>

            {/* Footer with icon count */}
            <Flex justify="between" align="center" pt="2" className="border-t border-[var(--gray-6)]">
              <Text size="1" color="gray">
                {!isReady
                  ? 'Loading…'
                  : hiddenCount > 0
                    ? `Showing ${visibleIcons.length} of ${filteredIcons.length} — refine to see more`
                    : `${filteredIcons.length} icon${filteredIcons.length !== 1 ? 's' : ''}`}
              </Text>
              <Button
                type="button"
                onClick={() => setIsOpen(false)}
                variant="soft"
                color="gray"
                size="1"
              >
                Close
              </Button>
            </Flex>
          </Flex>
        </Popover.Content>
      </Popover.Root>
    </Flex>
  );
};

export default RadixIconPicker;
