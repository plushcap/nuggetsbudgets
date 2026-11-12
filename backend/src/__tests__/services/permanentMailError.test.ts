import { describe, it, expect } from 'vitest';
import { isPermanentMailError } from '../../services/EmailDeliveryService.js';

/**
 * A reply that carries an enhanced status code and no reply code. nodemailer
 * takes a reply's leading digits as its responseCode (smtp-connection: `response.match(/^\d+/)`),
 * so "5.1.1 User unknown" gave responseCode 5: read as a reply code, that is no 5xx, and the
 * send was tried again (and a notification kept being retried) for a recipient that can never
 * be reached. These are the errors nodemailer builds for such replies.
 */
describe('isPermanentMailError, a reply with only an enhanced status code', () => {
  const refused = (response: string, code = 'EENVELOPE') =>
    Object.assign(new Error(`Recipient command failed: ${response}`), {
      code,
      command: 'RCPT TO',
      response,
      responseCode: Number(response.match(/^\d+/)?.[0]),
    });

  it('is permanent for a 5.X.X refusal of the recipient or the message', () => {
    expect(isPermanentMailError(refused('5.1.1 <nobody@example.test>: Recipient address rejected: User unknown'))).toBe(true);
    expect(isPermanentMailError(refused('5.7.1 Message rejected', 'EMESSAGE'))).toBe(true);
    // The recipient-unreachable words count with it, as with a 550.
    expect(isPermanentMailError(Object.assign(new Error('x'), { response: '5.1.1 Mailbox unavailable', responseCode: 5 }))).toBe(true);
  });

  it('is tried again for a 4.X.X one', () => {
    expect(isPermanentMailError(refused('4.2.2 Mailbox full, try again later'))).toBe(false);
    expect(isPermanentMailError(Object.assign(new Error('x'), { response: '4.4.1 Mailbox unavailable', responseCode: 4 }))).toBe(false);
  });

  it('still reads a reply code first', () => {
    expect(isPermanentMailError(refused('550 5.1.1 User unknown'))).toBe(true);
    expect(isPermanentMailError(refused('450 4.2.1 Try again later'))).toBe(false);
    // 503 (a bad sequence of commands) is the conversation's fault, whatever it adds.
    expect(isPermanentMailError(refused('503 5.5.1 Bad sequence of commands'))).toBe(false);
  });
});
