import React from 'react';
import { Box, Flex, Text } from '@radix-ui/themes';
import { Check, ExternalLink } from 'lucide-react';
import toast from 'react-hot-toast';
import { useCreateMerchantMutation } from '../../hooks/queries';
import type { MerchantLite } from '../../services/api';
import { logger } from '../../utils/logger';
import RadixMerchantSelector from '../RadixMerchantSelector';
import { FieldCaption, FieldStatus, ReadOnlyValue, type FieldSaveStatus } from './TransactionFieldParts';

const CAPTION_ID = 'transaction-merchant';

interface MerchantFieldProps {
  editing: boolean;
  status: FieldSaveStatus;
  /** The merchant box's text. */
  search: string;
  onSearchChange: (text: string) => void;
  /** The merchant the form holds. */
  merchantId: number | null;
  /** A merchant was picked, made, or cleared (null). */
  onChoose: (merchantId: number | null) => void;
  merchants: MerchantLite[];
  /** The transaction's merchant, shown while it isn't edited. */
  merchantName: string | null;
}

/** The transaction's merchant: picked from the ledger's, or made from what was typed. */
export const MerchantField: React.FC<MerchantFieldProps> = ({
  editing,
  status,
  search,
  onSearchChange,
  merchantId,
  onChoose,
  merchants,
  merchantName,
}) => {
  const createMerchantMutation = useCreateMerchantMutation();
  const chosen = merchantId ? merchants.find((m) => m.id === merchantId) : undefined;

  const createMerchant = async (name: string) => {
    try {
      const newMerchant = await createMerchantMutation.mutateAsync({ name });
      // The merchants list refreshes via query invalidation.
      onSearchChange(name);
      onChoose(newMerchant.id);
      toast.success(`Merchant "${name}" created and assigned`);
    } catch (error) {
      logger.error({ err: error, merchantName: name }, 'Failed to create merchant');
      toast.error('Failed to create merchant');
    }
  };

  return (
    <Box position="relative">
      <FieldCaption id={CAPTION_ID}>
        Merchant
        <FieldStatus {...status} />
      </FieldCaption>
      {editing ? (
        <Box>
          <RadixMerchantSelector
            aria-labelledby={CAPTION_ID}
            clearable
            value={search}
            onChange={onSearchChange}
            onSelectMerchant={(merchant) => onChoose(merchant?.id ?? null)}
            onCreateNew={createMerchant}
            merchants={merchants}
            size="3"
          />
          {/* The chosen merchant, with a link to its rules */}
          {merchantId ? (
            <Flex align="center" justify="between" mt="2">
              <Text size="1" color="green" highContrast>
                <Flex as="span" align="center" gap="1">
                  <Check size={12} />
                  Using existing merchant
                </Flex>
              </Text>
              {chosen ? (
                <a
                  href={`/settings/merchants/${chosen.uuid}/rules`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-[var(--accent-11)] hover:text-[var(--accent-12)]"
                >
                  <Flex as="span" align="center" gap="1">
                    View Rules
                    <ExternalLink size={12} />
                  </Flex>
                </a>
              ) : null}
            </Flex>
          ) : null}
        </Box>
      ) : (
        <ReadOnlyValue>
          <Text color="gray" highContrast>{merchantName || 'No merchant'}</Text>
        </ReadOnlyValue>
      )}
    </Box>
  );
};
