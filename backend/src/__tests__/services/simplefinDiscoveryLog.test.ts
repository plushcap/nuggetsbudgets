import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Connecting SimpleFin lists the bank accounts to check the credential, and logs the errors
 * SimpleFin returns: as their codes and the connection and account they name, not their
 * text, which the bridge writes for people and may name an account. The sync logs
 * them the same way (importSyncLogLines.db.test.ts). The fetch is stubbed; encrypting the
 * credential is made to fail, so the test stops before anything is stored.
 */

const captured = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock('../../utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../utils/logger.js')>();
  const { default: pino } = await import('pino');
  const capture = pino({ level: 'trace' }, { write: (line: string) => void captured.lines.push(line) });
  return { ...actual, createLogger: (context: Record<string, unknown>) => capture.child(context) };
});

vi.mock('../../services/EncryptionService.js', () => ({
  EncryptionService: class {
    encryptString = async () => {
      throw new Error('stop here: nothing is stored');
    };
  },
}));

const { createConnection } = await import('../../services/OrganizationSimpleFinService.js');

describe('connecting SimpleFin', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    captured.lines.length = 0;
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('SIMPLEFIN_ALLOWED_HOSTS', '');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("logs SimpleFin's errors by code and id, not their text", async () => {
    const errlist = [
      { code: 'con.auth', msg: 'Sign in again to Example Bank for JOINT CHECKING SECRET', conn_id: 'CONN-1' },
      { code: 'act.sync', msg: 'VACATION FUND SECRET could not be refreshed', account_id: 'ACT-2' },
    ];
    fetchMock
      .mockResolvedValueOnce(new Response('https://user:pass@bridge.simplefin.org/simplefin\n'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ errlist, accounts: [] }), { headers: { 'content-type': 'application/json' } }));

    await expect(
      createConnection(1, { setupToken: Buffer.from('https://bridge.simplefin.org/simplefin/claim/abc').toString('base64') }, 1)
    ).rejects.toThrow('stop here');

    const line = captured.lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'SimpleFin discovery returned errors');
    expect(line).toMatchObject({
      simplefinErrors: [
        { code: 'con.auth', conn_id: 'CONN-1' },
        { code: 'act.sync', account_id: 'ACT-2' },
      ],
    });
    expect(captured.lines.join('\n')).not.toMatch(/SECRET|Example Bank/);
  });
});
