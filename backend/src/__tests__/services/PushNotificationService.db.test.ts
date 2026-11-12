import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// Real VAPID key generation and payload encryption; only the network send is stubbed.
const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn() }));
vi.mock('web-push', async (importOriginal) => {
  // An ES module with named exports only: the service imports sendNotification by name.
  const actual = await importOriginal<typeof import('web-push')>();
  return { ...actual, sendNotification };
});

// Every line the service logs, as JSON, to check what a failure logs.
const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>();
  const { default: pino } = await import('pino');
  const capture = pino(
    { level: 'trace', redact: { paths: actual.REDACT_PATHS, censor: '[REDACTED]' }, serializers: actual.LOG_SERIALIZERS },
    { write: (line: string) => void logged.lines.push(line) }
  );
  return { ...actual, createLogger: (context: Record<string, unknown>) => capture.child(context) };
});

const { WebPushError } = await import('web-push');
const { globalDb } = await import('../../db/withTenant.js');
const { PushNotificationService, isAllowedPushEndpoint } = await import(
  '../../services/PushNotificationService.js'
);
import type { EncryptionService } from '../../services/EncryptionService.js';

// Reversible stand-in for the data_encryption_key-backed service, so the test
// can tell ciphertext from plaintext without the Docker secret.
const fakeEncryption = {
  encryptString: async (plain: string) => `enc:${Buffer.from(plain).toString('base64')}`,
  decryptString: async (cipher: string) => Buffer.from(cipher.replace(/^enc:/, ''), 'base64').toString(),
} as unknown as EncryptionService;

// p256dh/auth taken from a real Chrome subscription shape: web-push validates
// their lengths before it encrypts the payload.
const keys = {
  p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg', // gitleaks:allow (made-up)
};
const endpoint = (n: string) => `https://fcm.googleapis.com/fcm/send/test-${Date.now()}-${n}`;

describe('isAllowedPushEndpoint', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
    ['https://web.push.apple.com/QAbc', true],
    ['https://wns2-by3p.notify.windows.com/w/?token=abc', true],
    ['http://fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com:8443/fcm/send/abc', false],
    ['https://fcm.googleapis.com.evil.example/abc', false],
    ['https://backend:5000/api/admin', false],
    ['https://169.254.169.254/latest/meta-data', false],
    ['not a url', false],
  ])('%s -> %s', (url, allowed) => {
    expect(isAllowedPushEndpoint(url)).toBe(allowed);
  });
});

describe('PushNotificationService (database)', () => {
  const userIds: number[] = [];
  let alice: number;
  let bob: number;

  const createUser = async (name: string) => {
    const row = await globalDb
      .insertInto('users')
      .values({ email: `push-${name}-${Date.now()}@test.local`, password_hash: 'x' })
      .returning('id')
      .executeTakeFirstOrThrow();
    userIds.push(row.id);
    return row.id;
  };

  const deleteVapidKeys = () =>
    globalDb.deleteFrom('system_settings')
      .where('setting_key', 'in', ['push_vapid_public_key', 'push_vapid_private_key'])
      .execute();

  beforeAll(async () => {
    await deleteVapidKeys();
    alice = await createUser('alice');
    bob = await createUser('bob');
  });

  afterAll(async () => {
    await globalDb.deleteFrom('push_subscriptions').where('user_id', 'in', userIds).execute();
    await globalDb.deleteFrom('users').where('id', 'in', userIds).execute();
    await deleteVapidKeys();
  });

  beforeEach(() => {
    sendNotification.mockReset();
  });

  it('generates the VAPID pair once, storing only the private key encrypted', async () => {
    const first = await new PushNotificationService(fakeEncryption).getPublicKey();
    const second = await new PushNotificationService(fakeEncryption).getPublicKey();
    expect(second).toBe(first);

    const rows = await globalDb.selectFrom('system_settings')
      .select(['setting_key', 'setting_value', 'category'])
      .where('setting_key', 'in', ['push_vapid_public_key', 'push_vapid_private_key'])
      .execute();
    const byKey = Object.fromEntries(rows.map((r) => [r.setting_key, r]));
    expect(byKey.push_vapid_public_key.setting_value).toBe(first);
    expect(byKey.push_vapid_private_key.setting_value).toMatch(/^enc:/);
    // Not 'notifications': GET /api/admin/notifications/settings returns that whole category.
    expect(byKey.push_vapid_private_key.category).toBe('push');
  });

  it('stores the subscription keys encrypted and moves a re-subscribed browser to its new person', async () => {
    const service = new PushNotificationService(fakeEncryption);
    const url = endpoint('shared');

    await service.subscribe(alice, { endpoint: url, keys }, 'Chrome');
    await service.subscribe(bob, { endpoint: url, keys }, 'Chrome');

    const rows = await globalDb.selectFrom('push_subscriptions').selectAll().where('endpoint', '=', url).execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBe(bob);
    expect(rows[0].keys_encrypted).not.toContain(keys.auth);
    expect(await service.countSubscriptions(alice)).toBe(0);
    expect(await service.countSubscriptions(bob)).toBe(1);
  });

  it("removes only the person's own device", async () => {
    const service = new PushNotificationService(fakeEncryption);
    const url = endpoint('own');
    await service.subscribe(alice, { endpoint: url, keys }, null);

    expect(await service.unsubscribe(bob, url)).toBe(false);
    expect(await service.unsubscribe(alice, url)).toBe(true);
    expect(await service.countSubscriptions(alice)).toBe(0);
  });

  it('sends to every device, records success, and drops a device the push service says is gone', async () => {
    const service = new PushNotificationService(fakeEncryption);
    const live = endpoint('live');
    const gone = endpoint('gone');
    await service.subscribe(alice, { endpoint: live, keys }, null);
    await service.subscribe(alice, { endpoint: gone, keys }, null);

    sendNotification.mockImplementation(async (subscription: { endpoint: string }) => {
      if (subscription.endpoint === gone) {
        throw new WebPushError('Gone', 410, {}, '', subscription.endpoint);
      }
      return { statusCode: 201, body: '', headers: {} };
    });

    const message = { title: 'Hi', body: 'There', url: '/' };
    const result = await service.sendToUser(alice, message);

    expect(result).toEqual({ sent: 1, failed: 0, removed: 1 });
    const [subscription, payload, options] = sendNotification.mock.calls.find(([s]) => s.endpoint === live)!;
    expect(subscription.keys).toEqual(keys);
    expect(JSON.parse(payload)).toEqual(message);
    expect(options.vapidDetails.publicKey).toBe(await service.getPublicKey());

    const remaining = await globalDb.selectFrom('push_subscriptions')
      .select(['endpoint', 'last_success_at'])
      .where('user_id', '=', alice)
      .execute();
    expect(remaining.map((r) => r.endpoint)).toEqual([live]);
    expect(remaining[0].last_success_at).not.toBeNull();
  });

  it('keeps a device after any other failure', async () => {
    const service = new PushNotificationService(fakeEncryption);
    const url = endpoint('flaky');
    await service.subscribe(bob, { endpoint: url, keys }, null);
    sendNotification.mockRejectedValue(new WebPushError('Server error', 500, {}, '', url));

    const result = await service.sendToUser(bob, { title: 'Hi', body: '', url: '/' });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.removed).toBe(0);
    expect(await globalDb.selectFrom('push_subscriptions').select('id').where('endpoint', '=', url).executeTakeFirst()).toBeDefined();
  });

  // A device's endpoint is its subscription's address: with its keys, whoever has it can
  // push to that phone. web-push's error carries it (and the push service's answer), so
  // a failure is logged as its name and status code.
  it("logs a failed push without the device's endpoint or the push service's answer", async () => {
    const service = new PushNotificationService(fakeEncryption);
    const url = endpoint('logged-secret-token');
    await service.subscribe(bob, { endpoint: url, keys }, null);
    sendNotification.mockRejectedValue(
      new WebPushError('Received unexpected response code', 500, { 'x-push': 'header' }, `answer naming ${url}`, url)
    );
    logged.lines.length = 0;

    await service.sendToUser(bob, { title: 'Hi', body: '', url: '/' });

    const failures = logged.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === 'Push delivery failed');
    expect(failures.length).toBeGreaterThanOrEqual(1);
    expect(failures).toContainEqual(expect.objectContaining({ userId: bob, pushError: { name: 'WebPushError', statusCode: 500 } }));
    expect(logged.lines.join('\n')).not.toContain('logged-secret-token');
    expect(logged.lines.join('\n')).not.toContain('answer naming');
  });

  it('sends nothing to a person without devices', async () => {
    const carol = await createUser('carol');
    const result = await new PushNotificationService(fakeEncryption).sendToUser(carol, { title: 'Hi', body: '', url: '/' });
    expect(result).toEqual({ sent: 0, failed: 0, removed: 0 });
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
