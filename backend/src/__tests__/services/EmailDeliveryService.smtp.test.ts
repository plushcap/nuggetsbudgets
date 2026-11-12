import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';

/**
 * EmailDeliveryService through the real nodemailer, to an SMTP server this file runs
 * (fakeSmtpServer.ts, on node:net and node:tls), with no database: the SMTP settings come
 * from an in-memory system_settings (written for a dependency upgrade). The
 * other email tests mock nodemailer away, so a minor release that changed how it
 * negotiates STARTTLS, signs in or writes the envelope would pass them.
 *
 * - A server that requires STARTTLS and offers AUTH only after it: the message arrives
 *   with the right envelope and headers, and the password goes only over TLS.
 * - A server with no STARTTLS (AUTH offered in the clear, as a downgraded one would): the
 *   send is refused before any password or message is sent (requireTLS).
 * - A STARTTLS server with a certificate the client doesn't trust: refused the same way.
 *
 * The password is saved as the Email Notifications page saves it, encrypted with a data
 * encryption key of this file's own (DATA_ENCRYPTION_KEY_FILE), and the service decrypts it.
 */
const { settings, previousEnv } = vi.hoisted(() => {
  const previousEnv = { DATA_ENCRYPTION_KEY_FILE: process.env.DATA_ENCRYPTION_KEY_FILE };
  process.env.LOG_LEVEL ??= 'silent';
  return { settings: new Map<string, string>(), previousEnv };
});

// system_settings, in memory: a query gets the rows of the keys it names that are set.
vi.mock('../../db/withTenant.js', async () => {
  const { Kysely, PostgresDialect } = await import('kysely');
  const query = async (sql: string, params: unknown[] = []) => {
    if (!/from "system_settings"/.test(sql)) throw new Error(`Unexpected query in the SMTP test: ${sql}`);
    const rows = params
      .filter((p): p is string => typeof p === 'string' && settings.has(p))
      .map((key) => ({ setting_key: key, setting_value: settings.get(key) }));
    return { command: 'SELECT', rowCount: rows.length, rows };
  };
  const pool = { connect: async () => ({ query, release: () => undefined }), end: async () => undefined };
  const db = new Kysely({ dialect: new PostgresDialect({ pool: pool as never }) });
  return { globalDb: db, currentDbOrGlobal: () => db };
});

import tls from 'tls';
import { randomBytes } from 'crypto';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { EmailDeliveryService, mailFailureReason } from '../../services/EmailDeliveryService.js';
import { EncryptionService } from '../../services/EncryptionService.js';
import { errorCode } from '../../utils/errors.js';
import { startFakeSmtpServer, selfSignedLocalhostCertificate, type FakeSmtpServer } from './fakeSmtpServer.js';

const PASSWORD = 'smtp-pass-only-over-tls-kq7';
const USERNAME = 'smtp-user@example.test';
const FROM_ADDRESS = 'notifications@example.test';
// A quote and an address in the display name: it must stay a name.
const FROM_NAME = 'Nuggets "Family" <alerts@attacker.test>';

/** The password as stored: encrypted with the data encryption key (beforeAll). */
let sealedPassword: string;

function configure(port: number) {
  settings.clear();
  // The address the server listens on (its certificate names it), not a name that could resolve to ::1.
  settings.set('notification_smtp_host', '127.0.0.1');
  settings.set('notification_smtp_port', String(port));
  settings.set('notification_smtp_username', USERNAME);
  settings.set('notification_smtp_password', sealedPassword);
  settings.set('notification_email_from_address', FROM_ADDRESS);
  settings.set('notification_email_from_name', FROM_NAME);
}

/** Close the service's pooled transport (sends QUIT), so no connection outlives a test. */
function closeTransport(service: EmailDeliveryService) {
  (service as unknown as { transporter: { close(): void } | null }).transporter?.close();
}

describe('EmailDeliveryService over SMTP (real nodemailer, fake server)', () => {
  let defaultCAs: string[];
  let certificate: { key: string; cert: string };
  let keyDir: string;
  const servers: FakeSmtpServer[] = [];
  const services: EmailDeliveryService[] = [];

  beforeAll(async () => {
    keyDir = await mkdtemp(path.join(os.tmpdir(), 'smtp-test-key-'));
    const keyFile = path.join(keyDir, 'data_encryption_key');
    const key = randomBytes(32).toString('base64');
    await writeFile(keyFile, key);
    process.env.DATA_ENCRYPTION_KEY_FILE = keyFile;
    sealedPassword = await EncryptionService.withSecret(key).encryptString(PASSWORD);
    expect(sealedPassword).not.toContain(PASSWORD);
    certificate = selfSignedLocalhostCertificate();
    // Trust the throwaway certificate for this file's connections, so the client checks the
    // server's certificate as it does in production (rejectUnauthorized stays on).
    defaultCAs = tls.getCACertificates('default');
    tls.setDefaultCACertificates([...defaultCAs, certificate.cert]);
  });

  afterEach(async () => {
    services.splice(0).forEach(closeTransport);
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  afterAll(async () => {
    tls.setDefaultCACertificates(defaultCAs);
    for (const [name, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(keyDir, { recursive: true, force: true });
  });

  async function serverAndService(startTls: boolean, cert = certificate) {
    const server = await startFakeSmtpServer(startTls ? { startTls, ...cert } : { startTls });
    servers.push(server);
    configure(server.port);
    const service = new EmailDeliveryService();
    services.push(service);
    return { server, service };
  }

  it('upgrades with STARTTLS before signing in, and delivers the message with its envelope and headers', async () => {
    const { server, service } = await serverAndService(true);

    const messageId = await service.sendEmail(
      'member@example.test',
      'Your weekly summary',
      '<p>Groceries are <strong>on track</strong>.</p>',
      'Groceries are on track.',
      { 'List-Unsubscribe': '<https://nuggets.example.test/settings/notifications>' }
    );

    // Before TLS the client said hello and asked for TLS, nothing else.
    expect(server.commands.filter((c) => !c.tls).map((c) => c.line.split(' ')[0].toUpperCase())).toEqual([
      'EHLO',
      'STARTTLS',
    ]);
    expect(server.cleartext()).not.toContain(Buffer.from(`\u0000${USERNAME}\u0000${PASSWORD}`).toString('base64'));
    expect(server.cleartext()).not.toContain(PASSWORD);
    // Then, encrypted: hello again, sign in with the configured account, send.
    expect(server.commands.filter((c) => c.tls).map((c) => c.line.split(' ')[0].toUpperCase())).toEqual([
      'EHLO',
      'AUTH',
      'MAIL',
      'RCPT',
      'DATA',
    ]);
    expect(server.auths).toEqual([{ user: USERNAME, pass: PASSWORD, tls: true }]);

    expect(server.messages).toHaveLength(1);
    const [message] = server.messages;
    expect(message).toMatchObject({
      mailFrom: FROM_ADDRESS,
      rcptTo: ['member@example.test'],
      tls: true,
      authUser: USERNAME,
    });
    expect(['TLSv1.2', 'TLSv1.3']).toContain(message.tlsProtocol);

    const { headers } = message;
    // The display name is quoted, so the only address in From is the configured one.
    expect(headers.from).toBe('"Nuggets \\"Family\\" <alerts@attacker.test>" <notifications@example.test>');
    expect(headers.to).toBe('member@example.test');
    expect(headers.subject).toBe('Your weekly summary');
    expect(headers['list-unsubscribe']).toBe('<https://nuggets.example.test/settings/notifications>');
    expect(headers['message-id']).toBe(messageId);
    expect(headers['mime-version']).toBe('1.0');
    expect(headers['content-type']).toMatch(/^multipart\/alternative;\s*boundary=/);
    expect(message.body).toMatch(/Content-Type: text\/plain[\s\S]*Groceries are on track\./);
    expect(message.body).toMatch(/Content-Type: text\/html[\s\S]*<strong>on track<\/strong>/);
  });

  it('refuses a server without STARTTLS before sending the password or the message', async () => {
    const { server, service } = await serverAndService(false);

    const failure = await service.sendEmail('member@example.test', 'Not over plaintext', '<p>x</p>', 'x').then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(Error);
    expect(errorCode(failure)).toBe('ETLS');
    // What a member or admin is told names what to check, not the server's reply.
    expect(mailFailureReason(failure)).toBe("Couldn't connect to the mail server: check the SMTP host and port");
    // The client asked for TLS (the server didn't offer it), was refused, and stopped.
    const verbs = server.commands.map((c) => c.line.split(' ')[0].toUpperCase());
    expect(verbs.slice(0, 2)).toEqual(['EHLO', 'STARTTLS']);
    expect(verbs).not.toContain('AUTH');
    expect(verbs).not.toContain('MAIL');
    expect(server.auths).toEqual([]);
    expect(server.messages).toEqual([]);
    expect(server.cleartext()).not.toContain(Buffer.from(`\u0000${USERNAME}\u0000${PASSWORD}`).toString('base64'));
  });

  it("refuses a STARTTLS server whose certificate it doesn't trust, before signing in", async () => {
    // Someone in the middle answering with a certificate of their own.
    const { server, service } = await serverAndService(true, selfSignedLocalhostCertificate());

    const failure = await service.sendEmail('member@example.test', 'Not to an impostor', '<p>x</p>', 'x').then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(Error);
    // nodemailer reports a certificate it can't verify as a socket error.
    expect((failure as Error).message).toMatch(/certificate/i);
    expect(mailFailureReason(failure)).toBe("Couldn't connect to the mail server: check the SMTP host and port");
    expect(server.commands.map((c) => c.line.split(' ')[0].toUpperCase())).toEqual(['EHLO', 'STARTTLS']);
    expect(server.auths).toEqual([]);
    expect(server.messages).toEqual([]);
  });
});
