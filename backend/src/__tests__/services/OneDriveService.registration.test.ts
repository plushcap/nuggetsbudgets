import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * OneDrive's app registration comes only from what the Backup page saved. The client id,
 * secret and redirect URI used to fall back to ONEDRIVE_* variables, which put a secret
 * in the stack's environment, and the tokens' key to an ENCRYPTION_KEY variable. Here the
 * saved settings are a map, and "encrypted" is a prefix: nothing touches a database.
 */

const saved = vi.hoisted(() => new Map<string, string>());
vi.mock('../../services/systemSettings.js', () => ({
  readSystemSettings: async (keys: readonly string[]) =>
    Object.fromEntries(keys.filter((k) => saved.has(k)).map((k) => [k, saved.get(k)])),
  writeSystemSetting: async (key: string, value: string) => {
    saved.set(key, value);
  },
}));
vi.mock('../../services/EncryptionService.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/EncryptionService.js')>()),
  EncryptionService: class {
    async encryptString(value: string) {
      return `sealed:${value}`;
    }
    async decryptString(value: string) {
      return value.replace(/^sealed:/, '');
    }
  },
}));

const { OneDriveService } = await import('../../services/OneDriveService.js');
const { EncryptionKeyUnavailableError } = await import('../../services/EncryptionService.js');

const VARIABLES = [
  'ONEDRIVE_CLIENT_ID',
  'ONEDRIVE_CLIENT_SECRET',
  'ONEDRIVE_REDIRECT_URI',
  'ENCRYPTION_KEY',
  'DOMAIN_URL',
  'CLIENT_URL',
  'DATA_ENCRYPTION_KEY_FILE',
] as const;

describe('the OneDrive app registration', () => {
  const before = Object.fromEntries(VARIABLES.map((name) => [name, process.env[name]]));

  beforeEach(() => {
    saved.clear();
    for (const name of VARIABLES) delete process.env[name];
  });

  afterEach(() => {
    for (const name of VARIABLES) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  });

  it('ignores the old variables: nothing saved is not set up', async () => {
    process.env.ONEDRIVE_CLIENT_ID = 'from-the-environment';
    process.env.ONEDRIVE_CLIENT_SECRET = 'from-the-environment'; // gitleaks:allow (made-up)
    process.env.ONEDRIVE_REDIRECT_URI = 'https://env.example.com/api/onedrive/callback';
    const service = new OneDriveService();
    expect(await service.isConfigured()).toBe(false);
    expect(await service.getClientConfig()).toEqual({ clientId: '', redirectUri: '', clientSecretSet: false });
    await expect(service.getAuthorizationUrl(1)).rejects.toThrow(/not configured/);
  });

  it('is set up once a client id and secret are saved, with the saved redirect URI', async () => {
    process.env.DOMAIN_URL = 'https://nuggets.example.com';
    const service = new OneDriveService();
    await service.saveClientConfig({ clientId: 'app-id', redirectUri: 'https://saved.example.com/api/onedrive/callback' });
    expect(await service.isConfigured()).toBe(false); // an id without a secret
    await service.saveClientConfig({
      clientId: 'app-id',
      clientSecret: 'app-secret', // gitleaks:allow (made-up)
      redirectUri: 'https://saved.example.com/api/onedrive/callback',
    });
    expect(saved.get('onedrive_client_secret')).toBe('sealed:app-secret');
    expect(await service.isConfigured()).toBe(true);
    expect(await service.getClientConfig()).toEqual({
      clientId: 'app-id',
      redirectUri: 'https://saved.example.com/api/onedrive/callback',
      clientSecretSet: true,
    });
  });

  it.each([
    ['the browser-facing CLIENT_URL', { CLIENT_URL: 'https://app.example.com/', DOMAIN_URL: 'https://api.example.com' }, 'https://app.example.com/api/onedrive/callback'],
    ['DOMAIN_URL without a CLIENT_URL', { DOMAIN_URL: 'https://nuggets.example.com' }, 'https://nuggets.example.com/api/onedrive/callback'],
    ['nothing without either', {}, ''],
    ['nothing for an address that is not a URL', { DOMAIN_URL: 'nuggets.example.com' }, ''],
  ])('starts the redirect URI on %s', async (_label, env: Record<string, string>, expected) => {
    Object.assign(process.env, env);
    expect((await new OneDriveService().getClientConfig()).redirectUri).toBe(expected);
  });

  it('has no key for its tokens from ENCRYPTION_KEY: only the data encryption key seals them', () => {
    process.env.DATA_ENCRYPTION_KEY_FILE = '/nonexistent/data_encryption_key';
    process.env.ENCRYPTION_KEY = 'ab'.repeat(32); // gitleaks:allow (made-up)
    expect(() => new OneDriveService().assertTokenKeyAvailable()).toThrow(EncryptionKeyUnavailableError);
  });
});
