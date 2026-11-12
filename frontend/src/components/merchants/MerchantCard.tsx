import React from 'react';
import { Card, Flex, IconButton, Text, Box } from '@radix-ui/themes';
import { Edit3, ExternalLink, Merge, Settings, Trash2 } from 'lucide-react';
import type { Merchant } from '../../services/api';
import StretchedLink, { ABOVE_STRETCHED_LINK } from '../StretchedLink';
import { websiteHref } from '../../utils/safeUrls';
import MerchantThumbnail from './MerchantThumbnail';

interface MerchantCardProps {
  merchant: Merchant;
  /** The merchant's page: the card's link. */
  viewPath: string;
  // Each callback takes the merchant, so the list can pass stable (useCallback) handlers
  // and React.memo skips the cards whose merchant didn't change.
  onEdit: (merchant: Merchant) => void;
  onManageRules: (merchant: Merchant) => void;
  onDelete: (merchant: Merchant) => void;
  onMerge: (merchant: Merchant) => void;
}

/** A merchant on the mobile list: its name links to its page, with its counts and actions. */
const MerchantCard: React.FC<MerchantCardProps> = React.memo(({
  merchant,
  viewPath,
  onEdit,
  onManageRules,
  onDelete,
  onMerge,
}) => {
  const website = merchant.merchant_website ? websiteHref(merchant.merchant_website) : null;
  return (
    <Card className="hover:shadow-md transition-shadow">
      {/* Header: image and name */}
      <Flex align="center" gap="3" mb="3">
        <MerchantThumbnail merchant={merchant} look="card" />
        <Flex direction="column" flexGrow="1" minWidth="0">
          <Text size="4" weight="bold" className="break-words" color="gray" highContrast asChild>
            <StretchedLink to={viewPath}>{merchant.name}</StretchedLink>
          </Text>
          {merchant.merchant_accountid && (
            <Text size="2" className="truncate" color="gray">
              ID: {merchant.merchant_accountid}
            </Text>
          )}
        </Flex>
      </Flex>

      <Flex direction="column" gap="2">
        {merchant.merchant_website && (
          <Flex align="center" justify="between">
            <Text size="2" color="gray">Website:</Text>
            {website ? (
              <Flex asChild align="center" gap="1" maxWidth="60%" className={`hover:underline text-[var(--accent-11)] ${ABOVE_STRETCHED_LINK}`}>
                <a href={website} target="_blank" rel="noopener noreferrer">
                  <span className="truncate text-sm">{merchant.merchant_website}</span>
                  <ExternalLink size={12} className="shrink-0" />
                </a>
              </Flex>
            ) : (
              <Box as="span" display="inline" maxWidth="60%" className="truncate text-sm">{merchant.merchant_website}</Box>
            )}
          </Flex>
        )}

        {/* Counts */}
        <Flex align="center" gap="4" pt="2" className="border-t border-[var(--gray-4)]">
          <Flex align="center" gap="1">
            <Text size="1" color="gray">Transactions:</Text>
            <Text size="1" weight="medium" color="gray" highContrast>
              {merchant.transaction_count || 0}
            </Text>
          </Flex>
          <Flex align="center" gap="1">
            <Text size="1" color="gray">Rules:</Text>
            <Text size="1" weight="medium" color="gray" highContrast>
              {merchant.rule_count || 0}
            </Text>
          </Flex>
        </Flex>

        {/* Actions, spread out for touch */}
        <Flex align="center" justify="between" pt="2" className={`border-t border-[var(--gray-4)] ${ABOVE_STRETCHED_LINK}`}>
          <IconButton
            size="3"
            variant="ghost"
            color="red"
            onClick={(e) => { e.stopPropagation(); onDelete(merchant); }}
            aria-label={`Delete merchant ${merchant.name}`}
            title="Delete"
          >
            <Trash2 size={20} />
          </IconButton>
          <IconButton
            size="3"
            variant="ghost"
            color="orange"
            onClick={(e) => { e.stopPropagation(); onMerge(merchant); }}
            aria-label={`Merge merchant ${merchant.name}`}
            title="Merge"
          >
            <Merge size={20} />
          </IconButton>
          <IconButton
            size="3"
            variant="ghost"
            color="gray"
            onClick={(e) => { e.stopPropagation(); onManageRules(merchant); }}
            aria-label={`Manage rules ${merchant.name}`}
            title="Manage Rules"
          >
            <Settings size={20} />
          </IconButton>
          <IconButton
            size="3"
            variant="ghost"
            color="blue"
            onClick={(e) => { e.stopPropagation(); onEdit(merchant); }}
            aria-label={`Edit merchant ${merchant.name}`}
            title="Edit"
          >
            <Edit3 size={20} />
          </IconButton>
        </Flex>
      </Flex>
    </Card>
  );
});
MerchantCard.displayName = 'MerchantCard';

export default MerchantCard;
