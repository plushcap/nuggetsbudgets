import React from 'react';
import { Box, Flex } from '@radix-ui/themes';
import { Store } from 'lucide-react';
import type { Merchant } from '../../services/api';
import { ownImageSrc } from '../../utils/safeUrls';

/** Each place's look: the image's and the placeholder tile's size (px) and classes, and the icon's. */
const LOOKS = {
  /** The mobile card's header. */
  card: {
    size: '48px',
    shrink: true,
    image: 'object-cover rounded-[var(--radius-4)] border border-[var(--gray-6)]',
    tile: 'rounded-[var(--radius-4)] bg-[var(--accent-3)]',
    iconSize: 24,
    icon: 'text-[var(--accent-11)]',
  },
  /** The desktop table's image column. */
  row: {
    size: '32px',
    shrink: false,
    image: 'object-cover rounded-[var(--radius-4)] border border-[var(--gray-6)]',
    tile: 'rounded-[var(--radius-4)] bg-[var(--gray-3)]',
    iconSize: 16,
    icon: 'text-[var(--gray-11)]',
  },
  /** A merchant picker's option: the icon alone, without a tile. */
  option: {
    size: '16px',
    shrink: false,
    image: 'object-cover rounded-[var(--radius-2)]',
    tile: null,
    iconSize: 16,
    icon: 'text-[var(--gray-11)]',
  },
} as const;

interface MerchantThumbnailProps {
  merchant: Pick<Merchant, 'name' | 'merchant_image'>;
  look: keyof typeof LOOKS;
}

/** A merchant's own image, or a store icon while it has none. An image that fails to load hides. */
const MerchantThumbnail: React.FC<MerchantThumbnailProps> = ({ merchant, look }) => {
  const { size, shrink, image, tile, iconSize, icon } = LOOKS[look];
  const box = { width: size, height: size, ...(shrink ? { flexShrink: '0' as const } : {}) };
  const src = ownImageSrc(merchant.merchant_image);
  if (src) {
    return (
      <Box asChild {...box}>
        <img
          src={src}
          alt={merchant.name}
          className={image}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      </Box>
    );
  }
  const storeIcon = <Store size={iconSize} className={icon} />;
  return tile ? (
    <Flex align="center" justify="center" {...box} className={tile}>
      {storeIcon}
    </Flex>
  ) : (
    storeIcon
  );
};

export default MerchantThumbnail;
