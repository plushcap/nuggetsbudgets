import { writeTenantSettings, type TenantSettings } from './tenantSettings.js';
import { clampDayRangesToToday, lockDayRangeWriters } from './goalDayRanges.js';

/**
 * Save the current tenant's General settings (POST /api/settings/general), checked by the route
 * first: `stored` holds their current values. Its time zone decides which day is today, and the
 * goal history's ranges of days were written in the old one: a change of it locks what writes
 * them, writes the zone, and clamps them to the new today, all in the caller's transaction
 * (goalDayRanges.ts), so a refused or failed save leaves both as they were.
 */
export async function saveGeneralSettings(
  values: Pick<TenantSettings, 'application_timezone' | 'application_currency' | 'application_locale'>,
  stored: Pick<TenantSettings, 'application_timezone'>,
  userId: number
): Promise<void> {
  const zoneChanges = values.application_timezone !== undefined && values.application_timezone !== (stored.application_timezone ?? null);
  if (zoneChanges) await lockDayRangeWriters();
  await writeTenantSettings(values, userId);
  if (zoneChanges) await clampDayRangesToToday();
}
