import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { defaultNotificationRules, notificationRulesSchema } from '@nuggets/shared';
import { withTenant, getDb } from '../../../db/withTenant.js';
import { NotificationRulesEngine } from '../../../services/NotificationRulesEngine.js';
import { NotificationQueueService } from '../../../services/NotificationQueueService.js';
import { EmailTemplateService } from '../../../services/EmailTemplateService.js';
import { NotificationRuleService } from '../../../services/notifications/NotificationRuleService.js';
import { addDays } from '../../../services/notifications/schedule.js';
import { appDateOf } from '../../../utils/appDate.js';
import net, { type AddressInfo } from 'net';
import nodemailer, { type Transporter } from 'nodemailer';
import { EmailDeliveryService, isPermanentMailError } from '../../../services/EmailDeliveryService.js';
import type { PushNotificationService } from '../../../services/PushNotificationService.js';
import { createTestTenant, type TestTenant } from '../../../test/testTenant.js';
import { fixtureAccountId } from '../../../test/fixtureAccount.js';

/**
 * A notification whose email the mail server refused for good (a bad address, a mailbox
 * that doesn't exist: isPermanentMailError) fails at once. The queue asked only
 * whether attempts were left, so it sent it again on each of the next passes, to the same
 * refusal. A failure that may pass (the server unreachable) is still retried.
 */
describe('A permanent email refusal is not retried', () => {
  const now = new Date();
  let tenant: TestTenant;
  const ruleService = new NotificationRuleService(async () => 'a-test-secret-that-is-at-least-32-chars');
  const push = { sendToUser: vi.fn().mockResolvedValue({ sent: 0, failed: 0, removed: 0 }) };
  const email = { isConfigured: vi.fn().mockResolvedValue(true), sendEmailWithRetry: vi.fn() };
  const engine = new NotificationRulesEngine(
    new NotificationQueueService(),
    new EmailTemplateService(),
    email as unknown as EmailDeliveryService,
    push as unknown as PushNotificationService,
    ruleService
  );
  const row = async () =>
    (
      await tenant.pool.query<{ status: string; retry_count: number; max_retries: number; error_message: string | null }>(
        'SELECT status, retry_count, max_retries, error_message FROM notifications'
      )
    ).rows;

  /** nodemailer's error for a recipient the server refused (SMTPConnection's _formatError). */
  const refusedRecipient = () =>
    Object.assign(new Error("Can't send mail - all recipients were rejected: 550 5.1.1 <someone@example.org>: User unknown"), {
      code: 'EENVELOPE',
      responseCode: 550,
      command: 'RCPT TO',
    });
  const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:587'), { code: 'ECONNECTION' });

  beforeAll(async () => {
    tenant = await createTestTenant('Permanent email refusal');
    await withTenant(tenant.tenantId, async () => {
      const db = getDb();
      // The engine's day at `now`, in the ledger's time zone as the engine reads it.
      const today = await appDateOf(now);
      const period = await db
        .insertInto('budget_period')
        .values({ name: `Refusal ${Date.now()}`, month: 'Test', year: 2026, month_number: 1, start_date: addDays(today, -9), end_date: addDays(today, 20) })
        .returning('id')
        .executeTakeFirstOrThrow();
      const item = await db.insertInto('budget_items').values({ name: 'Groceries', expense_type: 'Expense', type: 'Monthly' }).returning('id').executeTakeFirstOrThrow();
      const pi = await db.insertInto('budget_period_items').values({ budget_period_id: period.id, budget_item_id: item.id }).returning('id').executeTakeFirstOrThrow();
      await db
        .insertInto('budget_period_transactions')
        .values({ budget_period_item_id: pi.id, budget_item_id: item.id, transaction_type: 'add', type: 'budget_update', amount: '500.00' })
        .execute();
      await db
        .insertInto('transactions')
        .values({ account_id: await fixtureAccountId(db), type: 'expense', amount: '-650.00', transaction_date: today, budget_item_id: item.id, budget_period_id: period.id, budget_period_item_id: pi.id, review_status: 'reviewed' })
        .execute();
      await ruleService.saveRules(
        notificationRulesSchema.parse({ rules: defaultNotificationRules.rules.filter((r) => r.key === 'over_budget') }),
        tenant.userId
      );
    });
    expect(await withTenant(tenant.tenantId, () => engine.queueDueNotifications(now))).toBe(1);
  });

  beforeEach(async () => {
    await tenant.pool.query("UPDATE notifications SET status = 'pending', retry_count = 0, error_message = NULL, last_attempt_at = NULL, scheduled_for = now() - interval '1 minute'");
    email.sendEmailWithRetry.mockReset();
  });

  afterAll(async () => {
    await tenant?.cleanup();
  });

  it('knows a refused recipient from a server it could not reach', () => {
    expect(isPermanentMailError(refusedRecipient())).toBe(true);
    expect(isPermanentMailError(Object.assign(new Error('x'), { response: '550 Mailbox unavailable' }))).toBe(true);
    expect(isPermanentMailError(unreachable())).toBe(false);
  });

  // No code means no reply only when nodemailer refused the address itself (no response at all):
  // a server that answered something that isn't SMTP may answer properly next time.
  it('retries a reply it can read no code from, and fails only a refusal with no reply at all', () => {
    const envelope = (fields: Record<string, unknown>) => Object.assign(new Error('x'), { code: 'EENVELOPE', ...fields });
    expect(isPermanentMailError(envelope({ response: 'hello this is not smtp', command: 'RCPT TO' }))).toBe(false);
    expect(isPermanentMailError(envelope({ command: 'API' }))).toBe(true);
  });

  it('fails a notification whose recipient the mail server refused, with its attempts left', async () => {
    email.sendEmailWithRetry.mockRejectedValue(refusedRecipient());
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 0, failed: 1 });
    const [notification] = await row();
    expect(notification.retry_count).toBeLessThan(notification.max_retries);
    expect(notification).toMatchObject({ status: 'failed', error_message: 'The mail server refused the recipient address' });

    // Nothing is sent again on the next pass.
    await engine.processNotificationQueue(tenant.tenantId, now);
    expect(email.sendEmailWithRetry).toHaveBeenCalledTimes(1);
  });

  it('retries one whose push a device refused for now, whatever the email said', async () => {
    push.sendToUser.mockResolvedValueOnce({ sent: 0, failed: 1, removed: 0 });
    email.sendEmailWithRetry.mockRejectedValue(refusedRecipient());
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, failed: 1 });
    expect(await row()).toEqual([
      expect.objectContaining({ status: 'pending', retry_count: 1, error_message: 'The mail server refused the recipient address' }),
    ]);
  });

  it('still retries one the mail server could not be reached for', async () => {
    email.sendEmailWithRetry.mockRejectedValue(unreachable());
    expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, failed: 1 });
    expect(await row()).toEqual([expect.objectContaining({ status: 'pending', retry_count: 1 })]);
  });

  /**
   * The errors nodemailer itself gives, from an SMTP server on a socket here. nodemailer
   * calls any refusal at MAIL FROM, RCPT TO or DATA `EENVELOPE`, and any after the body
   * `EMESSAGE`, 4xx (try again later: greylisting, throttling) as much as 5xx; RFC 5321
   * words a 450 "mailbox unavailable" too. Only a 5xx is permanent.
   */
  describe('with real nodemailer and a mail server that answers as told', () => {
    let smtp: FakeSmtpServer;
    let transport: Transporter;
    const send = async (to: string, subject: string, html: string, text: string) =>
      (await transport.sendMail({ from: 'nuggets@fake.test', to, subject, html, text })).messageId;

    beforeAll(async () => {
      smtp = await fakeSmtpServer();
      transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtp.port, secure: false, ignoreTLS: true, connectionTimeout: 5000 });
    });

    afterAll(async () => {
      transport?.close();
      await smtp?.close();
    });

    const replies: Array<[string, Replies, 'pending' | 'failed']> = [
      ['451 Greylisted at RCPT TO', { rcpt: '451 4.7.1 Greylisted, try again later' }, 'pending'],
      ['450 mailbox unavailable at RCPT TO', { rcpt: '450 4.2.1 Mailbox unavailable, try again later' }, 'pending'],
      ['454 Throttling after DATA', { afterData: '454 4.7.0 Throttling: too many messages' }, 'pending'],
      ['451 local error after DATA', { afterData: '451 4.3.0 Local error in processing' }, 'pending'],
      ['550 user unknown at RCPT TO', { rcpt: '550 5.1.1 <someone@fake.test>: Recipient address rejected: User unknown' }, 'failed'],
      ['554 rejected after DATA', { afterData: '554 5.7.1 Message rejected as spam' }, 'failed'],
    ];

    it.each(replies)('a %s (%j) leaves the notification %s', async (_reply, answers, status) => {
      smtp.answer(answers);
      email.sendEmailWithRetry.mockImplementation(send);
      expect(await engine.processNotificationQueue(tenant.tenantId, now)).toMatchObject({ processed: 1, sent: 0, failed: 1 });
      const [notification] = await row();
      expect(notification).toMatchObject({ status, retry_count: 1 });
      expect(notification.retry_count).toBeLessThan(notification.max_retries);
    });

    it('sends again on its own retries after a 4xx, and stops at a 5xx (sendEmailWithRetry)', async () => {
      const service = new EmailDeliveryService();
      const attempts = vi.spyOn(service, 'sendEmail').mockImplementation((to, subject, html, text) => send(to, subject, html, text));
      vi.spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();

      smtp.answer({ rcpt: '451 4.7.1 Greylisted, try again later' });
      await expect(service.sendEmailWithRetry('someone@fake.test', 'Hi', '<p>hi</p>', 'hi', 2)).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 451 });
      expect(attempts).toHaveBeenCalledTimes(3);

      attempts.mockClear();
      smtp.answer({ rcpt: '550 5.1.1 User unknown' });
      await expect(service.sendEmailWithRetry('someone@fake.test', 'Hi', '<p>hi</p>', 'hi', 2)).rejects.toMatchObject({ code: 'EENVELOPE', responseCode: 550 });
      expect(attempts).toHaveBeenCalledTimes(1);

      smtp.answer({ afterData: '250 2.0.0 queued' });
      await expect(service.sendEmailWithRetry('someone@fake.test', 'Hi', '<p>hi</p>', 'hi', 2)).resolves.toEqual(expect.any(String));
    });

    it("still counts nodemailer's own refusal of an address, with no reply from the server, as permanent", async () => {
      const refused = await transport.sendMail({ from: 'nuggets@fake.test', to: 'not an address', text: 'x' }).catch((err: unknown) => err);
      expect(refused).toMatchObject({ code: 'EENVELOPE' });
      expect((refused as { responseCode?: unknown }).responseCode).toBeUndefined();
      expect(isPermanentMailError(refused)).toBe(true);
    });
  });
});

interface Replies {
  /** The answer to RCPT TO (250 when not given). */
  rcpt?: string;
  /** The answer once the message has been sent (250 when not given). */
  afterData?: string;
}

interface FakeSmtpServer {
  port: number;
  /** How the server answers from now on. */
  answer(replies: Replies): void;
  close(): Promise<void>;
}

/** An SMTP server on a local port that speaks just enough for nodemailer, answering as told. */
async function fakeSmtpServer(): Promise<FakeSmtpServer> {
  let replies: Replies = {};
  const server = net.createServer((socket) => {
    let buffer = '';
    let inData = false;
    const say = (line: string) => socket.write(`${line}\r\n`);
    socket.on('error', () => {});
    say('220 fake.test ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          buffer = buffer.slice(end + 5);
          inData = false;
          say(replies.afterData ?? '250 2.0.0 queued as FAKE');
          continue;
        }
        const lineEnd = buffer.indexOf('\r\n');
        if (lineEnd === -1) return;
        const verb = buffer.slice(0, 4).toUpperCase();
        buffer = buffer.slice(lineEnd + 2);
        if (verb === 'EHLO') {
          say('250-fake.test');
          say('250 8BITMIME');
        } else if (verb === 'HELO' || verb === 'MAIL' || verb === 'RSET' || verb === 'NOOP') {
          say('250 2.0.0 OK');
        } else if (verb === 'RCPT') {
          say(replies.rcpt ?? '250 2.1.5 OK');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          say('221 2.0.0 Bye');
          socket.end();
        } else {
          say('502 5.5.2 Command not recognized');
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    answer: (next) => {
      replies = next;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
