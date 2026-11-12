import { globalDb, runDetached } from '../db/withTenant.js';
import { createLogger } from '../utils/logger.js';
import { config } from '../config.js';
import { EmailDeliveryService, mailErrorFields } from './EmailDeliveryService.js';
import { PushNotificationService } from './PushNotificationService.js';

const logger = createLogger({ service: 'CredentialNotices' });

/**
 * Telling someone that a way into their account was added: a passkey,
 * or an MCP personal access token. A session someone else holds for a few minutes (a
 * stolen cookie, an unattended browser) can add either after re-authenticating, and
 * either outlives the session; the notice is how the owner hears of it.
 *
 * It goes by email when SMTP is configured, else by push to the person's devices that
 * subscribed, and is logged when neither can carry it: the app has no in-app inbox, and
 * the credential itself is listed where it is managed (Profile → Passkeys, Settings →
 * MCP Access). The ledger notification queue can't carry it: that is per ledger, and
 * sends only what an enabled rule and the member's choice of channel allow.
 *
 * Sent after the credential's write has committed, detached from the request (it neither
 * delays nor fails the answer), with no transaction open while the mail server or push
 * service answers. Best effort: a notice in flight when the server stops is lost.
 */
export type CredentialKind = 'passkey' | 'mcp_token';

export interface CredentialAdded {
  kind: CredentialKind;
  /** The name it was given (a passkey's device name, a token's label), if any. */
  name?: string | null;
  at?: Date;
}

export type NoticeChannel = 'email' | 'push' | 'none';

interface Recipient {
  email: string;
  firstName: string | null;
}

export interface NoticeDeps {
  recipient(userId: number): Promise<Recipient | undefined>;
  emailConfigured(): Promise<boolean>;
  sendEmail(to: string, subject: string, html: string, text: string): Promise<unknown>;
  sendPush(userId: number, message: { title: string; body: string; url: string; tag: string }): Promise<{ sent: number }>;
}

// Built when first used: the push service reads the data encryption key, which a server
// may run without (OneDrive and push then answer 503 when used).
let email: EmailDeliveryService | undefined;
let push: PushNotificationService | undefined;

const defaultDeps: NoticeDeps = {
  recipient: (userId) =>
    globalDb
      .selectFrom('users')
      .select(['email', 'first_name as firstName'])
      .where('id', '=', userId)
      .executeTakeFirst(),
  emailConfigured: () => (email ??= new EmailDeliveryService()).isConfigured(),
  sendEmail: (to, subject, html, text) => (email ??= new EmailDeliveryService()).sendEmailWithRetry(to, subject, html, text, 2),
  sendPush: (userId, message) => (push ??= new PushNotificationService()).sendToUser(userId, message),
};

/** The app's address, as the notification emails link to it. */
function appUrl(): string {
  return (config().CLIENT_URL || config().DOMAIN_URL || 'http://localhost:3000').replace(/\/$/, '');
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The notice's words: the same for email and push. */
export function credentialNoticeContent(notice: CredentialAdded, firstName: string | null) {
  const what = notice.kind === 'passkey' ? 'passkey' : 'MCP access token';
  const where = notice.kind === 'passkey' ? 'Profile → Passkeys' : 'Settings → MCP Access';
  const path = notice.kind === 'passkey' ? '/profile' : '/settings/mcp';
  // A name the user typed, cut short: it is shown, never interpreted.
  const name = notice.name?.trim() ? `“${notice.name.trim().slice(0, 100)}”` : null;
  const at = (notice.at ?? new Date()).toISOString().replace('T', ' ').slice(0, 16);
  const subject = notice.kind === 'passkey' ? 'A passkey was added to your Nuggets account' : 'An MCP access token was created for your Nuggets account';
  const lines = [
    `${firstName ? `Hi ${firstName}, a` : 'A'} new ${what}${name ? ` named ${name}` : ''} was added to your Nuggets account on ${at} UTC.`,
    `If that was you, there is nothing to do. If it wasn't, remove it in ${where}, and change your password.`,
  ];
  return { subject, lines, path, url: `${appUrl()}${path}` };
}

async function send(userId: number, notice: CredentialAdded, deps: NoticeDeps): Promise<NoticeChannel> {
  const recipient = await deps.recipient(userId);
  if (!recipient) return 'none';
  const content = credentialNoticeContent(notice, recipient.firstName);

  if (await deps.emailConfigured()) {
    try {
      const html =
        content.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n') +
        `\n<p><a href="${escapeHtml(content.url)}">${escapeHtml(content.url)}</a></p>`;
      await deps.sendEmail(recipient.email, content.subject, html, `${content.lines.join('\n\n')}\n\n${content.url}\n`);
      return 'email';
    } catch (err) {
      logger.warn({ ...mailErrorFields(err), userId, kind: notice.kind }, 'Could not email the new-credential notice; trying push');
    }
  }
  const pushed = await deps.sendPush(userId, {
    title: content.subject,
    body: content.lines.join(' '),
    url: content.path,
    tag: `credential-added:${notice.kind}`,
  });
  if (pushed.sent > 0) return 'push';
  logger.warn({ userId, kind: notice.kind }, 'No channel could carry the new-credential notice (no SMTP, no push subscription)');
  return 'none';
}

/**
 * Tell `userId` that `notice`'s credential was added to their account. Call it once the
 * credential is saved; it returns at once, and the notice goes in the background. The
 * promise (for tests) resolves with the channel it went by, and never rejects.
 */
export function noticeCredentialAdded(userId: number, notice: CredentialAdded, deps: NoticeDeps = defaultDeps): Promise<NoticeChannel> {
  return runDetached(() =>
    send(userId, notice, deps).catch((err) => {
      logger.error({ err, userId, kind: notice.kind }, 'Could not send the new-credential notice');
      return 'none' as const;
    })
  );
}
