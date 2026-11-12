import React from 'react';
import { Button, DropdownMenu, Flex, Text } from '@radix-ui/themes';
import { Download, Shield, Trash } from 'lucide-react';

interface MerchantAdminMenuProps {
  onRemoveUnused: () => void;
  onExport: () => void;
  /** While an export runs: its item is disabled and says so. */
  exporting: boolean;
}

/** The merchant list's administrative actions: remove the unused merchants, export them all. */
const MerchantAdminMenu: React.FC<MerchantAdminMenuProps> = ({ onRemoveUnused, onExport, exporting }) => (
  <DropdownMenu.Root>
    <DropdownMenu.Trigger>
      <Button variant="soft" color="gray" size="3">
        <Shield size={20} />
        Admin
      </Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" style={{ minWidth: '15rem' }}>
      <DropdownMenu.Label>
        <Flex align="center" gap="2">
          <Shield size={16} />
          <Text size="2" weight="medium">Administrative Actions</Text>
        </Flex>
      </DropdownMenu.Label>
      <DropdownMenu.Separator />
      <DropdownMenu.Item onSelect={onRemoveUnused}>
        <Flex align="center" gap="3">
          <Trash size={16} className="text-[var(--orange-12)]" />
          <Flex direction="column">
            <Text size="2" weight="medium">Remove Unused Merchants</Text>
            <Text size="1" color="gray">Delete merchants nothing uses</Text>
          </Flex>
        </Flex>
      </DropdownMenu.Item>
      <DropdownMenu.Item onSelect={onExport} disabled={exporting}>
        <Flex align="center" gap="3">
          <Download size={16} className="text-[var(--accent-11)]" />
          <Flex direction="column">
            <Text size="2" weight="medium">
              {exporting ? 'Exporting…' : 'Export Merchants CSV'}
            </Text>
            <Text size="1" color="gray">Download all merchants with counts and rules</Text>
          </Flex>
        </Flex>
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
);

export default MerchantAdminMenu;
