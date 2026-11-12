import { logger } from './logger';

/**
 * Register the app's service worker (`public/sw.js`).
 *
 * Browsers only treat Nuggets as an installable app — and can only deliver
 * Web Push notifications — once a service worker controls the page. The worker
 * caches nothing (no fetch handler), so registering it doesn't change how
 * pages or API calls load.
 *
 * Service workers require a secure context (HTTPS or localhost); elsewhere the
 * API is absent and this is a no-op.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .catch((err: unknown) => logger.warn({ err }, 'Service worker registration failed'));
  });
}
