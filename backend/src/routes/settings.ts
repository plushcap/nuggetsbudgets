import { Router, Response } from 'express';
import { AuthenticatedRequest, authHandler, tenantHandler } from '../utils/routeHandler.js';
import { requireTenantAdmin } from '../middleware/tenant.js';
import { createLogger } from '../utils/logger.js';
import { isAppTimeZone } from '../utils/appDate.js';
import { readTenantSettings } from '../services/tenantSettings.js';
import { saveGeneralSettings } from '../services/generalSettings.js';
import { readSystemSetting } from '../services/systemSettings.js';
import { validateBody } from '../middleware/validate.js';
import {
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  currencyCodeProblem,
  generalSettingsUpdateSchema,
  moneyLocaleProblem,
  type GeneralSettingsUpdateInput,
} from '@nuggets/shared';

const logger = createLogger({ service: 'SettingsRoute' });

/**
 * The settings on the General settings page: the ledger's own (`tenant_settings`).
 * Its time zone, which decides the ledger's calendar day, and its currency and locale, which
 * every amount is shown in (tenantMoneyFormat.ts). The description says "tenant", as the
 * backend's text does; the page shows it in Ledger wording (getGeneralSettings, frontend).
 */
const GENERAL_SETTINGS = [
  {
    setting_key: 'application_timezone',
    setting_type: 'string',
    description:
      "This tenant's time zone (an IANA name such as America/New_York): decides which day is today for its budget periods, bills, goals, snapshots and reports.",
  },
  {
    setting_key: 'application_currency',
    setting_type: 'string',
    description: "This tenant's currency (an ISO 4217 code such as USD or EUR): every amount is shown in it.",
  },
  {
    setting_key: 'application_locale',
    setting_type: 'string',
    description:
      'How this tenant writes amounts (a BCP 47 locale such as en-US or de-DE): its separators and where the currency sign goes.',
  },
] as const;
type GeneralSettingKey = (typeof GENERAL_SETTINGS)[number]['setting_key'];
const GENERAL_KEYS: readonly GeneralSettingKey[] = GENERAL_SETTINGS.map((s) => s.setting_key);

/**
 * Why a General Settings save is refused, or null. `stored` holds the ledger's current
 * values of the general settings; a key not in GENERAL_SETTINGS can't be set.
 */
export async function generalSettingsError(
  entries: Array<[string, unknown]>,
  stored: Map<string, string | null>
): Promise<string | null> {
  for (const [key, value] of entries) {
    if (!(GENERAL_KEYS as readonly string[]).includes(key)) {
      return `Setting '${key}' does not exist or is not user configurable`;
    }
    if (typeof value !== 'string') return `Setting '${key}' must be a string`;
    // The ledger's calendar day is read in this zone (utils/appDate.ts). Checked only
    // when it changes: the page saves every setting, and a zone stored before this check
    // (or one this Postgres build lacks) mustn't block saving the others.
    if (key === 'application_timezone' && value !== stored.get(key) && !(await isAppTimeZone(value))) {
      return 'application_timezone must be an IANA time zone such as America/New_York';
    }
    // Checked when they change, as the zone is: the page saves every setting.
    const moneyProblem =
      key === 'application_currency' ? currencyCodeProblem(value) : key === 'application_locale' ? moneyLocaleProblem(value) : null;
    if (moneyProblem && value !== stored.get(key)) return moneyProblem;
  }
  return null;
}

/** What a setting the ledger hasn't set reads as: the deployment's zone, or USD in en-US. */
function unsetValue(key: GeneralSettingKey, deploymentZone: string | null): string | null {
  if (key === 'application_currency') return DEFAULT_CURRENCY;
  if (key === 'application_locale') return DEFAULT_LOCALE;
  return deploymentZone;
}

/** The deployment's zone: a ledger's until it sets its own. */
async function deploymentTimezone(): Promise<string | null> {
  return (await readSystemSetting('application_timezone')) ?? null;
}

export function createSettingsRoutes(): Router {
  const router = Router();

  // GET /api/settings/general - the ledger's general settings (any member may read them).
  router.get('/general', tenantHandler(async (_req: AuthenticatedRequest, res: Response) => {
    const stored = await readTenantSettings(GENERAL_KEYS);
    const zone = stored.application_timezone ? null : await deploymentTimezone();
    res.json(
      GENERAL_SETTINGS.map((s) => ({
        ...s,
        setting_value: stored[s.setting_key] ?? unsetValue(s.setting_key, zone),
        is_user_configurable: true,
      }))
    );
  }));

  // POST /api/settings/general - change the ledger's general settings (its admins:
  // a ledger admin, an admin of its organization, or a deployment admin). Every setting
  // is checked before any is written, and they are written together; a new time zone clamps
  // the goal history's ranges of days to the new today in the same transaction.
  router.post('/general', requireTenantAdmin, validateBody(generalSettingsUpdateSchema), tenantHandler(async (req: AuthenticatedRequest, res: Response) => {
    const { settings } = req.body as GeneralSettingsUpdateInput;
    const entries = Object.entries(settings);
    const current = await readTenantSettings(GENERAL_KEYS);
    const stored = new Map<string, string | null>(Object.entries(current));
    const refused = await generalSettingsError(entries, stored);
    if (refused) {
      res.status(400).json({ error: refused, code: 'VALIDATION_ERROR' });
      return;
    }

    await saveGeneralSettings(Object.fromEntries(entries) as Record<GeneralSettingKey, string>, current, req.user.userId);
    logger.info({ keys: entries.map(([key]) => key) }, 'Tenant general settings updated');
    res.json({ success: true, message: 'General settings updated successfully' });
  }));

  // GET /api/settings/timezones - Get available timezones
  router.get('/timezones', authHandler(async (_req: AuthenticatedRequest, res: Response) => {
    // Get list of common timezones with their offsets
    const timezones = [
      { value: 'UTC', label: 'UTC', offset: 'UTC+0' },
      { value: 'America/New_York', label: 'Eastern Time', offset: 'UTC-5/-4' },
      { value: 'America/Chicago', label: 'Central Time', offset: 'UTC-6/-5' },
      { value: 'America/Denver', label: 'Mountain Time', offset: 'UTC-7/-6' },
      { value: 'America/Los_Angeles', label: 'Pacific Time', offset: 'UTC-8/-7' },
      { value: 'America/Anchorage', label: 'Alaska Time', offset: 'UTC-9/-8' },
      { value: 'Pacific/Honolulu', label: 'Hawaii Time', offset: 'UTC-10' },
      { value: 'America/Phoenix', label: 'Arizona Time', offset: 'UTC-7' },
      { value: 'America/Toronto', label: 'Toronto', offset: 'UTC-5/-4' },
      { value: 'America/Vancouver', label: 'Vancouver', offset: 'UTC-8/-7' },
      { value: 'Europe/London', label: 'London', offset: 'UTC+0/+1' },
      { value: 'Europe/Paris', label: 'Paris', offset: 'UTC+1/+2' },
      { value: 'Europe/Berlin', label: 'Berlin', offset: 'UTC+1/+2' },
      { value: 'Europe/Rome', label: 'Rome', offset: 'UTC+1/+2' },
      { value: 'Europe/Madrid', label: 'Madrid', offset: 'UTC+1/+2' },
      { value: 'Asia/Tokyo', label: 'Tokyo', offset: 'UTC+9' },
      { value: 'Asia/Shanghai', label: 'Shanghai', offset: 'UTC+8' },
      { value: 'Asia/Hong_Kong', label: 'Hong Kong', offset: 'UTC+8' },
      { value: 'Asia/Singapore', label: 'Singapore', offset: 'UTC+8' },
      { value: 'Asia/Kolkata', label: 'India', offset: 'UTC+5:30' },
      { value: 'Australia/Sydney', label: 'Sydney', offset: 'UTC+10/+11' },
      { value: 'Australia/Melbourne', label: 'Melbourne', offset: 'UTC+10/+11' },
      { value: 'Australia/Perth', label: 'Perth', offset: 'UTC+8' }
    ];

    res.json(timezones);
  }));

  return router;
}
