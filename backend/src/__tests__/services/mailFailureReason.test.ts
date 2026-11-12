import { describe, it, expect } from 'vitest';
import { mailFailureReason, SmtpNotConfiguredError } from '../../services/EmailDeliveryService.js';

/**
 * Why an email couldn't go, as a test email's answer and a notification's error_message
 * say it: what to check, never the mailer's own text (the SMTP server's reply, its
 * host and the account it refused).
 */
describe('mailFailureReason', () => {
  const smtp = (code: string) => Object.assign(new Error('535 5.7.8 smtp.internal says no to user@host'), { code });

  it('names what to check for the failures it knows', () => {
    expect(mailFailureReason(smtp('EAUTH'))).toBe('The mail server refused the sign-in: check the SMTP username and password');
    expect(mailFailureReason(smtp('ECONNECTION'))).toBe("Couldn't connect to the mail server: check the SMTP host and port");
    expect(mailFailureReason(smtp('ETIMEDOUT'))).toBe("Couldn't connect to the mail server: check the SMTP host and port");
    expect(mailFailureReason(smtp('EENVELOPE'))).toBe('The mail server refused the recipient address');
  });

  it("says SMTP isn't set up in the setup's own words, and nothing for anything else", () => {
    expect(mailFailureReason(new SmtpNotConfiguredError('SMTP configuration incomplete.'))).toBe('SMTP configuration incomplete.');
    expect(mailFailureReason(new Error('anything else: smtp.internal'))).toBe('The email could not be sent; the server log has the details');
    expect(mailFailureReason('a string')).toBe('The email could not be sent; the server log has the details');
  });
});
