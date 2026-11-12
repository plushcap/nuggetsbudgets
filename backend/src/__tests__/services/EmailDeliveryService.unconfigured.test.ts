import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

/**
 * An empty SMTP host is "email not configured": a fresh install has none since
 * a migration before v3.0.0 stopped seeding a provider's. With a username and a password set but no
 * host, nothing is sent and nothing connects: isConfigured() is false (notification rules
 * and the new-credential notice then queue no email), and a send is refused with
 * SMTP_NOT_CONFIGURED, in words an admin can act on. The refusal is permanent: a send
 * isn't retried while nothing is set up.
 */

const { settings, settingsPool } = vi.hoisted(() => {
  const settings = new Map<string, string | null>();
  const query = vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
    const keys = (params ?? []).filter((p): p is string => typeof p === 'string');
    return Promise.resolve({
      rows: keys.filter((key) => settings.has(key)).map((key) => ({ setting_key: key, setting_value: settings.get(key) })),
    });
  });
  return { settings, settingsPool: { query, connect: vi.fn(async () => ({ query, release: () => {} })) } };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: vi.fn(() => ({ sendMail: vi.fn(), close: vi.fn() })) },
}));

// A password is saved (sealed), so only the host is missing.
// The stored password, sealed with the data encryption key; decrypting it gives this.
vi.mock('../../services/EncryptionService.js', () => ({
  EncryptionService: class {
    async decryptString(sealed: string) {
      if (sealed !== 'sealed-smtp-password') throw new Error('not sealed with this key');
      return 'test-password';
    }
  },
}));

// The settings, read through systemSettings.ts (currentDbOrGlobal).
vi.mock('../../db/withTenant.js', () => {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: settingsPool as unknown as Pool }) });
  return { globalDb: db, currentDbOrGlobal: () => db };
});

import nodemailer from 'nodemailer';
import { EmailDeliveryService, SmtpNotConfiguredError, mailFailureReason } from '../../services/EmailDeliveryService.js';

describe.each([
  ['empty', ''],
  ['NULL', null],
])('EmailDeliveryService with an %s SMTP host', (_name, host) => {
  beforeEach(() => {
    vi.mocked(nodemailer.createTransport).mockClear();
    settings.clear();
    settings.set('notification_smtp_host', host);
    settings.set('notification_smtp_port', '587');
    settings.set('notification_smtp_username', 'someone@example.com');
    settings.set('notification_smtp_password', 'sealed-smtp-password');
    settings.set('notification_email_from_address', 'from@example.com');
  });

  it('is not configured', async () => {
    expect(await new EmailDeliveryService().isConfigured()).toBe(false);
  });

  it('refuses a send with SMTP_NOT_CONFIGURED, without connecting anywhere', async () => {
    const err = await new EmailDeliveryService().sendEmail('to@example.com', 'Subject', '<p>hi</p>', 'hi').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmtpNotConfiguredError);
    expect(err).toMatchObject({ status: 503, code: 'SMTP_NOT_CONFIGURED' });
    // Words for the admin, which the test email answers and a notification's history
    // shows: what to set and where, not the settings' keys.
    expect(mailFailureReason(err)).toBe(
      "Email isn't set up yet: enter the SMTP host in the Email Notifications settings."
    );
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('gives up on a retried send with the same refusal', async () => {
    await expect(new EmailDeliveryService().sendEmailWithRetry('to@example.com', 'Subject', '<p>hi</p>', 'hi', 0)).rejects.toMatchObject({
      code: 'SMTP_NOT_CONFIGURED',
    });
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('does not retry it: another try seconds later would be refused the same', async () => {
    const service = new EmailDeliveryService();
    const sleep = vi.spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(undefined);
    const ensureTransport = vi.spyOn(service as unknown as { ensureTransport: () => Promise<void> }, 'ensureTransport');

    await expect(service.sendEmailWithRetry('to@example.com', 'Subject', '<p>hi</p>', 'hi', 3)).rejects.toBeInstanceOf(SmtpNotConfiguredError);
    expect(ensureTransport).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('EmailDeliveryService with neither a host nor a username', () => {
  it('says to enter both, and not the port, which has a default', async () => {
    settings.clear();
    settings.set('notification_smtp_host', '');
    settings.set('notification_smtp_username', '');
    const err = await new EmailDeliveryService().sendEmail('to@example.com', 'Subject', '<p>hi</p>', 'hi').catch((e: unknown) => e);
    expect(mailFailureReason(err)).toBe("Email isn't set up yet: enter the SMTP host and username in the Email Notifications settings.");
  });
});

describe('EmailDeliveryService with a host', () => {
  it('is configured once the host is set too', async () => {
    settings.clear();
    settings.set('notification_smtp_host', 'smtp.example.com');
    settings.set('notification_smtp_port', '587');
    settings.set('notification_smtp_username', 'someone@example.com');
    settings.set('notification_smtp_password', 'sealed-smtp-password');
    expect(await new EmailDeliveryService().isConfigured()).toBe(true);
  });
});
