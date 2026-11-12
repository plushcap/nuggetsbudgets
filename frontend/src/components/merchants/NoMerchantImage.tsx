import React from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { Store } from 'lucide-react';
import MerchantImagePicker from './MerchantImagePicker';

/** The merchant form's image field while it has no image: a placeholder and the picker. */
const NoMerchantImage: React.FC<{ onChoose: (file: File) => void }> = ({ onChoose }) => (
  <Box p="5" className="border-2 border-dashed rounded-[var(--radius-4)] text-center border-[var(--gray-6)]">
    <Flex direction="column" align="center" gap="2">
      <Flex align="center" justify="center" width="48px" height="48px" className="rounded-[var(--radius-4)] bg-[var(--gray-3)]">
        <Store size={24} className="text-[var(--gray-11)]" />
      </Flex>
      <MerchantImagePicker label="Upload merchant image" onChoose={onChoose} />
      <Text size="1" color="gray">
        PNG, JPG up to 5MB
      </Text>
    </Flex>
  </Box>
);

export default NoMerchantImage;
