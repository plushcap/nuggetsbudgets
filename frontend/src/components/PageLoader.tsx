import React from 'react';
import { Flex, Text } from '@radix-ui/themes';
import NuggetSpinner from './NuggetSpinner';

interface PageLoaderProps {
  /** Optional label rendered beneath the spinner */
  label?: string;
  /** Spinner size in px (defaults to 40) */
  size?: number;
  /** Min height of the centering area (defaults to 16rem) */
  minHeight?: string;
}

/**
 * Shared full-area loading indicator. Centers the brand NuggetSpinner and
 * replaces the ad-hoc `animate-spin` / skeleton blocks scattered across pages.
 */
const PageLoader: React.FC<PageLoaderProps> = ({ label, size = 40, minHeight = '16rem' }) => (
  <Flex direction="column" align="center" justify="center" gap="3" minHeight={minHeight}>
    <NuggetSpinner size={size} />
    {label && (
      <Text size="2" color="gray">
        {label}
      </Text>
    )}
  </Flex>
);

export default PageLoader;
