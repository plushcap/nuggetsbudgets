import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

/**
 * Unit tests for EmailDeliveryService.
 *
 * nodemailer and the stored SMTP password's decryption are mocked, so these exercise
 * the send + retry logic without a real SMTP server. This also guards the
 * nodemailer 8 upgrade (the createTransport/sendMail surface we rely on).
 */

// Shared sendMail spy so each test can configure its behavior.
const sendMailMock = vi.fn();

// Mock pool returning the SMTP settings rows. Hoisted so the vi.mock factory
// below can reference it. Kysely acquires a client via pool.connect() and runs
// client.query(sql, params); expose the same query fn on both the pool and the
// checked-out client.
const { settingsPool } = vi.hoisted(() => {
  const settingsRows = [
    { setting_key: 'notification_smtp_host', setting_value: 'smtp.example.com' },
    { setting_key: 'notification_smtp_port', setting_value: '587' },
    { setting_key: 'notification_smtp_username', setting_value: 'user@example.com' },
    { setting_key: 'notification_email_from_address', setting_value: 'from@example.com' },
    { setting_key: 'notification_email_from_name', setting_value: 'Nuggets' },
  ];
  // The password lives under a separate key and is resolved via its own query: it is
  // stored sealed (EncryptionService, mocked below). Every other query gets the canned
  // SMTP settings rows.
  const query = vi.fn().mockImplementation((_sql: string, params?: unknown[]) => {
    if (Array.isArray(params) && params.includes('notification_smtp_password')) {
      return Promise.resolve({ rows: [{ setting_value: 'sealed-smtp-password' }] });
    }
    return Promise.resolve({ rows: settingsRows });
  });
  return {
    settingsPool: {
      query,
      connect: vi.fn(async () => ({ query, release: () => {} })),
    },
  };
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: sendMailMock,
      verify: vi.fn().mockResolvedValue(true),
    })),
  },
}));

// The stored password, sealed with the data encryption key; decrypting it gives this.
vi.mock('../../services/EncryptionService.js', () => ({
  EncryptionService: class {
    async decryptString(sealed: string) {
      if (sealed !== 'sealed-smtp-password') throw new Error('not sealed with this key');
      return 'test-password';
    }
  },
}));

// EmailDeliveryService reads SMTP settings through systemSettings.ts, on
// currentDbOrGlobal(). Back it with the mocked pool so getSMTPSettings resolves the
// canned rows above.
vi.mock('../../db/withTenant.js', () => {
  const db = new Kysely({ dialect: new PostgresDialect({ pool: settingsPool as unknown as Pool }) });
  return { globalDb: db, currentDbOrGlobal: () => db };
});

import nodemailer from 'nodemailer';
import { EmailDeliveryService } from '../../services/EmailDeliveryService.js';

describe('EmailDeliveryService', () => {
  beforeEach(() => {
    sendMailMock.mockReset();
  });

  it('sends an email with the configured from/to/subject/body and returns the messageId', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'msg-123' });
    const svc = new EmailDeliveryService();

    const id = await svc.sendEmail('to@example.com', 'Subj', '<p>hi</p>', 'hi');

    expect(id).toBe('msg-123');
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0];
    expect(mail).toMatchObject({
      to: 'to@example.com',
      subject: 'Subj',
      html: '<p>hi</p>',
      text: 'hi',
    });
    // An address object, which nodemailer quotes and encodes.
    expect(mail.from).toEqual({ name: 'Nuggets', address: 'from@example.com' });
  });

  it('requires TLS 1.2 or later before sending the SMTP password', async () => {
    sendMailMock.mockResolvedValue({ messageId: 'msg-tls' });
    await new EmailDeliveryService().sendEmail('to@example.com', 'Subj', '<p>hi</p>', 'hi');
    expect(vi.mocked(nodemailer.createTransport)).toHaveBeenLastCalledWith(
      expect.objectContaining({
        host: 'smtp.example.com', port: 587, secure: false, requireTLS: true,
        tls: expect.objectContaining({ minVersion: 'TLSv1.2' }),
        // The password saved in the app, decrypted.
        auth: { user: 'user@example.com', pass: 'test-password' },
      })
    );
  });

  it('retries a transient failure and then succeeds', async () => {
    const svc = new EmailDeliveryService();
    vi.spyOn(svc as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(undefined);

    const transient = Object.assign(new Error('connection reset'), { code: 'ETIMEDOUT' });
    sendMailMock.mockRejectedValueOnce(transient).mockResolvedValue({ messageId: 'ok-after-retry' });

    const id = await svc.sendEmailWithRetry('to@example.com', 'S', '<p>x</p>', 'x', 3);

    expect(id).toBe('ok-after-retry');
    expect(sendMailMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent (EENVELOPE) error', async () => {
    const svc = new EmailDeliveryService();
    const sleepSpy = vi
      .spyOn(svc as unknown as { sleep: () => Promise<void> }, 'sleep')
      .mockResolvedValue(undefined);

    const permanent = Object.assign(new Error('bad recipient'), { code: 'EENVELOPE' });
    sendMailMock.mockRejectedValue(permanent);

    await expect(svc.sendEmailWithRetry('bad@', 'S', '<p>x</p>', 'x', 3)).rejects.toThrow(
      'bad recipient'
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('gives up after exhausting retries on persistent transient failures', async () => {
    const svc = new EmailDeliveryService();
    vi.spyOn(svc as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(undefined);

    const transient = Object.assign(new Error('temporarily unavailable'), { code: 'ETIMEDOUT' });
    sendMailMock.mockRejectedValue(transient);

    await expect(svc.sendEmailWithRetry('to@example.com', 'S', '<p>x</p>', 'x', 2)).rejects.toThrow(
      'temporarily unavailable'
    );
    // initial attempt + 2 retries
    expect(sendMailMock).toHaveBeenCalledTimes(3);
  });
});
