import React from 'react';
import { Link } from 'react-router-dom';
import { ABOVE_STRETCHED_LINK } from './StretchedLink';
import { Badge, Tooltip, Flex } from '@radix-ui/themes';
import { Wifi, WifiOff, Clock } from 'lucide-react';
import { deriveAccountConnectionHealth, type AccountConnectionStatus } from '@nuggets/shared';
import type { Account } from '../services/api';

/**
 * Per-account connection-health pill. Derives status from cheaply
 * persisted fields (last v2 error code + balance-date freshness) via the shared
 * `deriveAccountConnectionHealth` helper — no live SimpleFIN call. When the
 * connection needs re-auth (`con.auth`) it renders a "Reconnect" link to the
 * Bank Import page (recommendation A), which tells a member that an organization
 * admin reconnects it.
 *
 * Renders nothing for accounts that aren't sync-enabled SimpleFin imports.
 */
const STATUS_COLOR: Record<AccountConnectionStatus, 'green' | 'amber' | 'red'> = {
  connected: 'green',
  delayed: 'amber',
  disconnected: 'red',
};

const STATUS_LABEL: Record<AccountConnectionStatus, string> = {
  connected: 'Connected',
  delayed: 'Delayed',
  disconnected: 'Disconnected',
};

interface AccountConnectionPillProps {
  account: Pick<
    Account,
    'import_provider' | 'import_enabled' | 'import_balance_date' | 'import_last_error_code'
  >;
}

const AccountConnectionPill: React.FC<AccountConnectionPillProps> = ({ account }) => {
  if (account.import_provider !== 'simplefin' || !account.import_enabled) {
    return null;
  }

  const health = deriveAccountConnectionHealth({
    import_provider: account.import_provider,
    import_balance_date: account.import_balance_date ?? null,
    import_last_error_code: account.import_last_error_code ?? null,
  });

  const color = STATUS_COLOR[health.status];
  const Icon = health.status === 'connected' ? Wifi : health.status === 'delayed' ? Clock : WifiOff;

  return (
    <Flex align="center" gap="2" wrap="wrap" className={ABOVE_STRETCHED_LINK}>
      <Tooltip content={health.reason}>
        <Badge highContrast variant="soft" color={color} radius="full">
          <Icon size={12} />
          {STATUS_LABEL[health.status]}
        </Badge>
      </Tooltip>
      {health.needsReconnect && (
        <Badge
          asChild
          variant="solid"
          color="red"
          radius="full"
          className="cursor-pointer"
        >
          <Link to="/settings/import-settings">
            Reconnect
          </Link>
        </Badge>
      )}
    </Flex>
  );
};

export default AccountConnectionPill;
