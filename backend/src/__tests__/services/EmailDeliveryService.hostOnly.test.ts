import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

/**
 * A host is not enough to send email: the notification status said "Configured"
 * for a host alone while every send was refused. With a host and no username or password
 * in the database, isConfigured() is false and a send is refused at once, with no retries,
 * in words for the admin.
 *
 * The password is only the one saved in the app. A stack pasted from 2.4.0 still mounts an
 * smtp_password Docker secret, and may set SMTP_PASSWORD: neither is read any more, so
 * here both hold a password, and email still isn't configured.
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

// The settings, read through systemSettings.ts (currentDbOrGlobal).
vi.mock('../../db/withTenant.js', () => {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: settingsPool as unknown as Pool }) });
  return { globalDb: db, currentDbOrGlobal: () => db };
});

import nodemailer from 'nodemailer';
import { EmailDeliveryService, SmtpNotConfiguredError, mailFailureReason } from '../../services/EmailDeliveryService.js';

let secretsDir: string;
beforeAll(() => {
  secretsDir = mkdtempSync(path.join(os.tmpdir(), 'smtp-secret-ignored-'));
  writeFileSync(path.join(secretsDir, 'smtp_password'), 'a-password-in-the-old-secret-file\n');
  vi.stubEnv('SECRETS_PATH', secretsDir);
  vi.stubEnv('SMTP_PASSWORD', 'a-password-in-the-old-variable');
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(secretsDir, { recursive: true, force: true });
});

describe('EmailDeliveryService with an SMTP host and nothing else', () => {
  beforeEach(() => {
    vi.mocked(nodemailer.createTransport).mockClear();
    settings.clear();
    settings.set('notification_smtp_host', 'smtp.example.com');
    settings.set('notification_smtp_port', '587');
    settings.set('notification_smtp_username', '');
  });

  it('is not configured', async () => {
    expect(await new EmailDeliveryService().isConfigured()).toBe(false);
  });

  it('refuses a send at once, without retrying or connecting', async () => {
    const service = new EmailDeliveryService();
    const sleep = vi.spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(undefined);

    const err = await service.sendEmailWithRetry('to@example.com', 'Subject', '<p>hi</p>', 'hi', 3).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SmtpNotConfiguredError);
    expect(mailFailureReason(err)).toBe(
      "Email isn't set up yet: enter the SMTP username in the Email Notifications settings."
    );
    expect(sleep).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('with a username too but no password: not configured, and a send says to enter the password', async () => {
    settings.set('notification_smtp_username', 'someone@example.com');
    const service = new EmailDeliveryService();
    const sleep = vi.spyOn(service as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(undefined);

    expect(await service.isConfigured()).toBe(false);
    const err = await service.sendEmailWithRetry('to@example.com', 'Subject', '<p>hi</p>', 'hi', 3).catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 503, code: 'SMTP_NOT_CONFIGURED' });
    expect(mailFailureReason(err)).toBe("Email isn't set up yet: enter the SMTP password in the Email Notifications settings.");
    expect(sleep).not.toHaveBeenCalled();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });
});
