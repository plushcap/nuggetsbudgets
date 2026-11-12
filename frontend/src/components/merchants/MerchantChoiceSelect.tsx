import React from 'react';
import { Flex, Select, Text } from '@radix-ui/themes';
import type { Merchant } from '../../services/api';
import MerchantThumbnail from './MerchantThumbnail';

/** The option that stands for no merchant (a Select item can't have an empty value). */
const NONE = 'null';

interface MerchantChoiceSelectProps {
  /** The trigger's id, which its label names. */
  id: string;
  /** The label shown above it. */
  label: string;
  /** The chosen merchant's uuid, or null for none. */
  value: string | null;
  onChange: (uuid: string | null) => void;
  merchants: Merchant[];
  placeholder: string;
  /** The words of the option that chooses no merchant. */
  noneLabel: string;
}

/** A labelled choice of one of the listed merchants, each shown with its image, or none. */
const MerchantChoiceSelect: React.FC<MerchantChoiceSelectProps> = ({
  id,
  label,
  value,
  onChange,
  merchants,
  placeholder,
  noneLabel,
}) => (
  <>
    <Text as="label" htmlFor={id} size="2" weight="medium" color="gray" highContrast>
      {label}
    </Text>
    <Select.Root value={value || NONE} onValueChange={(choice) => onChange(choice === NONE ? null : choice)} size="3">
      <Select.Trigger id={id} placeholder={placeholder} style={{ width: '100%' }} />
      <Select.Content>
        <Select.Item value={NONE}>
          <Text color="gray">{noneLabel}</Text>
        </Select.Item>
        {merchants.map((m) => (
          <Select.Item key={m.id} value={m.uuid}>
            <Flex align="center" gap="2">
              <MerchantThumbnail merchant={m} look="option" />
              <Text>{m.name}</Text>
            </Flex>
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  </>
);

export default MerchantChoiceSelect;
