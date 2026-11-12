import { getPushPublicKey, removePushSubscription, savePushSubscription } from '../services/api';
import { logger } from './logger';

/**
 * What this browser can do about Nuggets push notifications:
 * - `unsupported`  no Push API at all (old browser)
 * - `insecure`     the page isn't on HTTPS, so browsers withhold service workers and push
 * - `install-first` iPhone/iPad Safari: push only exists in the app added to the Home Screen
 * - `denied`       the person blocked notifications for the site in browser settings
 * - `enabled` / `disabled`  whether this browser is subscribed
 */
export type PushState = 'unsupported' | 'insecure' | 'install-first' | 'denied' | 'enabled' | 'disabled';

function isIosBrowserTab(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
    // iPadOS reports itself as a Mac; touch support gives it away.
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

function base64UrlToBytes(base64Url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false;
  const view = new Uint8Array(a);
  return view.every((byte, i) => byte === b[i]);
}

// getRegistration, not serviceWorker.ready: `ready` never settles if the worker
// failed to register, which would hang sign-out.
async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration ? registration.pushManager.getSubscription() : null;
}

export async function getPushState(): Promise<PushState> {
  if (!window.isSecureContext) return 'insecure';
  if (isIosBrowserTab()) return 'install-first';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'disabled';
  return (await currentSubscription()) ? 'enabled' : 'disabled';
}

/**
 * Ask for permission (must run from a click: browsers ignore the prompt
 * otherwise), subscribe this browser, and register it with the server.
 * Returns the resulting state, e.g. `denied` if the person said no.
 */
export async function enablePush(): Promise<PushState> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'disabled';

  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) throw new Error('The Nuggets service worker is not registered');
  const { publicKey } = await getPushPublicKey();
  const applicationServerKey = base64UrlToBytes(publicKey);

  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for a different server key can't receive our pushes.
  if (subscription && !sameKey(subscription.options.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });

  await savePushSubscription(subscription.toJSON());
  return 'enabled';
}

/** Unsubscribe this browser and forget it on the server. */
export async function disablePush(): Promise<void> {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await removePushSubscription(subscription.endpoint);
  await subscription.unsubscribe();
}

/**
 * Re-register this browser's existing subscription with the server. Push
 * services rotate endpoints and the server prunes ones that stop working, so
 * the app reports what the browser actually holds each time someone signs in.
 */
export async function syncPushSubscription(): Promise<void> {
  try {
    if ((await getPushState()) !== 'enabled') return;
    const subscription = await currentSubscription();
    if (subscription) await savePushSubscription(subscription.toJSON());
  } catch (err) {
    logger.warn({ err }, 'Could not sync the push subscription');
  }
}

/** Best-effort {@link disablePush} for sign-out, so the next person on this device doesn't get these alerts. */
export async function disablePushOnSignOut(): Promise<void> {
  try {
    if ('serviceWorker' in navigator && 'PushManager' in window) await disablePush();
  } catch (err) {
    logger.warn({ err }, 'Could not remove the push subscription on sign-out');
  }
}
