import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Pool } from 'pg';
import { Kysely, PostgresDialect } from 'kysely';

/**
 * What sending an email logs: the message id and the recipient masked, never
 * the subject (a notification's names an amount and a merchant: "A large purchase: $45.67
 * at Sample Wholesale"); and a failure as nodemailer's code, the SMTP command, and the reply's code and
 * enhanced status, never the reply's text or the error's message, which quote the
 * recipient's address. Every line the service logs is captured as JSON.
 */

const state = vi.hoisted(() => ({ lines: [] as string[] }));
const sendMail = vi.hoisted(() => vi.fn());

vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>();
  const { default: pino } = await import('pino');
  const capture = pino(
    { level: 'trace', redact: { paths: actual.REDACT_PATHS, censor: '[REDACTED]' } },
    { write: (line: string) => void state.lines.push(line) }
  );
  return { ...actual, createLogger: (context: Record<string, unknown>) => capture.child(context) };
});

const { settingsPool } = vi.hoisted(() => {
  const rows = [
    { setting_key: 'notification_smtp_host', setting_value: 'smtp.example.com' },
    { setting_key: 'notification_smtp_port', setting_value: '587' },
    { setting_key: 'notification_smtp_username', setting_value: 'user@example.com' },
    { setting_key: 'notification_email_from_address', setting_value: 'from@example.com' },
  ];
  const query = vi.fn().mockImplementation((_sql: string, params?: unknown[]) =>
    Promise.resolve({
      rows: Array.isArray(params) && params.includes('notification_smtp_password') ? [{ setting_value: 'sealed-smtp-password' }] : rows,
    })
  );
  return { settingsPool: { query, connect: vi.fn(async () => ({ query, release: () => {} })) } };
});

vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => ({ sendMail, close: vi.fn() })) } }));
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

import { EmailDeliveryService, mailErrorFields } from '../../services/EmailDeliveryService.js';

const TO = 'ann.real@example.org';
const SUBJECT = 'A large purchase: $45.67 at Sample Wholesale';
const REPLY = `550 5.1.1 <${TO}>: Recipient address rejected: User unknown in virtual mailbox table`;

/** nodemailer's error for a recipient the server refused (SMTPConnection's _formatError). */
function refused(): Error {
  return Object.assign(new Error(`Can't send mail - all recipients were rejected: ${REPLY}`), {
    code: 'EENVELOPE',
    response: REPLY,
    responseCode: 550,
    command: 'RCPT TO',
    rejected: [TO],
  });
}

const logged = () => state.lines.join('\n');
const said = (msg: string) => state.lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg);

describe('what sending an email logs', () => {
  beforeEach(() => {
    state.lines.length = 0;
    sendMail.mockReset();
  });

  it('a sent email: its message id and the recipient masked, not the subject', async () => {
    sendMail.mockResolvedValue({ messageId: '<msg-1@example.com>' });
    await new EmailDeliveryService().sendEmail(TO, SUBJECT, '<p>hi</p>', 'hi');

    expect(said('Email sent successfully')).toEqual([expect.objectContaining({ messageId: '<msg-1@example.com>', recipient: 'a…@example.org' })]);
    expect(logged()).not.toContain('45.67');
    expect(logged()).not.toContain('Sample Wholesale');
    expect(logged()).not.toContain(TO);
  });

  it("a refused recipient: the reply's codes, not its text, the address or the subject", async () => {
    const service = new EmailDeliveryService();
    vi.spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(undefined);
    sendMail.mockRejectedValue(refused());

    await expect(service.sendEmailWithRetry(TO, SUBJECT, '<p>hi</p>', 'hi', 3)).rejects.toThrow('all recipients were rejected');

    const [failed] = said('Failed to send email');
    expect(failed).toMatchObject({
      mailError: { name: 'Error', code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, enhancedStatus: '5.1.1' },
      recipient: 'a…@example.org',
    });
    expect(failed).not.toHaveProperty('err');
    expect(said('Permanent error - not retrying')).toHaveLength(1);
    for (const text of [TO, 'Recipient address rejected', 'User unknown', '45.67', 'Sample Wholesale']) {
      expect(logged(), text).not.toContain(text);
    }
  });

  it("a failure it retries, and the last one: the same codes, never the mailer's message", async () => {
    const service = new EmailDeliveryService();
    vi.spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(undefined);
    const busy = `451 4.7.1 <${TO}>: Recipient address rejected: try again later`;
    sendMail.mockRejectedValue(Object.assign(new Error(`Message failed: ${busy}`), { code: 'EMESSAGE_TEMP', response: busy, command: 'DATA' }));

    await expect(service.sendEmailWithRetry(TO, SUBJECT, '<p>hi</p>', 'hi', 2)).rejects.toThrow('Message failed');

    expect(said('Email send failed - retrying after delay')).toHaveLength(2);
    expect(said('Email send failed after all retries')[0]).toMatchObject({
      mailError: { code: 'EMESSAGE_TEMP', command: 'DATA', responseCode: 451, enhancedStatus: '4.7.1' },
    });
    for (const text of [TO, 'try again later', 'Message failed']) {
      expect(logged(), text).not.toContain(text);
    }
  });

  it("logs the app's own refusals and anything that isn't the mailer's whole", () => {
    const own = new Error('decryption failed');
    expect(mailErrorFields(own)).toEqual({ err: own });
    const database = Object.assign(new Error('connection terminated'), { code: '57P01' });
    expect(mailErrorFields(database)).toEqual({ err: database });
    // A network failure is the mailer's: its code says it, and its message names hosts.
    expect(mailErrorFields(Object.assign(new Error('getaddrinfo ENOTFOUND smtp.internal'), { code: 'EDNS' })))
      .toEqual({ mailError: { name: 'Error', code: 'EDNS' } });
  });
});
