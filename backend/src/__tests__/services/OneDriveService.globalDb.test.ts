import { describe, it, expect, vi } from 'vitest';

/**
 * OneDriveService keeps its rows (the app registration in system_settings, the tokens in
 * onedrive_tokens) on globalDb, the app's one control-plane handle. It built a
 * Kysely of its own over a pool it was given, and the lifecycle made a second service
 * that way. Here globalDb is a stand-in that records what it is asked.
 */

const asked = vi.hoisted(() => ({ queries: [] as string[] }));
vi.mock('../../db/withTenant.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../db/withTenant.js')>();
  const { Kysely, PostgresDialect } = await import('kysely');
  const client = {
    query: async (text: string) => {
      asked.queries.push(text);
      const rows = /system_settings/.test(text) ? [{ setting_key: 'onedrive_redirect_uri', setting_value: 'https://stored.example/api/onedrive/callback' }] : [];
      return { command: 'SELECT', rowCount: rows.length, rows };
    },
    release: () => {},
  };
  return { ...actual, globalDb: new Kysely({ dialect: new PostgresDialect({ pool: { connect: async () => client } as never }) }) };
});

const { OneDriveService } = await import('../../services/OneDriveService.js');

describe('OneDriveService', () => {
  it('reads the app registration on globalDb, taking no pool', async () => {
    const service = new OneDriveService();
    expect((await service.getClientConfig()).redirectUri).toBe('https://stored.example/api/onedrive/callback');
    expect(asked.queries.some((q) => /from "system_settings"/.test(q))).toBe(true);
  });
});
