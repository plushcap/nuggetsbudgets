import React from 'react';
import { Flex, Text } from '@radix-ui/themes';
import { Tag as TagIcon } from 'lucide-react';
import type { Tag } from '../services/api';
import { getIconByName } from '../utils/iconCatalog';

/**
 * A tag's icon in the colour its members chose for it (data, not theme, so it's the one
 * colour here that can't be a Radix variable), or a plain tag icon. Decorative: the
 * tag's name is always next to it.
 */
export const TagGlyph: React.FC<{ tag: { icon: string | null; color: string | null }; size?: number }> = ({ tag, size = 16 }) => {
  const Icon = (tag.icon && getIconByName(tag.icon)?.component) || TagIcon;
  return (
    <Icon
      aria-hidden
      size={size}
      className={`shrink-0 ${tag.color ? '' : 'text-[var(--gray-11)]'}`}
      style={tag.color ? { /* lint:guard colour: the tag's own colour */ color: tag.color } : undefined}
    />
  );
};

/** A tag's row in a picker list: its icon, name and, under a parent, its path. */
export const TagOptionContent: React.FC<{ tag: Tag }> = ({ tag }) => (
  <>
    <TagGlyph tag={tag} />
    <Flex direction="column" minWidth="0">
      <Text size="2" weight="medium" truncate>{tag.name}</Text>
      {tag.level > 0 && (
        <Text size="1" color="gray" truncate>{tag.hierarchy_path}</Text>
      )}
    </Flex>
  </>
);
