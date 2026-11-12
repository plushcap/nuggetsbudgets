import { lazy, type LazyExoticComponent } from 'react';
import { logger } from './logger';
import { readStored, writeStored } from './storage';

/**
 * `React.lazy` with resilience against dynamic-import failures.
 *
 * Two failure modes this guards against (both render a blank page otherwise,
 * since a rejected import propagates past <Suspense>):
 *
 * 1. A transient network blip → retry the import once in place.
 * 2. A stale chunk after a deploy (the client still has the old index.html, so
 *    the hashed chunk URL 404s) → hard-reload once to pull fresh HTML + chunk
 *    hashes. A sessionStorage flag prevents a reload loop; it's cleared on the
 *    first successful import so each genuine stale-deploy event gets one reload.
 *
 * If it still fails after a reload, the error propagates to the nearest
 * ErrorBoundary, which shows a recoverable fallback instead of a blank screen.
 */
const RELOAD_FLAG = 'nuggets:chunk-reloaded';

/** The components React.lazy accepts, taken from its own signature. */
type LazyComponent = Awaited<ReturnType<Parameters<typeof lazy>[0]>>['default'];

export function lazyWithRetry<T extends LazyComponent>(
  factory: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await factory();
      writeStored('session', RELOAD_FLAG, null);
      return mod;
    } catch (firstError) {
      logger.warn({ err: firstError }, 'Dynamic import failed; retrying once');
      try {
        const mod = await factory();
        writeStored('session', RELOAD_FLAG, null);
        return mod;
      } catch (retryError) {
        const alreadyReloaded = readStored('session', RELOAD_FLAG) === '1';
        // Reload only if the flag was stored: without it, a reload could loop forever.
        if (!alreadyReloaded && writeStored('session', RELOAD_FLAG, '1')) {
          // Most likely a stale chunk after a deploy — reload to get fresh HTML.
          logger.warn({ err: retryError }, 'Dynamic import still failing; reloading for fresh chunks');
          window.location.reload();
          // Stall until the reload takes over so we never surface the error here.
          return new Promise<{ default: T }>(() => {});
        }
        logger.error({ err: retryError }, 'Dynamic import failed after reload');
        throw retryError;
      }
    }
  });
}

export default lazyWithRetry;
