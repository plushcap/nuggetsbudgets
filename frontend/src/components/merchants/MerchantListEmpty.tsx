import React from 'react';
import { Button, Card, Flex, Text } from '@radix-ui/themes';
import { Plus, Store } from 'lucide-react';

interface MerchantListEmptyProps {
  /** Whether a search found nothing (rather than the ledger having no merchants). */
  searching: boolean;
  onAdd: () => void;
}

/** The merchant list with nothing in it: no merchants yet, or none the search finds. */
const MerchantListEmpty: React.FC<MerchantListEmptyProps> = ({ searching, onAdd }) => (
  <Card>
    <Flex direction="column" align="center" gap="4" py="9">
      <Store size={64} className="text-[var(--gray-6)]" />
      <Flex direction="column" align="center" gap="2">
        <Text size="5" weight="medium" color="gray" highContrast>
          {searching ? 'No merchants found' : 'No merchants yet'}
        </Text>
        <Text size="2" color="gray">
          {searching ? 'Try adjusting your search terms' : 'Add your first merchant to get started'}
        </Text>
      </Flex>
      {!searching && (
        <Button size="3" onClick={onAdd}>
          <Plus size={20} />
          Add Merchant
        </Button>
      )}
    </Flex>
  </Card>
);

export default MerchantListEmpty;
