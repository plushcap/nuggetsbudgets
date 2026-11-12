import React from 'react';
import { DropdownMenu, Button, Text, Box } from '@radix-ui/themes';
import { Wallet, ChevronDown } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import type { TenantSummary } from '@nuggets/shared';

/**
 * Active-ledger switcher for the app header. Groups the caller's ledgers by
 * organization, each group a set of radio items, so a screen reader hears which
 * ledger is the active one ("checked"). The button's name says it too, as the
 * ledger's name is hidden on a narrow screen. Hidden entirely when there's
 * nothing to switch to (the common single-ledger install).
 */
const TenantSwitcher: React.FC = () => {
  const { tenants, activeTenant, switchTenant } = useAuth();

  if (tenants.length <= 1) return null;

  // Preserve backend ordering (org name, then budget name) while grouping.
  const groups: { uuid: string; name: string; items: TenantSummary[] }[] = [];
  for (const t of tenants) {
    let group = groups.find((g) => g.uuid === t.organizationUuid);
    if (!group) {
      group = { uuid: t.organizationUuid, name: t.organizationName, items: [] };
      groups.push(group);
    }
    group.items.push(t);
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button
          variant="soft"
          color="gray"
          highContrast
          aria-label={activeTenant ? `Switch ledger (current: ${activeTenant.name})` : 'Switch ledger'}
        >
          <Wallet size={16} aria-hidden="true" />
          <Box display={{ initial: 'none', sm: 'block' }} maxWidth="160px">
            <Text truncate>{activeTenant?.name ?? 'Select ledger'}</Text>
          </Box>
          <ChevronDown size={16} aria-hidden="true" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="end">
        {groups.map((group, idx) => (
          <React.Fragment key={group.uuid}>
            {idx > 0 && <DropdownMenu.Separator />}
            <DropdownMenu.Label>{group.name}</DropdownMenu.Label>
            <DropdownMenu.RadioGroup
              aria-label={group.name}
              value={activeTenant?.uuid ?? ''}
              onValueChange={(uuid) => {
                if (uuid !== activeTenant?.uuid) void switchTenant(uuid);
              }}
            >
              {group.items.map((t) => (
                <DropdownMenu.RadioItem key={t.uuid} value={t.uuid}>
                  <Text truncate>{t.name}</Text>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </React.Fragment>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
};

export default TenantSwitcher;
