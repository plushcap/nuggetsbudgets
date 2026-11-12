import React from 'react';
import { Box, Card, Flex, Text, TextField } from '@radix-ui/themes';
import { Search } from 'lucide-react';

interface MerchantSearchCardProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
  /** How many merchants the search finds, across every page. */
  total: number;
}

/** The merchant list's search box and its count. */
const MerchantSearchCard: React.FC<MerchantSearchCardProps> = ({ searchTerm, onSearchChange, total }) => (
  <Card mb="5">
    <Flex direction={{ initial: 'column', sm: 'row' }} align={{ sm: 'center' }} justify="between" gap="4">
      <Box flexGrow="1" maxWidth="28rem">
        <TextField.Root
          aria-label="Search merchants"
          placeholder="Search merchants..."
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
          size="3"
          variant="surface"
        >
          <TextField.Slot>
            <Search size={16} />
          </TextField.Slot>
        </TextField.Root>
      </Box>
      <Text size="2" color="gray">
        {total} merchants
      </Text>
    </Flex>
  </Card>
);

export default MerchantSearchCard;
