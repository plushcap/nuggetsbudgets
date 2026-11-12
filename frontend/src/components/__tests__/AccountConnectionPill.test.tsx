import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { renderWithProviders } from '../../test/renderWithProviders';
import AccountConnectionPill from '../AccountConnectionPill';

describe('AccountConnectionPill', () => {
  it('leads Reconnect to the Bank Import page at its settings address', () => {
    renderWithProviders(
      <Theme>
        <AccountConnectionPill
          account={{ import_provider: 'simplefin', import_enabled: true, import_balance_date: null, import_last_error_code: 'con.auth' }}
        />
      </Theme>
    );
    expect(screen.getByRole('link', { name: 'Reconnect' })).toHaveAttribute('href', '/settings/import-settings');
  });
});
