/**
 * API Settings Module - System Settings Operations
 *
 * Handles all settings-related API operations:
 * - General system settings
 * - Timezone configuration
 *
 * Each answer is parsed with its `@nuggets/shared` schema.
 */

import { generalSettingsResponseSchema, settingsActionResponseSchema, timeZoneOptionsResponseSchema } from '@nuggets/shared';
import { API_BASE_URL, getAuthHeaders, handleResponse, toLedgerWording } from './base';
import { parseAnswer } from './parseAnswer';
import type { SystemSetting, TimezoneOption } from './types';
import { logger } from '../../utils/logger';

/**
 * Get all general settings. Their descriptions come from the server, which calls a ledger a
 * tenant, so they are shown in Ledger wording, as its errors are.
 */
export const getGeneralSettings = async (): Promise<SystemSetting[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/settings/general`, {
      headers: getAuthHeaders(),
    });
    const result = parseAnswer(generalSettingsResponseSchema, await handleResponse<unknown>(response), 'general settings');
    // `?? ''`: a production build reads a mismatched answer as it came (parseAnswer), maybe without one.
    return result.map((setting) => ({ ...setting, description: toLedgerWording(setting.description ?? '') }));
  } catch (error) {
    logger.error({ err: error, endpoint: '/settings' }, 'Failed to fetch general settings');
    throw error;
  }
};

/**
 * Update general settings
 */
export const updateGeneralSettings = async (settings: Record<string, string>): Promise<void> => {
  try {
    const response = await fetch(`${API_BASE_URL}/settings/general`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify({ settings }),
    });
    parseAnswer(settingsActionResponseSchema, await handleResponse<unknown>(response), 'general settings saved');
  } catch (error) {
    logger.error({ err: error, endpoint: '/settings' }, 'Failed to update general settings');
    throw error;
  }
};

/**
 * Get list of available timezones
 */
export const getAvailableTimezones = async (): Promise<TimezoneOption[]> => {
  try {
    const response = await fetch(`${API_BASE_URL}/settings/timezones`, {
      headers: getAuthHeaders(),
    });
    return parseAnswer(timeZoneOptionsResponseSchema, await handleResponse<unknown>(response), 'time zones');
  } catch (error) {
    logger.error({ err: error, endpoint: '/settings/timezones' }, 'Failed to fetch available timezones');
    throw error;
  }
};
