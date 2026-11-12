import React, { Fragment } from 'react';
import { formatMoneyDefaults, setFormatMoneyDefaults } from '@nuggets/shared';
import { useGeneralSettingsQuery } from '../hooks/queries/settings';
import type { SystemSetting } from '../services/api';
import PageLoader from './PageLoader';
import LoadError from './LoadError';

/** The ledger's currency and locale among its general settings; unset (or not sent) is the default's. */
export function ledgerMoneyFormat(settings: readonly SystemSetting[]): { currency: string | null; locale: string | null } {
  const value = (key: string) => settings.find((setting) => setting.setting_key === key)?.setting_value || null;
  return { currency: value('application_currency'), locale: value('application_locale') };
}

/**
 * Shows the active ledger's money in its own currency and locale (General Settings), as
 * utils/timezone.ts keeps its time zone: it makes them formatMoney's defaults
 * (setFormatMoneyDefaults), so every amount a page shows with formatMoney, and an amount
 * box's sign and grouping (CurrencyInput), follows the ledger. A ledger that hasn't set them
 * shows USD in en-US.
 *
 * Its pages render once its settings have loaded, never before: until then (the first load, or
 * a ledger switch, which empties them, resetLedgerData) a loader stands in for them, and the
 * defaults are USD in en-US, so no amount of one ledger shows in another's format, nor in a
 * format the ledger doesn't use. If they don't load, it says so and offers to try again, rather
 * than guess a currency.
 *
 * The pages read the defaults as they render, so when they change (an admin saving new ones)
 * the pages under this are drawn again from scratch (`key`).
 */
const LedgerMoneyFormat: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { data, isError, error, refetch, isFetching } = useGeneralSettingsQuery();
  if (data) {
    // Set before the pages below render, in this same pass. The same answer sets the same
    // values, and keeps the key.
    setFormatMoneyDefaults(ledgerMoneyFormat(data));
    const { currency, locale } = formatMoneyDefaults();
    return <Fragment key={`${currency}|${locale}`}>{children}</Fragment>;
  }
  setFormatMoneyDefaults({});
  if (isError) {
    return (
      <LoadError
        title="This ledger didn't load"
        message="Its settings, which say what currency its amounts are in, didn't load, so its pages can't open yet."
        error={error}
        onRetry={() => void refetch()}
        retrying={isFetching}
      />
    );
  }
  return <PageLoader label="Loading…" />;
};

export default LedgerMoneyFormat;
