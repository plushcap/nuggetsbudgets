import nodemailer, { Transporter } from 'nodemailer';
import { createHash } from 'crypto';
import { readSystemSetting, readSystemSettings } from './systemSettings.js';
import { EncryptionService } from './EncryptionService.js';
import { createLogger, maskEmail } from '../utils/logger.js';
import { errorCode } from '../utils/errors.js';
import { ControlPlaneError } from './controlPlaneErrors.js';

const logger = createLogger({ service: 'EmailDeliveryService' });

/** The last server response nodemailer puts on a failed send (SMTPError.response), if any. */
function smtpResponse(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('response' in error)) return undefined;
  return typeof error.response === 'string' ? error.response : undefined;
}

/**
 * A mail failure as a log line carries it: nodemailer's code (EAUTH,
 * EENVELOPE), the SMTP command, and the server's reply code and enhanced status (550,
 * 5.1.1). Never the reply's text, the error's message or its stack: they quote the
 * recipient's address and whatever the server said ("550 5.1.1 <ann@example.org>:
 * Recipient address rejected"). The app's own refusals (SMTP not set up, a push nothing
 * took) are written for people, and anything that isn't the mailer's is logged whole.
 */
export function mailErrorFields(error: unknown): { mailError: Record<string, string | number> } | { err: unknown } {
  if (error instanceof ControlPlaneError || typeof error !== 'object' || error === null) return { err: error };
  const code = errorCode(error);
  const reply = smtpResponse(error);
  const { responseCode, command } = error as { responseCode?: unknown; command?: unknown };
  if (!(code !== undefined && /^E[A-Z0-9_]+$/.test(code)) && reply === undefined && responseCode === undefined) {
    return { err: error };
  }
  const fields: Record<string, string | number> = { name: error instanceof Error ? error.name : 'Error' };
  if (code !== undefined) fields.code = code;
  // A command's name ("RCPT TO", "AUTH PLAIN"), never anything after it.
  if (typeof command === 'string' && /^[A-Z][A-Z ]{0,19}$/.test(command)) fields.command = command;
  const replied = replyCode(error);
  if (replied !== undefined && Number.isInteger(replied)) fields.responseCode = replied;
  const enhanced = reply?.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1];
  if (enhanced !== undefined) fields.enhancedStatus = enhanced;
  return { mailError: fields };
}

/**
 * SMTP isn't set up (no host, username or password): what to set, in words for the admin.
 * Permanent for a send (isPermanentMailError): nothing changes until someone sets it up.
 */
export class SmtpNotConfiguredError extends ControlPlaneError {
  constructor(message: string) {
    super(503, 'SMTP_NOT_CONFIGURED', message);
    this.name = 'SmtpNotConfiguredError';
  }
}

/**
 * Why an email couldn't be sent, in words safe to answer or store where members read it
 * (a test email's answer, a notification's error_message). A mailer's own message names
 * hosts, ports and the server's replies; this names only what to check. The log has the
 * full error.
 */
export function mailFailureReason(error: unknown): string {
  if (error instanceof ControlPlaneError) return error.message;
  switch (errorCode(error)) {
    case 'EAUTH':
    case 'ENOAUTH':
    case 'EOAUTH2':
      return 'The mail server refused the sign-in: check the SMTP username and password';
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
    case 'ENOTFOUND':
    case 'ETLS':
      return "Couldn't connect to the mail server: check the SMTP host and port";
    case 'EENVELOPE':
      return 'The mail server refused the recipient address';
    default:
      return 'The email could not be sent; the server log has the details';
  }
}

/**
 * The SMTP reply code of a failed send, 200 to 599: nodemailer's responseCode, else the reply's
 * first three digits. nodemailer takes the reply's leading digits as its code, so a reply that
 * starts with an enhanced status code alone ("5.1.1 User unknown") has responseCode 5, which
 * is no reply code.
 */
function replyCode(error: unknown): number | undefined {
  const { responseCode } = (typeof error === 'object' && error !== null ? error : {}) as { responseCode?: unknown };
  if (typeof responseCode === 'number' && Number.isInteger(responseCode) && responseCode >= 200 && responseCode <= 599) return responseCode;
  const digits = smtpResponse(error)?.match(/^\s*([2-5]\d\d)\b/)?.[1];
  return digits === undefined ? undefined : Number(digits);
}

/**
 * A reply that says the same message would be refused again: a 5xx (RFC 5321's permanent
 * negative completion). Not 503, a bad sequence of commands, which is the conversation's
 * fault rather than the message's (nodemailer's isPermanentResponseCode agrees).
 */
const isPermanentReply = (code: number): boolean => code >= 500 && code < 600 && code !== 503;

/**
 * Whether a failed send's reply says it would be refused again: its reply code
 * ({@link isPermanentReply}), or, a reply with no reply code but an enhanced status code
 * first, that code's class (RFC 3463: 5.X.X is a permanent failure, 4.X.X a transient one).
 * Undefined when the reply says neither (none, or one that isn't SMTP).
 */
function permanentReply(error: unknown): boolean | undefined {
  const code = replyCode(error);
  if (code !== undefined) return isPermanentReply(code);
  const enhancedClass = smtpResponse(error)?.match(/^\s*([245])\.\d{1,3}\.\d{1,3}\b/)?.[1];
  return enhancedClass === undefined ? undefined : enhancedClass === '5';
}

/**
 * Whether a failed send is permanent (not worth retrying): another attempt later would
 * fail the same way. sendEmailWithRetry stops at one, and the notification queue fails a
 * notification on one rather than send it again on its next passes.
 *
 * nodemailer calls any refusal at MAIL FROM, RCPT TO or DATA `EENVELOPE`, and any after the
 * message `EMESSAGE`, whatever the reply: a 4xx (greylisting, throttling, a full mailbox,
 * "try again later") as much as a 5xx. So those codes are permanent only with a 5xx reply,
 * or with no reply at all (nodemailer's own refusal of an address it can't send to), and
 * the reply's words count only in a 5xx: RFC 5321 words a 450 "mailbox unavailable" too.
 */
export function isPermanentMailError(error: unknown): boolean {
  // Nothing to send with until an admin sets SMTP up. A queued notification waits for
  // that, uncounted, and goes on the first pass after it (NotificationRulesEngine).
  if (error instanceof SmtpNotConfiguredError) {
    return true;
  }

  const permanent = permanentReply(error);
  const code = errorCode(error);
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    // No code: permanent only with no reply at all (nodemailer refusing the address itself);
    // a reply it can't read a code from (a server that isn't speaking SMTP) is tried again.
    if (permanent === undefined) return smtpResponse(error) === undefined;
    return permanent;
  }

  // The SMTP server's 5xx reply (SMTPError.response) saying the recipient can never be reached.
  const smtpReply = smtpResponse(error);
  if (smtpReply && permanent === true) {
    const response = smtpReply.toLowerCase();
    if (
      response.includes('address does not exist') ||
      response.includes('mailbox unavailable') ||
      response.includes('domain not found') ||
      response.includes('blacklisted')
    ) {
      return true;
    }
  }

  return false;
}

/**
 * EmailDeliveryService
 *
 * Sends email through the SMTP server the deployment admin sets up (nodemailer; any
 * provider that speaks SMTP).
 * - Reads SMTP configuration from system_settings
 * - Reads the SMTP password from the DB, where the Email Notifications page saves it
 *   encrypted
 * - Sends HTML + plain text emails
 * - Retry logic with exponential backoff, except for a permanent failure
 */

export class EmailDeliveryService {
  private transporter: Transporter | null = null;
  // Fingerprint of the auth the current transporter was built with, so a
  // host/port/username/password change (e.g. saved in the UI) rebuilds it on
  // the next send rather than sticking to stale credentials.
  private authFingerprint: string | null = null;

  /**
   * Resolve the SMTP password: the encrypted `notification_smtp_password` stored in
   * system_settings (set on the Email Notifications page, decrypted here). It is the only
   * place the password comes from: the `smtp_password` Docker secret and the SMTP_PASSWORD
   * variable aren't read (3.0.0), even where a stack still mounts the secret.
   */
  private async resolveSmtpPassword(): Promise<string> {
    const stored = await readSystemSetting('notification_smtp_password');
    if (stored) {
      return new EncryptionService().decryptString(stored);
    }

    throw new SmtpNotConfiguredError("Email isn't set up yet: enter the SMTP password in the Email Notifications settings.");
  }

  /**
   * Ensure a transporter exists and matches the current SMTP config. Rebuilds it
   * when the effective auth changed since it was last created.
   */
  private async ensureTransport(): Promise<void> {
    const settings = await this.getSMTPSettings();

    // What is missing, of what an admin enters: the port has a default (587).
    const missing = [!settings.host && 'host', !settings.username && 'username'].filter(Boolean);
    if (missing.length > 0) {
      throw new SmtpNotConfiguredError(
        `Email isn't set up yet: enter the SMTP ${missing.join(' and ')} in the Email Notifications settings.`
      );
    }

    const password = await this.resolveSmtpPassword();
    // Hash the password into the fingerprint so it's never held in plaintext
    // beyond the transporter itself.
    const fingerprint = createHash('sha256')
      .update(`${settings.host}|${settings.port}|${settings.username}|${password}`)
      .digest('hex');

    if (this.transporter && this.authFingerprint === fingerprint) {
      return;
    }

    if (this.transporter) {
      this.transporter.close();
    }

    this.transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.port === 465, // true for 465 (SSL), false for 587 (TLS)
      // On other ports, refuse to log in unless STARTTLS succeeds, so the SMTP password is
      // never sent in the clear. nodemailer otherwise carries on unencrypted.
      requireTLS: true,
      // And never over TLS older than 1.2, whatever Node's or OpenSSL's default.
      tls: { minVersion: 'TLSv1.2' },
      auth: {
        user: settings.username,
        pass: password,
      },
      // Without these a server that stops answering holds a send for minutes
      // (nodemailer's defaults are 2 min to connect and 10 min of socket idle).
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      // Connection pool settings
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
      rateDelta: 1000, // 1 second
      rateLimit: 10, // max 10 emails per second
    });
    this.authFingerprint = fingerprint;

    logger.info({
      host: settings.host,
      port: settings.port,
      username: settings.username.substring(0, 4) + '***',
      secure: settings.port === 465,
    }, 'SMTP transport initialized');
  }

  /**
   * Whether email can be sent at all: host, port, username and a password (saved in
   * the DB) are all set. Notification rules don't queue email for anyone while this is
   * false.
   */
  async isConfigured(): Promise<boolean> {
    const settings = await this.getSMTPSettings();
    if (!settings.host || !settings.username) return false;
    try {
      return (await this.resolveSmtpPassword()) !== '';
    } catch {
      return false;
    }
  }

  /**
   * Get SMTP settings from system_settings table
   */
  private async getSMTPSettings(): Promise<{
    host: string;
    port: number;
    username: string;
    fromAddress: string;
    fromName: string;
  }> {
    const settings = await readSystemSettings([
      'notification_smtp_host',
      'notification_smtp_port',
      'notification_smtp_username',
      'notification_email_from_address',
      'notification_email_from_name',
    ]);

    return {
      host: settings.notification_smtp_host || '',
      port: parseInt(settings.notification_smtp_port ?? '') || 587,
      username: settings.notification_smtp_username || '',
      fromAddress: settings.notification_email_from_address || 'notifications@nuggets.local',
      fromName: settings.notification_email_from_name || 'Nuggets Financial Tracker',
    };
  }

  /**
   * Send an email
   *
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param htmlBody - HTML email body
   * @param textBody - Plain text email body (fallback)
   * @param headers - Extra headers, e.g. List-Unsubscribe
   * @returns The Message-ID of the email sent (nodemailer's `info.messageId`)
   */
  async sendEmail(
    to: string,
    subject: string,
    htmlBody: string,
    textBody: string,
    headers?: Record<string, string>
  ): Promise<string> {
    // (Re)initialize transport if needed (e.g. credentials changed).
    await this.ensureTransport();

    const settings = await this.getSMTPSettings();

    try {
      const info = await this.transporter!.sendMail({
        // As an object, so nodemailer quotes and encodes the name: interpolated into a
        // string, a quote in the name could change the sending address.
        from: { name: settings.fromName, address: settings.fromAddress },
        to,
        subject,
        text: textBody,
        html: htmlBody,
        headers,
      });

      // Not the subject: a notification's names an amount and a merchant. The caller
      // logs which notification it was.
      logger.info({ messageId: info.messageId, recipient: maskEmail(to) }, 'Email sent successfully');

      return info.messageId;

    } catch (error) {
      logger.error({ ...mailErrorFields(error), recipient: maskEmail(to) }, 'Failed to send email');

      throw error;
    }
  }

  /**
   * Send email with retry logic
   *
   * @param to - Recipient email address
   * @param subject - Email subject
   * @param htmlBody - HTML email body
   * @param textBody - Plain text email body
   * @param maxRetries - Maximum number of retry attempts (default: 3)
   * @param headers - Extra headers, e.g. List-Unsubscribe
   * @returns The Message-ID of the email sent (nodemailer's `info.messageId`)
   */
  async sendEmailWithRetry(
    to: string,
    subject: string,
    htmlBody: string,
    textBody: string,
    maxRetries: number = 3,
    headers?: Record<string, string>
  ): Promise<string> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const messageId = await this.sendEmail(to, subject, htmlBody, textBody, headers);

        if (attempt > 0) {
          logger.info({ attempt, recipient: maskEmail(to) }, 'Email sent successfully after retry');
        }

        return messageId;

      } catch (error) {
        lastError = error;

        // Don't retry on permanent errors
        if (isPermanentMailError(error)) {
          logger.error({ ...mailErrorFields(error), recipient: maskEmail(to) }, 'Permanent error - not retrying');
          throw error;
        }

        // Calculate exponential backoff delay
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s...
          logger.warn({
            ...mailErrorFields(error),
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            recipient: maskEmail(to),
          }, 'Email send failed - retrying after delay');

          await this.sleep(delay);
        }
      }
    }

    // All retries exhausted
    logger.error({
      ...mailErrorFields(lastError),
      recipient: maskEmail(to),
      maxRetries,
    }, 'Email send failed after all retries');

    throw lastError;
  }

  /**
   * Sleep for a given number of milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
