import { describe, it, expect, vi } from 'vitest';
import { credentialNoticeContent, noticeCredentialAdded, type NoticeDeps } from '../../services/credentialNotices.js';
import { getCurrentTenantId } from '../../context/requestContext.js';

/**
 * The notice that a passkey or MCP token was added to an account: by
 * email when SMTP is configured, else by push, else logged; never failing the request.
 */
function deps(overrides: Partial<NoticeDeps> = {}) {
  const sent = { email: [] as unknown[][], push: [] as unknown[][] };
  const d: NoticeDeps = {
    recipient: async () => ({ email: 'jane@example.com', firstName: 'Jane' }),
    emailConfigured: async () => true,
    sendEmail: async (...args) => {
      sent.email.push(args);
      return 'id';
    },
    sendPush: async (...args) => {
      sent.push.push(args);
      return { sent: 1 };
    },
    ...overrides,
  };
  return { d, sent };
}

const at = new Date('2026-11-02T09:30:00Z');

describe('noticeCredentialAdded', () => {
  it('emails when SMTP is configured, with the name escaped in the HTML', async () => {
    const { d, sent } = deps();
    expect(await noticeCredentialAdded(7, { kind: 'mcp_token', name: '<b>agent</b>', at }, d)).toBe('email');
    expect(sent.push).toEqual([]);
    const [to, subject, html, text] = sent.email[0] as string[];
    expect(to).toBe('jane@example.com');
    expect(subject).toBe('An MCP access token was created for your Nuggets account');
    expect(text).toContain('Hi Jane, a new MCP access token named “<b>agent</b>” was added to your Nuggets account on 2026-11-02 09:30 UTC.');
    expect(text).toContain('Settings → MCP Access');
    expect(html).toContain('“&lt;b&gt;agent&lt;/b&gt;”');
    expect(html).not.toContain('<b>agent');
    expect(html).toContain('/settings/mcp');
  });

  it('pushes when there is no SMTP, or the email fails', async () => {
    const noSmtp = deps({ emailConfigured: async () => false });
    expect(await noticeCredentialAdded(7, { kind: 'passkey', name: 'Phone', at }, noSmtp.d)).toBe('push');
    expect(noSmtp.sent.push[0]).toEqual([
      7,
      expect.objectContaining({ title: 'A passkey was added to your Nuggets account', url: '/profile', tag: 'credential-added:passkey' }),
    ]);

    const failing = deps({ sendEmail: async () => { throw new Error('SMTP down'); } });
    expect(await noticeCredentialAdded(7, { kind: 'passkey', at }, failing.d)).toBe('push');
  });

  it('logs, and fails nothing, when no channel can carry it', async () => {
    const none = deps({ emailConfigured: async () => false, sendPush: async () => ({ sent: 0 }) });
    expect(await noticeCredentialAdded(7, { kind: 'passkey', at }, none.d)).toBe('none');
    const gone = deps({ recipient: async () => undefined });
    expect(await noticeCredentialAdded(7, { kind: 'passkey', at }, gone.d)).toBe('none');
    const broken = deps({ recipient: async () => { throw new Error('db down'); } });
    expect(await noticeCredentialAdded(7, { kind: 'passkey', at }, broken.d)).toBe('none');
  });

  it('runs outside the request it was started from', async () => {
    const { runWithRequestContext } = await import('../../context/requestContext.js');
    const seen = vi.fn();
    const { d } = deps({ recipient: async () => { seen(getCurrentTenantId()); return undefined; } });
    await runWithRequestContext({ tenantId: 42 } as never, () => noticeCredentialAdded(7, { kind: 'passkey' }, d));
    expect(seen).toHaveBeenCalledWith(undefined);
  });

  it('says what was added and where to remove it', () => {
    expect(credentialNoticeContent({ kind: 'passkey', name: '  ', at }, null).lines[0]).toBe(
      'A new passkey was added to your Nuggets account on 2026-11-02 09:30 UTC.'
    );
    expect(credentialNoticeContent({ kind: 'passkey', at }, null).lines[1]).toContain('Profile → Passkeys');
  });
});
