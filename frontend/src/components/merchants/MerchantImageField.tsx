import React from 'react';
import { Box, Flex, IconButton, Text } from '@radix-ui/themes';
import { X } from 'lucide-react';
import type { MerchantImageUpload } from '../../hooks/useMerchantImageUpload';
import { ownImageSrc } from '../../utils/safeUrls';
import MerchantImagePicker from './MerchantImagePicker';
import NoMerchantImage from './NoMerchantImage';

/** The image's look; its 128px square is the Box asChild around it. */
const IMAGE_CLASSES = 'object-cover rounded-[var(--radius-4)] border border-[var(--gray-6)]';

interface MerchantImageFieldProps {
  /** The image chosen on this form (useMerchantImageUpload). */
  upload: Pick<MerchantImageUpload, 'preview' | 'choose' | 'remove'>;
  /** The merchant's saved image (the edit form), shown until another is chosen. */
  currentImageUrl?: string | null | undefined;
  /** Called when the saved image fails to load, so the field offers an upload instead. */
  onCurrentImageError?: (() => void) | undefined;
}

/**
 * The merchant form's image: the chosen image's preview (with a button that removes it), else
 * the saved image with a button to change it, else a placeholder with the picker.
 */
const MerchantImageField: React.FC<MerchantImageFieldProps> = ({ upload, currentImageUrl, onCurrentImageError }) => (
  <Flex direction="column" gap="2">
    <Text as="p" size="2" weight="medium">
      Merchant Image
    </Text>
    {upload.preview ? (
      <Box position="relative" display="inline-block" width="fit-content">
        <Box asChild width="128px" height="128px"><img src={upload.preview} alt="Merchant preview" className={IMAGE_CLASSES} /></Box>
        <Box position="absolute" top="-8px" right="-8px">
          <IconButton type="button" onClick={upload.remove} size="1" color="red" radius="full" aria-label="Remove image">
            <X size={16} />
          </IconButton>
        </Box>
      </Box>
    ) : currentImageUrl ? (
      <Box>
        <Box asChild width="128px" height="128px">
          <img
            src={ownImageSrc(currentImageUrl)}
            alt="Current merchant logo"
            className={IMAGE_CLASSES}
            onError={(e) => {
              e.currentTarget.style.display = 'none';
              onCurrentImageError?.();
            }}
          />
        </Box>
        <Box mt="2">
          <MerchantImagePicker label="Change image" onChoose={upload.choose} />
        </Box>
      </Box>
    ) : (
      <NoMerchantImage onChoose={upload.choose} />
    )}
  </Flex>
);

export default MerchantImageField;
