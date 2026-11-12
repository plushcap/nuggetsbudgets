import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const api = vi.hoisted(() => ({
  getPushPublicKey: vi.fn(),
  savePushSubscription: vi.fn(),
  removePushSubscription: vi.fn(),
}));
vi.mock('../../services/api', () => api);

import { disablePushOnSignOut, enablePush, getPushState } from '../pushNotifications';

// Server key as base64url, and the bytes the browser holds for it.
const SERVER_KEY = 'BAECAwQ';
const SERVER_KEY_BYTES = new Uint8Array([4, 1, 2, 3, 4]);

function fakeSubscription(keyBytes: Uint8Array) {
  return {
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    options: { applicationServerKey: keyBytes.buffer },
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn().mockResolvedValue(true),
  };
}

function installBrowser({
  permission = 'default' as NotificationPermission,
  requestResult = 'granted' as NotificationPermission,
  registration = true,
  existing = null as ReturnType<typeof fakeSubscription> | null,
  userAgent = 'Mozilla/5.0 (Linux; Android 16; Pixel 11)',
} = {}) {
  const pushManager = {
    getSubscription: vi.fn().mockResolvedValue(existing),
    subscribe: vi.fn().mockResolvedValue(fakeSubscription(SERVER_KEY_BYTES)),
  };
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('PushManager', function PushManager() {});
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn().mockResolvedValue(requestResult) });
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  Object.defineProperty(navigator, 'userAgent', { value: userAgent, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    value: { getRegistration: vi.fn().mockResolvedValue(registration ? { pushManager } : undefined) },
    configurable: true,
  });
  return { pushManager };
}

describe('pushNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getPushPublicKey.mockResolvedValue({ publicKey: SERVER_KEY });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports insecure over plain http', async () => {
    installBrowser();
    vi.stubGlobal('isSecureContext', false);
    expect(await getPushState()).toBe('insecure');
  });

  it('asks iPhone Safari tabs to install to the Home Screen first', async () => {
    installBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari' });
    expect(await getPushState()).toBe('install-first');
  });

  it('reports denied when the site is blocked', async () => {
    installBrowser({ permission: 'denied' });
    expect(await getPushState()).toBe('denied');
  });

  it('reports enabled only with permission and a subscription', async () => {
    installBrowser({ permission: 'granted', existing: fakeSubscription(SERVER_KEY_BYTES) });
    expect(await getPushState()).toBe('enabled');
  });

  it('subscribes with the server key and registers the subscription', async () => {
    const { pushManager } = installBrowser();
    expect(await enablePush()).toBe('enabled');
    expect(pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: SERVER_KEY_BYTES });
    expect(api.savePushSubscription).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }));
  });

  it('replaces a subscription made for a different server key', async () => {
    const stale = fakeSubscription(new Uint8Array([4, 9, 9, 9, 9]));
    const { pushManager } = installBrowser({ existing: stale });
    await enablePush();
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalled();
  });

  it('reuses a subscription already made for the server key', async () => {
    const { pushManager } = installBrowser({ existing: fakeSubscription(SERVER_KEY_BYTES) });
    await enablePush();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(api.savePushSubscription).toHaveBeenCalled();
  });

  it('stops when the person declines', async () => {
    const { pushManager } = installBrowser({ requestResult: 'denied' });
    expect(await enablePush()).toBe('denied');
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('signs out without waiting on a service worker that never registered', async () => {
    installBrowser({ registration: false });
    await expect(disablePushOnSignOut()).resolves.toBeUndefined();
    expect(api.removePushSubscription).not.toHaveBeenCalled();
  });

  it('forgets this device on sign-out', async () => {
    const existing = fakeSubscription(SERVER_KEY_BYTES);
    installBrowser({ permission: 'granted', existing });
    await disablePushOnSignOut();
    expect(api.removePushSubscription).toHaveBeenCalledWith(existing.endpoint);
    expect(existing.unsubscribe).toHaveBeenCalled();
  });
});
