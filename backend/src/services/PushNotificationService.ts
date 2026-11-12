import type { PushSendResult } from '@nuggets/shared';
// web-push is an ES module with named exports only (no default export since 4.0).
import { generateVAPIDKeys, sendNotification, WebPushError } from 'web-push';
import { sql } from 'kysely';
import { globalDb } from '../db/withTenant.js';
import { EncryptionService } from './EncryptionService.js';
import { addSystemSettings, readSystemSetting, readSystemSettings } from './systemSettings.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';

const logger = createLogger({ service: 'PushNotificationService' });

/**
 * What the service worker (frontend/public/sw.js) shows: `url` is a same-origin
 * path the notification opens when tapped, `tag` collapses repeats of one alert.
 */
export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** A browser PushSubscription as `subscription.toJSON()` serializes it. */
export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** What a send to a person's devices did: one type with the answer's (`@nuggets/shared`). */
export type { PushSendResult };

const VAPID_PUBLIC_KEY = 'push_vapid_public_key';
const VAPID_PRIVATE_KEY = 'push_vapid_private_key';

// The server POSTs to whatever endpoint a browser hands it, so only the push
// services browsers actually use are accepted — anything else (an internal host,
// a plain-http URL) would turn subscribe into a request forger.
const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,                 // Chrome, Edge on Android, Samsung Internet
  /^android\.googleapis\.com$/,             // legacy Chrome endpoints
  /^updates\.push\.services\.mozilla\.com$/, // Firefox
  /^web\.push\.apple\.com$/,                // Safari / iOS home-screen apps
  /^[a-z0-9-]+\.notify\.windows\.com$/,     // Edge on Windows (WNS)
];

/** Whether `endpoint` is an https URL on a known browser push service. */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.port && PUSH_SERVICE_HOSTS.some((host) => host.test(url.hostname));
}

/**
 * A failed push as a log line carries it: web-push's WebPushError as its name and
 * the push service's status code, never the error itself, whose `endpoint` is the device's
 * subscription address (with its keys, whoever has it can push to that device) and whose
 * `body` and `headers` are the push service's answer. Any other error (decrypting the
 * keys, a network failure, which names the push service's host at most) is logged whole.
 */
export function pushErrorFields(err: unknown): { pushError: { name: string; statusCode: number } } | { err: unknown } {
  if (err instanceof WebPushError) return { pushError: { name: err.name, statusCode: err.statusCode } };
  return { err };
}

/**
 * Web Push delivery: the VAPID key pair, each person's device subscriptions,
 * and sending a message to all of a person's devices.
 *
 * The key pair is generated the first time it's needed and kept in
 * system_settings (category 'push', so no settings page lists it), the private
 * key encrypted with EncryptionService. Nothing has to be configured, and
 * existing subscriptions keep working across restarts because the key persists.
 */
export class PushNotificationService {
  private vapid: { publicKey: string; privateKey: string } | null = null;

  constructor(private readonly encryption: EncryptionService = new EncryptionService()) {}

  /** The VAPID public key browsers subscribe with (`applicationServerKey`). */
  async getPublicKey(): Promise<string> {
    return (await this.getVapidKeys()).publicKey;
  }

  private async getVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
    if (this.vapid) return this.vapid;

    let stored = await this.readStoredKeys();
    if (!stored) {
      const generated = generateVAPIDKeys();
      const encryptedPrivate = await this.encryption.encryptString(generated.privateKey);
      // Two backends starting together could both generate; ON CONFLICT DO
      // NOTHING plus the re-read makes them agree on whichever pair landed first.
      // On globalDb, never a request's transaction: the pair is kept (and cached) even when the
      // request that needed it is rolled back.
      await addSystemSettings([
        {
          key: VAPID_PUBLIC_KEY,
          value: generated.publicKey,
          settingType: 'string',
          description: 'Web Push VAPID public key (generated automatically)',
          category: 'push',
          userConfigurable: false,
        },
        {
          key: VAPID_PRIVATE_KEY,
          value: encryptedPrivate,
          settingType: 'string',
          description: 'Web Push VAPID private key, encrypted (generated automatically)',
          category: 'push',
          userConfigurable: false,
        },
      ], globalDb);
      stored = await this.readStoredKeys();
      if (!stored) throw new Error('Web Push keys could not be stored');
      logger.info('Generated the Web Push VAPID key pair');
    }

    this.vapid = {
      publicKey: stored.publicKey,
      privateKey: await this.encryption.decryptString(stored.encryptedPrivateKey),
    };
    return this.vapid;
  }

  private async readStoredKeys(): Promise<{ publicKey: string; encryptedPrivateKey: string } | null> {
    const stored = await readSystemSettings([VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY], globalDb);
    const publicKey = stored[VAPID_PUBLIC_KEY];
    const encryptedPrivateKey = stored[VAPID_PRIVATE_KEY];
    return publicKey && encryptedPrivateKey ? { publicKey, encryptedPrivateKey } : null;
  }

  /**
   * The VAPID `sub` claim push services may use to contact the operator. Apple
   * rejects a localhost URL, so an https CLIENT_URL is used only when it's a real
   * host; otherwise the notification email's from-address.
   */
  private async getSubject(): Promise<string> {
    const { VAPID_SUBJECT, CLIENT_URL } = config();
    if (VAPID_SUBJECT) return VAPID_SUBJECT;

    const clientUrl = CLIENT_URL;
    if (clientUrl) {
      try {
        const url = new URL(clientUrl);
        if (url.protocol === 'https:' && url.hostname !== 'localhost') return url.origin;
      } catch {
        // fall through to the email address
      }
    }

    const from = await readSystemSetting('notification_email_from_address', globalDb);
    return `mailto:${from || 'notifications@nuggets.local'}`;
  }

  /**
   * Save (or move to `userId`) the subscription for one browser. Re-subscribing
   * the same browser updates its row in place, keyed by endpoint.
   */
  async subscribe(userId: number, subscription: PushSubscriptionInput, userAgent: string | null): Promise<string> {
    const keysEncrypted = await this.encryption.encryptString(JSON.stringify(subscription.keys));
    const row = await globalDb
      .insertInto('push_subscriptions')
      .values({
        user_id: userId,
        endpoint: subscription.endpoint,
        keys_encrypted: keysEncrypted,
        user_agent: userAgent,
      })
      .onConflict((oc) => oc.column('endpoint').doUpdateSet({
        user_id: userId,
        keys_encrypted: keysEncrypted,
        user_agent: userAgent,
      }))
      .returning('uuid')
      .executeTakeFirstOrThrow();

    logger.info({ userId }, 'Push subscription saved');
    return row.uuid;
  }

  /** Forget one of `userId`'s browsers. Returns whether a row was removed. */
  async unsubscribe(userId: number, endpoint: string): Promise<boolean> {
    const result = await globalDb
      .deleteFrom('push_subscriptions')
      .where('endpoint', '=', endpoint)
      .where('user_id', '=', userId)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0) > 0;
  }

  /** How many devices `userId` gets push notifications on. */
  async countSubscriptions(userId: number): Promise<number> {
    const row = await globalDb
      .selectFrom('push_subscriptions')
      .select((eb) => eb.fn.countAll().as('count'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /**
   * Send `message` to every device of `userId`. A device the push service says
   * is gone (404/410: the person revoked permission or uninstalled the app) is
   * deleted; any other failure is counted and logged, and the row kept.
   */
  async sendToUser(userId: number, message: PushMessage): Promise<PushSendResult> {
    const subscriptions = await globalDb
      .selectFrom('push_subscriptions')
      .select(['id', 'endpoint', 'keys_encrypted'])
      .where('user_id', '=', userId)
      .execute();

    const result: PushSendResult = { sent: 0, failed: 0, removed: 0 };
    if (subscriptions.length === 0) return result;

    const { publicKey, privateKey } = await this.getVapidKeys();
    const vapidDetails = { subject: await this.getSubject(), publicKey, privateKey };
    const payload = JSON.stringify(message);

    for (const subscription of subscriptions) {
      try {
        const keys = JSON.parse(await this.encryption.decryptString(subscription.keys_encrypted));
        await sendNotification(
          { endpoint: subscription.endpoint, keys },
          payload,
          // A day: an alert older than that is stale enough to drop if the phone stayed offline.
          // The timeout bounds how long a hung push service can hold up the queue.
          { vapidDetails, TTL: 24 * 60 * 60, urgency: 'normal', timeout: 15_000 }
        );
        await globalDb
          .updateTable('push_subscriptions')
          .set({ last_success_at: sql<Date>`CURRENT_TIMESTAMP` })
          .where('id', '=', subscription.id)
          .execute();
        result.sent++;
      } catch (err) {
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          await globalDb.deleteFrom('push_subscriptions').where('id', '=', subscription.id).execute();
          result.removed++;
          logger.info({ userId, subscriptionId: subscription.id }, 'Removed expired push subscription');
        } else {
          result.failed++;
          logger.warn({ ...pushErrorFields(err), userId, subscriptionId: subscription.id }, 'Push delivery failed');
        }
      }
    }

    return result;
  }
}
