import { DEFAULT_CURRENCY, DEFAULT_LOCALE, formatMoney, type FormatMoneyOptions, type MoneyFormat } from '@nuggets/shared';
import { readTenantSettings } from './tenantSettings.js';

/**
 * How a ledger shows money: its currency and locale, General Settings beside its time zone
 * (`application_currency`, `application_locale` in tenant_settings), USD in en-US while it
 * hasn't set them. The server serves every ledger at once, so a text it writes for one (an
 * email, a refusal, a transaction's description) names that ledger's format in its
 * formatMoney call; formatMoney's own defaults are the SPA's (setFormatMoneyDefaults, which
 * the backend's ESLint refuses).
 */

/**
 * The current ledger's money format (or ledger `tenantId`'s), each part the default while
 * unset. In the current tenant transaction when there is one, else a short one of its own
 * (readTenantSettings).
 */
export async function readTenantMoneyFormat(tenantId: number | null = null): Promise<MoneyFormat> {
  const stored = await readTenantSettings(['application_currency', 'application_locale'], tenantId);
  return {
    currency: stored.application_currency || DEFAULT_CURRENCY,
    locale: stored.application_locale || DEFAULT_LOCALE,
  };
}

/** `amount` as `format` shows it, with formatMoney's other options. */
export function moneyText(
  amount: number | string | null | undefined,
  format: MoneyFormat,
  options: Omit<FormatMoneyOptions, 'currency' | 'locale'> = {}
): string {
  return formatMoney(amount, { ...options, currency: format.currency, locale: format.locale });
}

/** `amount` as the current ledger shows money. */
export async function tenantMoneyText(
  amount: number | string | null | undefined,
  options: Omit<FormatMoneyOptions, 'currency' | 'locale'> = {}
): Promise<string> {
  return moneyText(amount, await readTenantMoneyFormat(), options);
}
