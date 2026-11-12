// Frontend timezone utilities for consistent date formatting
import { logger } from './logger';
// This fetches the application timezone setting from the backend

/** The zone used while the household hasn't set one: the backend's (utils/appDate.ts). */
export const DEFAULT_TIMEZONE = 'UTC';

let cachedTimezone: string | null = null;
let cacheTimestamp: number = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
// Counts clearTimezoneCache calls: an answer asked for before one (the previous ledger's
// zone, during a ledger switch) is not cached after it.
let cacheGeneration = 0;

/**
 * Get the application timezone setting (cached)
 */
export async function getApplicationTimezone(): Promise<string> {
  const now = Date.now();
  
  // Return cached value if still valid
  if (cachedTimezone && (now - cacheTimestamp) < CACHE_DURATION) {
    return cachedTimezone;
  }
  
  const generation = cacheGeneration;
  try {
    // Import dynamically to avoid circular dependencies
    const { getGeneralSettings } = await import('../services/api');
    const settings = await getGeneralSettings();
    
    const timezoneSetting = settings.find(s => s.setting_key === 'application_timezone');
    // UTC until the household sets its zone, as the backend reads it (utils/appDate.ts).
    const timezone = timezoneSetting?.setting_value || DEFAULT_TIMEZONE;
    
    // Update cache, unless it was cleared meanwhile: this may be another ledger's zone.
    if (generation === cacheGeneration) {
      cachedTimezone = timezone;
      cacheTimestamp = now;
    }
    
    return timezone;
  } catch (error) {
    logger.error({ err: error }, 'Error fetching application timezone');
    return DEFAULT_TIMEZONE;
  }
}

/**
 * Format a date/timestamp in the application timezone
 */
export async function formatDateInApplicationTimezone(
  date: string | Date | number,
  options: Intl.DateTimeFormatOptions = {}
): Promise<string> {
  const timezone = await getApplicationTimezone();
  
  const dateObj = typeof date === 'string' ? new Date(date) :
                  typeof date === 'number' ? new Date(date) : date;
  
  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...options
  };
  
  return new Intl.DateTimeFormat('en-US', defaultOptions).format(dateObj);
}

/**
 * Format a timestamp with time in the application timezone
 */
export async function formatTimestampInApplicationTimezone(
  timestamp: string | Date | number
): Promise<string> {
  return formatDateInApplicationTimezone(timestamp, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });
}

/** Forget the cached zone, so the next format reads the saved setting. */
export function clearTimezoneCache(): void {
  cacheGeneration += 1;
  cachedTimezone = null;
  cacheTimestamp = 0;
}
