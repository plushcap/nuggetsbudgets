import React from 'react';
import { Badge, Box, Flex, Text } from '@radix-ui/themes';
import TagSelector, { type Tag } from '../TagSelector';
import { chosenColourProps } from '../../utils/textColor';
import { FieldCaption, ReadOnlyValue } from './TransactionFieldParts';

const CAPTION_ID = 'transaction-tags';

interface TransactionTagsFieldProps {
  editing: boolean;
  /** The transaction's tags. */
  selectedTags: Tag[];
  /** The ledger's tags, to pick from. */
  tags: Tag[];
  onChange: (tags: Tag[]) => void;
}

/** The transaction's own tags (a split parent's splits have theirs: the split card shows them). */
export const TransactionTagsField: React.FC<TransactionTagsFieldProps> = ({ editing, selectedTags, tags, onChange }) => (
  <Box>
    <FieldCaption id={CAPTION_ID}>Tags</FieldCaption>
    {editing ? (
      <TagSelector aria-labelledby={CAPTION_ID} selectedTags={selectedTags} onChange={onChange} tags={tags} placeholder="Add tags..." />
    ) : (
      <ReadOnlyValue>
        {selectedTags.length > 0 ? (
          <Flex gap="2" wrap="wrap">
            {selectedTags.map((tag) => (
              <Badge key={tag.id} size="2" {...chosenColourProps(tag.color)}>
                {tag.name}
              </Badge>
            ))}
          </Flex>
        ) : (
          <Text color="gray">No tags</Text>
        )}
      </ReadOnlyValue>
    )}
  </Box>
);
