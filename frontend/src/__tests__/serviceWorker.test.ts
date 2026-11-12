import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi } from 'vitest';

/**
 * public/sw.js opens the page a push notification names when it is clicked. The URL
 * comes from the push payload, so only a page of the app itself is opened.
 */
// The tests run from frontend/.
const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
const ORIGIN = 'https://nuggets.example';

type Listener = (event: unknown) => void;

/** Load the worker with a stand-in `self`; click a notification whose data.url is `url`. */
async function click(url: unknown, openWindows: { url: string }[] = []) {
  const listeners: Record<string, Listener> = {};
  const navigate = vi.fn(async () => null);
  const windows = openWindows.map((w) => ({ ...w, focus: vi.fn(async () => ({ navigate })) }));
  const openWindow = vi.fn(async () => null);
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
    clients: { matchAll: async () => windows, openWindow, claim: async () => undefined },
    registration: { showNotification: async () => undefined },
    skipWaiting: () => undefined,
  };
  new Function('self', source)(self);
  let pending: Promise<unknown> = Promise.resolve();
  listeners.notificationclick({
    notification: { close: () => undefined, data: { url } },
    waitUntil: (p: Promise<unknown>) => (pending = p),
  });
  await pending;
  return { openWindow, navigate };
}

describe('the service worker’s notification click', () => {
  it('opens a page of the app', async () => {
    expect((await click('/bills?month=2026-11')).openWindow).toHaveBeenCalledWith(`${ORIGIN}/bills?month=2026-11`);
    expect((await click(`${ORIGIN}/tasks`)).openWindow).toHaveBeenCalledWith(`${ORIGIN}/tasks`);
  });

  it.each(['https://evil.example/login', '//evil.example/login', 'javascript:alert(1)', 'http://nuggets.example/x'])(
    'opens the home page instead of %s',
    async (url) => {
      expect((await click(url)).openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
    }
  );

  it('navigates an open window only within the app', async () => {
    const { navigate, openWindow } = await click('https://evil.example/', [{ url: `${ORIGIN}/dashboard` }]);
    expect(navigate).toHaveBeenCalledWith(`${ORIGIN}/`);
    expect(openWindow).not.toHaveBeenCalled();
  });
});
