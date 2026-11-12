import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * While the household hasn't set its zone, or the setting can't be read, dates are shown
 * in UTC, the zone the backend uses then (utils/appDate.ts). The page fell back to
 * America/New_York, the original deployment's zone.
 */
const settings = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../services/api', () => ({ getGeneralSettings: settings.get }));

async function freshTimezone() {
  vi.resetModules();
  return import('../timezone');
}

afterEach(() => {
  settings.get.mockReset();
});

describe('getApplicationTimezone', () => {
  it('is the household’s zone when it is set', async () => {
    settings.get.mockResolvedValue([{ setting_key: 'application_timezone', setting_value: 'Europe/Berlin' }]);
    const { getApplicationTimezone } = await freshTimezone();
    expect(await getApplicationTimezone()).toBe('Europe/Berlin');
  });

  it('is UTC while none is set', async () => {
    settings.get.mockResolvedValue([{ setting_key: 'something_else', setting_value: 'x' }]);
    const { getApplicationTimezone } = await freshTimezone();
    expect(await getApplicationTimezone()).toBe('UTC');
  });

  it('is UTC when the settings can’t be read', async () => {
    settings.get.mockRejectedValue(new Error('offline'));
    const { getApplicationTimezone } = await freshTimezone();
    expect(await getApplicationTimezone()).toBe('UTC');
  });
});

describe('the cached zone', () => {
  const zone = (value: string) => [{ setting_key: 'application_timezone', setting_value: value }];

  // Each ledger has its own zone; the cache outlived a switch by 5 minutes.
  it('is read again after a ledger switch, and after a sign-in or sign-out', async () => {
    settings.get.mockResolvedValue(zone('Europe/Berlin'));
    const { getApplicationTimezone } = await freshTimezone();
    const { resetLedgerData, removeSessionData } = await import('../../hooks/queries/invalidation');
    const { QueryClient } = await import('@tanstack/react-query');
    const client = new QueryClient();
    expect(await getApplicationTimezone()).toBe('Europe/Berlin');

    settings.get.mockResolvedValue(zone('Asia/Tokyo'));
    expect(await getApplicationTimezone()).toBe('Europe/Berlin');
    await resetLedgerData(client);
    expect(await getApplicationTimezone()).toBe('Asia/Tokyo');

    settings.get.mockResolvedValue(zone('America/Chicago'));
    removeSessionData(client);
    expect(await getApplicationTimezone()).toBe('America/Chicago');
  });

  it("doesn't keep the previous ledger's zone when its answer lands after the switch", async () => {
    let answer: (rows: unknown) => void = () => {};
    settings.get.mockReturnValueOnce(new Promise((resolve) => { answer = resolve; }));
    const { getApplicationTimezone, clearTimezoneCache } = await freshTimezone();
    const before = getApplicationTimezone();
    clearTimezoneCache(); // the switch, while the old ledger's zone is on its way
    answer(zone('Europe/Berlin'));
    expect(await before).toBe('Europe/Berlin');

    settings.get.mockResolvedValue(zone('Asia/Tokyo'));
    expect(await getApplicationTimezone()).toBe('Asia/Tokyo');
  });
});
